Page({
  onLoad() {
    wx.redirectTo({
      url: "/pages/admin/page-center/index?channel=web",
      fail: () => {
        wx.reLaunch({ url: "/pages/admin/page-center/index?channel=web" });
      },
    });
  },
});