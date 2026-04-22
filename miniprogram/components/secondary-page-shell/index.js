const { resolveShellSafeTop } = require("../../utils/page-shell-safe-top");
const { getManagedPageAccess } = require("../../utils/runtime-config");

function normalizeMiniProgramRoutePath(value) {
  return String(value || "")
    .trim()
    .split("?")[0]
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function normalizeMiniProgramRouteUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  const [path, query = ""] = raw.split("?");
  const normalizedPath = normalizeMiniProgramRoutePath(path);
  if (!normalizedPath) {
    return "";
  }
  return `/${normalizedPath}${query ? `?${query}` : ""}`;
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
      const globalData = app && app.globalData ? app.globalData : {};
      if (!Boolean(globalData.auditConfigReady)) {
        return "";
      }
      const runtimeConfig = globalData.runtimeConfig || null;
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
      const normalizedFallbackTab =
        normalizeMiniProgramRoutePath(this.properties.fallbackTab) || "pages/index/index";
      const nextFallbackTab = normalizedFallbackTab;
      const nextPreferFallback = Boolean(this.properties.preferFallback);

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

    openFallbackTab() {
      wx.switchTab({ url: `/${this.data.resolvedFallbackTab}` });
    },

    openFallbackRoute(onFail) {
      const fallbackRoute = normalizeMiniProgramRouteUrl(this.properties.fallbackRoute);
      if (!fallbackRoute) {
        return false;
      }
      wx.reLaunch({
        url: fallbackRoute,
        fail: (error) => {
          if (typeof onFail === "function") {
            onFail(error);
          }
        },
      });
      return true;
    },

    shouldPreferExplicitFallback() {
      return Boolean(normalizeMiniProgramRouteUrl(this.properties.fallbackRoute));
    },

    onBack() {
      this.triggerEvent("back");

      if (this.data.resolvedPreferFallback || this.shouldPreferExplicitFallback()) {
        if (this.openFallbackRoute(() => this.openFallbackTab())) {
          return;
        }
        this.openFallbackTab();
        return;
      }

      wx.navigateBack({
        delta: 1,
        fail: () => {
          if (this.openFallbackRoute(() => this.openFallbackTab())) {
            return;
          }
          this.openFallbackTab();
        },
      });
    },
  },
});
