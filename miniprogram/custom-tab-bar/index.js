const { getSession, extractSessionUser } = require("../services/photo-api");
const {
  buildRuntimeConfigPreset,
  getDisplayedTabBarItems,
  normalizeRuntimeConfig,
} = require("../utils/runtime-config");
const {
  normalizeMiniProgramRoutePath,
  resolvePagePresentationState,
} = require("../utils/page-presentation");

const ICON_PATH_MAP = {
  home: {
    normal: "/images/tab/house.svg",
    active: "/images/tab/house-active.svg",
  },
  album: {
    normal: "/images/tab/lock.svg",
    active: "/images/tab/lock-active.svg",
  },
  gallery: {
    normal: "/images/tab/image.svg",
    active: "/images/tab/image-active.svg",
  },
  booking: {
    normal: "/images/tab/calendar.svg",
    active: "/images/tab/calendar-active.svg",
  },
  profile: {
    normal: "/images/tab/user.svg",
    active: "/images/tab/user-active.svg",
  },
};

function hydrateTabBarItems(runtimeConfig, isLoggedIn) {
  return getDisplayedTabBarItems(runtimeConfig, isLoggedIn).map((item) => {
    const iconConfig = ICON_PATH_MAP[item.iconKey] || ICON_PATH_MAP.profile;
    return {
      key: item.key,
      pagePath: item.pagePath,
      text: item.displayText,
      iconPath: iconConfig.normal,
      selectedIconPath: iconConfig.active,
    };
  });
}

Component({
  data: {
    selected: 0,
    selectedPath: "pages/index/index",
    visible: false,
    hideAudit: false,
    isLoggedIn: false,
    presentationMode: "tabbar",
    hasBottomTabbar: true,
    runtimeConfig: buildRuntimeConfigPreset("standard"),
    list: hydrateTabBarItems(buildRuntimeConfigPreset("standard"), false),
  },
  lifetimes: {
    attached() {
      const app = typeof getApp === "function" ? getApp() : null;
      const globalData = app && app.globalData ? app.globalData : {};
      const auditConfigReady = Boolean(globalData.auditConfigReady);
      if (!auditConfigReady) {
        this.setData({ visible: false });
        if (app && typeof app.ensureAuditConfig === "function") {
          app.ensureAuditConfig().catch(() => {});
        }
      } else {
        this.applyRuntimeConfig(globalData.runtimeConfig || buildRuntimeConfigPreset("standard"));
      }

      if (app && typeof app.subscribeMiniProgramRuntimeConfig === "function") {
        this._unsubscribeRuntimeConfig = app.subscribeMiniProgramRuntimeConfig((runtimeConfig) => {
          this.applyRuntimeConfig(runtimeConfig);
        });
      }

      if (app && typeof app.subscribePagePresentation === "function") {
        this._unsubscribePresentation = app.subscribePagePresentation((presentation) => {
          this.applyPresentation(presentation);
        });
      } else if (app && typeof app.getPagePresentation === "function") {
        this.applyPresentation(app.getPagePresentation());
      }

      this.refreshLoginState();
    },
    detached() {
      if (typeof this._unsubscribeRuntimeConfig === "function") {
        this._unsubscribeRuntimeConfig();
      }
      this._unsubscribeRuntimeConfig = null;
      if (typeof this._unsubscribePresentation === "function") {
        this._unsubscribePresentation();
      }
      this._unsubscribePresentation = null;
    },
  },
  pageLifetimes: {
    show() {
      this.refreshLoginState();
    },
  },
  methods: {
    applyList(list) {
      const selectedPath = String(this.data.selectedPath || "")
        .trim()
        .replace(/^\/+/, "");
      const selectedIndex = Number(this.data.selected);

      let nextSelected = -1;
      if (selectedPath) {
        nextSelected = list.findIndex((item) => item.pagePath === selectedPath);
      }

      if (nextSelected < 0) {
        const safeIndex = Number.isFinite(selectedIndex) ? Math.round(selectedIndex) : 0;
        nextSelected = safeIndex >= 0 && safeIndex < list.length ? safeIndex : 0;
      }

      const nextSelectedPath = list[nextSelected]
        ? String(list[nextSelected].pagePath || "")
        : "";

      this.setData({
        visible: Boolean(this.data.hasBottomTabbar) && list.length > 0,
        list,
        selected: nextSelected,
        selectedPath: nextSelectedPath,
      });
    },

    applyPresentation(presentation) {
      let currentRoute = "";
      try {
        const pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];
        const currentPage = Array.isArray(pages) && pages.length > 0 ? pages[pages.length - 1] : null;
        currentRoute = normalizeMiniProgramRoutePath(currentPage && currentPage.route);
      } catch (error) {
        currentRoute = "";
      }

      const state = resolvePagePresentationState(presentation, currentRoute);
      this.setData({
        presentationMode: state.mode,
        hasBottomTabbar: Boolean(state.hasBottomTabbar),
      });
      this.applyList(Array.isArray(this.data.list) ? this.data.list : []);
    },

    applyRuntimeConfig(runtimeConfig) {
      const normalized = normalizeRuntimeConfig(runtimeConfig);
      const nextList = hydrateTabBarItems(normalized, this.data.isLoggedIn);

      this.setData({
        runtimeConfig: normalized,
        hideAudit: Boolean(normalized.hideAudit),
      });
      this.applyList(nextList);
    },

    applyLoginState(isLoggedIn) {
      const nextLoggedIn = Boolean(isLoggedIn);
      const normalized = normalizeRuntimeConfig(this.data.runtimeConfig);
      const nextList = hydrateTabBarItems(normalized, nextLoggedIn);
      this.setData({
        isLoggedIn: nextLoggedIn,
      });
      this.applyList(nextList);
    },

    async refreshLoginState() {
      try {
        const session = await getSession();
        const user = extractSessionUser(session);
        this.applyLoginState(Boolean(user && user.id));
      } catch (error) {
        this.applyLoginState(false);
      }
    },

    switchTab(e) {
      const path = String(
        (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.path) || ""
      )
        .trim()
        .replace(/^\/+/, "");
      if (!path) return;

      const list = Array.isArray(this.data.list) ? this.data.list : [];
      const selectedPath = String(this.data.selectedPath || "").trim().replace(/^\/+/, "");
      const index = list.findIndex((item) => item.pagePath === path);

      if (selectedPath === path && index >= 0 && index === Number(this.data.selected)) {
        return;
      }

      if (index >= 0) {
        this.setData({ selected: index, selectedPath: path });
      } else {
        this.setData({ selectedPath: path });
      }

      const app = typeof getApp === "function" ? getApp() : null;
      if (app && typeof app.resetPagePresentation === "function") {
        app.resetPagePresentation();
      }
      wx.switchTab({ url: `/${path}` });
    },
  },
});
