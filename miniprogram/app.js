// app.js
const config = require("./config");
const { requestJson } = require("./utils/cloudrun");

const CLOUDRUN_HEALTH_ENDPOINT = "/api/auth/session";
const AUDIT_CONFIG_ENDPOINT = "/api/miniprogram/runtime-config";
const DEFAULT_SHARE_TITLE = "拾光谣小工具";
const DEFAULT_SHARE_IMAGE = "/images/share/shiguangyao-share.jpg";
const SHARE_TITLE_BY_ROUTE = {
  "pages/index/index": "拾光谣｜发现灵感摆姿，记录每一帧",
  "pages/gallery/index": "拾光谣｜定格美好瞬间",
  "pages/booking/index": "拾光谣｜约拍入口，来定格你的故事",
  "pages/album/index": "拾光谣｜相册提取",
  "pages/album/detail": "「拾光谣」相册分享",
  "pages/album/detail/index": "「拾光谣」相册分享",
  "pages/profile/index": "拾光谣｜定格美好瞬间",
};

function parseBooleanLike(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value !== 0;
  }

  const text = String(value || "").trim().toLowerCase();
  if (!text) return null;
  if (["1", "true", "yes", "y", "on"].includes(text)) return true;
  if (["0", "false", "no", "n", "off"].includes(text)) return false;
  return null;
}

function readHideAuditFromPayload(payload) {
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    const direct = parseBooleanLike(current);
    if (typeof direct === "boolean") return direct;

    if (!current || typeof current !== "object") break;

    if (Object.prototype.hasOwnProperty.call(current, "hideAudit")) {
      const parsed = parseBooleanLike(current.hideAudit);
      if (typeof parsed === "boolean") return parsed;
    }
    if (Object.prototype.hasOwnProperty.call(current, "hide_audit")) {
      const parsed = parseBooleanLike(current.hide_audit);
      if (typeof parsed === "boolean") return parsed;
    }

    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }

  return null;
}

function buildQueryString(options) {
  if (!options || typeof options !== "object") return "";
  return Object.keys(options)
    .filter((key) => key && options[key] !== undefined && options[key] !== null)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(options[key]))}`)
    .join("&");
}

function resolveCurrentShareContext() {
  try {
    const pages = getCurrentPages();
    const current = Array.isArray(pages) && pages.length > 0 ? pages[pages.length - 1] : null;
    const route = String((current && current.route) || "pages/index/index")
      .trim()
      .replace(/^\/+/, "");
    const query = buildQueryString(current && current.options ? current.options : {});
    return { route, query };
  } catch (error) {
    return { route: "pages/index/index", query: "" };
  }
}

function resolveShareTitle(route) {
  const normalizedRoute = String(route || "").trim().replace(/^\/+/, "");
  if (!normalizedRoute) return DEFAULT_SHARE_TITLE;
  return String(SHARE_TITLE_BY_ROUTE[normalizedRoute] || DEFAULT_SHARE_TITLE);
}

function buildShareAppMessagePayload() {
  const { route, query } = resolveCurrentShareContext();
  const payload = {
    title: resolveShareTitle(route),
    path: `/${route}${query ? `?${query}` : ""}`,
  };
  if (DEFAULT_SHARE_IMAGE) {
    payload.imageUrl = DEFAULT_SHARE_IMAGE;
  }
  return payload;
}

function buildShareTimelinePayload() {
  const { route, query } = resolveCurrentShareContext();
  const payload = {
    title: resolveShareTitle(route),
    query,
  };
  if (DEFAULT_SHARE_IMAGE) {
    payload.imageUrl = DEFAULT_SHARE_IMAGE;
  }
  return payload;
}

function ensureShareMenuEnabled() {
  try {
    wx.showShareMenu({
      withShareTicket: true,
      menus: ["shareAppMessage", "shareTimeline"],
    });
    return;
  } catch (error) {
    // ignore and fallback
  }

  try {
    wx.showShareMenu({ withShareTicket: true });
  } catch (error) {
    // ignore
  }
}

const NativePage = Page;
if (typeof NativePage === "function") {
  Page = function patchedPage(definition) {
    const pageDef = definition && typeof definition === "object" ? definition : {};

    const originalOnLoad = typeof pageDef.onLoad === "function" ? pageDef.onLoad : null;
    pageDef.onLoad = function patchedOnLoad(...args) {
      ensureShareMenuEnabled();
      if (originalOnLoad) {
        return originalOnLoad.apply(this, args);
      }
      return undefined;
    };

    if (typeof pageDef.onShareAppMessage !== "function") {
      pageDef.onShareAppMessage = function onShareAppMessage() {
        return buildShareAppMessagePayload();
      };
    }

    if (typeof pageDef.onShareTimeline !== "function") {
      pageDef.onShareTimeline = function onShareTimeline() {
        return buildShareTimelinePayload();
      };
    }

    return NativePage(pageDef);
  };
}

async function diagnoseCloudRunConnectivity() {
  try {
    await requestJson(CLOUDRUN_HEALTH_ENDPOINT, {
      method: "GET",
      timeout: 8000,
    });
    return { reachable: true, error: "" };
  } catch (error) {
    return {
      reachable: false,
      error: String((error && error.message) || "云托管连通性检测失败"),
    };
  }
}

App({
  auditConfigPromise: null,
  auditConfigListeners: [],

  globalData: {
    // env 参数说明：
    // env 参数决定接下来小程序发起的云开发调用（wx.cloud.xxx）会请求到哪个云环境的资源
    env: config.cloudbaseEnvId,
    cloudRunService: config.cloudRunService,
    cloudRunServiceInferred: Boolean(config.cloudRunServiceInferred),
    cloudRunServiceSource: String(config.cloudRunServiceSource || ""),
    appUrl: config.appUrl,
    cloudRunBaseUrl: config.cloudRunBaseUrl,
    debugRequests: Boolean(config.debugRequests),
    cloudRunReachable: null,
    cloudRunLastError: "",
    storageDomain: config.storageDomain,

    // 系统信息（用于自定义导航栏安全区）
    statusBarHeight: 0,
    safeArea: null,

    // 审核开关（true: 隐藏约拍入口）
    hideAudit: false,
    auditConfigReady: false,
  },

  notifyAuditConfigChange(hideAudit) {
    const listeners = Array.isArray(this.auditConfigListeners)
      ? this.auditConfigListeners.slice()
      : [];
    const nextValue = Boolean(hideAudit);
    listeners.forEach((listener) => {
      if (typeof listener !== "function") return;
      try {
        listener(nextValue);
      } catch (error) {
        // ignore listener errors
      }
    });
  },

  subscribeAuditConfig(listener) {
    if (typeof listener !== "function") {
      return () => {};
    }

    if (!Array.isArray(this.auditConfigListeners)) {
      this.auditConfigListeners = [];
    }
    this.auditConfigListeners.push(listener);

    if (this.globalData && this.globalData.auditConfigReady) {
      try {
        listener(Boolean(this.globalData.hideAudit));
      } catch (error) {
        // ignore listener errors
      }
    }

    return () => {
      const rows = Array.isArray(this.auditConfigListeners)
        ? this.auditConfigListeners
        : [];
      this.auditConfigListeners = rows.filter((item) => item !== listener);
    };
  },

  ensureAuditConfig() {
    if (this.auditConfigPromise) {
      return this.auditConfigPromise;
    }

    const service = String((this.globalData && this.globalData.cloudRunService) || "").trim();
    if (!service) {
      this.globalData.hideAudit = false;
      this.globalData.auditConfigReady = true;
      this.notifyAuditConfigChange(false);
      this.auditConfigPromise = Promise.resolve(false);
      return this.auditConfigPromise;
    }

    this.auditConfigPromise = requestJson(AUDIT_CONFIG_ENDPOINT, {
      method: "GET",
      timeout: 8000,
    })
      .then((payload) => {
        const parsed = readHideAuditFromPayload(payload);
        const hideAudit = parsed === null ? false : parsed;
        this.globalData.hideAudit = hideAudit;
        this.globalData.auditConfigReady = true;
        this.notifyAuditConfigChange(hideAudit);
        return hideAudit;
      })
      .catch((error) => {
        this.globalData.hideAudit = false;
        this.globalData.auditConfigReady = true;
        this.notifyAuditConfigChange(false);

        try {
          console.warn(
            `[Audit 配置获取失败] error=${String((error && error.message) || "unknown")}`
          );
        } catch (_) {
          // ignore log error
        }
        return false;
      });

    return this.auditConfigPromise;
  },

  onLaunch: function () {
    try {
      const windowInfo = wx.getWindowInfo();
      this.globalData.statusBarHeight = Number(windowInfo.statusBarHeight || 0);
      this.globalData.safeArea = windowInfo.safeArea || null;
    } catch (e) {
      // ignore
    }

    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
      this.globalData.hideAudit = false;
      this.globalData.auditConfigReady = true;
      this.notifyAuditConfigChange(false);
      this.auditConfigPromise = Promise.resolve(false);
      return;
    }

    wx.cloud.init({
      env: this.globalData.env,
      traceUser: true,
    });

    if (this.globalData.cloudRunServiceInferred) {
      console.warn(
        `[CloudRun 配置提醒] 当前 cloudRunService 来源为推断值（${this.globalData.cloudRunService}）。建议在 photo/.env.local 中显式配置 MINIPROGRAM_CLOUDRUN_SERVICE。`
      );
    }
    if (this.globalData.cloudRunService) {
      void diagnoseCloudRunConnectivity().then((result) => {
        this.globalData.cloudRunReachable = Boolean(result && result.reachable);
        this.globalData.cloudRunLastError = String((result && result.error) || "");

        if (!this.globalData.cloudRunReachable) {
          console.warn(
            `[CloudRun 连通性检测失败] env=${this.globalData.env} service=${this.globalData.cloudRunService} error=${this.globalData.cloudRunLastError}`
          );
        }
      });
    }

    void this.ensureAuditConfig();
  },
});
