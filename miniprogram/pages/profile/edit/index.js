const {
  getSession,
  dbQuery,
  requestJson,
  clearSessionCache,
  extractSessionUser,
} = require("../../../services/photo-api");
const {
  clampChinaMobileInput,
  isValidChinaMobile,
  normalizeChinaMobile,
} = require("../../../utils/phone");
const { guardMiniProgramPageAccess } = require("../../../utils/page-access");

function trimText(value) {
  return String(value || "").trim();
}

function buildFormData(profile, user) {
  return {
    name: trimText(profile && profile.name) || trimText(user && user.name),
    phone: trimText(profile && profile.phone) || trimText(user && user.phone),
    wechat: trimText(profile && profile.wechat),
  };
}

Page({
  data: {
    serviceMissing: false,
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

  async onLoad() {
    const app = typeof getApp === "function" ? getApp() : null;
    const globalData = app && app.globalData ? app.globalData : {};
    const serviceMissing = !trimText(globalData.cloudRunService);

    this.setData({ serviceMissing });

    const blocked = await this.guardManagedAccess();
    if (blocked) {
      return;
    }

    if (serviceMissing) {
      this.setData({ loading: false });
      return;
    }

    await this.loadProfile();
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

  onInput(event) {
    const dataset = event && event.currentTarget ? event.currentTarget.dataset : null;
    const field = trimText(dataset && dataset.field);
    if (!field) {
      return;
    }

    const rawValue = event && event.detail ? event.detail.value : "";
    const value = field === "phone" ? clampChinaMobileInput(rawValue) : rawValue;
    this.setData({ [`formData.${field}`]: value });
  },

  onFieldFocus(event) {
    const dataset = event && event.currentTarget ? event.currentTarget.dataset : null;
    this.setData({ focusField: trimText(dataset && dataset.field) });
  },

  onFieldBlur() {
    this.setData({ focusField: "" });
  },

  async loadProfile() {
    this.setData({
      loading: true,
      success: false,
      error: "",
    });

    try {
      const session = await getSession();
      const user = extractSessionUser(session);

      if (!user || !user.id) {
        this.setData({ loading: false });
        wx.showToast({ title: "请先登录", icon: "none" });
        wx.switchTab({ url: "/pages/profile/index" });
        return;
      }

      const response = await dbQuery({
        table: "profiles",
        action: "select",
        columns: "name,phone,wechat",
        filters: [{ column: "id", operator: "eq", value: user.id }],
        maybeSingle: true,
      });

      if (response && response.error) {
        this.setData({
          loading: false,
          error: `加载失败：${String(response.error.message || "请稍后重试")}`,
        });
        return;
      }

      this.setData({
        loading: false,
        formData: buildFormData(response && response.data, user),
      });
    } catch (error) {
      this.setData({
        loading: false,
        error: "加载失败，请稍后重试",
      });
    }
  },

  async submit() {
    if (this.data.serviceMissing || this.data.saving) {
      return;
    }

    const name = trimText(this.data.formData.name);
    const rawPhone = trimText(this.data.formData.phone);
    const wechat = trimText(this.data.formData.wechat);

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

      this.setData({
        success: true,
      });

      setTimeout(() => {
        wx.navigateBack({
          delta: 1,
          fail: () => wx.switchTab({ url: "/pages/profile/index" }),
        });
      }, 1200);
    } catch (error) {
      const message = trimText(error && error.message);
      this.setData({
        error: message ? `保存失败：${message}` : "保存失败，请重试",
      });
    } finally {
      this.setData({ saving: false });
    }
  },
});
