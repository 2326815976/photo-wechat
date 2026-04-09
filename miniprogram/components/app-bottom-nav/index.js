const { getSession, extractSessionUser } = require('../../services/photo-api');
const {
  buildRuntimeConfigPreset,
  getDisplayedTabBarItems,
  normalizeRuntimeConfig,
} = require('../../utils/runtime-config');
const {
  normalizeMiniProgramRoutePath,
  resolvePagePresentationState,
} = require('../../utils/page-presentation');

const ICON_PATH_MAP = {
  home: {
    normal: '/images/tab/house.svg',
    active: '/images/tab/house-active.svg',
  },
  album: {
    normal: '/images/tab/lock.svg',
    active: '/images/tab/lock-active.svg',
  },
  gallery: {
    normal: '/images/tab/image.svg',
    active: '/images/tab/image-active.svg',
  },
  booking: {
    normal: '/images/tab/calendar.svg',
    active: '/images/tab/calendar-active.svg',
  },
  profile: {
    normal: '/images/tab/user.svg',
    active: '/images/tab/user-active.svg',
  },
  about: {
    normal: '/images/tab/user.svg',
    active: '/images/tab/user-active.svg',
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

function resolveCurrentRouteFromStack() {
  try {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    const currentPage = Array.isArray(pages) && pages.length > 0 ? pages[pages.length - 1] : null;
    return normalizeMiniProgramRoutePath(currentPage && currentPage.route);
  } catch (error) {
    return '';
  }
}

Component({
  properties: {
    show: {
      type: Boolean,
      value: true,
    },
    currentPath: {
      type: String,
      value: '',
    },
  },
  data: {
    selected: 0,
    selectedPath: '',
    visible: false,
    isLoggedIn: false,
    presentationMode: 'tabbar',
    hasBottomTabbar: true,
    runtimeConfig: buildRuntimeConfigPreset('standard'),
    list: hydrateTabBarItems(buildRuntimeConfigPreset('standard'), false),
  },
  observers: {
    show() {
      this.applyList(Array.isArray(this.data.list) ? this.data.list : []);
    },
    currentPath() {
      this.applyList(Array.isArray(this.data.list) ? this.data.list : []);
    },
  },
  lifetimes: {
    attached() {
      const app = typeof getApp === 'function' ? getApp() : null;
      const globalData = app && app.globalData ? app.globalData : {};
      const runtimeConfig = globalData.runtimeConfig || buildRuntimeConfigPreset('standard');
      this.applyRuntimeConfig(runtimeConfig);

      if (app && typeof app.subscribeMiniProgramRuntimeConfig === 'function') {
        this._unsubscribeRuntimeConfig = app.subscribeMiniProgramRuntimeConfig((nextRuntimeConfig) => {
          this.applyRuntimeConfig(nextRuntimeConfig);
        });
      }

      if (app && typeof app.subscribePagePresentation === 'function') {
        this._unsubscribePresentation = app.subscribePagePresentation((presentation) => {
          this.applyPresentation(presentation);
        });
      } else if (app && typeof app.getPagePresentation === 'function') {
        this.applyPresentation(app.getPagePresentation());
      }

      this.refreshLoginState();
      this.applyList(Array.isArray(this.data.list) ? this.data.list : []);
    },
    detached() {
      if (typeof this._unsubscribeRuntimeConfig === 'function') {
        this._unsubscribeRuntimeConfig();
      }
      this._unsubscribeRuntimeConfig = null;
      if (typeof this._unsubscribePresentation === 'function') {
        this._unsubscribePresentation();
      }
      this._unsubscribePresentation = null;
    },
  },
  pageLifetimes: {
    show() {
      this.refreshLoginState();
      this.applyList(Array.isArray(this.data.list) ? this.data.list : []);
    },
  },
  methods: {
    applyList(list) {
      const nextList = Array.isArray(list) ? list : [];
      const currentPath =
        normalizeMiniProgramRoutePath(this.properties.currentPath) ||
        normalizeMiniProgramRoutePath(this.data.selectedPath) ||
        resolveCurrentRouteFromStack();
      let selectedIndex = currentPath
        ? nextList.findIndex((item) => item.pagePath === currentPath)
        : -1;

      if (selectedIndex < 0) {
        const selected = Number(this.data.selected);
        selectedIndex = Number.isFinite(selected) && selected >= 0 && selected < nextList.length ? selected : 0;
      }

      const selectedPath = nextList[selectedIndex]
        ? String(nextList[selectedIndex].pagePath || '')
        : currentPath;

      this.setData({
        list: nextList,
        selected: selectedIndex < 0 ? 0 : selectedIndex,
        selectedPath,
        visible:
          Boolean(this.properties.show) &&
          Boolean(this.data.hasBottomTabbar) &&
          nextList.length > 0,
      });
    },

    applyPresentation(presentation) {
      const pagePath = normalizeMiniProgramRoutePath(this.properties.currentPath) || resolveCurrentRouteFromStack();
      const state = resolvePagePresentationState(presentation, pagePath);
      this.setData({
        presentationMode: state.mode,
        hasBottomTabbar: Boolean(state.hasBottomTabbar),
      });
      this.applyList(Array.isArray(this.data.list) ? this.data.list : []);
    },

    applyRuntimeConfig(runtimeConfig) {
      const normalized = normalizeRuntimeConfig(runtimeConfig);
      const nextList = hydrateTabBarItems(normalized, this.data.isLoggedIn);
      this.setData({ runtimeConfig: normalized });
      this.applyList(nextList);
    },

    applyLoginState(isLoggedIn) {
      const nextLoggedIn = Boolean(isLoggedIn);
      const normalized = normalizeRuntimeConfig(this.data.runtimeConfig);
      const nextList = hydrateTabBarItems(normalized, nextLoggedIn);
      this.setData({ isLoggedIn: nextLoggedIn });
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

    onTapItem(e) {
      const path = normalizeMiniProgramRoutePath(
        e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.path : ''
      );
      if (!path) return;

      const currentPath =
        normalizeMiniProgramRoutePath(this.properties.currentPath) || resolveCurrentRouteFromStack();
      if (currentPath === path) {
        return;
      }

      this.setData({ selectedPath: path });
      const app = typeof getApp === 'function' ? getApp() : null;
      if (app && typeof app.resetPagePresentation === 'function') {
        app.resetPagePresentation();
      }
      wx.reLaunch({ url: `/${path}` });
    },
  },
});
