const { getManagedPageAccess, normalizeRuntimeConfig } = require("../../../utils/runtime-config");
const { guardMiniProgramPageAccess } = require("../../../utils/page-access");

Page({
  data: {
    safeTop: 0,
    managedTitle: "重置密码",
    managedSubtitle: "当前版本使用手机号登录后在个人中心完成密码更新",
    loginEntryVisible: true,
    loginEntryLabel: "登录",
    forgotEntryVisible: true,
    forgotEntryLabel: "忘记密码",
  },

  applyRuntimeConfig(runtimeConfig) {
    const normalized = normalizeRuntimeConfig(runtimeConfig);
    const resetAccess = getManagedPageAccess(normalized, "reset-password");
    const loginAccess = getManagedPageAccess(normalized, "login");
    const forgotAccess = getManagedPageAccess(normalized, "forgot-password");
    this.setData({
      managedTitle:
        String((resetAccess && (resetAccess.headerTitle || resetAccess.navText)) || "").trim() ||
        "重置密码",
      managedSubtitle: "当前版本使用手机号登录后在个人中心完成密码更新",
      loginEntryVisible:
        Boolean(loginAccess) && String((loginAccess && loginAccess.publishState) || "").trim() === "online",
      loginEntryLabel:
        String((loginAccess && (loginAccess.navText || loginAccess.headerTitle)) || "").trim() || "登录",
      forgotEntryVisible:
        Boolean(forgotAccess) && String((forgotAccess && forgotAccess.publishState) || "").trim() === "online",
      forgotEntryLabel:
        String((forgotAccess && (forgotAccess.navText || forgotAccess.headerTitle)) || "").trim() ||
        "忘记密码",
    });
    return normalized;
  },

  async onLoad() {
    const app = getApp();
    const globalData = app && app.globalData ? app.globalData : {};
    this.setData({ safeTop: Number(globalData.statusBarHeight || 0) });
    this.applyRuntimeConfig(globalData.runtimeConfig || { hideAudit: globalData.hideAudit });

    if (app && typeof app.subscribeMiniProgramRuntimeConfig === "function") {
      this._unsubscribeAuditConfig = app.subscribeMiniProgramRuntimeConfig((runtimeConfig) => {
        this.applyRuntimeConfig(runtimeConfig);
      });
    }

    await this.guardManagedAccess();
  },

  async onShow() {
    const app = typeof getApp === "function" ? getApp() : null;
    if (app && typeof app.ensureAuditConfig === "function") {
      try {
        await app.ensureAuditConfig();
      } catch (error) {
        // ignore
      }
    }
    this.applyRuntimeConfig(
      app && app.globalData
        ? app.globalData.runtimeConfig || { hideAudit: app.globalData.hideAudit }
        : { hideAudit: false }
    );
    await this.guardManagedAccess();
  },

  onUnload() {
    if (typeof this._unsubscribeAuditConfig === "function") {
      this._unsubscribeAuditConfig();
      this._unsubscribeAuditConfig = null;
    }
  },

  async guardManagedAccess() {
    const result = await guardMiniProgramPageAccess({
      pageKey: "reset-password",
      fallbackTab: "pages/profile/index",
    });
    return !result.allowed;
  },

  goBack() {
    const pages = getCurrentPages();
    const canNavigateBack = Array.isArray(pages) && pages.length > 1;
    if (canNavigateBack) {
      wx.navigateBack({ delta: 1 });
      return;
    }
    if (this.data.loginEntryVisible) {
      wx.redirectTo({ url: "/pages/login/index" });
      return;
    }
    wx.switchTab({ url: "/pages/profile/index" });
  },

  goLogin() {
    if (!this.data.loginEntryVisible) {
      wx.showToast({ title: "当前未开放登录入口", icon: "none" });
      return;
    }
    wx.redirectTo({ url: "/pages/login/index" });
  },

  goForgotPassword() {
    if (!this.data.forgotEntryVisible) {
      wx.showToast({ title: "当前未开放忘记密码入口", icon: "none" });
      return;
    }
    wx.redirectTo({ url: "/pages/auth/forgot-password/index" });
  },
});
