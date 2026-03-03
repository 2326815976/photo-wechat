const { dbRpc, getSession, extractSessionUser } = require("../../../services/photo-api");

const TAB_PAGE_SET = new Set([
  "/pages/index/index",
  "/pages/album/index",
  "/pages/gallery/index",
  "/pages/booking/index",
  "/pages/profile/index",
]);

const ROUTE_ALIAS_MAP = {
  "/pose": "/pages/index/index",
  "/poses": "/pages/index/index",
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
    if (message) return message;
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return String(fallback || "操作失败");
}

function readRpcResultError(result, fallback) {
  if (!result || !result.error) return "";
  if (typeof result.error === "string" && result.error.trim()) {
    return result.error.trim();
  }
  if (result.error && typeof result.error === "object") {
    const message = String(result.error.message || "").trim();
    if (message) return message;
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
  const raw = String(rawRoutePath || "").trim();
  if (!raw) return false;
  const lowered = raw.toLowerCase();
  if (lowered === "/pose" || lowered === "/poses") {
    return true;
  }
  const normalized = normalizeFeatureRoutePath(raw).toLowerCase();
  return normalized === "/pages/index/index";
}

function setPoseBypassIfNeeded(rawRoutePath) {
  if (!isPoseFeatureRoute(rawRoutePath)) {
    return;
  }

  const app = typeof getApp === "function" ? getApp() : null;
  if (!app || !app.globalData) return;

  app.globalData.betaFeatureBypassRoute = "/pose";
  app.globalData.betaFeatureBypassExpiresAt = Date.now() + 90 * 1000;
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
    const app = getApp();
    const globalData = app && app.globalData ? app.globalData : {};
    this.setData({
      safeTop: Number(globalData.statusBarHeight || 0),
      hideAudit: Boolean(globalData.hideAudit),
    });
  },

  onShow() {
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
      return {
        id,
        feature_name: String((row && row.feature_name) || "").trim(),
        feature_description: String((row && row.feature_description) || "").trim(),
        feature_code: String((row && row.feature_code) || "").trim(),
        route_path_raw: routePathRaw,
        route_path: normalizeFeatureRoutePath(routePathRaw),
        route_title: String((row && row.route_title) || "").trim(),
        route_description: String((row && row.route_description) || "").trim(),
        bound_at: String((row && row.bound_at) || "").trim(),
        expires_at: expiresAt,
        expires_text: expiresAt ? `有效期至：${expiresAt}` : "有效期：长期有效",
      };
    }).filter((row) => row.id);

    this.setData({
      loading: false,
      featureRows,
    });
  },

  onCodeInput(e) {
    const value = e && e.detail ? String(e.detail.value || "") : "";
    this.setData({ codeInput: value });
  },

  onPasteCode() {
    wx.getClipboardData({
      success: (res) => {
        const text = String((res && res.data) || "").trim().slice(0, 64);
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
    const code = String(this.data.codeInput || "").trim();
    if (!code) {
      wx.showToast({ title: "请输入内测码", icon: "none" });
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
