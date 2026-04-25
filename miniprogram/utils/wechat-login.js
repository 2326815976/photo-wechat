const WECHAT_NICKNAME_AUTH_DESC = "用于同步微信昵称到个人资料";

function trimText(value) {
  return String(value == null ? "" : value).trim();
}

function resolveWechatLoginErrorMessage(error, fallback) {
  const message = trimText(error && typeof error === "object" ? error.message : error);
  const normalized = message.toLowerCase();
  const defaultMessage = trimText(fallback) || "微信登录失败，请稍后重试";

  if (!message) {
    return defaultMessage;
  }

  if (message.includes("微信昵称") || normalized.includes("nickname")) {
    return "需要先授权微信昵称后才能登录";
  }

  if (message.includes("微信登录凭证") || message.includes("重新授权") || normalized.includes("invalid_code") || normalized.includes("wx_mini_openid_missing") || normalized.includes("wx_mini_code_exchange_failed")) {
    return "微信授权已失效，请重新登录";
  }

  if (message.includes("配置") || normalized.includes("wx_mini_config_missing") || normalized.includes("cloudrunservice") || normalized.includes("appid") || normalized.includes("secret") || message.includes("X-WX-SERVICE")) {
    return "请检查微信登录与云托管配置";
  }

  if (message.includes("小程序") || normalized.includes("miniprogram")) {
    return "请在微信小程序内完成登录";
  }

  if (message.includes("禁用") || normalized.includes("account_disabled")) {
    return "当前账号已被禁用";
  }

  if (normalized.includes("network") || normalized.includes("failed to fetch") || message.includes("网络") || message.includes("请求失败")) {
    return "网络异常，请稍后重试";
  }

  return message;
}

module.exports = {
  WECHAT_NICKNAME_AUTH_DESC,
  resolveWechatLoginErrorMessage,
};
