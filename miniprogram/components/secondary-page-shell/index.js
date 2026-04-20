const { resolveShellSafeTop } = require("../../utils/page-shell-safe-top");
const { getManagedPageAccess } = require("../../utils/runtime-config");

function normalizeMiniProgramRoutePath(value) {
  return String(value || "")
    .trim()
    .split("?")[0]
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function resolveCurrentRouteFromStack() {
  try {
    const pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];
    const currentPage = Array.isArray(pages) && pages.length > 0 ? pages[pages.length - 1] : null;
    return normalizeMiniProgramRoutePath(currentPage && currentPage.route);
  } catch (error) {
    return "";
  }
}

Component({
  externalClasses: ["shell-class", "content-class"],
  data: {
    resolvedSafeTop: 0,
    resolvedFallbackTab: "pages/index/index",
    resolvedPreferFallback: false,
    displayedTitle: "",
  },
  properties: {
    title: {
      type: String,
      value: "",
    },
    subtitle: {
      type: String,
      value: "",
    },
    managedPageKey: {
      type: String,
      value: "",
    },
    fallbackTab: {
      type: String,
      value: "pages/index/index",
    },
    fallbackRoute: {
      type: String,
      value: "",
    },
    preferFallback: {
      type: Boolean,
      value: false,
    },
    useScrollView: {
      type: Boolean,
      value: true,
    },
    scrollY: {
      type: Boolean,
      value: true,
    },
    enableFlex: {
      type: Boolean,
      value: true,
    },
    showScrollbar: {
      type: Boolean,
      value: false,
    },
    hidden: {
      type: Boolean,
      value: false,
    },
  },
  lifetimes: {
    attached() {
      this.syncShellState();
      this.applyManagedTitle();

      const app = typeof getApp === "function" ? getApp() : null;
      if (app && typeof app.subscribeMiniProgramRuntimeConfig === "function") {
        this._unsubscribeRuntimeConfig = app.subscribeMiniProgramRuntimeConfig(() => {
          this.applyManagedTitle();
        });
      }
    },
    detached() {
      if (typeof this._unsubscribeRuntimeConfig === "function") {
        this._unsubscribeRuntimeConfig();
      }
      this._unsubscribeRuntimeConfig = null;
    },
  },
  observers: {
    "title, managedPageKey"() {
      this.applyManagedTitle();
    },
    "fallbackTab, preferFallback"() {
      this.syncShellState();
    },
  },
  pageLifetimes: {
    show() {
      this.syncShellState();
      this.applyManagedTitle();
    },
  },
  methods: {
    resolveManagedTitle() {
      const managedPageKey = String(this.properties.managedPageKey || "").trim();
      if (!managedPageKey) {
        return "";
      }

      const app = typeof getApp === "function" ? getApp() : null;
      const runtimeConfig = app && app.globalData ? app.globalData.runtimeConfig : null;
      const managedAccess = getManagedPageAccess(runtimeConfig, managedPageKey);

      return String((managedAccess && (managedAccess.headerTitle || managedAccess.navText)) || "").trim();
    },

    applyManagedTitle() {
      const nextDisplayedTitle =
        this.resolveManagedTitle() || String(this.properties.title || "").trim();

      if (nextDisplayedTitle === this.data.displayedTitle) {
        return;
      }

      this.setData({ displayedTitle: nextDisplayedTitle });
    },

    syncShellState() {
      const nextSafeTop = resolveShellSafeTop();
      const currentRoute = resolveCurrentRouteFromStack();
      const normalizedFallbackTab =
        normalizeMiniProgramRoutePath(this.properties.fallbackTab) || "pages/index/index";
      const shouldPreferProfileFallback =
        normalizedFallbackTab === "pages/profile/index" && currentRoute !== "pages/profile/index";
      const nextFallbackTab = shouldPreferProfileFallback
        ? "pages/profile/index"
        : normalizedFallbackTab;
      const nextPreferFallback = Boolean(this.properties.preferFallback || shouldPreferProfileFallback);

      if (
        nextSafeTop === this.data.resolvedSafeTop &&
        nextFallbackTab === this.data.resolvedFallbackTab &&
        nextPreferFallback === this.data.resolvedPreferFallback
      ) {
        return;
      }

      this.setData({
        resolvedSafeTop: nextSafeTop,
        resolvedFallbackTab: nextFallbackTab,
        resolvedPreferFallback: nextPreferFallback,
      });
    },

    openFallbackRoute() {
      const fallbackRoute = String(this.properties.fallbackRoute || "").trim();
      if (fallbackRoute) {
        wx.reLaunch({ url: fallbackRoute });
        return true;
      }
      return false;
    },

    onBack() {
      this.triggerEvent("back");

      if (this.data.resolvedPreferFallback) {
        if (this.openFallbackRoute()) {
          return;
        }
        wx.switchTab({ url: `/${this.data.resolvedFallbackTab}` });
        return;
      }

      wx.navigateBack({
        delta: 1,
        fail: () => {
          if (this.openFallbackRoute()) {
            return;
          }
          wx.switchTab({ url: `/${this.data.resolvedFallbackTab}` });
        },
      });
    },
  },
});
