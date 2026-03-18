const { dbRpc, getSession, extractSessionUser } = require("../../../services/photo-api");

const BETA_POSE_BYPASS_STORAGE_KEY = "beta_pose_bypass_until";

const TAB_PAGE_SET = new Set([
  "/pages/index/index",
  "/pages/album/index",
  "/pages/gallery/index",
  "/pages/booking/index",
  "/pages/profile/index",
]);

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

function toErrorMessage(error, fallback) {
  if (error && typeof error === "object") {
    const message = String(error.message || "").trim();
    if (message) return normalizeRpcErrorMessage(message);
  }
  if (typeof error === "string" && error.trim()) {
    return normalizeRpcErrorMessage(error.trim());
  }
  return String(fallback || "操作失败");
}

function normalizeRpcErrorMessage(message) {
  const text = String(message || "").trim();
  if (!text) return "";
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
    return { path: "", fullPath: "" };
  }
  const [path] = normalized.split("?");
  return {
    path: path || normalized,
    fullPath: normalized,
  };
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

function setPoseBypassIfNeeded(rawRoutePath) {
  if (!isPoseFeatureRoute(rawRoutePath)) {
    return;
  }

  const app = typeof getApp === "function" ? getApp() : null;
  if (!app || !app.globalData) return;

  app.globalData.betaFeatureBypassRoute = "/pose";
  app.globalData.betaFeatureBypassExpiresAt = Date.now() + 5 * 60 * 1000;
  try {
    wx.setStorageSync(BETA_POSE_BYPASS_STORAGE_KEY, app.globalData.betaFeatureBypassExpiresAt);
  } catch (error) {
    // ignore storage write errors
  }
}

function openRoute(url) {
  const target = String(url || "").trim();
  if (!target) {
    return Promise.reject(new Error("功能路由未配置"));
  }

  const { path, fullPath } = parseRoutePathAndQuery(target);
  if (TAB_PAGE_SET.has(path)) {
    return new Promise((resolve, reject) => {
      wx.switchTab({
        url: path,
        success: () => resolve(true),
        fail: (error) => reject(error),
      });
    });
  }

  return new Promise((resolve, reject) => {
    wx.navigateTo({
      url: fullPath,
      success: () => resolve(true),
      fail: (error) => {
        const message = String((error && error.errMsg) || "").toLowerCase();
        if (message.includes("tabbar page") && path) {
          wx.switchTab({
            url: path,
            success: () => resolve(true),
            fail: (switchError) => reject(switchError),
          });
          return;
        }
        reject(error);
      },
    });
  });
}

Page({
  data: {
    safeTop: 0,
    hideAudit: false,
    loading: true,
    isLoggedIn: false,
    codeInput: "",
    submitting: false,
    enteringFeatureId: "",
    featureRows: [],
  },

  onLoad() {
    this._betaFeatureBootstrapped = false;
    this._lastSeenAppEnterSeq = 0;
    const app = getApp();
    const globalData = app && app.globalData ? app.globalData : {};
    this.setData({
      safeTop: Number(globalData.statusBarHeight || 0),
      hideAudit: Boolean(globalData.hideAudit),
    });
  },

  onShow() {
    const app = typeof getApp === "function" ? getApp() : null;
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
    const hideAudit = Boolean(app && app.globalData && app.globalData.hideAudit);
    this.setData({ hideAudit });

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
      title: "请先在关于页完成微信登录",
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
    const result = await dbRpc("get_user_beta_features");
    const errorMessage = readRpcResultError(result, "加载内测功能失败");
    if (errorMessage) {
      throw new Error(errorMessage);
    }

    const payload = result ? result.data : null;
    const rows = readArrayFromPayloadChain(payload);
    const featureRows = rows.map((row) => {
      const id = String((row && row.feature_id) || "").trim();
      const routePathRaw = String((row && row.route_path) || "").trim();
      const expiresAt = String((row && row.expires_at) || "").trim();
      const expiresAtText = formatFeatureExpiresAt(expiresAt);
      const featureDescription = String((row && row.feature_description) || "").trim();
      return {
        id,
        feature_name: String((row && row.feature_name) || "").trim(),
        feature_description: featureDescription || "暂无功能简介",
        feature_code: String((row && row.feature_code) || "").trim(),
        route_path_raw: routePathRaw,
        route_path: normalizeFeatureRoutePath(routePathRaw),
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
      const result = await dbRpc("bind_user_to_beta_feature", {
        p_feature_code: code,
      });
      const errorMessage = readRpcResultError(result, "绑定内测码失败");
      if (errorMessage) {
        throw new Error(errorMessage);
      }

      const payload = result && result.data && typeof result.data === "object"
        ? result.data
        : {};
      const newlyBound = Boolean(payload.bound_newly);

      this.setData({ codeInput: "" });
      await this.loadFeatureRows();
      wx.showToast({
        title: newlyBound ? "内测功能绑定成功" : "该内测功能已绑定",
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
    if (this.data.submitting) return;
    const featureId =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!featureId) return;

    const target = (this.data.featureRows || []).find((row) => row.id === featureId);
    if (!target) return;

    this.setData({ enteringFeatureId: featureId });
    try {
      const result = await dbRpc("check_user_beta_feature_access", {
        p_feature_id: featureId,
      });
      const errorMessage = readRpcResultError(result, "校验内测权限失败");
      if (errorMessage) {
        throw new Error(errorMessage);
      }

      const payload = result && result.data && typeof result.data === "object"
        ? result.data
        : {};
      const routePathRaw = String(payload.route_path || target.route_path_raw || "").trim();
      const normalizedRoute = normalizeFeatureRoutePath(routePathRaw);
      if (!normalizedRoute) {
        throw new Error("该功能未配置可访问路由");
      }

      if (isPoseFeatureRoute(routePathRaw)) {
        await openRoute("/pages/profile/beta/pose/index");
        return;
      }

      setPoseBypassIfNeeded(routePathRaw);
      await openRoute(normalizedRoute);
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

  onGoLogin() {
    if (this.data.hideAudit) {
      this.redirectToProfileForWechatLogin();
      return;
    }
    wx.navigateTo({
      url: "/pages/login/index",
    });
  },
});
