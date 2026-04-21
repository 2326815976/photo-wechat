// app.js
const config = require("./config");
const { requestJson } = require("./utils/cloudrun");
const {
  buildRuntimeConfigPreset,
  normalizeRuntimeConfigPayload,
} = require("./utils/runtime-config");

const CLOUDRUN_HEALTH_ENDPOINT = "/api/health/ready";
const AUDIT_CONFIG_ENDPOINT = "/api/miniprogram/runtime-config";
const BACKEND_RETRY_INTERVAL_MS = 2500;
const BACKEND_HEALTH_TIMEOUT_MS = 12000;
const AUDIT_CONFIG_REQUEST_TIMEOUT_MS = 12000;
const RUNTIME_CONFIG_CACHE_KEY = "miniprogram-runtime-config-v1";
const AUDIT_CONFIG_REFRESH_TTL_MS = 15000;
const DEFAULT_SHARE_TITLE = "拾光谣小工具";
const DEFAULT_SHARE_IMAGE = "/images/share/shiguangyao-share.jpg";
const SHARE_TITLE_BY_ROUTE = {
  "pages/index/index": "拾光谣｜发现灵感摆姿，记录每一帧",
  "pages/gallery/index": "拾光谣｜定格美好瞬间",
  "pages/booking/index": "拾光谣｜预约拍摄入口，来定格你的故事",
  "pages/album/index": "拾光谣｜相册提取",
  "pages/album/detail": "「拾光谣」相册分享",
  "pages/profile/index": "拾光谣｜定格美好瞬间",
};

function decodeUrlQueryComponent(value) {
  const raw = String(value || "");
  if (!raw) return "";
  try {
    return decodeURIComponent(raw.replace(/\+/g, "%20"));
  } catch (error) {
    return raw;
  }
}

function createURLSearchParamsPolyfill() {
  function MiniProgramURLSearchParams(init) {
    this._entries = [];

    const appendEntry = (key, value) => {
      const normalizedKey = String(key || "").trim();
      if (!normalizedKey) return;
      this._entries.push([normalizedKey, String(value == null ? "" : value)]);
    };

    if (typeof init === "string") {
      String(init || "")
        .trim()
        .replace(/^\?/, "")
        .split("&")
        .forEach((segment) => {
          if (!segment) return;
          const [rawKey, ...valueParts] = segment.split("=");
          const key = decodeUrlQueryComponent(rawKey);
          if (!key) return;
          appendEntry(key, decodeUrlQueryComponent(valueParts.join("=")));
        });
      return;
    }

    if (Array.isArray(init)) {
      init.forEach((item) => {
        if (!Array.isArray(item) || item.length < 1) return;
        appendEntry(item[0], item.length > 1 ? item[1] : "");
      });
      return;
    }

    if (init && typeof init === "object") {
      Object.keys(init).forEach((key) => {
        appendEntry(key, init[key]);
      });
    }
  }

  MiniProgramURLSearchParams.prototype.append = function append(key, value) {
    this._entries.push([String(key || "").trim(), String(value == null ? "" : value)]);
  };

  MiniProgramURLSearchParams.prototype.get = function get(key) {
    const normalizedKey = String(key || "").trim();
    for (let index = 0; index < this._entries.length; index += 1) {
      const item = this._entries[index];
      if (item && item[0] === normalizedKey) {
        return item[1];
      }
    }
    return null;
  };

  MiniProgramURLSearchParams.prototype.set = function set(key, value) {
    const normalizedKey = String(key || "").trim();
    const normalizedValue = String(value == null ? "" : value);
    let replaced = false;
    this._entries = this._entries.reduce((list, item) => {
      if (!item || item[0] !== normalizedKey) {
        list.push(item);
        return list;
      }
      if (!replaced) {
        list.push([normalizedKey, normalizedValue]);
        replaced = true;
      }
      return list;
    }, []);
    if (!replaced) {
      this._entries.push([normalizedKey, normalizedValue]);
    }
  };

  MiniProgramURLSearchParams.prototype.toString = function toString() {
    return this._entries
      .filter((item) => item && item[0])
      .map((item) => `${encodeURIComponent(item[0])}=${encodeURIComponent(String(item[1] || ""))}`)
      .join("&");
  };

  return MiniProgramURLSearchParams;
}

function installURLSearchParamsPolyfill() {
  if (typeof URLSearchParams !== "undefined") {
    return;
  }
  const Polyfill = createURLSearchParamsPolyfill();
  try {
    if (typeof globalThis !== "undefined" && globalThis) {
      globalThis.URLSearchParams = Polyfill;
    }
  } catch (error) {
    // ignore global assignment errors
  }
  try {
    if (typeof global !== "undefined" && global) {
      global.URLSearchParams = Polyfill;
    }
  } catch (error) {
    // ignore global assignment errors
  }
}

installURLSearchParamsPolyfill();

function loadCachedRuntimeConfig() {
  try {
    const raw = wx.getStorageSync(RUNTIME_CONFIG_CACHE_KEY);
    if (!raw) return null;
    const payload = typeof raw === "string" ? JSON.parse(raw) : raw;
    return normalizeRuntimeConfigPayload(payload);
  } catch (error) {
    return null;
  }
}

function saveCachedRuntimeConfig(runtimeConfig) {
  try {
    wx.setStorageSync(RUNTIME_CONFIG_CACHE_KEY, JSON.stringify(runtimeConfig));
  } catch (error) {
    // ignore cache errors
  }
}

function isDevtoolsEnvironment() {
  try {
    if (wx && typeof wx.getDeviceInfo === "function") {
      const deviceInfo = wx.getDeviceInfo();
      return String((deviceInfo && deviceInfo.platform) || "").toLowerCase() === "devtools";
    }
    if (wx && typeof wx.getSystemInfoSync === "function") {
      const systemInfo = wx.getSystemInfoSync();
      return String((systemInfo && systemInfo.platform) || "").toLowerCase() === "devtools";
    }
  } catch (error) {
    return false;
  }
  return false;
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
  if (isDevtoolsEnvironment()) {
    return;
  }

  const invokeShareMenu = (options, onRejected) => {
    try {
      const result = wx.showShareMenu(options);
      if (result && typeof result.catch === "function") {
        result.catch((error) => {
          if (typeof onRejected === "function") {
            onRejected(error);
          }
        });
      }
      return true;
    } catch (error) {
      if (typeof onRejected === "function") {
        onRejected(error);
      }
      return false;
    }
  };

  const fallback = () => {
    invokeShareMenu({ withShareTicket: true });
  };

  try {
    const triggered = invokeShareMenu({
      withShareTicket: true,
      menus: ["shareAppMessage", "shareTimeline"],
    }, fallback);
    if (triggered) {
      return;
    }
  } catch (error) {
    // ignore and fallback
  }

  try {
    fallback();
  } catch (error) {
    // ignore
  }
}

function sleep(ms) {
  const delay = Math.max(0, Number(ms || 0));
  if (!delay) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, delay);
  });
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

function normalizeMiniProgramRoutePath(value) {
  return String(value || "")
    .trim()
    .split("?")[0]
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function resolvePresentationFallbackRoute(mode, value) {
  const fallbackRoute = String(value || "").trim();
  if (fallbackRoute) {
    return fallbackRoute;
  }
  return mode === "beta" ? "/pages/profile/beta/index" : "";
}

function resolvePresentationFallbackTab(mode, value) {
  const fallbackTab = normalizeMiniProgramRoutePath(value);
  if (fallbackTab) {
    return fallbackTab;
  }
  return mode === "beta" ? "pages/profile/index" : "pages/index/index";
}

function normalizePagePresentation(input) {
  const current = input && typeof input === "object" ? input : {};
  const rawMode = String(current.mode || "").trim().toLowerCase();
  const mode = rawMode === "preview" ? "preview" : rawMode === "beta" ? "beta" : "tabbar";
  return {
    mode,
    pageKey: String(current.pageKey || "").trim(),
    routePath: normalizeMiniProgramRoutePath(current.routePath),
    fallbackRoute: resolvePresentationFallbackRoute(mode, current.fallbackRoute),
    fallbackTab: resolvePresentationFallbackTab(mode, current.fallbackTab),
  };
}

function isSamePagePresentation(left, right) {
  const current = normalizePagePresentation(left);
  const next = normalizePagePresentation(right);
  return (
    current.mode === next.mode &&
    current.pageKey === next.pageKey &&
    current.routePath === next.routePath &&
    current.fallbackRoute === next.fallbackRoute &&
    current.fallbackTab === next.fallbackTab
  );
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
  auditConfigFetchedAt: 0,
  runtimeConfigListeners: [],
  backendReadyPromise: null,
  backendStatusListeners: [],
  pagePresentationListeners: [],
  globalData: {
    // 云环境、云托管与后端连通性相关状态
    // 供页面与网络层共享，避免重复探测后端可用性
    env: config.cloudbaseEnvId,
    cloudRunService: config.cloudRunService,
    cloudRunServiceInferred: Boolean(config.cloudRunServiceInferred),
    cloudRunServiceSource: String(config.cloudRunServiceSource || ""),
    appUrl: config.appUrl,
    cloudRunBaseUrl: config.cloudRunBaseUrl,
    debugRequests: Boolean(config.debugRequests),
    cloudRunReachable: null,
    cloudRunLastError: "",
    backendReady: false,
    backendReconnecting: false,
    backendRetryCount: 0,
    backendLastError: "",
    storageDomain: config.storageDomain,

    // 小程序设备窗口信息
    statusBarHeight: 0,
    safeArea: null,

    // 统一运行时配置
    runtimeConfig: buildRuntimeConfigPreset("standard"),
    auditConfigReady: false,
    betaFeatureBypassRoute: "",
    betaFeatureBypassExpiresAt: 0,
    appEnterSeq: 0,
    appEnteredAt: 0,
    pagePresentation: normalizePagePresentation(),
  },

  onShow() {
    const currentSeq = Math.max(0, Number((this.globalData && this.globalData.appEnterSeq) || 0));
    const nextSeq = currentSeq + 1;
    this.globalData.appEnterSeq = nextSeq;
    this.globalData.appEnteredAt = Date.now();
  },

  notifyBackendStatusChange() {
    const listeners = Array.isArray(this.backendStatusListeners)
      ? this.backendStatusListeners.slice()
      : [];
    const payload = {
      backendReady: Boolean(this.globalData && this.globalData.backendReady),
      backendReconnecting: Boolean(this.globalData && this.globalData.backendReconnecting),
      backendRetryCount: Math.max(0, Number((this.globalData && this.globalData.backendRetryCount) || 0)),
      backendLastError: String((this.globalData && this.globalData.backendLastError) || ""),
    };
    listeners.forEach((listener) => {
      if (typeof listener !== "function") return;
      try {
        listener(payload);
      } catch (error) {
        // ignore listener errors
      }
    });
  },

  subscribeBackendStatus(listener) {
    if (typeof listener !== "function") {
      return () => {};
    }
    if (!Array.isArray(this.backendStatusListeners)) {
      this.backendStatusListeners = [];
    }
    this.backendStatusListeners.push(listener);

    try {
      listener({
        backendReady: Boolean(this.globalData && this.globalData.backendReady),
        backendReconnecting: Boolean(this.globalData && this.globalData.backendReconnecting),
        backendRetryCount: Math.max(0, Number((this.globalData && this.globalData.backendRetryCount) || 0)),
        backendLastError: String((this.globalData && this.globalData.backendLastError) || ""),
      });
    } catch (error) {
      // ignore listener errors
    }

    return () => {
      const rows = Array.isArray(this.backendStatusListeners)
        ? this.backendStatusListeners
        : [];
      this.backendStatusListeners = rows.filter((item) => item !== listener);
    };
  },

  setBackendStatus(patch) {
    const next = patch && typeof patch === "object" ? patch : {};
    const backendReady = Object.prototype.hasOwnProperty.call(next, "backendReady")
      ? Boolean(next.backendReady)
      : Boolean(this.globalData.backendReady);
    const backendReconnecting = Object.prototype.hasOwnProperty.call(next, "backendReconnecting")
      ? Boolean(next.backendReconnecting)
      : Boolean(this.globalData.backendReconnecting);
    const backendRetryCount = Object.prototype.hasOwnProperty.call(next, "backendRetryCount")
      ? Math.max(0, Number(next.backendRetryCount || 0))
      : Math.max(0, Number(this.globalData.backendRetryCount || 0));
    const backendLastError = Object.prototype.hasOwnProperty.call(next, "backendLastError")
      ? String(next.backendLastError || "")
      : String(this.globalData.backendLastError || "");

    if (
      backendReady === Boolean(this.globalData.backendReady) &&
      backendReconnecting === Boolean(this.globalData.backendReconnecting) &&
      backendRetryCount === Math.max(0, Number(this.globalData.backendRetryCount || 0)) &&
      backendLastError === String(this.globalData.backendLastError || "")
    ) {
      return;
    }

    this.globalData.backendReady = backendReady;
    this.globalData.backendReconnecting = backendReconnecting;
    this.globalData.backendRetryCount = backendRetryCount;
    this.globalData.backendLastError = backendLastError;
    this.globalData.cloudRunReachable = backendReady;
    this.globalData.cloudRunLastError = backendLastError;
    this.notifyBackendStatusChange();
  },

  async ensureBackendReady() {
    const service = String((this.globalData && this.globalData.cloudRunService) || "").trim();
    if (!service) {
      this.setBackendStatus({
        backendReady: true,
        backendReconnecting: false,
        backendRetryCount: 0,
        backendLastError: "",
      });
      return true;
    }

    if (this.globalData.backendReady) {
      return true;
    }

    if (this.backendReadyPromise) {
      return this.backendReadyPromise;
    }

    this.setBackendStatus({
      backendReady: false,
      backendReconnecting: true,
    });

    this.backendReadyPromise = (async () => {
      let attempts = Math.max(0, Number(this.globalData.backendRetryCount || 0));
      while (true) {
        attempts += 1;
        try {
          await requestJson(CLOUDRUN_HEALTH_ENDPOINT, {
            method: "GET",
            timeout: BACKEND_HEALTH_TIMEOUT_MS,
            disableBackendRecovery: true,
            skipBackendReadyGate: true,
          });
          this.setBackendStatus({
            backendReady: true,
            backendReconnecting: false,
            backendRetryCount: attempts,
            backendLastError: "",
          });
          return true;
        } catch (error) {
          this.setBackendStatus({
            backendReady: false,
            backendReconnecting: true,
            backendRetryCount: attempts,
            backendLastError: String((error && error.message) || "服务暂不可用"),
          });
          await sleep(BACKEND_RETRY_INTERVAL_MS);
        }
      }
    })()
      .finally(() => {
        this.backendReadyPromise = null;
      });

    return this.backendReadyPromise;
  },

  applyRuntimeConfig(runtimeConfig, options) {
    const normalized = normalizeRuntimeConfigPayload(runtimeConfig);
    const markReady =
      !options || !Object.prototype.hasOwnProperty.call(options, "markReady")
        ? true
        : Boolean(options.markReady);
    this.globalData.runtimeConfig = normalized;
    this.globalData.auditConfigReady = markReady;
    if (markReady && (!options || options.markFetchedAt !== false)) {
      this.auditConfigFetchedAt = Date.now();
    }

    if (!options || options.persistCache !== false) {
      saveCachedRuntimeConfig(normalized);
    }

    if ((!options || options.notify !== false) && markReady) {
      this.notifyRuntimeConfigChange(normalized);
    }

    return normalized;
  },

  notifyRuntimeConfigChange(runtimeConfig) {
    const listeners = Array.isArray(this.runtimeConfigListeners)
      ? this.runtimeConfigListeners.slice()
      : [];
    listeners.forEach((listener) => {
      if (typeof listener !== "function") return;
      try {
        listener(runtimeConfig);
      } catch (error) {
        // ignore listener errors
      }
    });
  },

  subscribeMiniProgramRuntimeConfig(listener) {
    if (typeof listener !== "function") {
      return () => {};
    }

    if (!Array.isArray(this.runtimeConfigListeners)) {
      this.runtimeConfigListeners = [];
    }
    this.runtimeConfigListeners.push(listener);

    if (this.globalData && this.globalData.auditConfigReady) {
      try {
        listener(this.globalData.runtimeConfig || buildRuntimeConfigPreset("standard"));
      } catch (error) {
        // ignore listener errors
      }
    }

    return () => {
      const rows = Array.isArray(this.runtimeConfigListeners)
        ? this.runtimeConfigListeners
        : [];
      this.runtimeConfigListeners = rows.filter((item) => item !== listener);
    };
  },

  notifyPagePresentationChange() {
    const listeners = Array.isArray(this.pagePresentationListeners)
      ? this.pagePresentationListeners.slice()
      : [];
    const payload = this.getPagePresentation();
    listeners.forEach((listener) => {
      if (typeof listener !== "function") return;
      try {
        listener(payload);
      } catch (error) {
        // ignore listener errors
      }
    });
  },

  subscribePagePresentation(listener) {
    if (typeof listener !== "function") {
      return () => {};
    }

    if (!Array.isArray(this.pagePresentationListeners)) {
      this.pagePresentationListeners = [];
    }
    this.pagePresentationListeners.push(listener);

    try {
      listener(this.getPagePresentation());
    } catch (error) {
      // ignore listener errors
    }

    return () => {
      const rows = Array.isArray(this.pagePresentationListeners)
        ? this.pagePresentationListeners
        : [];
      this.pagePresentationListeners = rows.filter((item) => item !== listener);
    };
  },

  getPagePresentation() {
    if (!this.globalData) {
      return normalizePagePresentation();
    }
    this.globalData.pagePresentation = normalizePagePresentation(this.globalData.pagePresentation);
    return this.globalData.pagePresentation;
  },

  setPagePresentation(presentation, options) {
    if (!this.globalData) {
      this.globalData = {};
    }
    const opts = options && typeof options === "object" ? options : {};
    const nextPresentation = normalizePagePresentation(presentation);
    const currentPresentation = normalizePagePresentation(this.globalData.pagePresentation);
    if (isSamePagePresentation(currentPresentation, nextPresentation)) {
      this.globalData.pagePresentation = currentPresentation;
      return currentPresentation;
    }
    this.globalData.pagePresentation = nextPresentation;
    if (!opts.silent) {
      this.notifyPagePresentationChange();
    }
    return this.globalData.pagePresentation;
  },

  resetPagePresentation(options) {
    return this.setPagePresentation(
      { mode: "tabbar", fallbackTab: "pages/index/index" },
      options
    );
  },
  ensureAuditConfig() {
    if (this.auditConfigPromise) {
      return this.auditConfigPromise;
    }

    const lastFetchedAt = Math.max(0, Number(this.auditConfigFetchedAt || 0));
    const canReuseCurrent =
      Boolean(this.globalData && this.globalData.auditConfigReady && this.globalData.runtimeConfig) &&
      Date.now() - lastFetchedAt < AUDIT_CONFIG_REFRESH_TTL_MS;
    if (canReuseCurrent) {
      return Promise.resolve(this.globalData.runtimeConfig);
    }

    const service = String((this.globalData && this.globalData.cloudRunService) || "").trim();
    if (!service) {
      const cached = loadCachedRuntimeConfig();
      const fallback = cached || buildRuntimeConfigPreset("standard");
      const applied = this.applyRuntimeConfig(fallback, {
        notify: true,
        persistCache: Boolean(cached),
        markFetchedAt: Boolean(cached),
        markReady: Boolean(cached),
      });
      this.auditConfigPromise = Promise.resolve(applied).finally(() => {
        this.auditConfigPromise = null;
      });
      return this.auditConfigPromise;
    }

    this.auditConfigPromise = requestJson(AUDIT_CONFIG_ENDPOINT, {
      method: "GET",
      timeout: AUDIT_CONFIG_REQUEST_TIMEOUT_MS,
    })
      .then((payload) => {
        const runtimeConfig = normalizeRuntimeConfigPayload(payload);
        return this.applyRuntimeConfig(runtimeConfig, { notify: true, persistCache: true });
      })
      .catch((error) => {
        const cached = loadCachedRuntimeConfig();
        const fallback = cached || buildRuntimeConfigPreset("standard");
        const applied = this.applyRuntimeConfig(fallback, {
          notify: true,
          persistCache: Boolean(cached),
          markFetchedAt: Boolean(cached),
          markReady: Boolean(cached),
        });

        try {
          console.warn(
            `[Audit 配置获取失败] error=${String((error && error.message) || "unknown")}`
          );
        } catch (_) {
          // ignore log error
        }
        return applied;
      })
      .finally(() => {
        this.auditConfigPromise = null;
      });

    return this.auditConfigPromise;
  },

  onLaunch: function () {
    const cachedRuntimeConfig = loadCachedRuntimeConfig();
    const bootRuntimeConfig = cachedRuntimeConfig || buildRuntimeConfigPreset("standard");
    this.applyRuntimeConfig(bootRuntimeConfig, {
      notify: false,
      persistCache: Boolean(cachedRuntimeConfig),
      markFetchedAt: Boolean(cachedRuntimeConfig),
      markReady: Boolean(cachedRuntimeConfig),
    });

    try {
      const windowInfo = wx.getWindowInfo();
      this.globalData.statusBarHeight = Number(windowInfo.statusBarHeight || 0);
      this.globalData.safeArea = windowInfo.safeArea || null;
    } catch (e) {
      // ignore
    }

    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
      const fallback = cachedRuntimeConfig || buildRuntimeConfigPreset("standard");
      const applied = this.applyRuntimeConfig(fallback, {
        notify: true,
        persistCache: Boolean(cachedRuntimeConfig),
        markFetchedAt: Boolean(cachedRuntimeConfig),
        markReady: Boolean(cachedRuntimeConfig),
      });
      this.auditConfigPromise = Promise.resolve(applied);
      return;
    }

    wx.cloud.init({
      env: this.globalData.env,
      traceUser: true,
    });

    if (this.globalData.cloudRunServiceInferred) {
      console.warn(
        `[CloudRun 配置提醒] 当前 cloudRunService 来源为推断值（${this.globalData.cloudRunService}），建议在 photo/.env.local 中显式配置 MINIPROGRAM_CLOUDRUN_SERVICE。`
      );
    }
    if (this.globalData.cloudRunService) {
      this.setBackendStatus({
        backendReady: false,
        backendReconnecting: false,
        backendRetryCount: 0,
        backendLastError: "",
      });
    } else {
      this.setBackendStatus({
        backendReady: true,
        backendReconnecting: false,
        backendRetryCount: 0,
        backendLastError: "",
      });
    }

    if (typeof this.ensureAuditConfig === "function") {
      this.ensureAuditConfig().catch(() => {});
    }
  },
});

