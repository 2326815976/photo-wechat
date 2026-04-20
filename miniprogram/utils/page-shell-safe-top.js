function resolveShellSafeTop() {
  const app = typeof getApp === "function" ? getApp() : null;
  const globalData = app && app.globalData ? app.globalData : {};
  const cachedSafeTop = Number(globalData.statusBarHeight || 0);
  if (cachedSafeTop > 0) {
    return cachedSafeTop;
  }

  try {
    if (wx && typeof wx.getWindowInfo === "function") {
      const windowInfo = wx.getWindowInfo();
      const safeTop = Number((windowInfo && windowInfo.statusBarHeight) || 0);
      if (safeTop > 0) {
        return safeTop;
      }
    }
  } catch (error) {
    // ignore
  }

  try {
    if (wx && typeof wx.getSystemInfoSync === "function") {
      const systemInfo = wx.getSystemInfoSync();
      const safeTop = Number((systemInfo && systemInfo.statusBarHeight) || 0);
      if (safeTop > 0) {
        return safeTop;
      }
    }
  } catch (error) {
    // ignore
  }

  return 0;
}

module.exports = {
  resolveShellSafeTop,
};
