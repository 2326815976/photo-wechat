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

function trimOptionalText(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text) {
    return "";
  }
  const normalized = text.toLowerCase();
  if (normalized === "null" || normalized === "undefined" || normalized === "nil" || normalized === "none") {
    return "";
  }
  return text;
}

function canUseWechatNicknameInput() {
  return typeof wx !== "undefined" && typeof wx.canIUse === "function" && wx.canIUse("input.type.nickname");
}

function isGenericWechatNickname(value) {
  const text = trimText(value);
  const normalized = text.toLowerCase();
  return text === "微信用户" || normalized === "wechat user";
}

function readInputField(event) {
  const dataset = event && event.currentTarget ? event.currentTarget.dataset : null;
  return trimText(dataset && dataset.field);
}

function normalizeFormValue(field, rawValue) {
  return field === "phone" ? clampChinaMobileInput(rawValue) : String(rawValue == null ? "" : rawValue);
}

function readErrorMessage(error, fallback) {
  if (error && typeof error === "object") {
    const message = trimText(error.message);
    if (message) {
      return message;
    }
  }
  return String(fallback || "请求失败");
}

function isTransientBackendError(error) {
  const code = trimText(error && error.code).toUpperCase();
  const message = readErrorMessage(error, "").toLowerCase();
  return (
    code === "TRANSIENT_BACKEND" ||
    message.includes("服务暂时不可用") ||
    message.includes("服务异常") ||
    message.includes("temporarily unavailable") ||
    message.includes("database connection failed")
  );
}

async function loadProfileRecord(userId) {
  const result = await dbQuery({
    table: "profiles",
    action: "select",
    columns: "name,phone,wechat",
    filters: [{ column: "id", operator: "eq", value: userId }],
    maybeSingle: true,
  });
  return result ? result.data : null;
}

Page({
  data: {
    safeTop: 0,
    serviceMissing: false,
    hideAudit: false,
    loading: true,
    saving: false,
    supportsWechatNicknameInput: true,
    nameInputFocus: false,
    success: false,
    error: "",
    focusField: "",
    pageTitle: "编辑个人资料",
    pageSubtitle: "仅支持修改用户名、手机号和微信号",
    formData: {
      name: "",
      phone: "",
      wechat: "",
    },
  },

  async onLoad() {
    const app = typeof getApp === "function" ? getApp() : null;
    const globalData = app && app.globalData ? app.globalData : {};
    const safeTop = Number(globalData.statusBarHeight || 0);
    const serviceMissing = !trimText(globalData.cloudRunService);
    const hideAudit = Boolean(globalData.runtimeConfig && globalData.runtimeConfig.hideAudit);

    this.setData({
      safeTop,
      serviceMissing,
      hideAudit,
      supportsWechatNicknameInput: canUseWechatNicknameInput(),
    });

    if (app && typeof app.subscribeMiniProgramRuntimeConfig === "function") {
      this._unsubscribeAuditConfig = app.subscribeMiniProgramRuntimeConfig((nextRuntimeConfig) => {
        this.setData({ hideAudit: Boolean(nextRuntimeConfig && nextRuntimeConfig.hideAudit) });
      });
    }

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

  onUnload() {
    if (typeof this._unsubscribeAuditConfig === "function") {
      this._unsubscribeAuditConfig();
    }
    this._unsubscribeAuditConfig = null;
  },

  async guardManagedAccess() {
    const result = await guardMiniProgramPageAccess({
      pageKey: "profile-edit",
      fallbackTab: "pages/profile/index",
    });
    return !result.allowed;
  },

  async loadProfile() {
    this.setData({ loading: true, error: "" });

    try {
      const session = await getSession();
      const user = extractSessionUser(session);

      if (!user || !user.id) {
        this.setData({ loading: false });
        wx.showToast({ title: "请先登录", icon: "none" });
        wx.switchTab({ url: "/pages/profile/index" });
        return;
      }

      let profile = null;
      try {
        profile = await loadProfileRecord(user.id);
      } catch (error) {
        profile = null;
      }

      this.setData({
        loading: false,
        formData: {
          name: trimOptionalText(profile && profile.name) || trimOptionalText(user && user.name),
          phone: trimOptionalText(profile && profile.phone) || trimOptionalText(user && user.phone),
          wechat: trimOptionalText(profile && profile.wechat),
        },
      });
    } catch (error) {
      this.setData({
        loading: false,
        error: "加载个人资料失败",
      });
    }
  },

  onInput(event) {
    const field = readInputField(event);
    if (!field) {
      return;
    }

    const rawValue = event && event.detail ? event.detail.value : "";
    const value = normalizeFormValue(field, rawValue);
    this.setData({
      [`formData.${field}`]: value,
      error: "",
      success: false,
    });
  },

  onInputChange(event) {
    const field = readInputField(event);
    if (!field) {
      return;
    }

    const rawValue = event && event.detail ? event.detail.value : "";
    const value = normalizeFormValue(field, rawValue);
    this.setData({
      [`formData.${field}`]: value,
      error: "",
      success: false,
    });
  },

  onFieldFocus(event) {
    const field = readInputField(event);
    if (!field) {
      return;
    }
    this.setData({ focusField: field }, () => {
      if (field === "name") {
        this.onUseWechatNickname({
          refocus: false,
          silentUnsupported: true,
        });
      }
    });
  },

  onFieldBlur() {
    this.setData({
      focusField: "",
      nameInputFocus: false,
    });
  },

  onUseWechatNickname(options) {
    const config = options && typeof options === "object" ? options : {};
    const shouldRefocus = config.refocus !== false;
    const silentUnsupported = Boolean(config.silentUnsupported);
    if (!this.data.supportsWechatNicknameInput) {
      if (silentUnsupported) {
        return;
      }
      wx.showToast({ title: "当前微信版本不支持自动填写昵称", icon: "none" });
      return;
    }

    const currentName = trimText(this.data.formData.name);
    const nextName = isGenericWechatNickname(currentName) ? "" : currentName;
    const nextData = {
      error: "",
      success: false,
    };
    if (nextName !== this.data.formData.name) {
      nextData["formData.name"] = nextName;
    }

    if (!shouldRefocus) {
      this.setData(nextData);
      return;
    }

    nextData.nameInputFocus = false;
    this.setData(nextData, () => {
      setTimeout(() => {
        this.setData({ nameInputFocus: true });
      }, 30);
    });
  },

  async submit() {
    if (this.data.serviceMissing || this.data.saving) {
      return;
    }

    const name = trimText(this.data.formData.name);
    const rawPhone = trimOptionalText(this.data.formData.phone);
    const wechat = trimOptionalText(this.data.formData.wechat);

    if (!name) {
      this.setData({ error: "请输入用户名" });
      return;
    }

    if (rawPhone && !isValidChinaMobile(rawPhone)) {
      this.setData({ error: "请输入正确的手机号" });
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

      const response = await requestJson("/api/auth/update-user", {
        method: "POST",
        data: {
          name,
          phone: phone || null,
          wechat: wechat || null,
        },
      });

      if (response && response.error) {
        throw new Error(readErrorMessage(response.error, "保存失败"));
      }

      clearSessionCache();
      await getSession({ force: true }).catch(() => null);

      this.setData({ success: true });
      wx.showToast({ title: "保存成功", icon: "none" });

      setTimeout(() => {
        wx.navigateBack({
          delta: 1,
          fail: () => wx.switchTab({ url: "/pages/profile/index" }),
        });
      }, 1200);
    } catch (error) {
      const message = trimText(error && error.message);
      this.setData({
        error: isTransientBackendError(error)
          ? "服务暂时不可用，请稍后重试"
          : message || "保存失败，请稍后重试",
      });
    } finally {
      this.setData({ saving: false });
    }
  },
});
