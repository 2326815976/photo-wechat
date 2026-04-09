Page({
  data: {
    url: "",
  },

  onLoad(options) {
    const url = options && typeof options === "object" ? decodeURIComponent(String(options.url || "")) : "";
    this.setData({ url });
  },
});
