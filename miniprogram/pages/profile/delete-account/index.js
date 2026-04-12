const { requestJson } = require("../../../utils/cloudrun");
const { clearStoredCookie } = require("../../../utils/auth");
const { getManagedPageAccess, normalizeRuntimeConfig } = require("../../../utils/runtime-config");
const { guardMiniProgramPageAccess } = require("../../../utils/page-access");

function readPayloadMessage(payload, fallback) {
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") break;
    const message = String(current.message || "").trim();
    if (message) return message;
    const error = current.error;
    if (typeof error === "string" && error.trim()) {
      return error.trim();
    }
    if (error && typeof error === "object") {
      const nested = String(error.message || "").trim();
      if (nested) return nested;
    }
    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }
  if (typeof payload === "string" && payload.trim()) {
    return payload.trim();
  }
  return String(fallback || "删除失败，请稍后重试");
}

function hasPayloadFailure(payload) {
  if (payload === false) return true;
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") break;
    if (current.error) return true;
    if (Object.prototype.hasOwnProperty.call(current, "success") && current.success === false) return true;
    if (Object.prototype.hasOwnProperty.call(current, "ok") && current.ok === false) return true;
    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }
  return false;
}

function readPayloadWarning(payload) {
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") break;
    const warning = String(current.warning || "").trim();
    if (warning) return warning;
    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }
  return "";
}

Page({
  data: {
    safeTop: 0,
    serviceMissing: false,
    hideAudit: false,
    managedTitle: "删除账户",

    showConfirm: false,
    isDeleting: false,
    error: "",
    showSuccess: false,
    postDeleteWarning: "",
  },

  applyRuntimeConfig(runtimeConfig) {
    const normalized = normalizeRuntimeConfig(runtimeConfig);
    const access = getManagedPageAccess(normalized, "profile-delete-account");
    this.setData({
      hideAudit: Boolean(normalized.hideAudit),
      managedTitle:
        String((access && (access.headerTitle || access.navText)) || "").trim() || "删除账户",
    });
    return normalized;
  },

  async onLoad() {
    const app = getApp();
    const globalData = app && app.globalData ? app.globalData : {};
    const safeTop = Number(globalData.statusBarHeight || 0);
    const serviceMissing = !String(globalData.cloudRunService || "").trim();
    this.setData({
      safeTop,
      serviceMissing,
    });
    this.applyRuntimeConfig(globalData.runtimeConfig || { hideAudit: globalData.hideAudit });

    if (app && typeof app.subscribeMiniProgramRuntimeConfig === "function") {
      this._unsubscribeAuditConfig = app.subscribeMiniProgramRuntimeConfig((runtimeConfig) => {
        this.applyRuntimeConfig(runtimeConfig);
      });
    }
    await this.guardManagedAccess();
  },

  async onShow() {
    await this.guardManagedAccess();
  },

  async guardManagedAccess() {
    const result = await guardMiniProgramPageAccess({
      pageKey: "profile-delete-account",
      fallbackTab: "pages/profile/index",
    });
    return !result.allowed;
  },

  onUnload() {
    if (typeof this._unsubscribeAuditConfig === "function") {
      this._unsubscribeAuditConfig();
    }
    this._unsubscribeAuditConfig = null;
  },

  goBack() {
    wx.navigateBack({
      delta: 1,
      fail: () => {
        wx.switchTab({ url: "/pages/profile/index" });
      },
    });
  },

  openConfirm() {
    this.setData({ showConfirm: true });
  },

  cancelConfirm() {
    this.setData({ showConfirm: false });
  },

  async submitDelete() {
    if (this.data.serviceMissing) return;
    if (this.data.isDeleting) return;

    this.setData({ isDeleting: true, error: "" });
    try {
      const res = await requestJson("/api/delete-account", {
        method: "POST",
        data: {},
      });

      if (hasPayloadFailure(res)) {
        this.setData({ error: readPayloadMessage(res, "删除失败，请稍后重试") });
        return;
      }

      clearStoredCookie();
      const warning = readPayloadWarning(res);
      this.setData({
        showSuccess: true,
        postDeleteWarning: warning,
      });
      setTimeout(() => {
        wx.reLaunch({ url: "/pages/index/index" });
      }, 3000);
    } catch (e) {
      this.setData({ error: "系统错误，请稍后重试" });
    } finally {
      this.setData({ isDeleting: false });
    }
  },
});
