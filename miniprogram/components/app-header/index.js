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

      wx.navigateBack({
        delta: 1,
        fail: () => {
          wx.switchTab({ url: `/${this.properties.fallbackTab}` });
        },
      });
    },
  },
});
