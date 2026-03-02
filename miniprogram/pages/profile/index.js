const { getSession, dbQuery, logout, extractSessionUser } = require("../../services/photo-api");
const { clearStoredCookie } = require("../../utils/auth");
const { resolvePublicUrl } = require("../../utils/storage-url");

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

Page({
  data: {
    safeTop: 0,
    serviceMissing: false,
    hideAudit: false,
    showAuditAboutMode: false,

    loading: true,
    isLoggedIn: false,
    isAdmin: false,
    userRole: "",

    userName: "",
    userPhone: "",
    canChangePassword: false,

    aboutLoading: true,
    aboutError: "",
    savingDonationQr: false,
    hasDonationQrCode: false,
    about: Object.assign({}, DEFAULT_ABOUT),
  },

  onLoad() {
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

    if (app && typeof app.subscribeAuditConfig === "function") {
      this._unsubscribeAuditConfig = app.subscribeAuditConfig((hideAudit) => {
        const nextHideAudit = Boolean(hideAudit);
        this.setData({
          hideAudit: nextHideAudit,
          showAuditAboutMode: nextHideAudit ? this.data.showAuditAboutMode : false,
        });
        this.refreshCurrentModeData();
      });
    }

    this.refreshCurrentModeData();
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
    const hideAudit = Boolean(app && app.globalData && app.globalData.hideAudit);
    this.setData({
      hideAudit,
      showAuditAboutMode: hideAudit ? this.data.showAuditAboutMode : false,
    });

    this.syncTabBar("pages/profile/index");
    this.refreshCurrentModeData();
  },

  onUnload() {
    if (typeof this._unsubscribeAuditConfig === "function") {
      this._unsubscribeAuditConfig();
    }
    this._unsubscribeAuditConfig = null;
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

  refreshCurrentModeData() {
    if (this.data.serviceMissing) {
      this.setData({ loading: false, aboutLoading: false });
      return;
    }
    this.loadUser();
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
          isAdmin: false,
          userRole: "",
          userName: "",
          userPhone: "",
          canChangePassword: false,
          showAuditAboutMode: Boolean(this.data.hideAudit),
        });
        if (this.data.hideAudit) {
          this.loadAbout();
        }
        return;
      }

      let userName = String((user && user.phone) || "用户");
      let userPhone = String((user && user.phone) || "");
      const userRole = String((user && user.role) || "");

      // 尝试从 profiles 获取更友好的昵称
      try {
        const r = await dbQuery({
          table: "profiles",
          action: "select",
          columns: "name,phone",
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
      } catch (e) {
        // ignore
      }

      this.setData({
        loading: false,
        isLoggedIn: true,
        userRole,
        isAdmin: userRole === "admin",
        userName,
        userPhone,
        canChangePassword: !isWechatMiniProgramAccount(user),
        showAuditAboutMode: false,
      });
    } catch (e) {
      this.setData({
        loading: false,
        isLoggedIn: false,
        isAdmin: false,
        userRole: "",
        userName: "",
        userPhone: "",
        canChangePassword: false,
        showAuditAboutMode: Boolean(this.data.hideAudit),
      });
      if (this.data.hideAudit) {
        this.loadAbout();
      }
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
      clearStoredCookie();
      this.setData({
        isLoggedIn: false,
        isAdmin: false,
        userRole: "",
        userName: "",
        userPhone: "",
      });
      wx.showToast({ title: "已退出登录", icon: "none" });
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
