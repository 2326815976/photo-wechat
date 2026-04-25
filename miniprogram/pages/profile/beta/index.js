const { getSession, extractSessionUser, requestJson } = require("../../../services/photo-api");
const {
  isTabBarPagePath,
  normalizeRuntimeConfig,
} = require("../../../utils/runtime-config");
const { guardMiniProgramPageAccess } = require("../../../utils/page-access");

const POSE_FEATURE_ID = "pose";
const POSE_BETA_ROUTE = "/pages/profile/beta/pose/index";

const ROUTE_ALIAS_MAP = {
  "/pose": "/pages/profile/beta/pose/index",
  "/poses": "/pages/profile/beta/pose/index",
  "/gallery": "/pages/gallery/index",
  "/album": "/pages/album/index",
  "/extract": "/pages/album/index",
  "/about": "/pages/profile/about/index",
  "/profile": "/pages/profile/index",
  "/booking": "/pages/booking/index",
  "/admin": "/pages/admin/index",
};

function extractErrorText(error) {
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  if (!error || typeof error !== "object") {
    return "";
  }

  const nestedError = error.error && typeof error.error === "object" ? error.error : null;
  const candidates = [
    error.message,
    error.errMsg,
    error.reason,
    nestedError && nestedError.message,
    typeof error.error === "string" ? error.error : "",
  ];

  for (let index = 0; index < candidates.length; index += 1) {
    const value = String(candidates[index] || "").trim();
    if (value) {
      return value;
    }
  }

  return "";
}

function toErrorMessage(error, fallback) {
  const message = extractErrorText(error);
  if (message) {
    return normalizeRpcErrorMessage(message);
  }
  return String(fallback || "操作失败");
}

function normalizeRpcErrorMessage(message) {
  const text = String(message || "").trim();
  if (!text) return "";
  const lowerText = text.toLowerCase();
  if (text.includes("未实现的 RPC")) {
    return "后端服务版本过旧，请先发布 photo 服务最新版本";
  }
  if (
    text.includes("does not support the IS keyword") ||
    text.includes("IS keyword with the prepared statement setting turned ON") ||
    text.includes("InvalidParameter")
  ) {
    return "后端服务仍是旧版本（SQL 兼容逻辑未生效），请先发布 photo 最新后端到云托管 service：slogan";
  }
  if (
    lowerText.includes("webview count limit exceed") ||
    lowerText.includes("page stack depth exceed") ||
    (lowerText.includes("page stack") && lowerText.includes("exceed")) ||
    lowerText.includes("limit exceed")
  ) {
    return "页面层级过深，已无法继续压栈，请返回上一页后重试";
  }
  if (lowerText.includes("is not found") && lowerText.includes("page")) {
    return "目标内测页面未注册，请重新编译小程序后重试";
  }
  if (
    lowerText.includes("script error") ||
    lowerText.includes("component is not found") ||
    lowerText.includes("failed to load page")
  ) {
    return "目标内测页面加载失败，请重新编译小程序后重试";
  }
  return text;
}

function readRpcResultError(result, fallback) {
  if (!result || !result.error) return "";
  if (typeof result.error === "string" && result.error.trim()) {
    return normalizeRpcErrorMessage(result.error.trim());
  }
  if (result.error && typeof result.error === "object") {
    const message = String(result.error.message || "").trim();
    if (message) return normalizeRpcErrorMessage(message);
  }
  return String(fallback || "请求失败");
}

function readArrayFromPayloadChain(payload) {
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (Array.isArray(current)) return current;
    if (!current || typeof current !== "object") break;

    if (Array.isArray(current.rows)) return current.rows;
    if (Array.isArray(current.list)) return current.list;
    if (Array.isArray(current.items)) return current.items;
    if (Array.isArray(current.data)) return current.data;

    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }
  return [];
}

function normalizeFeatureRoutePath(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";

  if (raw.startsWith("/pages/")) {
    return raw;
  }
  if (raw.startsWith("pages/")) {
    return `/${raw}`;
  }

  const lower = raw.toLowerCase();
  if (ROUTE_ALIAS_MAP[lower]) {
    return ROUTE_ALIAS_MAP[lower];
  }

  if (raw.startsWith("/")) {
    return raw;
  }

  return `/${raw}`;
}

function parseRoutePathAndQuery(url) {
  const normalized = String(url || "").trim();
  if (!normalized) {
    return { path: "", fullPath: "", query: "" };
  }
  const [path, query = ""] = normalized.split("?");
  return {
    path: path || normalized,
    fullPath: normalized,
    query,
  };
}

function decodeQueryValue(value) {
  const raw = String(value || "");
  if (!raw) return "";
  try {
    return decodeURIComponent(raw.replace(/\+/g, "%20"));
  } catch (error) {
    return raw;
  }
}

function parseQueryString(query) {
  const output = {};
  const normalized = String(query || "").trim().replace(/^\?/, "");
  if (!normalized) {
    return output;
  }

  normalized.split("&").forEach((segment) => {
    if (!segment) return;
    const [rawKey, ...valueParts] = segment.split("=");
    const key = decodeQueryValue(rawKey);
    if (!key) return;
    output[key] = decodeQueryValue(valueParts.join("="));
  });

  return output;
}

function stringifyQueryString(params) {
  return Object.keys(params || {}).reduce((parts, key) => {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) {
      return parts;
    }
    const value = params[key];
    if (value === undefined || value === null) {
      return parts;
    }
    const normalizedValue = String(value).trim();
    if (!normalizedValue) {
      return parts;
    }
    parts.push(`${encodeURIComponent(normalizedKey)}=${encodeURIComponent(normalizedValue)}`);
    return parts;
  }, []).join("&");
}

function attachBetaFallbackQuery(url, featureId) {
  const parsed = parseRoutePathAndQuery(url);
  if (!parsed.path) {
    return "";
  }

  const params = parseQueryString(parsed.query);
  const mode = String(params.presentation || "").trim().toLowerCase();
  if (mode !== "beta" && mode !== "preview") {
    return parsed.fullPath;
  }

  const pageKey = String(featureId || "").trim();
  if (pageKey && !String(params.page_key || "").trim()) {
    params.page_key = pageKey;
  }
  if (!String(params.fallback_route || "").trim()) {
    params.fallback_route = "/pages/profile/beta/index";
  }
  if (!String(params.fallback_tab || "").trim()) {
    params.fallback_tab = "pages/profile/index";
  }

  const query = stringifyQueryString(params);
  return query ? `${parsed.path}?${query}` : parsed.path;
}

function shouldRetryRouteWithRedirect(error) {
  const lowerMessage = extractErrorText(error).toLowerCase();
  return (
    lowerMessage.includes("webview count limit exceed") ||
    lowerMessage.includes("page stack depth exceed") ||
    (lowerMessage.includes("page stack") && lowerMessage.includes("exceed")) ||
    lowerMessage.includes("limit exceed")
  );
}

function buildNavigationError(error, fallback) {
  const wrapped = new Error(extractErrorText(error) || String(fallback || "页面跳转失败"));
  if (error && typeof error === "object") {
    wrapped.errMsg = String(error.errMsg || "").trim();
    wrapped.code = String(error.code || "").trim();
  }
  return wrapped;
}

function isPoseFeatureRoute(rawRoutePath) {
  const raw = String(rawRoutePath || "")
    .trim()
    .split("?")[0]
    .replace(/\/+$/, "");
  if (!raw) return false;
  const lowered = raw.toLowerCase();
  if (lowered === "/pose" || lowered === "/poses") {
    return true;
  }
  const normalized = normalizeFeatureRoutePath(raw)
    .toLowerCase()
    .split("?")[0]
    .replace(/\/+$/, "");
  return normalized === "/pages/index/index" || normalized === "/pages/profile/beta/pose/index";
}

function resolveFeatureEntryRoute(featureId, rawRoutePath) {
  const normalizedFeatureId = String(featureId || "").trim().toLowerCase();
  if (normalizedFeatureId === POSE_FEATURE_ID || isPoseFeatureRoute(rawRoutePath)) {
    return POSE_BETA_ROUTE;
  }
  return normalizeFeatureRoutePath(rawRoutePath);
}

function normalizeBetaFeatureCode(input) {
  return String(input || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
}

function formatFeatureExpiresAt(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) return "";

  const normalized = raw
    .replace("T", " ")
    .replace(/\.\d+Z$/i, "")
    .replace(/Z$/i, "")
    .replace(/([+-]\d{2}:\d{2})$/i, "")
    .replace(/\.\d+$/i, "")
    .trim();

  const directDate = normalized.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (directDate) {
    return `${directDate[1]}-${directDate[2]}-${directDate[3]}`;
  }

  const parsed = new Date(normalized || raw);
  if (Number.isNaN(parsed.getTime())) return "";
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function prepareFeaturePresentation(featureId, routePath) {
  const app = typeof getApp === "function" ? getApp() : null;
  if (!app || typeof app.setPagePresentation !== "function") return;

  const { path } = parseRoutePathAndQuery(routePath);
  const normalizedRoute = String(path || "").trim().replace(/^\/+/, "");
  if (!normalizedRoute) return;

  app.setPagePresentation({
    mode: "beta",
    pageKey: String(featureId || "").trim(),
    routePath: normalizedRoute,
    fallbackRoute: "/pages/profile/beta/index",
    fallbackTab: "pages/profile/index",
  });
}

function openRoute(url) {
  const target = String(url || "").trim();
  if (!target) {
    return Promise.reject(new Error("功能路由未配置"));
  }

  const { path, fullPath } = parseRoutePathAndQuery(target);
  const app = typeof getApp === "function" ? getApp() : null;
  const runtimeConfig = app && app.globalData ? app.globalData.runtimeConfig : null;
  if (isTabBarPagePath(path, runtimeConfig)) {
    return new Promise((resolve, reject) => {
      wx.switchTab({
        url: path,
        success: () => resolve(true),
        fail: (error) => reject(buildNavigationError(error, `页面跳转失败：${path}`)),
      });
    });
  }

  return new Promise((resolve, reject) => {
    wx.navigateTo({
      url: fullPath,
      success: () => resolve(true),
      fail: (error) => {
        const message = extractErrorText(error).toLowerCase();
        if (message.includes("tabbar page") && path) {
          wx.switchTab({
            url: path,
            success: () => resolve(true),
            fail: (switchError) => reject(buildNavigationError(switchError, `页面跳转失败：${path}`)),
          });
          return;
        }
        if (shouldRetryRouteWithRedirect(error)) {
          wx.redirectTo({
            url: fullPath,
            success: () => resolve(true),
            fail: (redirectError) => reject(buildNavigationError(redirectError, `页面跳转失败：${fullPath}`)),
          });
          return;
        }
        reject(buildNavigationError(error, `页面跳转失败：${fullPath}`));
      },
    });
  });
}

async function enterFeatureRoute(featureId, routePathRaw) {
  const normalizedFeatureId = String(featureId || "").trim();
  const rawRoute = String(routePathRaw || "").trim();
  const resolvedRoute = resolveFeatureEntryRoute(normalizedFeatureId, rawRoute);
  const normalizedRoute = attachBetaFallbackQuery(
    resolvedRoute,
    normalizedFeatureId
  );
  if (!normalizedFeatureId) {
    throw new Error("缺少页面标识");
  }
  if (!normalizedRoute) {
    throw new Error("该功能未配置可访问路由");
  }

  prepareFeaturePresentation(normalizedFeatureId, normalizedRoute);
  await openRoute(normalizedRoute);
}

function readFeatureAccessDeniedMessage(payload, fallback) {
  const directMessage = extractErrorText(payload);
  if (directMessage) {
    return normalizeRpcErrorMessage(directMessage);
  }

  const reason = String((payload && payload.reason) || "").trim().toLowerCase();
  if (reason.startsWith("legacy_")) {
    return "当前小程序仅支持页面中心新体系，请先迁移旧内测数据。";
  }
  if (reason === "beta_disabled") {
    return "该页面当前未开放内测入口";
  }
  if (reason === "beta_service_unavailable") {
    return "页面内测服务暂不可用，请稍后重试";
  }
  if (reason === "forbidden") {
    return "当前账号未获得该内测功能权限";
  }
  if (reason === "unauthorized") {
    return "登录状态已失效，请重新登录后重试";
  }

  return String(fallback || "进入功能失败");
}

Page({
  data: {
    safeTop: 0,
    loading: true,
    isLoggedIn: false,
    codeInput: "",
    enterButtonText: "进入",
    enteringButtonText: "进入中...",
    unbindButtonText: "解绑",
    unbindingButtonText: "解绑中...",
    submitting: false,
    enteringFeatureId: "",
    unbindingFeatureId: "",
    unbindTargetFeature: null,
    featureRows: [],
  },

  applyRuntimeConfig(runtimeConfig) {
    return normalizeRuntimeConfig(runtimeConfig);
  },

  onLoad() {
    this._betaFeatureBootstrapped = false;
    this._lastSeenAppEnterSeq = 0;
    const app = getApp();
    const globalData = app && app.globalData ? app.globalData : {};
    this.setData({
      safeTop: Number(globalData.statusBarHeight || 0),
    });
    this.applyRuntimeConfig(globalData.runtimeConfig);
  },

  onShow() {
    const app = typeof getApp === "function" ? getApp() : null;
    if (app && typeof app.resetPagePresentation === "function") {
      app.resetPagePresentation();
    }
    const appEnterSeq = Math.max(0, Number(app && app.globalData ? app.globalData.appEnterSeq : 0));
    const lastSeenAppEnterSeq = Math.max(0, Number(this._lastSeenAppEnterSeq || 0));
    const hasNewAppEntry = appEnterSeq > lastSeenAppEnterSeq;
    this._lastSeenAppEnterSeq = Math.max(appEnterSeq, lastSeenAppEnterSeq);
    if (hasNewAppEntry && this._betaFeatureBootstrapped && !this.data.loading) {
      return;
    }
    this.bootstrap();
  },

  async bootstrap() {
    const app = typeof getApp === "function" ? getApp() : null;
    this.applyRuntimeConfig(
      app && app.globalData
        ? app.globalData.runtimeConfig
        : null
    );

    const accessResult = await guardMiniProgramPageAccess({
      pageKey: "profile-beta",
      fallbackTab: "pages/profile/index",
    });
    if (!accessResult.allowed) {
      return;
    }

    this.setData({ loading: true });

    let user = null;
    try {
      const session = await getSession();
      user = extractSessionUser(session);
    } catch (error) {
      user = null;
    }

    if (!user || !user.id) {
      this.setData({
        loading: false,
        isLoggedIn: false,
        featureRows: [],
      });
      return;
    }

    this.setData({
      isLoggedIn: true,
    });

    try {
      await this.loadFeatureRows();
    } catch (error) {
      this.setData({
        loading: false,
        featureRows: [],
      });
      wx.showToast({
        title: toErrorMessage(error, "加载内测功能失败"),
        icon: "none",
      });
    } finally {
      this._betaFeatureBootstrapped = true;
    }
  },

  redirectToProfileForWechatLogin() {
    if (this._redirectingToProfile) return;
    this._redirectingToProfile = true;
    wx.showToast({
      title: "请先在我的页完成微信登录",
      icon: "none",
    });
    wx.switchTab({
      url: "/pages/profile/index",
      complete: () => {
        this._redirectingToProfile = false;
      },
    });
  },

  async loadFeatureRows() {
    const payload = await requestJson("/api/page-center/beta/features?channel=miniprogram", {
      method: "GET",
      timeout: 10000,
    });
    if (!payload || payload.error) {
      throw new Error(String((payload && payload.error) || "加载内测功能失败"));
    }
    const rows = readArrayFromPayloadChain(payload.data || payload);
    const featureRows = rows.map((row) => {
      const id = String((row && row.feature_id) || "").trim();
      const routePathRaw = String((row && row.route_path) || "").trim();
      const resolvedRoutePath = resolveFeatureEntryRoute(id, routePathRaw);
      const expiresAt = String((row && row.expires_at) || "").trim();
      const expiresAtText = formatFeatureExpiresAt(expiresAt);
      const featureDescription = String((row && row.feature_description) || "").trim();
      return {
        id,
        feature_name: String((row && row.feature_name) || "").trim(),
        feature_description: featureDescription,
        feature_code: String((row && row.feature_code) || "").trim(),
        route_path_raw: resolvedRoutePath,
        route_path: resolvedRoutePath,
        route_title: String((row && row.route_title) || "").trim(),
        route_description: String((row && row.route_description) || "").trim(),
        bound_at: String((row && row.bound_at) || "").trim(),
        expires_at: expiresAt,
        expires_text: expiresAtText ? `有效期至：${expiresAtText}` : "有效期：长期有效",
      };
    }).filter((row) => row.id);

    this.setData({
      loading: false,
      featureRows,
    });
  },

  onCodeInput(e) {
    const value = normalizeBetaFeatureCode(e && e.detail ? String(e.detail.value || "") : "");
    this.setData({ codeInput: value });
  },

  onPasteCode() {
    wx.getClipboardData({
      success: (res) => {
        const text = normalizeBetaFeatureCode((res && res.data) || "");
        if (!text) {
          wx.showToast({ title: "剪贴板为空", icon: "none" });
          return;
        }
        this.setData({ codeInput: text });
        wx.showToast({ title: "已粘贴", icon: "none" });
      },
      fail: () => {
        wx.showToast({ title: "粘贴失败，请重试", icon: "none" });
      },
    });
  },

  async onBindCode() {
    if (this.data.submitting) return;
    const code = normalizeBetaFeatureCode(this.data.codeInput || "");
    if (!code) {
      wx.showToast({ title: "请输入内测码", icon: "none" });
      return;
    }
    if (code.length !== 8) {
      wx.showToast({ title: "内测码必须是 8 位大写字母或数字", icon: "none" });
      return;
    }

    this.setData({ submitting: true });
    try {
      const payload = await requestJson("/api/page-center/beta/bind", {
        method: "POST",
        data: { featureCode: code, channel: "miniprogram" },
        timeout: 10000,
      });
      if (!payload || payload.error) {
        throw new Error(String((payload && payload.error) || "绑定内测码失败"));
      }
      const data = payload && payload.data && typeof payload.data === "object" ? payload.data : {};
      const featureId = String(data.feature_id || data.page_key || "").trim();
      const routePathRaw = String(data.route_path || "").trim();
      this.setData({ codeInput: "" });
      if (featureId && routePathRaw) {
        await this.loadFeatureRows().catch(() => null);
        await enterFeatureRoute(featureId, routePathRaw);
        return;
      }

      await this.loadFeatureRows();
      wx.showToast({
        title: "内测功能绑定成功",
        icon: "none",
      });
    } catch (error) {
      wx.showToast({
        title: toErrorMessage(error, "绑定内测码失败"),
        icon: "none",
      });
    } finally {
      this.setData({ submitting: false });
    }
  },

  async onEnterFeature(e) {
    if (this.data.submitting || this.data.enteringFeatureId || this.data.unbindingFeatureId) return;
    const featureId =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!featureId) return;

    const target = (this.data.featureRows || []).find((row) => row.id === featureId);
    if (!target) return;

    this.setData({ enteringFeatureId: featureId });
    try {
      const payload = await requestJson(
        `/api/page-center/beta/check?page_key=${encodeURIComponent(featureId)}&channel=miniprogram`,
        {
          method: "GET",
          timeout: 10000,
        }
      );
      if (!payload || payload.error || payload.allowed !== true) {
        throw new Error(readFeatureAccessDeniedMessage(payload, "进入功能失败"));
      }
      const data = payload && payload.data && typeof payload.data === "object" ? payload.data : {};
      const routePathRaw = String(data.route_path || target.route_path_raw || "").trim();
      await enterFeatureRoute(featureId, routePathRaw);
    } catch (error) {
      wx.showToast({
        title: toErrorMessage(error, "进入功能失败"),
        icon: "none",
      });
      try {
        await this.loadFeatureRows();
      } catch (_) {
        // ignore
      }
    } finally {
      this.setData({ enteringFeatureId: "" });
    }
  },

  async onUnbindFeature(e) {
    if (this.data.submitting || this.data.enteringFeatureId || this.data.unbindingFeatureId) return;
    const featureId =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!featureId) return;

    const target = (this.data.featureRows || []).find((row) => row.id === featureId);
    if (!target) return;

    this.setData({ unbindTargetFeature: target });
  },

  cancelUnbindFeature() {
    if (this.data.unbindingFeatureId) return;
    this.setData({ unbindTargetFeature: null });
  },

  noop() {},

  async confirmUnbindFeature() {
    const target = this.data.unbindTargetFeature;
    if (!target || this.data.submitting || this.data.enteringFeatureId || this.data.unbindingFeatureId) return;

    const featureId = String(target.id || "").trim();
    if (!featureId) {
      this.setData({ unbindTargetFeature: null });
      return;
    }

    this.setData({ unbindingFeatureId: featureId });
    try {
      const payload = await requestJson(
        `/api/page-center/beta/bindings/${encodeURIComponent(featureId)}?channel=miniprogram`,
        {
          method: "DELETE",
          timeout: 10000,
        }
      );
      if (!payload || payload.error) {
        throw new Error(String((payload && payload.error) || "解绑内测功能失败"));
      }

      await this.loadFeatureRows();
      this.setData({ unbindTargetFeature: null });
      wx.showToast({
        title: "已解绑",
        icon: "none",
      });
    } catch (error) {
      this.setData({ unbindTargetFeature: null });
      wx.showToast({
        title: toErrorMessage(error, "解绑内测功能失败"),
        icon: "none",
      });
    } finally {
      this.setData({ unbindingFeatureId: "" });
    }
  },

  onGoLogin() {
    wx.switchTab({ url: "/pages/profile/index" });
  },
});
