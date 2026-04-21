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
  data: {
    displayedTitle: "",
    displayedSubtitle: "",
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
    showBack: {
      type: Boolean,
      value: false,
    },
    safeTop: {
      type: Number,
      value: 0,
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
    isHomePage: {
      type: Boolean,
      value: false,
    },
    animateIn: {
      type: Boolean,
      value: false,
    },
    managedPageKey: {
      type: String,
      value: "",
    },
  },
  observers: {
    "title, subtitle, managedPageKey"() {
      this.applyManagedMeta();
    },
  },
  lifetimes: {
    attached() {
      this.applyManagedMeta();
      const app = typeof getApp === "function" ? getApp() : null;
      if (app && typeof app.subscribeMiniProgramRuntimeConfig === "function") {
        this._unsubscribeRuntimeConfig = app.subscribeMiniProgramRuntimeConfig(() => {
          this.applyManagedMeta();
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
  methods: {
    resolveManagedMeta() {
      const pageKey = String(this.properties.managedPageKey || "").trim();
      if (!pageKey) {
        return { title: "", subtitle: "" };
      }

      const app = typeof getApp === "function" ? getApp() : null;
      const globalData = app && app.globalData ? app.globalData : {};
      const runtimeConfig = globalData.runtimeConfig && typeof globalData.runtimeConfig === "object"
        ? globalData.runtimeConfig
        : {};
      const metaMap = runtimeConfig.managedPageMetaMap && typeof runtimeConfig.managedPageMetaMap === "object"
        ? runtimeConfig.managedPageMetaMap
        : {};
      const current = metaMap[pageKey] && typeof metaMap[pageKey] === "object" ? metaMap[pageKey] : {};
      return {
        title: String(current.title || "").trim(),
        subtitle: String(current.subtitle || "").trim(),
      };
    },

    applyManagedMeta() {
      const managedMeta = this.resolveManagedMeta();
      this.setData({
        displayedTitle: managedMeta.title || String(this.properties.title || "").trim(),
        displayedSubtitle: managedMeta.subtitle || String(this.properties.subtitle || "").trim(),
      });
    },

    openFallbackTab() {
      const fallbackTab =
        normalizeMiniProgramRoutePath(this.properties.fallbackTab) || "pages/index/index";
      wx.switchTab({ url: `/${fallbackTab}` });
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

      if (this.properties.preferFallback || this.shouldPreferExplicitFallback()) {
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
