const { getManagedPageAccess, normalizeRuntimeConfig } = require("../../../utils/runtime-config");
const { guardMiniProgramPageAccess } = require("../../../utils/page-access");

Page({
  data: {
    safeTop: 0,
    managedTitle: "忘记密码",
    managedSubtitle: "当前版本仅提供手机号体系下的密码修改说明",
    loginEntryVisible: true,
    loginEntryLabel: "登录",
    registerEntryVisible: true,
    registerEntryLabel: "注册",
  },

  applyRuntimeConfig(runtimeConfig) {
    const normalized = normalizeRuntimeConfig(runtimeConfig);
    const forgotAccess = getManagedPageAccess(normalized, "forgot-password");
    const loginAccess = getManagedPageAccess(normalized, "login");
    const registerAccess = getManagedPageAccess(normalized, "register");
    this.setData({
      managedTitle:
        String((forgotAccess && (forgotAccess.headerTitle || forgotAccess.navText)) || "").trim() ||
        "忘记密码",
      managedSubtitle: "当前版本仅提供手机号体系下的密码修改说明",
      loginEntryVisible:
        Boolean(loginAccess) && String((loginAccess && loginAccess.publishState) || "").trim() === "online",
      loginEntryLabel:
        String((loginAccess && (loginAccess.navText || loginAccess.headerTitle)) || "").trim() || "登录",
      registerEntryVisible:
        Boolean(registerAccess) &&
        String((registerAccess && registerAccess.publishState) || "").trim() === "online",
      registerEntryLabel:
        String((registerAccess && (registerAccess.navText || registerAccess.headerTitle)) || "").trim() ||
        "注册",
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
      pageKey: "forgot-password",
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

  goRegister() {
    if (!this.data.registerEntryVisible) {
      wx.showToast({ title: "当前未开放注册入口", icon: "none" });
      return;
    }
    wx.redirectTo({ url: "/pages/register/index" });
  },
});
