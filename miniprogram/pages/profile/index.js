const {
  getSession,
  dbQuery,
  logout,
  extractSessionUser,
  loginWithMiniProgram,
} = require("../../services/photo-api");
const { requestWechatUserProfile } = require("../../utils/wechat-profile");
const { clearStoredCookie } = require("../../utils/auth");
const { resolvePublicUrl } = require("../../utils/storage-url");
const { getLegalDocuments, getLegalDocumentByKey } = require("../../utils/legal-docs");
const {
  getManagedPageAccess,
  normalizeRuntimeConfig,
} = require("../../utils/runtime-config");
const { buildManagedPageLoadingCopy } = require("../../utils/page-loading");
const {
  applyPagePresentationToPage,
  subscribePagePresentation,
} = require("../../utils/page-presentation");
const { guardMiniProgramPageAccess } = require("../../utils/page-access");

const SHARE_IMAGE_URL = "/images/share/shiguangyao-share.jpg";
const SHARE_TITLE = "拾光谣｜定格美好瞬间";

const WECHAT_MINIPROGRAM_EMAIL_SUFFIX = "@wechat.miniprogram.local";
const DEFAULT_ABOUT = {
  author_name: "",
  phone: "",
  wechat: "",
  email: "",
  donation_qr_code: "",
  author_message: "",
};

const PROFILE_MANAGED_MENU_SPECS = [
  {
    pageKey: "profile-edit",
    action: "goEditProfile",
    defaultOrder: 110,
    defaultTitle: "编辑个人资料",
    description: "修改用户名、手机号、微信号",
    iconSrc: "/images/icons/user-yellow.svg",
    featureFlag: "profileEditEnabled",
  },
  {
    pageKey: "profile-bookings",
    action: "goBookings",
    defaultOrder: 120,
    defaultTitle: "我的预约记录",
    description: "查看所有约拍记录",
    iconSrc: "/images/icons/calendar-yellow.svg",
    featureFlag: "profileBookingsEnabled",
  },
  {
    pageKey: "profile-beta",
    action: "goBetaFeatures",
    defaultOrder: 130,
    defaultTitle: "内测功能",
    description: "输入内测码，解锁并进入专属内测页面",
    iconSrc: "/images/icons/sparkles-yellow.svg",
    requiresWechatLogin: true,
  },
  {
    pageKey: "profile-change-password",
    action: "goChangePassword",
    defaultOrder: 150,
    defaultTitle: "修改密码",
    description: "更新账户安全信息",
    iconSrc: "/images/icons/lock-yellow.svg",
    requiresPasswordUser: true,
  },
  {
    pageKey: "about",
    action: "goAbout",
    defaultOrder: 140,
    defaultTitle: "关于",
    description: "查看作者联系方式与留言",
    iconSrc: "/images/icons/question.svg",
    hideWhenAdmin: true,
  },
  {
    pageKey: "profile-delete-account",
    action: "goDeleteAccount",
    defaultOrder: 160,
    defaultTitle: "删除账户",
    description: "永久删除账户和所有数据",
    iconSrc: "/images/icons/log-out-red.svg",
    isDanger: true,
  },
];

const GUEST_PROFILE_MENU_SPECS = [
  {
    action: "goWechatLogin",
    defaultTitle: "微信登录",
    buttonClass: "btn-primary",
    hoverClass: "btn-primary--active",
    requiresWechatLogin: true,
  },
];

function isWechatMiniProgramAccount(user) {
  const email = String((user && user.email) || "").trim().toLowerCase();
  return email.endsWith(WECHAT_MINIPROGRAM_EMAIL_SUFFIX);
}

function toText(value) {
  return String(value || "").trim();
}

function toOptionalText(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text) return "";
  const normalized = text.toLowerCase();
  if (normalized === "null" || normalized === "undefined" || normalized === "nil" || normalized === "none") {
    return "";
  }
  return text;
}

function resolveDisplayUserName(user, preferGuestDisplayName) {
  const fallbackName = preferGuestDisplayName ? "拾光者" : "用户";
  const name = toOptionalText(user && user.name);
  const phone = toOptionalText(user && user.phone);

  if (!name) {
    return phone || fallbackName;
  }

  if (preferGuestDisplayName && (name === "微信用户" || name === "用户")) {
    return fallbackName;
  }

  return name;
}

function toOptionalMessageText(value) {
  const raw = String(value == null ? "" : value);
  const text = raw.trim();
  if (!text) return "";
  const normalized = text.toLowerCase();
  if (normalized === "null" || normalized === "undefined" || normalized === "nil" || normalized === "none") {
    return "";
  }
  return raw.replace(/\r\n/g, "\n");
}

function normalizeDonationQrCode(value) {
  const raw = toOptionalText(value);
  if (!raw) return "";

  const resolved = toOptionalText(resolvePublicUrl(raw));
  if (!resolved) return "";

  const normalized = resolved.toLowerCase();
  if (
    normalized === "/" ||
    normalized === "./" ||
    normalized.includes("[object object]") ||
    normalized.endsWith("/null") ||
    normalized.endsWith("/undefined")
  ) {
    return "";
  }

  return resolved;
}

function isMissingColumnError(error, columnName) {
  const message = String((error && error.message) || "").toLowerCase();
  const column = String(columnName || "").toLowerCase();
  if (!message || !column) return false;
  return (
    message.includes(column) &&
    (message.includes("unknown column") ||
      message.includes("does not exist") ||
      (message.includes("column") && message.includes("not found")))
  );
}

function wxLogin() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => resolve(res),
      fail: (error) => reject(error),
    });
  });
}

function parseRegisterDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsed = new Date(`${raw}T00:00:00+08:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}$/.test(raw)) {
    const parsed = new Date(`${raw.replace(" ", "T")}+08:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatRegisterDateText(value) {
  const parsed = parseRegisterDate(value);
  if (!parsed) return "";
  const shifted = new Date(parsed.getTime() + 8 * 60 * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `注册日期：${year}-${month}-${day}`;
}

function buildManagedProfileMenuItems(state, runtimeConfig) {
  const currentState = state && typeof state === "object" ? state : {};
  return PROFILE_MANAGED_MENU_SPECS.reduce((list, spec, index) => {
    const access = getManagedPageAccess(runtimeConfig, spec.pageKey);
    if (!access || String(access.publishState || "").trim() !== "online") {
      return list;
    }
    if (spec.featureFlag && !Boolean(currentState[spec.featureFlag])) {
      return list;
    }
    if (spec.requiresPasswordUser && !Boolean(currentState.canChangePassword)) {
      return list;
    }
    if (spec.requiresWechatLogin && !Boolean(currentState.isWechatLogin)) {
      return list;
    }
    if (spec.hideWhenAdmin && Boolean(currentState.isAdmin)) {
      return list;
    }

    const title =
      toText(access.navText) || toText(access.headerTitle) || String(spec.defaultTitle || "").trim();
    if (!title) {
      return list;
    }

    list.push({
      key: spec.pageKey,
      action: spec.action,
      navOrder: Number.isFinite(Number(access.navOrder)) ? Number(access.navOrder) : Number(spec.defaultOrder || 99),
      title,
      description: String(spec.description || "").trim(),
      iconSrc: spec.iconSrc,
      itemClass: spec.isDanger
        ? "menu-item menu-item--plain menu-item--danger motion-fade-up"
        : "menu-item motion-fade-up",
      iconClass: spec.isDanger ? "menu-icon menu-icon--danger" : "menu-icon",
      titleClass: spec.isDanger ? "menu-title menu-title--danger" : "menu-title",
      hoverClass: spec.isDanger ? "menu-item--danger-active" : "menu-item--active",
      delayMs: 120 + index * 40,
    });
    return list;
  }, []).sort((left, right) => {
    if (left.navOrder !== right.navOrder) {
      return left.navOrder - right.navOrder;
    }
    return String(left.key || "").localeCompare(String(right.key || ""), "zh-CN");
  });
}

function buildManagedGuestProfileMenuItems(state) {
  const currentState = state && typeof state === "object" ? state : {};
  return GUEST_PROFILE_MENU_SPECS.reduce((list, spec) => {
    if (spec.requiresWechatLogin && !Boolean(currentState.wechatLoginEnabled)) {
      return list;
    }
    const title = String(spec.defaultTitle || "").trim();
    if (!title) {
      return list;
    }

    list.push({
      key: spec.action,
      action: spec.action,
      title,
      buttonClass: String(spec.buttonClass || "").trim(),
      hoverClass: String(spec.hoverClass || "").trim(),
    });
    return list;
  }, []);
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
    hideAudit: false,
    authMode: "phone_password",
    guestProfileMode: "login",
    phoneLoginEnabled: true,
    wechatLoginEnabled: false,
    profileEditEnabled: true,
    profileBookingsEnabled: true,
    donationQrCodeEnabled: true,
    showAuditAboutMode: false,
    auditWechatSubmitting: false,
    showAuditLegalModal: false,
    auditLegalDocTabs: [],
    auditActiveLegalKey: "",
    auditActiveLegalTitle: "",
    auditActiveLegalVersion: "",
    auditActiveLegalSections: [],
    auditActiveLegalFooter: [],

    loading: true,
    pageLoadingTitle: "拾光中...",
    pageLoadingDescription: "正在载入我的小天地内容",
    isLoggedIn: false,
    isWechatLogin: false,
    isAdmin: false,
    userRole: "",

    userName: "",
    userPhone: "",
    userRegisterDateText: "",
    canChangePassword: false,
    profileMenuItems: [],
    guestMenuItems: [],

    aboutLoading: true,
    aboutError: "",
    savingDonationQr: false,
    hasDonationQrCode: false,
    about: Object.assign({}, DEFAULT_ABOUT),
    pagePresentationMode: "tabbar",
    pageFallbackRoute: "",
    pageFallbackTab: "pages/index/index",
    hasBottomTabbar: true,
  },

  buildPageLoadingData(runtimeConfig, nextState) {
    const currentState = nextState && typeof nextState === "object" ? nextState : {};
    const isLoggedIn = Object.prototype.hasOwnProperty.call(currentState, "isLoggedIn")
      ? Boolean(currentState.isLoggedIn)
      : Boolean(this.data.isLoggedIn);
    const showAuditAboutMode = Object.prototype.hasOwnProperty.call(currentState, "showAuditAboutMode")
      ? Boolean(currentState.showAuditAboutMode)
      : Boolean(this.data.showAuditAboutMode);
    const loadingCopy = buildManagedPageLoadingCopy(runtimeConfig, {
      pagePath: "pages/profile/index",
      pageKey: "profile",
      isLoggedIn,
      fallbackTitle: showAuditAboutMode ? "关于我" : "我的小天地",
    });

    return {
      normalizedRuntimeConfig: loadingCopy.normalizedRuntimeConfig,
      pageLoadingTitle: loadingCopy.title,
      pageLoadingDescription: loadingCopy.description,
    };
  },

  applyRuntimeConfig(runtimeConfig) {
    const normalized = normalizeRuntimeConfig(runtimeConfig);
    const authMode = String(normalized.authMode || "phone_password");
    const guestProfileMode = String(normalized.guestProfileMode || "login");
    const phoneLoginEnabled = authMode === "phone_password" || authMode === "mixed";
    const wechatLoginEnabled = authMode === "wechat_only" || authMode === "mixed";
    const nextShowAuditAboutMode =
      guestProfileMode === "about" && !Boolean(this.data && this.data.isLoggedIn);
    const enableGuestWechatEntry =
      nextShowAuditAboutMode && wechatLoginEnabled && !phoneLoginEnabled;
    const loadingData = this.buildPageLoadingData(runtimeConfig, {
      isLoggedIn: Boolean(this.data && this.data.isLoggedIn),
      showAuditAboutMode: nextShowAuditAboutMode,
    });
    const nextState = Object.assign({}, this.data, {
      hideAudit: Boolean(normalized.hideAudit),
      authMode,
      guestProfileMode,
      phoneLoginEnabled,
      wechatLoginEnabled,
      profileEditEnabled: Boolean(
        normalized.featureFlags && normalized.featureFlags.showProfileEdit
      ),
      profileBookingsEnabled: Boolean(
        normalized.featureFlags && normalized.featureFlags.showProfileBookings
      ),
      donationQrCodeEnabled: Boolean(
        normalized.featureFlags && normalized.featureFlags.showDonationQrCode
      ),
      showAuditAboutMode: nextShowAuditAboutMode,
    });

    this.setData({
      hideAudit: nextState.hideAudit,
      authMode,
      guestProfileMode,
      phoneLoginEnabled,
      wechatLoginEnabled,
      profileEditEnabled: nextState.profileEditEnabled,
      profileBookingsEnabled: nextState.profileBookingsEnabled,
      donationQrCodeEnabled: nextState.donationQrCodeEnabled,
      showAuditAboutMode: nextShowAuditAboutMode,
      showAuditLegalModal: enableGuestWechatEntry
        ? Boolean(this.data.showAuditLegalModal)
        : false,
      pageLoadingTitle: loadingData.pageLoadingTitle,
      pageLoadingDescription: loadingData.pageLoadingDescription,
      profileMenuItems: buildManagedProfileMenuItems(nextState, normalized),
      guestMenuItems: buildManagedGuestProfileMenuItems(nextState, normalized),
    });
    this.initAuditLegalDocuments(enableGuestWechatEntry);
    return normalized;
  },

  applyPagePresentation() {
    const app = typeof getApp === "function" ? getApp() : null;
    return applyPagePresentationToPage(this, app, "pages/profile/index");
  },

  onLoad() {
    this._profilePageBootstrapped = false;
    this._lastSeenAppEnterSeq = 0;
    const app = getApp();
    const globalData = app && app.globalData ? app.globalData : {};
    const safeTop = Number(globalData.statusBarHeight || 0);
    const serviceMissing = !String(globalData.cloudRunService || "").trim();
    this.setData({
      safeTop,
      serviceMissing,
    });
    this.applyRuntimeConfig(globalData.runtimeConfig || { hideAudit: globalData.hideAudit });
    this.applyPagePresentation();

    if (app && typeof app.subscribeMiniProgramRuntimeConfig === "function") {
      this._unsubscribeAuditConfig = app.subscribeMiniProgramRuntimeConfig((runtimeConfig) => {
        this.applyRuntimeConfig(runtimeConfig);
        this.refreshCurrentModeData();
      });
    }
    this._unsubscribePagePresentation = subscribePagePresentation(app, this, "pages/profile/index");

    this.refreshCurrentModeData();
  },

  async onShow() {
    const app = typeof getApp === "function" ? getApp() : null;
    const appEnterSeq = Math.max(0, Number(app && app.globalData ? app.globalData.appEnterSeq : 0));
    const lastSeenAppEnterSeq = Math.max(0, Number(this._lastSeenAppEnterSeq || 0));
    const hasNewAppEntry = appEnterSeq > lastSeenAppEnterSeq;
    this._lastSeenAppEnterSeq = Math.max(appEnterSeq, lastSeenAppEnterSeq);
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
    const presentationState = this.applyPagePresentation();
    if (!this.data.serviceMissing) {
      const accessResult = await guardMiniProgramPageAccess({
        pageKey: "profile",
        presentationMode: presentationState.accessMode || presentationState.mode,
      });
      if (!accessResult.allowed) {
        return;
      }
    }

    this.syncTabBar("pages/profile/index");
    if (hasNewAppEntry && this._profilePageBootstrapped && !this.data.loading) {
      return;
    }
    this.refreshCurrentModeData();
  },

  onUnload() {
    if (typeof this._unsubscribeAuditConfig === "function") {
      this._unsubscribeAuditConfig();
    }
    this._unsubscribeAuditConfig = null;
    if (this._auditLoginRefreshTimer) {
      clearTimeout(this._auditLoginRefreshTimer);
      this._auditLoginRefreshTimer = null;
    }
    if (typeof this._unsubscribePagePresentation === "function") {
      this._unsubscribePagePresentation();
    }
    this._unsubscribePagePresentation = null;
  },

  syncTabBar(selectedPath) {
    if (typeof this.getTabBar !== "function") return;
    const tab = this.getTabBar();
    if (tab && typeof tab.setData === "function") {
      tab.setData({
        selectedPath: String(selectedPath || "").trim().replace(/^\/+/, ""),
      });
    }
  },

  refreshTabBarLoginState() {
    if (typeof this.getTabBar !== "function") return;
    const tab = this.getTabBar();
    if (tab && typeof tab.refreshLoginState === "function") {
      tab.refreshLoginState();
    }
  },

  refreshCurrentModeData() {
    if (this.data.serviceMissing) {
      this.setData({ loading: false, aboutLoading: false });
      return;
    }
    this.loadUser();
  },

  initAuditLegalDocuments(enabled) {
    const nextEnabled =
      typeof enabled === "boolean"
        ? enabled
        : Boolean(this.data.showAuditAboutMode && this.data.wechatLoginEnabled && !this.data.phoneLoginEnabled);
    if (!nextEnabled) {
      this.auditLegalDocMap = {};
      this.setData({
        auditLegalDocTabs: [],
        showAuditLegalModal: false,
        auditActiveLegalKey: "",
        auditActiveLegalTitle: "",
        auditActiveLegalVersion: "",
        auditActiveLegalSections: [],
        auditActiveLegalFooter: [],
      });
      return;
    }

    const docs = getLegalDocuments({ hideAudit: Boolean(this.data.hideAudit) });
    this.auditLegalDocMap = {};
    docs.forEach((doc) => {
      const key = String((doc && doc.key) || "").trim();
      if (!key) return;
      this.auditLegalDocMap[key] = doc;
    });

    const tabs = docs.map((doc) => ({
      key: String((doc && doc.key) || ""),
      title: String((doc && doc.title) || ""),
      shortTitle: String((doc && doc.shortTitle) || (doc && doc.title) || ""),
    }));
    const activeKey = String(this.data.auditActiveLegalKey || "").trim();
    const hasActiveKey = tabs.some((tab) => String((tab && tab.key) || "") === activeKey);
    const defaultKey = hasActiveKey ? activeKey : tabs.length > 0 ? String(tabs[0].key || "") : "";
    this.setData({ auditLegalDocTabs: tabs });
    if (defaultKey) {
      this.applyAuditLegalDocument(defaultKey, true);
    }
  },

  applyAuditLegalDocument(key, enabled) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) return false;
    const nextEnabled =
      typeof enabled === "boolean"
        ? enabled
        : Boolean(this.data.showAuditAboutMode && this.data.wechatLoginEnabled && !this.data.phoneLoginEnabled);
    if (!nextEnabled) return false;

    const doc =
      (this.auditLegalDocMap && this.auditLegalDocMap[normalizedKey]) ||
      getLegalDocumentByKey(normalizedKey, { hideAudit: Boolean(this.data.hideAudit) });
    if (!doc) return false;

    this.setData({
      auditActiveLegalKey: String(doc.key || normalizedKey),
      auditActiveLegalTitle: String(doc.title || ""),
      auditActiveLegalVersion: String(doc.versionLine || ""),
      auditActiveLegalSections: Array.isArray(doc.sections) ? doc.sections : [],
      auditActiveLegalFooter: Array.isArray(doc.footer) ? doc.footer : [],
    });
    return true;
  },

  onOpenAuditWechatLogin() {
    if (
      !this.data.showAuditAboutMode ||
      !this.data.wechatLoginEnabled ||
      this.data.phoneLoginEnabled ||
      this.data.serviceMissing
    ) {
      return;
    }
    if (this.data.auditWechatSubmitting) return;
    this.initAuditLegalDocuments(true);
    this.applyAuditLegalDocument("terms", true);
    this.setData({ showAuditLegalModal: true });
  },

  onSwitchAuditLegalDoc(e) {
    const key =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.docKey || "")
        : "";
    this.applyAuditLegalDocument(key, true);
  },

  onCloseAuditLegalModal() {
    if (!this.data.showAuditLegalModal) return;
    this.setData({ showAuditLegalModal: false });
  },

  onRejectAuditWechatLogin() {
    this.setData({
      showAuditLegalModal: false,
      auditWechatSubmitting: false,
    });
  },

  onAgreeAuditWechatLogin() {
    this.setData({ showAuditLegalModal: false });
    this.submitAuditWechatLogin();
  },

  onStopPropagation() {},

  scheduleAuditLoginStateRefresh() {
    if (this._auditLoginRefreshTimer) {
      clearTimeout(this._auditLoginRefreshTimer);
      this._auditLoginRefreshTimer = null;
    }
    this._auditLoginRefreshTimer = setTimeout(() => {
      this._auditLoginRefreshTimer = null;
      this.loadUser();
    }, 360);
  },

  async submitWechatLogin() {
    if (!this.data.wechatLoginEnabled || this.data.serviceMissing) {
      return;
    }
    if (this.data.auditWechatSubmitting) return;
    this.setData({ auditWechatSubmitting: true });
    try {
      const [loginRes, profile] = await Promise.all([
        wxLogin(),
        requestWechatUserProfile({ desc: "用于完善登录后的头像与昵称" }),
      ]);
      const code = String((loginRes && loginRes.code) || "").trim();
      if (!code) {
        wx.showToast({ title: "未获取到微信登录凭证，请重试", icon: "none" });
        return;
      }

      const result = await loginWithMiniProgram(code, profile || undefined);
      const user = extractAuthUserFromPayload(result);
      if (!user) {
        wx.showToast({ title: "微信登录失败，请稍后重试", icon: "none" });
        return;
      }

      const preferGuestDisplayName = this.data.guestProfileMode === "about";
      const userRole = String((user && user.role) || "").trim();
      const userPhone = String((user && user.phone) || "").trim();
      const defaultName = resolveDisplayUserName(user, preferGuestDisplayName);
      const userRegisterDateText =
        formatRegisterDateText(user && (user.created_at || user.createdAt)) ||
        this.data.userRegisterDateText ||
        "";
      const isAdmin = userRole === "admin";

      this.setData({
        loading: false,
        isLoggedIn: true,
        isWechatLogin: true,
        isAdmin,
        userRole,
        userName: defaultName,
        userPhone,
        userRegisterDateText,
        canChangePassword: !isWechatMiniProgramAccount(user),
        showAuditAboutMode: false,
        pageLoadingTitle: this.buildPageLoadingData(undefined, { isLoggedIn: true, showAuditAboutMode: false }).pageLoadingTitle,
        pageLoadingDescription: this.buildPageLoadingData(undefined, { isLoggedIn: true, showAuditAboutMode: false }).pageLoadingDescription,
        profileMenuItems: buildManagedProfileMenuItems(
          Object.assign({}, this.data, {
            isLoggedIn: true,
            isAdmin,
            canChangePassword: !isWechatMiniProgramAccount(user),
            showAuditAboutMode: false,
          }),
          typeof getApp === "function" && getApp() && getApp().globalData
            ? getApp().globalData.runtimeConfig || { hideAudit: getApp().globalData.hideAudit }
            : { hideAudit: false }
        ),
      });
      this.refreshTabBarLoginState();

      // 微信登录后延迟做一次会话态校准，确保管理员入口与昵称等信息最终一致。
      this.scheduleAuditLoginStateRefresh();

      wx.showToast({ title: "登录成功", icon: "none" });
    } catch (error) {
      const message = String((error && error.message) || "");
      if (message.includes("凭证无效") || message.includes("已过期")) {
        wx.showToast({ title: "微信登录凭证已失效，请重试", icon: "none" });
      } else if (message.includes("接口不存在") || message.includes("/api/auth/wechat/miniprogram/login")) {
        wx.showToast({ title: "后端未部署微信登录接口", icon: "none" });
      } else if (message.includes("云托管服务名称未配置")) {
        wx.showToast({ title: "请先配置云托管服务", icon: "none" });
      } else if (message.includes("服务：") && message.includes("环境：")) {
        wx.showToast({ title: "云托管调用失败，请检查配置", icon: "none" });
      } else if (message.includes("未配置")) {
        wx.showToast({ title: "服务端暂未开启微信登录", icon: "none" });
      } else {
        wx.showToast({ title: "微信登录失败，请稍后重试", icon: "none" });
      }
    } finally {
      this.setData({ auditWechatSubmitting: false });
    }
  },

  async submitAuditWechatLogin() {
    if (
      !this.data.showAuditAboutMode ||
      !this.data.wechatLoginEnabled ||
      this.data.phoneLoginEnabled ||
      this.data.serviceMissing
    ) {
      return;
    }
    await this.submitWechatLogin();
  },

  async loadUser() {
    this.setData({
      loading: true,
      pageLoadingTitle: this.buildPageLoadingData(undefined).pageLoadingTitle,
      pageLoadingDescription: this.buildPageLoadingData(undefined).pageLoadingDescription,
    });
    try {
      const session = await getSession();
      const user = extractSessionUser(session);
      if (!user || !user.id) {
        const showGuestAboutMode = this.data.guestProfileMode === "about";
        this.setData({
          loading: false,
          isLoggedIn: false,
          isWechatLogin: false,
          isAdmin: false,
          userRole: "",
          userName: "",
          userPhone: "",
          userRegisterDateText: "",
          canChangePassword: false,
          showAuditAboutMode: showGuestAboutMode,
          aboutLoading: showGuestAboutMode,
          aboutError: "",
          pageLoadingTitle: this.buildPageLoadingData(undefined, { isLoggedIn: false, showAuditAboutMode: showGuestAboutMode }).pageLoadingTitle,
          pageLoadingDescription: this.buildPageLoadingData(undefined, { isLoggedIn: false, showAuditAboutMode: showGuestAboutMode }).pageLoadingDescription,
          profileMenuItems: buildManagedProfileMenuItems(
            Object.assign({}, this.data, {
              isLoggedIn: false,
              isAdmin: false,
              canChangePassword: false,
              showAuditAboutMode: showGuestAboutMode,
            }),
            typeof getApp === "function" && getApp() && getApp().globalData
              ? getApp().globalData.runtimeConfig || { hideAudit: getApp().globalData.hideAudit }
              : { hideAudit: false }
          ),
        });
        this.refreshTabBarLoginState();
        if (showGuestAboutMode) {
          this.loadAbout();
        }
        return;
      }

      const preferGuestDisplayName = this.data.guestProfileMode === "about";
      let userName = resolveDisplayUserName(user, preferGuestDisplayName);
      let userPhone = String((user && user.phone) || "").trim();
      let userRegisterDateText = formatRegisterDateText(user && (user.created_at || user.createdAt));
      const userRole = String((user && user.role) || "").trim();
      let profileRole = "";
      let isAdmin = false;

      // 尝试从 profiles 获取更友好的昵称
      try {
        const r = await dbQuery({
          table: "profiles",
          action: "select",
          columns: "name,phone,role",
          filters: [{ column: "id", operator: "eq", value: user.id }],
          maybeSingle: true,
        });

        const profile = r ? r.data : null;
        if (profile && profile.name) {
          userName = String(profile.name);
        }
        if (profile && profile.phone) {
          userPhone = String(profile.phone);
        }
        if (profile) {
          profileRole = String((profile && profile.role) || "").trim();
        }
      } catch (e) {
        // ignore
      }

      if (!userRegisterDateText) {
        try {
          const userResult = await dbQuery({
            table: "users",
            action: "select",
            columns: "created_at",
            filters: [{ column: "id", operator: "eq", value: user.id }],
            maybeSingle: true,
          });
          const userRow = userResult ? userResult.data : null;
          userRegisterDateText = formatRegisterDateText(userRow && userRow.created_at);
        } catch (error) {
          // ignore
        }
      }

      if (preferGuestDisplayName) {
        const normalizedName = String(userName || "").trim();
        if (!normalizedName || normalizedName === "微信用户" || normalizedName === "用户") {
          userName = "拾光者";
        }
      }

      isAdmin = userRole === "admin" && profileRole === "admin";

      this.setData({
        loading: false,
        isLoggedIn: true,
        isWechatLogin: isWechatMiniProgramAccount(user),
        userRole: isAdmin ? "admin" : "user",
        isAdmin,
        userName,
        userPhone,
        userRegisterDateText,
        canChangePassword: !isWechatMiniProgramAccount(user),
        showAuditAboutMode: false,
        aboutLoading: false,
        pageLoadingTitle: this.buildPageLoadingData(undefined, { isLoggedIn: true, showAuditAboutMode: false }).pageLoadingTitle,
        pageLoadingDescription: this.buildPageLoadingData(undefined, { isLoggedIn: true, showAuditAboutMode: false }).pageLoadingDescription,
        profileMenuItems: buildManagedProfileMenuItems(
          Object.assign({}, this.data, {
            isLoggedIn: true,
            isAdmin,
            canChangePassword: !isWechatMiniProgramAccount(user),
            showAuditAboutMode: false,
          }),
          typeof getApp === "function" && getApp() && getApp().globalData
            ? getApp().globalData.runtimeConfig || { hideAudit: getApp().globalData.hideAudit }
            : { hideAudit: false }
        ),
      });
      this.refreshTabBarLoginState();
    } catch (e) {
      const showGuestAboutMode = this.data.guestProfileMode === "about";
      this.setData({
        loading: false,
        isLoggedIn: false,
        isWechatLogin: false,
        isAdmin: false,
        userRole: "",
        userName: "",
        userPhone: "",
        userRegisterDateText: "",
        canChangePassword: false,
        showAuditAboutMode: showGuestAboutMode,
        aboutLoading: showGuestAboutMode,
        aboutError: "",
        pageLoadingTitle: this.buildPageLoadingData(undefined, { isLoggedIn: false, showAuditAboutMode: showGuestAboutMode }).pageLoadingTitle,
        pageLoadingDescription: this.buildPageLoadingData(undefined, { isLoggedIn: false, showAuditAboutMode: showGuestAboutMode }).pageLoadingDescription,
        profileMenuItems: buildManagedProfileMenuItems(
          Object.assign({}, this.data, {
            isLoggedIn: false,
            isAdmin: false,
            canChangePassword: false,
            showAuditAboutMode: showGuestAboutMode,
          }),
          typeof getApp === "function" && getApp() && getApp().globalData
            ? getApp().globalData.runtimeConfig || { hideAudit: getApp().globalData.hideAudit }
            : { hideAudit: false }
        ),
      });
      this.refreshTabBarLoginState();
      if (showGuestAboutMode) {
        this.loadAbout();
      }
    } finally {
      this._profilePageBootstrapped = true;
    }
  },

  async loadAbout() {
    if (!this.data.showAuditAboutMode) {
      this.setData({ aboutLoading: false });
      return;
    }

    this.setData({ aboutLoading: true, aboutError: "" });
    try {
      let result = await dbQuery({
        table: "about_settings",
        action: "select",
        columns: "author_name,phone,wechat,email,donation_qr_code,author_message",
        orders: [
          { column: "updated_at", ascending: false },
          { column: "id", ascending: false },
        ],
        limit: 1,
        maybeSingle: true,
      });
      if (result && result.error && isMissingColumnError(result.error, "updated_at")) {
        result = await dbQuery({
          table: "about_settings",
          action: "select",
          columns: "author_name,phone,wechat,email,donation_qr_code,author_message",
          orders: [{ column: "id", ascending: false }],
          limit: 1,
          maybeSingle: true,
        });
      }

      if (result && result.error) {
        this.setData({
          aboutLoading: false,
          aboutError: `加载失败：${String(result.error.message || "请稍后重试")}`,
          hasDonationQrCode: false,
          about: Object.assign({}, DEFAULT_ABOUT),
        });
        return;
      }

      const row = result && result.data ? result.data : null;
      if (!row) {
        this.setData({
          aboutLoading: false,
          hasDonationQrCode: false,
          about: Object.assign({}, DEFAULT_ABOUT),
        });
        return;
      }

      const donationQrCode = normalizeDonationQrCode(row.donation_qr_code);
      this.setData({
        aboutLoading: false,
        hasDonationQrCode: Boolean(donationQrCode),
        about: {
          author_name: toOptionalText(row.author_name),
          phone: toOptionalText(row.phone),
          wechat: toOptionalText(row.wechat),
          email: toOptionalText(row.email),
          donation_qr_code: donationQrCode,
          author_message: toOptionalMessageText(row.author_message),
        },
      });
    } catch (error) {
      this.setData({
        aboutLoading: false,
        aboutError: `加载失败：${String((error && error.message) || "请稍后重试")}`,
        hasDonationQrCode: false,
        about: Object.assign({}, DEFAULT_ABOUT),
      });
    }
  },

  goWechatLogin() {
    if (!this.data.wechatLoginEnabled) {
      wx.showToast({ title: "当前未开放微信登录", icon: "none" });
      return;
    }
    if (this.data.serviceMissing) {
      wx.showToast({ title: "当前服务配置不完整", icon: "none" });
      return;
    }
    if (this.data.showAuditAboutMode && !this.data.phoneLoginEnabled) {
      this.onOpenAuditWechatLogin();
      return;
    }
    void this.submitWechatLogin();
  },

  goEditProfile() {
    if (!this.data.profileEditEnabled) {
      wx.showToast({ title: "当前未开放资料编辑", icon: "none" });
      return;
    }
    wx.navigateTo({ url: "/pages/profile/edit/index" });
  },

  goBookings() {
    if (!this.data.profileBookingsEnabled) {
      wx.showToast({ title: "该功能正在开发中", icon: "none" });
      return;
    }
    wx.navigateTo({ url: "/pages/profile/bookings/index" });
  },

  goChangePassword() {
    wx.navigateTo({ url: "/pages/profile/change-password/index" });
  },

  goBetaFeatures() {
    if (this._navigatingToBeta) return;
    this._navigatingToBeta = true;
    wx.navigateTo({
      url: "/pages/profile/beta/index",
      fail: () => {
        wx.showToast({ title: "进入功能内测失败，请重试", icon: "none" });
      },
      complete: () => {
        this._navigatingToBeta = false;
      },
    });
  },

  goDeleteAccount() {
    wx.navigateTo({ url: "/pages/profile/delete-account/index" });
  },

  goAdmin() {
    wx.navigateTo({ url: "/pages/admin/index" });
  },

  goAbout() {
    wx.navigateTo({ url: "/pages/profile/about/index" });
  },

  onProfileMenuTap(e) {
    const dataset = e && e.currentTarget ? e.currentTarget.dataset : {};
    const action = toText(dataset && dataset.action);
    if (!action) return;
    if (typeof this[action] === "function") {
      this[action]();
    }
  },

  onCopyField(e) {
    const dataset = e && e.currentTarget ? e.currentTarget.dataset : {};
    const value = toText(dataset && dataset.value);
    const label = toText(dataset && dataset.label) || "内容";
    if (!value) return;

    wx.setClipboardData({
      data: value,
      success: () => {
        wx.showToast({ title: `${label}已复制`, icon: "none" });
      },
      fail: () => {
        wx.showToast({ title: "复制失败，请手动复制", icon: "none" });
      },
    });
  },

  onPreviewDonationQr() {
    const url = toOptionalText(this.data.about && this.data.about.donation_qr_code);
    if (!url) return;
    wx.previewImage({
      current: url,
      urls: [url],
      fail: () => {
        wx.showToast({ title: "预览失败，请稍后重试", icon: "none" });
      },
    });
  },

  onDonationQrLoadError() {
    if (!this.data.hasDonationQrCode) return;
    this.setData({
      hasDonationQrCode: false,
      "about.donation_qr_code": "",
    });
  },

  async ensureAlbumWritePermission() {
    try {
      const setting = await wx.getSetting();
      const granted =
        setting && setting.authSetting ? setting.authSetting["scope.writePhotosAlbum"] : false;
      if (granted) return true;
      await wx.authorize({ scope: "scope.writePhotosAlbum" });
      return true;
    } catch (e) {
      return false;
    }
  },

  async resolveImageLocalPath(url) {
    const target = toText(url);
    if (!target) {
      throw new Error("缺少赞赏码地址");
    }

    try {
      const info = await wx.getImageInfo({ src: target });
      const localPath = toText(info && info.path);
      if (localPath) {
        return localPath;
      }
    } catch (error) {
      // ignore，进入 downloadFile 兜底
    }

    const download = await wx.downloadFile({ url: target, timeout: 60000 });
    if (!download || download.statusCode !== 200 || !download.tempFilePath) {
      throw new Error("下载赞赏码失败");
    }
    return download.tempFilePath;
  },

  async saveDonationQrToAlbum(url) {
    const localPath = await this.resolveImageLocalPath(url);
    await wx.saveImageToPhotosAlbum({ filePath: localPath });
  },

  async onSaveDonationQr() {
    if (this.data.savingDonationQr) return;
    const url = toOptionalText(this.data.about && this.data.about.donation_qr_code);
    if (!url) {
      wx.showToast({ title: "暂无可保存的赞赏码", icon: "none" });
      return;
    }

    const granted = await this.ensureAlbumWritePermission();
    if (!granted) {
      wx.showModal({
        title: "需要相册权限",
        content: "请在小程序设置中开启“保存到相册”权限后重试。",
        showCancel: false,
      });
      return;
    }

    this.setData({ savingDonationQr: true });
    wx.showLoading({ title: "保存中..." });
    try {
      await this.saveDonationQrToAlbum(url);
      wx.showToast({ title: "赞赏码已保存", icon: "success" });
    } catch (error) {
      wx.showToast({ title: "保存失败，请稍后重试", icon: "none" });
    } finally {
      try {
        wx.hideLoading();
      } catch (_) {
        // ignore
      }
      this.setData({ savingDonationQr: false });
    }
  },

  async logout() {
    try {
      await logout();
    } catch (e) {
      // ignore
    } finally {
      const showGuestAboutMode = this.data.guestProfileMode === "about";
      clearStoredCookie();
      this.setData({
        isLoggedIn: false,
        isWechatLogin: false,
        isAdmin: false,
        userRole: "",
        userName: "",
        userPhone: "",
        userRegisterDateText: "",
        canChangePassword: false,
        showAuditAboutMode: showGuestAboutMode,
        aboutLoading: showGuestAboutMode,
        aboutError: "",
        pageLoadingTitle: this.buildPageLoadingData(undefined, { isLoggedIn: false, showAuditAboutMode: showGuestAboutMode }).pageLoadingTitle,
        pageLoadingDescription: this.buildPageLoadingData(undefined, { isLoggedIn: false, showAuditAboutMode: showGuestAboutMode }).pageLoadingDescription,
        profileMenuItems: buildManagedProfileMenuItems(
          Object.assign({}, this.data, {
            isLoggedIn: false,
            isAdmin: false,
            canChangePassword: false,
            showAuditAboutMode: showGuestAboutMode,
          }),
          typeof getApp === "function" && getApp() && getApp().globalData
            ? getApp().globalData.runtimeConfig || { hideAudit: getApp().globalData.hideAudit }
            : { hideAudit: false }
        ),
      });
      this.refreshTabBarLoginState();
      wx.showToast({ title: "已退出登录", icon: "none" });
      if (showGuestAboutMode) {
        this.loadAbout();
      }
      wx.switchTab({ url: "/pages/profile/index" });
    }
  },

  onShareAppMessage() {
    return {
      title: SHARE_TITLE,
      path: "/pages/profile/index",
      imageUrl: SHARE_IMAGE_URL,
    };
  },

  onShareTimeline() {
    return {
      title: SHARE_TITLE,
      query: "",
      imageUrl: SHARE_IMAGE_URL,
    };
  },
});
