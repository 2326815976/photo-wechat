Page({
  onLoad() {
    wx.redirectTo({
      url: "/pages/admin/page-center/index?channel=miniprogram",
      fail: () => {
        wx.reLaunch({ url: "/pages/admin/page-center/index?channel=miniprogram" });
      },
    });
  },
});
