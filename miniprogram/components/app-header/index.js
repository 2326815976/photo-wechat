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

      if (this.properties.preferFallback) {
        if (this.openFallbackRoute()) {
          return;
        }
        wx.switchTab({ url: `/${this.properties.fallbackTab}` });
        return;
      }

      wx.navigateBack({
        delta: 1,
        fail: () => {
          if (this.openFallbackRoute()) {
            return;
          }
          wx.switchTab({ url: `/${this.properties.fallbackTab}` });
        },
      });
    },
  },
});
