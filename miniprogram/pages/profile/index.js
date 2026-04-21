const {
  getSession,
  dbQuery,
  logout,
  extractSessionUser,
  loginWithMiniProgram,
} = require("../../services/photo-api");
const { requestWechatUserProfile } = require("../../utils/wechat-profile");
const { clearStoredCookie } = require("../../utils/auth");
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
const SHARE_TITLE = "拾光谣｜我的小天地";
const WECHAT_MINIPROGRAM_EMAIL_SUFFIX = "@wechat.miniprogram.local";
const WECHAT_MINIPROGRAM_DEFAULT_NAME = "拾光者";
const WECHAT_MINIPROGRAM_LEGACY_DEFAULT_NAMES = new Set([
  "微信用户",
  WECHAT_MINIPROGRAM_DEFAULT_NAME,
]);

const PROFILE_MENU_SPECS = [
  {
    pageKey: "profile-edit",
    action: "goEditProfile",
    defaultOrder: 110,
    defaultTitle: "编辑个人资料",
    description: "修改用户名、手机号、微信号",
    iconSrc: "/images/icons/user-yellow.svg",
  },
  {
    pageKey: "profile-bookings",
    action: "goBookings",
    defaultOrder: 120,
    defaultTitle: "我的预约记录",
    description: "查看所有约拍记录",
    iconSrc: "/images/icons/calendar-yellow.svg",
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
    pageKey: "profile-delete-account",
    action: "goDeleteAccount",
    defaultOrder: 160,
    defaultTitle: "删除账户",
    description: "永久删除账户和所有数据",
    iconSrc: "/images/icons/log-out-red.svg",
    isDanger: true,
  },
];

const GUEST_MENU_SPECS = [
  {
    action: "goWechatLogin",
    defaultTitle: "微信登录",
    buttonClass: "btn-primary",
    hoverClass: "btn-primary--active",
  },
];

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

function isWechatMiniProgramAccount(user) {
  const email = String((user && user.email) || "").trim().toLowerCase();
  return email.endsWith(WECHAT_MINIPROGRAM_EMAIL_SUFFIX);
}

function normalizeWechatMiniDefaultName(name, user) {
  const normalizedName = toOptionalText(name);
  if (!isWechatMiniProgramAccount(user)) {
    return normalizedName;
  }
  if (!normalizedName || WECHAT_MINIPROGRAM_LEGACY_DEFAULT_NAMES.has(normalizedName)) {
    return WECHAT_MINIPROGRAM_DEFAULT_NAME;
  }
  return normalizedName;
}

function resolveDisplayUserName(user) {
  const name = normalizeWechatMiniDefaultName(user && user.name, user);
  const phone = toOptionalText(user && user.phone);
  return name || phone || WECHAT_MINIPROGRAM_DEFAULT_NAME;
}

function resolveAvatarText(name) {
  const text = toOptionalText(name);
  return text ? text.slice(0, 1) : "?";
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

function buildManagedProfileMenuItems(state, runtimeConfig) {
  const currentState = state && typeof state === "object" ? state : {};
  return PROFILE_MENU_SPECS.reduce((list, spec, index) => {
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
  return GUEST_MENU_SPECS.reduce((list, spec) => {
    if (!Boolean(currentState.wechatLoginEnabled)) {
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

Page({
  data: {
    safeTop: 0,
    serviceMissing: false,
    backendReady: false,
    backendReconnecting: false,
    wechatLoginEnabled: true,
    wechatLoginSubmitting: false,
    showWechatLegalModal: false,
    wechatLegalDocTabs: [],
    wechatActiveLegalKey: "",
    wechatActiveLegalTitle: "",
    wechatActiveLegalVersion: "",
    wechatActiveLegalSections: [],
    wechatActiveLegalFooter: [],

    loading: true,
    pageLoadingTitle: "拾光中...",
    pageLoadingDescription: "正在加载页面",
    isLoggedIn: false,
    isWechatLogin: false,
    isAdmin: false,
    userRole: "",
    userName: "",
    userAvatarText: "?",
    userPhone: "",
    userRegisterDateText: "",
    canChangePassword: false,
    profileMenuItems: [],
    guestMenuItems: buildManagedGuestProfileMenuItems({ wechatLoginEnabled: true }),
    pagePresentationMode: "tabbar",
    pageFallbackRoute: "",
    pageFallbackTab: "pages/index/index",
    hasBottomTabbar: true,
  },

  buildPageLoadingData(runtimeConfig, nextState) {
    const currentState = nextState && typeof nextState === "object" ? nextState : {};
    const loadingCopy = buildManagedPageLoadingCopy(runtimeConfig, {
      pagePath: "pages/profile/index",
      pageKey: "profile",
      isLoggedIn:
        Object.prototype.hasOwnProperty.call(currentState, "isLoggedIn")
          ? Boolean(currentState.isLoggedIn)
          : Boolean(this.data.isLoggedIn),
      fallbackTitle: "我的小天地",
    });

    return {
      normalizedRuntimeConfig: loadingCopy.normalizedRuntimeConfig,
      pageLoadingTitle: loadingCopy.title,
      pageLoadingDescription: loadingCopy.description,
    };
  },

  buildGuestState(runtimeConfig) {
    const normalized = normalizeRuntimeConfig(runtimeConfig);
    const loadingData = this.buildPageLoadingData(normalized, { isLoggedIn: false });
    return {
      loading: false,
      isLoggedIn: false,
      isWechatLogin: false,
      isAdmin: false,
      userRole: "",
      userName: "",
      userAvatarText: "?",
      userPhone: "",
      userRegisterDateText: "",
      canChangePassword: false,
      wechatLoginSubmitting: false,
      showWechatLegalModal: false,
      pageLoadingTitle: loadingData.pageLoadingTitle,
      pageLoadingDescription: loadingData.pageLoadingDescription,
      profileMenuItems: [],
      guestMenuItems: buildManagedGuestProfileMenuItems({ wechatLoginEnabled: true }),
    };
  },

  applyRuntimeConfig(runtimeConfig) {
    const normalized = normalizeRuntimeConfig(runtimeConfig);
    const loadingData = this.buildPageLoadingData(normalized);
    const nextState = {
      wechatLoginEnabled: true,
      pageLoadingTitle: loadingData.pageLoadingTitle,
      pageLoadingDescription: loadingData.pageLoadingDescription,
      guestMenuItems: buildManagedGuestProfileMenuItems({ wechatLoginEnabled: true }),
    };

    if (this.data.isLoggedIn) {
      nextState.profileMenuItems = buildManagedProfileMenuItems(
        Object.assign({}, this.data, nextState),
        normalized
      );
    }

    this.setData(nextState);
    return normalized;
  },

  applyPagePresentation() {
    const app = typeof getApp === "function" ? getApp() : null;
    return applyPagePresentationToPage(this, app, "pages/profile/index");
  },

  onLoad() {
    this._profileBootstrapped = false;
    this._lastSeenAppEnterSeq = 0;
    const app = typeof getApp === "function" ? getApp() : null;
    const globalData = app && app.globalData ? app.globalData : {};
    const safeTop = Number(globalData.statusBarHeight || 0);
    const serviceMissing = !String(globalData.cloudRunService || "").trim();
    const backendReady = serviceMissing ? true : Boolean(globalData.backendReady);
    const backendReconnecting = !backendReady && Boolean(globalData.backendReconnecting);

    this.setData({
      safeTop,
      serviceMissing,
      backendReady,
      backendReconnecting,
    });

    this.initWechatLegalDocuments();
    this.applyRuntimeConfig(globalData.runtimeConfig);
    this.applyPagePresentation();

    if (app && typeof app.subscribeMiniProgramRuntimeConfig === "function") {
      this._unsubscribeRuntimeConfig = app.subscribeMiniProgramRuntimeConfig((runtimeConfig) => {
        this.applyRuntimeConfig(runtimeConfig);
      });
    }
    this._unsubscribePagePresentation = subscribePagePresentation(app, this, "pages/profile/index");

    if (app && typeof app.subscribeBackendStatus === "function") {
      this._unsubscribeBackendStatus = app.subscribeBackendStatus((status) => {
        const ready = Boolean(status && status.backendReady);
        const reconnecting = !ready && Boolean(status && status.backendReconnecting);
        this.setData({
          backendReady: ready,
          backendReconnecting: reconnecting,
        });
      });
    }

    if (!serviceMissing && !backendReady && app && typeof app.ensureBackendReady === "function") {
      this.setData({ loading: true });
      void app.ensureBackendReady();
    }
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
        ? app.globalData.runtimeConfig
        : null
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

    if (this.data.serviceMissing) {
      this.setData(this.buildGuestState(app && app.globalData ? app.globalData.runtimeConfig : null));
      return;
    }

    if (app && typeof app.ensureBackendReady === "function") {
      if (!this.data.backendReady) {
        this.setData(
          this._profileBootstrapped
            ? {
                backendReconnecting: true,
              }
            : {
                loading: true,
                backendReconnecting: true,
              }
        );
      }
      try {
        await app.ensureBackendReady();
      } catch (error) {
        // ignore
      }
    }

    const nextBackendReady = Boolean(app && app.globalData && app.globalData.backendReady);
    const nextBackendReconnecting = !nextBackendReady && Boolean(
      app && app.globalData && app.globalData.backendReconnecting
    );
    this.setData({
      backendReady: nextBackendReady,
      backendReconnecting: nextBackendReconnecting,
    });

    this.loadUser({
      silent:
        !hasNewAppEntry &&
        this._profileBootstrapped &&
        !this.data.loading &&
        !nextBackendReconnecting,
    });
  },

  onUnload() {
    if (this._wechatLoginRefreshTimer) {
      clearTimeout(this._wechatLoginRefreshTimer);
      this._wechatLoginRefreshTimer = null;
    }
    if (typeof this._unsubscribeRuntimeConfig === "function") {
      this._unsubscribeRuntimeConfig();
    }
    this._unsubscribeRuntimeConfig = null;
    if (typeof this._unsubscribePagePresentation === "function") {
      this._unsubscribePagePresentation();
    }
    this._unsubscribePagePresentation = null;
    if (typeof this._unsubscribeBackendStatus === "function") {
      this._unsubscribeBackendStatus();
    }
    this._unsubscribeBackendStatus = null;
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

  scheduleWechatLoginStateRefresh() {
    if (this._wechatLoginRefreshTimer) {
      clearTimeout(this._wechatLoginRefreshTimer);
    }
    this._wechatLoginRefreshTimer = setTimeout(() => {
      this._wechatLoginRefreshTimer = null;
      this.loadUser({ silent: true });
    }, 360);
  },

  initWechatLegalDocuments() {
    const docs = getLegalDocuments();
    this.wechatLegalDocMap = {};
    docs.forEach((doc) => {
      const key = toText(doc && doc.key);
      if (!key) return;
      this.wechatLegalDocMap[key] = doc;
    });

    const tabs = docs
      .map((doc) => ({
        key: toText(doc && doc.key),
        title: toText(doc && doc.title),
        shortTitle: toText((doc && doc.shortTitle) || (doc && doc.title)),
      }))
      .filter((doc) => doc.key);
    const activeKey = toText(this.data.wechatActiveLegalKey);
    const defaultKey = tabs.some((tab) => tab.key === activeKey)
      ? activeKey
      : (tabs[0] ? tabs[0].key : "");

    this.setData({ wechatLegalDocTabs: tabs });
    if (defaultKey) {
      this.applyWechatLegalDocument(defaultKey);
    }
  },

  applyWechatLegalDocument(key) {
    const normalizedKey = toText(key);
    if (!normalizedKey) return false;

    const doc = (this.wechatLegalDocMap && this.wechatLegalDocMap[normalizedKey])
      || getLegalDocumentByKey(normalizedKey);
    if (!doc) return false;

    this.setData({
      wechatActiveLegalKey: toText(doc.key) || normalizedKey,
      wechatActiveLegalTitle: toText(doc.title),
      wechatActiveLegalVersion: toText(doc.versionLine),
      wechatActiveLegalSections: Array.isArray(doc.sections) ? doc.sections : [],
      wechatActiveLegalFooter: Array.isArray(doc.footer) ? doc.footer : [],
    });
    return true;
  },

  openWechatLegalModal() {
    if (!Array.isArray(this.data.wechatLegalDocTabs) || this.data.wechatLegalDocTabs.length === 0) {
      this.initWechatLegalDocuments();
    }
    if (!this.data.wechatActiveLegalKey && this.data.wechatLegalDocTabs[0]) {
      this.applyWechatLegalDocument(this.data.wechatLegalDocTabs[0].key);
    }
    if (!this.data.wechatActiveLegalKey) {
      wx.showToast({ title: "条款加载失败，请稍后重试", icon: "none" });
      return false;
    }
    this.setData({ showWechatLegalModal: true });
    return true;
  },

  onSwitchWechatLegalDoc(e) {
    const dataset = e && e.currentTarget ? e.currentTarget.dataset : {};
    this.applyWechatLegalDocument(dataset && dataset.docKey);
  },

  onCloseWechatLegalModal() {
    if (!this.data.showWechatLegalModal) return;
    this.setData({ showWechatLegalModal: false });
  },

  onRejectWechatLogin() {
    this.setData({ showWechatLegalModal: false });
  },

  onAgreeWechatLogin() {
    if (this.data.wechatLoginSubmitting) return;
    this.setData({ showWechatLegalModal: false });
    void this.submitWechatLogin();
  },

  onStopPropagation() {},

  async submitWechatLogin() {
    if (this.data.serviceMissing) {
      wx.showToast({ title: "当前服务配置不完整", icon: "none" });
      return;
    }
    if (this._wechatSubmitting || this.data.wechatLoginSubmitting) return;

    this._wechatSubmitting = true;
    this.setData({ wechatLoginSubmitting: true });
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

      const runtimeConfig =
        typeof getApp === "function" && getApp() && getApp().globalData
          ? getApp().globalData.runtimeConfig
          : null;
      const normalized = normalizeRuntimeConfig(runtimeConfig);
      const userRole = String((user && user.role) || "").trim();
      const isAdmin = userRole === "admin";
      const canChangePassword = !isWechatMiniProgramAccount(user);
      const userName = resolveDisplayUserName(user);

      this.setData({
        loading: false,
        isLoggedIn: true,
        isWechatLogin: true,
        isAdmin,
        userRole: isAdmin ? "admin" : "user",
        userName,
        userAvatarText: resolveAvatarText(userName),
        userPhone: "",
        userRegisterDateText:
          formatRegisterDateText(user && (user.created_at || user.createdAt)) || this.data.userRegisterDateText,
        canChangePassword,
        pageLoadingTitle: this.buildPageLoadingData(normalized, { isLoggedIn: true }).pageLoadingTitle,
        pageLoadingDescription: this.buildPageLoadingData(normalized, { isLoggedIn: true }).pageLoadingDescription,
        profileMenuItems: buildManagedProfileMenuItems(
          Object.assign({}, this.data, {
            isLoggedIn: true,
            isWechatLogin: true,
            isAdmin,
            userRole: isAdmin ? "admin" : "user",
            canChangePassword,
          }),
          normalized
        ),
      });
      this.refreshTabBarLoginState();
      this.scheduleWechatLoginStateRefresh();
      wx.showToast({ title: "登录成功", icon: "none" });
    } catch (error) {
      const message = String((error && error.message) || "");
      if (message.includes("凭证无效") || message.includes("已过期")) {
        wx.showToast({ title: "微信登录凭证已失效，请重试", icon: "none" });
      } else if (message.includes("接口不存在") || message.includes("/api/auth/wechat/miniprogram/login")) {
        wx.showToast({ title: "后端未部署微信登录接口", icon: "none" });
      } else if (message.includes("云托管服务名称未配置")) {
        wx.showToast({ title: "请先配置云托管服务", icon: "none" });
      } else if (message.includes("未配置")) {
        wx.showToast({ title: "服务端暂未开启微信登录", icon: "none" });
      } else {
        wx.showToast({ title: "微信登录失败，请稍后重试", icon: "none" });
      }
    } finally {
      this._wechatSubmitting = false;
      this.setData({ wechatLoginSubmitting: false });
    }
  },

  async loadUser(options) {
    const opts = options && typeof options === "object" ? options : {};
    const silent = Boolean(opts.silent) && this._profileBootstrapped;
    const runtimeConfig =
      typeof getApp === "function" && getApp() && getApp().globalData
        ? getApp().globalData.runtimeConfig
        : null;
    const normalized = normalizeRuntimeConfig(runtimeConfig);

    if (!silent) {
      this.setData({
        loading: true,
        pageLoadingTitle: this.buildPageLoadingData(normalized).pageLoadingTitle,
        pageLoadingDescription: this.buildPageLoadingData(normalized).pageLoadingDescription,
      });
    }

    try {
      const session = await getSession();
      const user = extractSessionUser(session);
      if (!user || !user.id) {
        this.setData(this.buildGuestState(normalized));
        this.refreshTabBarLoginState();
        return;
      }

      let userName = resolveDisplayUserName(user);
      let userRegisterDateText = formatRegisterDateText(user && (user.created_at || user.createdAt));
      const isWechatLogin = isWechatMiniProgramAccount(user);
      const rawUserRole = String((user && user.role) || "").trim();
      let profileRole = "";

      try {
        const result = await dbQuery({
          table: "profiles",
          action: "select",
          columns: "name,role",
          filters: [{ column: "id", operator: "eq", value: user.id }],
          maybeSingle: true,
        });
        const profile = result ? result.data : null;
        if (profile && profile.name) {
          userName = normalizeWechatMiniDefaultName(profile.name, user) || userName;
        }
        if (profile && profile.role) {
          profileRole = String(profile.role).trim();
        }
      } catch (error) {
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

      const isAdmin = rawUserRole === "admin" && profileRole === "admin";
      const canChangePassword = !isWechatLogin;
      const nextState = {
        loading: false,
        isLoggedIn: true,
        isWechatLogin,
        isAdmin,
        userRole: isAdmin ? "admin" : "user",
        userName,
        userAvatarText: resolveAvatarText(userName),
        userPhone: "",
        userRegisterDateText,
        canChangePassword,
        pageLoadingTitle: this.buildPageLoadingData(normalized, { isLoggedIn: true }).pageLoadingTitle,
        pageLoadingDescription: this.buildPageLoadingData(normalized, { isLoggedIn: true }).pageLoadingDescription,
      };

      this.setData(
        Object.assign({}, nextState, {
          profileMenuItems: buildManagedProfileMenuItems(
            Object.assign({}, this.data, nextState),
            normalized
          ),
          guestMenuItems: buildManagedGuestProfileMenuItems({ wechatLoginEnabled: true }),
        })
      );
      this.refreshTabBarLoginState();
    } catch (error) {
      this.setData(this.buildGuestState(normalized));
      this.refreshTabBarLoginState();
    } finally {
      this._profileBootstrapped = true;
    }
  },

  goWechatLogin() {
    if (this.data.serviceMissing || this.data.wechatLoginSubmitting) return;
    this.openWechatLegalModal();
  },

  goEditProfile() {
    wx.navigateTo({ url: "/pages/profile/edit/index" });
  },

  goBookings() {
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
        wx.showToast({ title: "进入内测功能失败，请重试", icon: "none" });
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

  onProfileMenuTap(e) {
    const dataset = e && e.currentTarget ? e.currentTarget.dataset : {};
    const action = toText(dataset && dataset.action);
    if (!action) return;
    if (typeof this[action] === "function") {
      this[action]();
    }
  },

  async logout() {
    try {
      await logout();
    } catch (error) {
      // ignore
    } finally {
      clearStoredCookie();
      const runtimeConfig =
        typeof getApp === "function" && getApp() && getApp().globalData
          ? getApp().globalData.runtimeConfig
          : null;
      this.setData(this.buildGuestState(runtimeConfig));
      this.refreshTabBarLoginState();
      wx.showToast({ title: "已退出登录", icon: "none" });
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
