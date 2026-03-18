const {
  getSession,
  dbQuery,
  logout,
  extractSessionUser,
  loginWithMiniProgram,
} = require("../../services/photo-api");
const { clearStoredCookie } = require("../../utils/auth");
const { resolvePublicUrl } = require("../../utils/storage-url");
const { getLegalDocuments, getLegalDocumentByKey } = require("../../utils/legal-docs");

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
    isLoggedIn: false,
    isWechatLogin: false,
    isAdmin: false,
    userRole: "",

    userName: "",
    userPhone: "",
    userRegisterDateText: "",
    canChangePassword: false,

    aboutLoading: true,
    aboutError: "",
    savingDonationQr: false,
    hasDonationQrCode: false,
    about: Object.assign({}, DEFAULT_ABOUT),
  },

  onLoad() {
    this._profilePageBootstrapped = false;
    this._lastSeenAppEnterSeq = 0;
    const app = getApp();
    const globalData = app && app.globalData ? app.globalData : {};
    const safeTop = Number(globalData.statusBarHeight || 0);
    const serviceMissing = !String(globalData.cloudRunService || "").trim();
    const hideAudit = Boolean(globalData.hideAudit);
    this.setData({
      safeTop,
      serviceMissing,
      hideAudit,
      showAuditAboutMode: hideAudit,
    });
    this.initAuditLegalDocuments(hideAudit);

    if (app && typeof app.subscribeAuditConfig === "function") {
      this._unsubscribeAuditConfig = app.subscribeAuditConfig((hideAudit) => {
        const nextHideAudit = Boolean(hideAudit);
        this.setData({
          hideAudit: nextHideAudit,
          showAuditAboutMode: nextHideAudit ? this.data.showAuditAboutMode : false,
          showAuditLegalModal: nextHideAudit ? this.data.showAuditLegalModal : false,
        });
        this.initAuditLegalDocuments(nextHideAudit);
        this.refreshCurrentModeData();
      });
    }

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
    const hideAudit = Boolean(app && app.globalData && app.globalData.hideAudit);
    this.setData({
      hideAudit,
      showAuditAboutMode: hideAudit ? this.data.showAuditAboutMode : false,
    });
    this.initAuditLegalDocuments(hideAudit);

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

  initAuditLegalDocuments(hideAudit) {
    const nextHideAudit =
      typeof hideAudit === "boolean" ? hideAudit : Boolean(this.data.hideAudit);
    if (!nextHideAudit) {
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

    const docs = getLegalDocuments({ hideAudit: true });
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

  applyAuditLegalDocument(key, hideAudit) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) return false;
    const nextHideAudit =
      typeof hideAudit === "boolean" ? hideAudit : Boolean(this.data.hideAudit);
    if (!nextHideAudit) return false;

    const doc =
      (this.auditLegalDocMap && this.auditLegalDocMap[normalizedKey]) ||
      getLegalDocumentByKey(normalizedKey, { hideAudit: true });
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
    if (!this.data.hideAudit || !this.data.showAuditAboutMode || this.data.serviceMissing) return;
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

  async submitAuditWechatLogin() {
    if (!this.data.hideAudit || !this.data.showAuditAboutMode || this.data.serviceMissing) return;
    if (this.data.auditWechatSubmitting) return;

    this.setData({ auditWechatSubmitting: true });
    try {
      const loginRes = await wxLogin();
      const code = String((loginRes && loginRes.code) || "").trim();
      if (!code) {
        wx.showToast({ title: "未获取到微信登录凭证，请重试", icon: "none" });
        return;
      }

      const result = await loginWithMiniProgram(code);
      const user = extractAuthUserFromPayload(result);
      if (!user) {
        wx.showToast({ title: "微信登录失败，请稍后重试", icon: "none" });
        return;
      }

      const userRole = String((user && user.role) || "").trim();
      const userPhone = String((user && user.phone) || "").trim();
      const defaultName = userPhone || (this.data.hideAudit ? "拾光者" : "用户");
      const isAdmin = userRole === "admin";

      this.setData({
        loading: false,
        isLoggedIn: true,
        isWechatLogin: true,
        isAdmin,
        userRole,
        userName: defaultName,
        userPhone,
        userRegisterDateText: formatRegisterDateText(user && user.created_at),
        canChangePassword: !isWechatMiniProgramAccount(user),
        showAuditAboutMode: false,
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

  async loadUser() {
    this.setData({ loading: true });
    try {
      const session = await getSession();
      const user = extractSessionUser(session);
      if (!user || !user.id) {
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
          showAuditAboutMode: Boolean(this.data.hideAudit),
        });
        this.refreshTabBarLoginState();
        if (this.data.hideAudit) {
          this.loadAbout();
        }
        return;
      }

      let userName = String((user && user.phone) || (this.data.hideAudit ? "拾光者" : "用户"));
      let userPhone = String((user && user.phone) || "");
      let userRegisterDateText = formatRegisterDateText(user && user.created_at);
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

      if (this.data.hideAudit) {
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
      });
      this.refreshTabBarLoginState();
    } catch (e) {
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
        showAuditAboutMode: Boolean(this.data.hideAudit),
      });
      this.refreshTabBarLoginState();
      if (this.data.hideAudit) {
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
          author_message: toOptionalText(row.author_message),
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

  goLogin() {
    wx.navigateTo({ url: "/pages/login/index" });
  },

  goRegister() {
    wx.navigateTo({ url: "/pages/register/index" });
  },

  goEditProfile() {
    wx.navigateTo({ url: "/pages/profile/edit/index" });
  },

  goBookings() {
    if (this.data.hideAudit) {
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
      const hideAudit = Boolean(this.data.hideAudit);
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
        showAuditAboutMode: hideAudit,
      });
      this.refreshTabBarLoginState();
      wx.showToast({ title: "已退出登录", icon: "none" });
      if (hideAudit) {
        this.loadAbout();
        wx.switchTab({ url: "/pages/profile/index" });
        return;
      }
      wx.navigateTo({ url: "/pages/login/index" });
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
