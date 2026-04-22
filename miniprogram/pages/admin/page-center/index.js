const CHANNEL_TITLE_MAP = {
  web: "Web 页面管理",
  miniprogram: "小程序页面管理",
};

Page({
  data: {
    channel: "web",
    channelTitle: CHANNEL_TITLE_MAP.web,
  },

  onLoad(options) {
    const channel =
      String((options && options.channel) || "").trim() === "miniprogram"
        ? "miniprogram"
        : "web";

    this.setData({
      channel,
      channelTitle: CHANNEL_TITLE_MAP[channel],
    });
  },

  onPullDownRefresh() {
    const panel = this.selectComponent("#pageCenterPanel");
    const task =
      panel && typeof panel.refresh === "function"
        ? panel.refresh()
        : Promise.resolve();

    Promise.resolve(task).finally(() => wx.stopPullDownRefresh());
  },
});
