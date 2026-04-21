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

const WECHAT_MINIPROGRAM_EMAIL_SUFFIX = "@wechat.miniprogram.local";
const WECHAT_MINIPROGRAM_DEFAULT_NAME = "拾光者";
const WECHAT_MINIPROGRAM_LEGACY_DEFAULT_NAMES = new Set([
  "微信用户",
  WECHAT_MINIPROGRAM_DEFAULT_NAME,
]);

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

function normalizeWechatMiniDefaultName(name, user) {
  const normalizedName = trimText(name);
  if (!isWechatMiniProgramAccount(user)) {
    return normalizedName;
  }
  if (!normalizedName || WECHAT_MINIPROGRAM_LEGACY_DEFAULT_NAMES.has(normalizedName)) {
    return WECHAT_MINIPROGRAM_DEFAULT_NAME;
  }
  return normalizedName;
}

function buildFormData(profile, user) {
  return {
    name:
      normalizeWechatMiniDefaultName(profile && profile.name, user) ||
      normalizeWechatMiniDefaultName(user && user.name, user),
    phone: trimOptionalText(profile && profile.phone) || trimOptionalText(user && user.phone),
    wechat: trimOptionalText(profile && profile.wechat),
  };
}

function isWechatMiniProgramAccount(user) {
  const email = trimText(user && user.email).toLowerCase();
  return email.endsWith(WECHAT_MINIPROGRAM_EMAIL_SUFFIX);
}

function readErrorMessage(error, fallback) {
  if (error && typeof error === "object") {
    const message = trimText(error.message);
    if (message) {
      return message;
    }
  }
  return String(fallback || "请稍后重试");
}

function isTransientBackendError(error) {
  const code = trimText(error && error.code).toUpperCase();
  const message = readErrorMessage(error, "").toLowerCase();
  return (
    code === "TRANSIENT_BACKEND" ||
    message.includes("服务暂时不可用") ||
    message.includes("服务正在恢复") ||
    message.includes("temporarily unavailable") ||
    message.includes("database connection failed")
  );
}

function canFallbackToProfileTable(user, nextPhone) {
  const currentPhone = normalizeChinaMobile(trimText(user && user.phone));
  return currentPhone === String(nextPhone || "");
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

  async saveProfileByTable(userId, payload) {
    const response = await dbQuery({
      table: "profiles",
      action: "update",
      values: {
        name: payload.name,
        phone: payload.phone,
        wechat: payload.wechat,
      },
      filters: [{ column: "id", operator: "eq", value: userId }],
    });

    if (response && response.error) {
      throw new Error(readErrorMessage(response.error, "请稍后重试"));
    }

    return response;
  },

  async saveProfileByAuthApi(payload) {
    return requestJson("/api/auth/update-user", {
      method: "POST",
      data: {
        name: payload.name,
        phone: payload.phone,
        wechat: payload.wechat,
      },
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

      const payload = {
        name,
        phone: phone || null,
        wechat: wechat || null,
      };

      if (isWechatMiniProgramAccount(user)) {
        await this.saveProfileByTable(user.id, payload);
      } else {
        try {
          await this.saveProfileByAuthApi(payload);
        } catch (error) {
          if (!isTransientBackendError(error) || !canFallbackToProfileTable(user, phone)) {
            throw error;
          }
          await this.saveProfileByTable(user.id, payload);
        }
      }

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
