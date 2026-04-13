const { loginWithPassword, loginWithMiniProgram } = require("../../services/photo-api");
const {
  clampChinaMobileInput,
  isValidChinaMobile,
  normalizeChinaMobile,
} = require("../../utils/phone");
const { getLegalDocuments, getLegalDocumentByKey } = require("../../utils/legal-docs");
const { getManagedPageAccess, normalizeRuntimeConfig } = require("../../utils/runtime-config");
const { requestWechatUserProfile } = require("../../utils/wechat-profile");
const { guardMiniProgramPageAccess } = require("../../utils/page-access");

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
    hideAudit: false,
    authMode: "phone_password",
    phoneLoginEnabled: true,
    wechatLoginEnabled: false,
    pageTitle: "登录",
    registerEntryVisible: true,
    registerEntryLabel: "注册",
  },

  applyRuntimeConfig(runtimeConfig) {
    const normalized = normalizeRuntimeConfig(runtimeConfig);
    const authMode = String(normalized.authMode || "phone_password");
    const phoneLoginEnabled = authMode === "phone_password" || authMode === "mixed";
    const wechatLoginEnabled = authMode === "wechat_only" || authMode === "mixed";
    const loginAccess = getManagedPageAccess(normalized, "login");
    const registerAccess = getManagedPageAccess(normalized, "register");
    const pageTitle =
      String((loginAccess && (loginAccess.headerTitle || loginAccess.navText)) || "").trim() || "登录";
    const registerEntryVisible =
      Boolean(registerAccess) &&
      String((registerAccess && registerAccess.publishState) || "").trim() === "online" &&
      phoneLoginEnabled;
    const registerEntryLabel =
      String((registerAccess && (registerAccess.navText || registerAccess.headerTitle)) || "").trim() ||
      "注册";
    this.setData({
      hideAudit: Boolean(normalized.hideAudit),
      authMode,
      phoneLoginEnabled,
      wechatLoginEnabled,
      pageTitle,
      registerEntryVisible,
      registerEntryLabel,
    });
    this.initLegalDocuments(Boolean(normalized.hideAudit));
    return normalized;
  },

  async onLoad() {
    const app = getApp();
    const globalData = app && app.globalData ? app.globalData : {};
    const safeTop = Number(globalData.statusBarHeight || 0);
    const serviceMissing = !String(globalData.cloudRunService || "").trim();
    this.setData({ safeTop, serviceMissing });
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

  initLegalDocuments(hideAudit) {
    const nextHideAudit =
      typeof hideAudit === "boolean" ? hideAudit : Boolean(this.data.hideAudit);
    const docs = getLegalDocuments({ hideAudit: nextHideAudit });
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
      this.applyLegalDocument(defaultKey, nextHideAudit);
    }
  },

  applyLegalDocument(key, hideAudit) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) return false;
    const nextHideAudit =
      typeof hideAudit === "boolean" ? hideAudit : Boolean(this.data.hideAudit);

    const doc =
      (this.legalDocMap && this.legalDocMap[normalizedKey]) ||
      getLegalDocumentByKey(normalizedKey, { hideAudit: nextHideAudit });
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

  goRegister() {
    if (!this.data.phoneLoginEnabled || !this.data.registerEntryVisible) {
      this.setData({ error: "当前配置未开放手机号注册" });
      return;
    }
    wx.navigateTo({ url: "/pages/register/index" });
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
      this.setData({ error: "当前未开放微信登录" });
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
      const [loginRes, profile] = await Promise.all([
        wxLogin(),
        requestWechatUserProfile({ desc: "用于完善登录后的头像与昵称" }),
      ]);
      const code = String((loginRes && loginRes.code) || "").trim();
      if (!code) {
        this.setData({ error: "未获取到微信登录凭证，请重试" });
        return;
      }

      const r = await loginWithMiniProgram(code, profile || undefined);
      const user = extractAuthUserFromPayload(r);
      if (!user) {
        this.setData({ error: "微信登录失败，请稍后重试" });
        return;
      }

      wx.showToast({ title: "登录成功", icon: "none" });
      wx.switchTab({ url: "/pages/profile/index" });
    } catch (e) {
      const msg = String((e && e.message) || "");
      console.error("[login] submitWechatLogin failed:", e);
      if (msg.includes("凭证无效") || msg.includes("已过期")) {
        this.setData({ error: "微信登录凭证已失效，请重试" });
      } else if (msg.includes("接口不存在") || msg.includes("/api/auth/wechat/miniprogram/login")) {
        this.setData({ error: "后端未部署微信登录接口，请先发布 photo 服务最新版本" });
      } else if (msg.includes("云托管服务名称未配置")) {
        this.setData({ error: "小程序未配置 cloudRunService，请检查 miniprogram/config.js" });
      } else if (msg.includes("服务：") && msg.includes("环境：")) {
        this.setData({ error: "云托管调用失败，请检查服务名和环境是否一致" });
      } else if (msg.includes("未配置")) {
        this.setData({ error: "服务端暂未开启微信登录，请联系管理员" });
      } else {
        this.setData({ error: "微信登录失败，请稍后重试" });
      }
    } finally {
      this.setData({ wechatSubmitting: false });
    }
  },
});
