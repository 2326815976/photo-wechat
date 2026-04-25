const { getSession, extractSessionUser } = require('../../services/photo-api');
const {
  buildRuntimeConfigPreset,
  getDisplayedTabBarItems,
  isTabBarPagePath,
  normalizeRuntimeConfig,
} = require('../../utils/runtime-config');
const {
  normalizeMiniProgramRoutePath,
  resolvePagePresentationState,
} = require('../../utils/page-presentation');

const TAB_SWITCH_TIMEOUT_MS = 3000;

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
    runtimeConfigReady: false,
    presentationMode: 'tabbar',
    hasBottomTabbar: true,
    useOfficialCustomTabBar: false,
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
      const auditConfigReady = Boolean(globalData.auditConfigReady);
      const currentPages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
      const currentPage = Array.isArray(currentPages) && currentPages.length > 0
        ? currentPages[currentPages.length - 1]
        : null;
      const useOfficialCustomTabBar = Boolean(
        currentPage && typeof currentPage.getTabBar === 'function' && currentPage.getTabBar()
      );

      this.setData({ useOfficialCustomTabBar });

      if (!auditConfigReady) {
        this.setData({ visible: false });
        if (app && typeof app.ensureAuditConfig === 'function') {
          app.ensureAuditConfig().catch(() => {});
        }
      } else {
        const runtimeConfig = globalData.runtimeConfig || buildRuntimeConfigPreset('standard');
        this.applyRuntimeConfig(runtimeConfig);
      }

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

      if (app && typeof app.subscribeBackendStatus === 'function') {
        this._unsubscribeBackendStatus = app.subscribeBackendStatus((status) => {
          if (status && status.backendReady) {
            this.refreshLoginState();
          }
        });
      }

      this.refreshLoginState();
      if (auditConfigReady) {
        this.applyList(Array.isArray(this.data.list) ? this.data.list : []);
      }
    },
    detached() {
      this.releaseSwitchLock();
      if (typeof this._unsubscribeRuntimeConfig === 'function') {
        this._unsubscribeRuntimeConfig();
      }
      this._unsubscribeRuntimeConfig = null;
      if (typeof this._unsubscribePresentation === 'function') {
        this._unsubscribePresentation();
      }
      this._unsubscribePresentation = null;
      if (typeof this._unsubscribeBackendStatus === 'function') {
        this._unsubscribeBackendStatus();
      }
      this._unsubscribeBackendStatus = null;
    },
  },
  pageLifetimes: {
    show() {
      this.releaseSwitchLock();
      const app = typeof getApp === 'function' ? getApp() : null;
      if (app && typeof app.getPagePresentation === 'function') {
        this.applyPresentation(app.getPagePresentation());
      }
      const currentPages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
      const currentPage = Array.isArray(currentPages) && currentPages.length > 0
        ? currentPages[currentPages.length - 1]
        : null;
      const useOfficialCustomTabBar = Boolean(
        currentPage && typeof currentPage.getTabBar === 'function' && currentPage.getTabBar()
      );
      this.setData({
        useOfficialCustomTabBar,
        selectedPath: resolveCurrentRouteFromStack(),
      });
      this.refreshLoginState();
      this.applyList(Array.isArray(this.data.list) ? this.data.list : []);
    },
  },
  methods: {
    releaseSwitchLock() {
      if (this._switchLockTimer) {
        clearTimeout(this._switchLockTimer);
      }
      this._switchLockTimer = null;
      this._switchingPath = '';
    },

    applyList(list) {
      const nextList = Array.isArray(list) ? list : [];
      const pendingPath = normalizeMiniProgramRoutePath(this._switchingPath);
      const selectedPath = normalizeMiniProgramRoutePath(this.data.selectedPath);
      const currentRoute = resolveCurrentRouteFromStack();
      const propertyPath = normalizeMiniProgramRoutePath(this.properties.currentPath);
      const currentPath = pendingPath || currentRoute || selectedPath || propertyPath;
      let selectedIndex = currentPath
        ? nextList.findIndex((item) => item.pagePath === currentPath)
        : -1;

      if (selectedIndex < 0 && selectedPath) {
        selectedIndex = nextList.findIndex((item) => item.pagePath === selectedPath);
      }

      if (selectedIndex < 0) {
        const selected = Number(this.data.selected);
        selectedIndex = Number.isFinite(selected) && selected >= 0 && selected < nextList.length ? selected : 0;
      }

      const nextSelectedPath = nextList[selectedIndex]
        ? String(nextList[selectedIndex].pagePath || '')
        : currentPath;

      this.setData({
        list: nextList,
        selected: selectedIndex < 0 ? 0 : selectedIndex,
        selectedPath: nextSelectedPath,
        visible:
          !Boolean(this.data.useOfficialCustomTabBar) &&
          Boolean(this.properties.show) &&
          Boolean(this.data.runtimeConfigReady) &&
          Boolean(this.data.hasBottomTabbar) &&
          nextList.length > 0,
      });
    },

    applyPresentation(presentation) {
      const pagePath = normalizeMiniProgramRoutePath(this.properties.currentPath) || resolveCurrentRouteFromStack();
      const state = resolvePagePresentationState(presentation, pagePath, this.data.runtimeConfig);
      this.setData({
        presentationMode: state.mode,
        hasBottomTabbar: Boolean(state.hasBottomTabbar),
      });
      this.applyList(Array.isArray(this.data.list) ? this.data.list : []);
    },

    applyRuntimeConfig(runtimeConfig) {
      const normalized = normalizeRuntimeConfig(runtimeConfig);
      const nextList = hydrateTabBarItems(normalized, this.data.isLoggedIn);
      this.setData({ runtimeConfig: normalized, runtimeConfigReady: true });

      const app = typeof getApp === 'function' ? getApp() : null;
      if (app && typeof app.getPagePresentation === 'function') {
        this.applyPresentation(app.getPagePresentation());
        return;
      }
      this.applyList(nextList);
    },

    applyLoginState(isLoggedIn) {
      const nextLoggedIn = Boolean(isLoggedIn);
      if (nextLoggedIn === Boolean(this.data.isLoggedIn)) {
        return;
      }
      const normalized = normalizeRuntimeConfig(this.data.runtimeConfig);
      const nextList = hydrateTabBarItems(normalized, nextLoggedIn);
      this.setData({ isLoggedIn: nextLoggedIn });
      this.applyList(nextList);
    },

    async refreshLoginState() {
      const app = typeof getApp === 'function' ? getApp() : null;
      const globalData = app && app.globalData ? app.globalData : {};
      if (globalData.cloudRunService && !globalData.backendReady) {
        return;
      }

      try {
        const session = await getSession();
        const user = extractSessionUser(session);
        this.applyLoginState(Boolean(user && user.id));
      } catch (error) {
        const errorCode = String((error && error.code) || '').trim();
        if (
          errorCode === 'TRANSIENT_BACKEND' ||
          (globalData.cloudRunService && globalData.backendReconnecting)
        ) {
          return;
        }
        this.applyLoginState(false);
      }
    },

    onTapItem(e) {
      const path = normalizeMiniProgramRoutePath(
        e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.path : ''
      );
      if (!path) return;

      const currentPath =
        resolveCurrentRouteFromStack() ||
        normalizeMiniProgramRoutePath(this.properties.currentPath);
      if (currentPath === path) {
        this.releaseSwitchLock();
        this.applyList(Array.isArray(this.data.list) ? this.data.list : []);
        return;
      }

      if (this._switchingPath) {
        return;
      }

      const list = Array.isArray(this.data.list) ? this.data.list : [];
      const index = list.findIndex((item) => item.pagePath === path);

      this._switchingPath = path;

      if (index >= 0) {
        this.setData({ selected: index, selectedPath: path });
      } else {
        this.setData({ selectedPath: path });
      }
      const app = typeof getApp === 'function' ? getApp() : null;
      if (app && typeof app.resetPagePresentation === 'function') {
        app.resetPagePresentation({ silent: true });
        if (typeof app.getPagePresentation === 'function') {
          this.applyPresentation(app.getPagePresentation());
        }
      }

      const revertSelection = () => {
        const fallbackIndex = list.findIndex((item) => item.pagePath === currentPath);
        this.releaseSwitchLock();
        if (fallbackIndex >= 0) {
          this.setData({ selected: fallbackIndex, selectedPath: currentPath });
        } else {
          this.setData({ selectedPath: currentPath });
        }
        this.applyList(Array.isArray(this.data.list) ? this.data.list : []);
      };

      this._switchLockTimer = setTimeout(() => {
        if (String(this._switchingPath || '') !== path) return;
        const activePath = resolveCurrentRouteFromStack();
        if (activePath === path) {
          this.releaseSwitchLock();
          return;
        }
        revertSelection();
      }, TAB_SWITCH_TIMEOUT_MS);

      if (isTabBarPagePath(path, this.data.runtimeConfig)) {
        wx.switchTab({
          url: `/${path}`,
          success: () => {
            this.releaseSwitchLock();
          },
          fail: revertSelection,
        });
        return;
      }

      wx.reLaunch({
        url: `/${path}`,
        success: () => {
          this.releaseSwitchLock();
        },
        fail: revertSelection,
      });
    },
  },
});

