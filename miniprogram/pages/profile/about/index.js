const { dbQuery } = require("../../../services/photo-api");
const { resolvePublicUrl } = require("../../../utils/storage-url");

const DEFAULT_ABOUT = {
  author_name: "",
  phone: "",
  wechat: "",
  email: "",
  donation_qr_code: "",
  author_message: "",
};

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
    loading: true,
    error: "",
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
    this.setData({ safeTop, serviceMissing, hideAudit });

    if (app && typeof app.subscribeAuditConfig === "function") {
      this._unsubscribeAuditConfig = app.subscribeAuditConfig((nextHideAudit) => {
        this.setData({ hideAudit: Boolean(nextHideAudit) });
      });
    }

    if (!serviceMissing) {
      this.loadAbout();
    } else {
      this.setData({ loading: false });
    }
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
    this.setData({ hideAudit });
  },

  onUnload() {
    if (typeof this._unsubscribeAuditConfig === "function") {
      this._unsubscribeAuditConfig();
    }
    this._unsubscribeAuditConfig = null;
  },

  async loadAbout() {
    this.setData({ loading: true, error: "" });
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
          loading: false,
          error: `加载失败：${String(result.error.message || "请稍后重试")}`,
          hasDonationQrCode: false,
          about: Object.assign({}, DEFAULT_ABOUT),
        });
        return;
      }

      const row = result && result.data ? result.data : null;
      if (!row) {
        this.setData({
          loading: false,
          hasDonationQrCode: false,
          about: Object.assign({}, DEFAULT_ABOUT),
        });
        return;
      }

      const donationQrCode = normalizeDonationQrCode(row.donation_qr_code);

      this.setData({
        loading: false,
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
        loading: false,
        error: `加载失败：${String((error && error.message) || "请稍后重试")}`,
        hasDonationQrCode: false,
        about: Object.assign({}, DEFAULT_ABOUT),
      });
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
});
