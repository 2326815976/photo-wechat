Component({
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
  },
  methods: {
    onBack() {
      this.triggerEvent("back");

      if (this.properties.preferFallback) {
        wx.switchTab({ url: `/${this.properties.fallbackTab}` });
        return;
      }

      wx.navigateBack({
        delta: 1,
        fail: () => {
          wx.switchTab({ url: `/${this.properties.fallbackTab}` });
        },
      });
    },
  },
});
