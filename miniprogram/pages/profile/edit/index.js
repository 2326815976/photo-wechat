const { getSession, dbQuery, requestJson, clearSessionCache, extractSessionUser } = require("../../../services/photo-api");
const {
  clampChinaMobileInput,
  isValidChinaMobile,
  normalizeChinaMobile,
} = require("../../../utils/phone");
const { normalizeRuntimeConfig } = require("../../../utils/runtime-config");
const { guardMiniProgramPageAccess } = require("../../../utils/page-access");

function trimOrEmpty(value) {
  return String(value || "").trim();
}

Page({
  data: {
    safeTop: 0,
    serviceMissing: false,
    hideAudit: false,

    loading: true,
    saving: false,
    success: false,
    error: "",
    focusField: "",

    formData: {
      name: "",
      phone: "",
      wechat: "",
    },
  },

  applyRuntimeConfig(runtimeConfig) {
    const normalized = normalizeRuntimeConfig(runtimeConfig);
    this.setData({ hideAudit: Boolean(normalized.hideAudit) });
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

    const blocked = await this.guardManagedAccess();
    if (blocked) {
      return;
    }

    if (!serviceMissing) {
      this.loadProfile();
    } else {
      this.setData({ loading: false });
    }
  },

  async onShow() {
    await this.guardManagedAccess();
  },

  async guardManagedAccess() {
    const result = await guardMiniProgramPageAccess({
      pageKey: "profile-edit",
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

  async loadProfile() {
    this.setData({ loading: true, error: "", success: false });
    try {
      const session = await getSession();
      const user = extractSessionUser(session);
      if (!user || !user.id) {
        this.setData({ loading: false });
        wx.showToast({ title: "请先登录", icon: "none" });
        wx.navigateTo({ url: "/pages/login/index" });
        return;
      }

      const r = await dbQuery({
        table: "profiles",
        action: "select",
        columns: "name,phone,wechat",
        filters: [{ column: "id", operator: "eq", value: user.id }],
        maybeSingle: true,
      });
      if (r && r.error) {
        this.setData({ loading: false, error: `加载失败：${String(r.error.message || "请稍后重试")}` });
        return;
      }

      const profile = r && r.data ? r.data : null;
      const fallbackName = trimOrEmpty(user && user.name);
      const fallbackPhone = trimOrEmpty(user && user.phone);
      this.setData({
        loading: false,
        formData: {
          name: profile && profile.name ? String(profile.name) : fallbackName,
          phone: profile && profile.phone ? String(profile.phone) : fallbackPhone,
          wechat: profile && profile.wechat ? String(profile.wechat) : "",
        },
      });
    } catch (e) {
      this.setData({ loading: false, error: "加载失败，请稍后重试" });
    }
  },

  onInput(e) {
    const field =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.field || "")
        : "";
    if (!field) return;
    const rawValue = e && e.detail ? e.detail.value : "";
    const value = field === "phone" ? clampChinaMobileInput(rawValue) : rawValue;
    this.setData({ [`formData.${field}`]: value });
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

  async submit() {
    if (this.data.serviceMissing) return;
    if (this.data.saving) return;

    const name = trimOrEmpty(this.data.formData.name);
    const rawPhone = trimOrEmpty(this.data.formData.phone);
    const wechat = trimOrEmpty(this.data.formData.wechat);

    if (!name) {
      this.setData({ error: "用户名不能为空" });
      return;
    }

    if (rawPhone && !isValidChinaMobile(rawPhone)) {
      this.setData({ error: "请输入有效的手机号" });
      return;
    }
    const phone = normalizeChinaMobile(rawPhone);

    this.setData({ saving: true, error: "" });
    try {
      const session = await getSession();
      const user = extractSessionUser(session);
      if (!user || !user.id) {
        this.setData({ error: "请先登录" });
        return;
      }

      await requestJson("/api/auth/update-user", {
        method: "POST",
        data: {
          name,
          phone: phone || null,
          wechat: wechat || null,
        },
      });
      clearSessionCache();
      await getSession({ force: true }).catch(() => null);

      this.setData({ success: true });
      setTimeout(() => {
        wx.navigateBack({
          delta: 1,
          fail: () => wx.switchTab({ url: "/pages/profile/index" }),
        });
      }, 1500);
    } catch (e) {
      const msg = String((e && e.message) || "");
      this.setData({ error: msg ? `保存失败：${msg}` : "保存失败，请重试" });
    } finally {
      this.setData({ saving: false });
    }
  },
});
