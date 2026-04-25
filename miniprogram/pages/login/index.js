const { loginWithPassword, loginWithMiniProgram } = require("../../services/photo-api");
const {
  clampChinaMobileInput,
  isValidChinaMobile,
  normalizeChinaMobile,
} = require("../../utils/phone");
const { getLegalDocuments, getLegalDocumentByKey } = require("../../utils/legal-docs");
const { getManagedPageAccess, normalizeRuntimeConfig } = require("../../utils/runtime-config");
const { guardMiniProgramPageAccess } = require("../../utils/page-access");
const { requestWechatUserProfile } = require("../../utils/wechat-profile");
const { WECHAT_NICKNAME_AUTH_DESC, resolveWechatLoginErrorMessage } = require("../../utils/wechat-login");

function wxLogin() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => resolve(res),
      fail: (error) => reject(error),
    });
  });
}

function extractAuthUserFromPayload(payload) {
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") break;
    if (current.user && typeof current.user === "object") return current.user;
    if (
      current.session &&
      typeof current.session === "object" &&
      current.session.user &&
      typeof current.session.user === "object"
    ) {
      return current.session.user;
    }
    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }
  return null;
}

Page({
  data: {
    safeTop: 0,
    serviceMissing: false,

    phone: "",
    password: "",
    showPassword: false,
    submitting: false,
    wechatSubmitting: false,
    error: "",
    focusField: "",
    legalDocTabs: [],
    showLegalModal: false,
    activeLegalKey: "",
    activeLegalTitle: "",
    activeLegalVersion: "",
    activeLegalSections: [],
    activeLegalFooter: [],
    agreedToLegal: false,
    authMode: "wechat_only",
    phoneLoginEnabled: false,
    wechatLoginEnabled: true,
    pageTitle: "登录",
    registerEntryVisible: false,
    registerEntryLabel: "注册",
  },

  applyRuntimeConfig(runtimeConfig, options) {
    const opts = options && typeof options === "object" ? options : {};
    const auditConfigReady =
      !Object.prototype.hasOwnProperty.call(opts, "auditConfigReady") ||
      Boolean(opts.auditConfigReady);
    const normalized = normalizeRuntimeConfig(runtimeConfig);
    const authMode = auditConfigReady ? String(normalized.authMode || "phone_password") : "wechat_only";
    const phoneLoginEnabled =
      auditConfigReady && (authMode === "phone_password" || authMode === "mixed");
    const wechatLoginEnabled = auditConfigReady
      ? authMode === "wechat_only" || authMode === "mixed"
      : true;
    const loginAccess = auditConfigReady ? getManagedPageAccess(normalized, "login") : null;
    const registerAccess = auditConfigReady ? getManagedPageAccess(normalized, "register") : null;
    const pageTitle =
      String((loginAccess && (loginAccess.headerTitle || loginAccess.navText)) || "").trim() || "登录";
    const registerEntryVisible =
      phoneLoginEnabled &&
      Boolean(registerAccess) &&
      String((registerAccess && registerAccess.publishState) || "").trim() === "online";
    const registerEntryLabel =
      String((registerAccess && (registerAccess.navText || registerAccess.headerTitle)) || "").trim() || "注册";
    this.setData({
      authMode,
      phoneLoginEnabled,
      wechatLoginEnabled,
      pageTitle,
      registerEntryVisible,
      registerEntryLabel,
    });
    this.initLegalDocuments();
    return normalized;
  },

  async onLoad() {
    const app = getApp();
    const globalData = app && app.globalData ? app.globalData : {};
    const safeTop = Number(globalData.statusBarHeight || 0);
    const serviceMissing = !String(globalData.cloudRunService || "").trim();
    const auditConfigReady = Boolean(globalData.auditConfigReady);
    this.setData({ safeTop, serviceMissing });
    this.applyRuntimeConfig(globalData.runtimeConfig || null, { auditConfigReady });

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
        ? app.globalData.runtimeConfig || null
        : null,
      { auditConfigReady: Boolean(app && app.globalData && app.globalData.auditConfigReady) }
    );
    await this.guardManagedAccess();
  },

  onUnload() {
    if (typeof this._unsubscribeAuditConfig === "function") {
      this._unsubscribeAuditConfig();
      this._unsubscribeAuditConfig = null;
    }
  },

  initLegalDocuments() {
    const docs = getLegalDocuments();
    this.legalDocMap = {};
    docs.forEach((doc) => {
      const key = String((doc && doc.key) || "").trim();
      if (!key) return;
      this.legalDocMap[key] = doc;
    });

    const tabs = docs.map((doc) => ({
      key: String((doc && doc.key) || ""),
      title: String((doc && doc.title) || ""),
      shortTitle: String((doc && doc.shortTitle) || (doc && doc.title) || ""),
    }));
    const activeKey = String(this.data.activeLegalKey || "").trim();
    const hasActiveKey = tabs.some((tab) => String((tab && tab.key) || "") === activeKey);
    const defaultKey = hasActiveKey ? activeKey : (tabs.length > 0 ? String(tabs[0].key || "") : "");
    this.setData({ legalDocTabs: tabs });
    if (defaultKey) {
      this.applyLegalDocument(defaultKey);
    }
  },

  applyLegalDocument(key) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) return false;

    const doc =
      (this.legalDocMap && this.legalDocMap[normalizedKey]) ||
      getLegalDocumentByKey(normalizedKey);
    if (!doc) return false;

    this.setData({
      activeLegalKey: String(doc.key || normalizedKey),
      activeLegalTitle: String(doc.title || ""),
      activeLegalVersion: String(doc.versionLine || ""),
      activeLegalSections: Array.isArray(doc.sections) ? doc.sections : [],
      activeLegalFooter: Array.isArray(doc.footer) ? doc.footer : [],
    });
    return true;
  },

  onOpenLegalDoc(e) {
    const key =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.docKey || "")
        : "";
    if (!this.applyLegalDocument(key)) return;
    this.setData({ showLegalModal: true });
  },

  onToggleLegalAgreement() {
    const nextAgreed = !this.data.agreedToLegal;
    const currentError = String(this.data.error || "");
    const shouldClearError =
      nextAgreed &&
      (currentError.includes("请先阅读并勾选同意") ||
        currentError.includes("用户协议") ||
        currentError.includes("隐私政策") ||
        currentError.includes("用户信息收集说明"));
    this.setData({
      agreedToLegal: nextAgreed,
      error: shouldClearError ? "" : currentError,
    });
  },

  onSwitchLegalDoc(e) {
    const key =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.docKey || "")
        : "";
    this.applyLegalDocument(key);
  },

  onCloseLegalModal() {
    if (!this.data.showLegalModal) return;
    this.setData({ showLegalModal: false });
  },

  onAcknowledgeLegal() {
    const currentError = String(this.data.error || "");
    const shouldClearError =
      currentError.includes("请先阅读并勾选同意") ||
      currentError.includes("用户协议") ||
      currentError.includes("隐私政策") ||
      currentError.includes("用户信息收集说明");
    this.setData({
      showLegalModal: false,
      agreedToLegal: true,
      error: shouldClearError ? "" : currentError,
    });
  },

  onStopPropagation() {},

  goBack() {
    wx.navigateBack({
      delta: 1,
      fail: () => {
        wx.switchTab({ url: "/pages/profile/index" });
      },
    });
  },

  onPhoneInput(e) {
    const value = e && e.detail ? e.detail.value : "";
    this.setData({ phone: clampChinaMobileInput(value) });
  },

  onPasswordInput(e) {
    const value = e && e.detail ? e.detail.value : "";
    this.setData({ password: String(value || "") });
  },

  onFieldFocus(e) {
    const field =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.field || "")
        : "";
    this.setData({ focusField: field });
  },

  onFieldBlur() {
    this.setData({ focusField: "" });
  },

  goRegister() {
    if (!this.data.registerEntryVisible) {
      wx.showToast({ title: "当前未开放注册入口", icon: "none" });
      return;
    }
    wx.navigateTo({ url: "/pages/register/index" });
  },

  togglePassword() {
    this.setData({ showPassword: !this.data.showPassword });
  },

  async guardManagedAccess() {
    const result = await guardMiniProgramPageAccess({
      pageKey: "login",
      fallbackTab: "pages/profile/index",
    });
    return !result.allowed;
  },

  async submit() {
    if (this.data.serviceMissing) return;
    if (!this.data.phoneLoginEnabled) {
      this.setData({ error: "当前仅支持微信登录" });
      return;
    }
    if (this.data.wechatSubmitting) return;
    if (this.data.submitting) return;

    const phone = normalizeChinaMobile(this.data.phone);
    const password = String(this.data.password || "");

    if (!this.data.agreedToLegal) {
      this.setData({
        error: "请先阅读并勾选同意《用户协议》《隐私政策》《用户信息收集说明》",
      });
      return;
    }

    if (!isValidChinaMobile(phone)) {
      this.setData({ error: "请输入有效的手机号" });
      return;
    }
    if (!password) {
      this.setData({ error: "请输入密码" });
      return;
    }

    this.setData({ submitting: true, error: "" });
    try {
      const r = await loginWithPassword(phone, password);
      const user = extractAuthUserFromPayload(r);
      if (!user) {
        this.setData({ error: "登录失败，请重试" });
        return;
      }

      wx.showToast({ title: "登录成功", icon: "none" });
      wx.switchTab({ url: "/pages/profile/index" });
    } catch (e) {
      const msg = String((e && e.message) || "登录失败");
      if (msg.toLowerCase().includes("invalid login credentials")) {
        this.setData({ error: "手机号或密码错误" });
      } else {
        this.setData({ error: "登录失败，请重试" });
      }
    } finally {
      this.setData({ submitting: false });
    }
  },

  async submitWechatLogin() {
    if (this.data.serviceMissing) return;
    if (!this.data.wechatLoginEnabled) {
      this.setData({ error: "当前未开启微信登录" });
      return;
    }
    if (this.data.submitting || this.data.wechatSubmitting) return;
    if (!this.data.agreedToLegal) {
      this.setData({
        error: "请先阅读并勾选同意《用户协议》《隐私政策》《用户信息收集说明》",
      });
      return;
    }

    this.setData({ wechatSubmitting: true, error: "" });
    try {
      const profile = await requestWechatUserProfile({
        desc: WECHAT_NICKNAME_AUTH_DESC,
      });
      const nickName = String((profile && profile.nickName) || "").trim();

      const loginRes = await wxLogin();
      const code = String((loginRes && loginRes.code) || "").trim();
      if (!code) {
        this.setData({ error: "微信授权已失效，请重新登录" });
        return;
      }

      const r = await loginWithMiniProgram(code, nickName ? { nickName } : null);
      const user = extractAuthUserFromPayload(r);
      if (!user) {
        this.setData({ error: "微信登录失败，请稍后重试" });
        return;
      }

      wx.showToast({ title: "登录成功", icon: "none" });
      wx.switchTab({ url: "/pages/profile/index" });
    } catch (e) {
      console.error("[login] submitWechatLogin failed:", e);
      this.setData({ error: resolveWechatLoginErrorMessage(e) });
    } finally {
      this.setData({ wechatSubmitting: false });
    }
  },
});
