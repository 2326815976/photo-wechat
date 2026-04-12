function normalizeWechatProfile(userInfo) {
  if (!userInfo || typeof userInfo !== "object") {
    return null;
  }

  const nickName = String(userInfo.nickName || "").trim();
  const avatarUrl = String(userInfo.avatarUrl || "").trim();
  if (!nickName && !avatarUrl) {
    return null;
  }

  return {
    nickName,
    avatarUrl,
  };
}

function requestWechatUserProfile(options) {
  const config = options && typeof options === "object" ? options : {};
  const desc = String(config.desc || "").trim() || "用于完善登录后的头像与昵称";

  return new Promise((resolve) => {
    if (typeof wx === "undefined" || typeof wx.getUserProfile !== "function") {
      resolve(null);
      return;
    }

    try {
      wx.getUserProfile({
        desc,
        lang: "zh_CN",
        success: (res) => {
          resolve(normalizeWechatProfile(res && res.userInfo));
        },
        fail: () => {
          resolve(null);
        },
      });
    } catch (error) {
      resolve(null);
    }
  });
}

module.exports = {
  requestWechatUserProfile,
};
