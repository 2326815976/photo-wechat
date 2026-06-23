const CHANNEL_TITLE_MAP = {
  web: "Web 页面管理",
  miniprogram: "小程序页面管理",
};

Page({
  data: {
    channel: "miniprogram",
    channelTitle: CHANNEL_TITLE_MAP.miniprogram,
  },

  onLoad() {
    this.setData({
      channel: "miniprogram",
      channelTitle: CHANNEL_TITLE_MAP.miniprogram,
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
