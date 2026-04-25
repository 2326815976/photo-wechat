const { WECHAT_NICKNAME_AUTH_DESC } = require("./wechat-login");

function normalizeWechatProfile(userInfo) {
  if (!userInfo || typeof userInfo !== "object") {
    return null;
  }

  const nickName = String(userInfo.nickName || "").trim();
  if (!nickName) {
    return null;
  }

  return {
    nickName,
  };
}

function requestWechatUserProfile(options) {
  const config = options && typeof options === "object" ? options : {};
  const desc = String(config.desc || "").trim() || WECHAT_NICKNAME_AUTH_DESC;

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
