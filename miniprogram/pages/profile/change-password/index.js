const { getSession, loginWithPassword, dbQuery, extractSessionUser } = require("../../../services/photo-api");
const { requestJson } = require("../../../utils/cloudrun");
const { clearStoredCookie } = require("../../../utils/auth");

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

function readPayloadMessage(payload, fallback) {
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") break;
    const message = String(current.message || "").trim();
    if (message) return message;
    const error = current.error;
    if (typeof error === "string" && error.trim()) {
      return error.trim();
    }
    if (error && typeof error === "object") {
      const nested = String(error.message || "").trim();
      if (nested) return nested;
    }
    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }
  return String(fallback || "操作失败");
}

function hasPayloadFailure(payload) {
  if (payload === false) return true;
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") break;
    if (current.error) return true;
    if (Object.prototype.hasOwnProperty.call(current, "success") && current.success === false) return true;
    if (Object.prototype.hasOwnProperty.call(current, "ok") && current.ok === false) return true;
    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }
  return false;
}

Page({
  data: {
    safeTop: 0,
    serviceMissing: false,

    formData: {
      currentPassword: "",
      newPassword: "",
      confirmPassword: "",
    },
    isLoading: false,
    error: "",
    showSuccess: false,
    showCurrentPassword: false,
    showNewPassword: false,
    showConfirmPassword: false,
    focusField: "",
  },

  onLoad() {
    const app = getApp();
    const globalData = app && app.globalData ? app.globalData : {};
    const safeTop = Number(globalData.statusBarHeight || 0);
    const serviceMissing = !String(globalData.cloudRunService || "").trim();
    this.setData({ safeTop, serviceMissing });
  },

  goBack() {
    const pages = getCurrentPages();
    const canNavigateBack = Array.isArray(pages) && pages.length > 1;

    if (canNavigateBack) {
      wx.navigateBack({
        delta: 1,
        fail: () => {
          wx.switchTab({
            url: "/pages/profile/index",
            fail: () => {
              wx.reLaunch({ url: "/pages/profile/index" });
            },
          });
        },
      });
      return;
    }

    wx.switchTab({
      url: "/pages/profile/index",
      fail: () => {
        wx.reLaunch({ url: "/pages/profile/index" });
      },
    });
  },

  onInput(e) {
    const field =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.field || "")
        : "";
    if (!field) return;
    const value = e && e.detail ? e.detail.value : "";
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

  togglePassword(e) {
    const key =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.key || "")
        : "";
    if (!key) return;
    this.setData({ [key]: !this.data[key] });
  },

  async submit() {
    if (this.data.serviceMissing) return;
    if (this.data.isLoading) return;

    const currentPassword = String(this.data.formData.currentPassword || "");
    const newPassword = String(this.data.formData.newPassword || "");
    const confirmPassword = String(this.data.formData.confirmPassword || "");

    if (newPassword !== confirmPassword) {
      this.setData({ error: "两次密码输入不一致" });
      return;
    }

    if (newPassword.length < 6) {
      this.setData({ error: "密码长度至少为 6 位" });
      return;
    }

    if (currentPassword === newPassword) {
      this.setData({ error: "新密码不能与当前密码相同" });
      return;
    }

    this.setData({ isLoading: true, error: "" });
    try {
      const session = await getSession();
      const user = extractSessionUser(session);
      if (!user || !user.id) {
        this.setData({ error: "请先登录" });
        return;
      }

      let phone = String(user.phone || "").trim();
      if (!phone) {
        try {
          const profileResult = await dbQuery({
            table: "profiles",
            action: "select",
            columns: "phone",
            filters: [{ column: "id", operator: "eq", value: user.id }],
            maybeSingle: true,
          });
          if (!(profileResult && profileResult.error)) {
            phone = String((profileResult && profileResult.data && profileResult.data.phone) || "").trim();
          }
        } catch (e) {
          // ignore
        }
      }
      if (!phone) {
        this.setData({ error: "未找到用户手机号" });
        return;
      }

      // 验证当前密码
      const verifyResult = await loginWithPassword(phone, currentPassword);
      const verifyUser = extractAuthUserFromPayload(verifyResult);
      if (!verifyUser) {
        this.setData({ error: "当前密码错误" });
        return;
      }

      // 更新新密码
      const r = await requestJson("/api/auth/update-user", {
        method: "POST",
        data: { password: newPassword },
      });

      if (hasPayloadFailure(r)) {
        const msg = readPayloadMessage(r, "修改失败");
        this.setData({ error: msg });
        return;
      }

      this.setData({ showSuccess: true });
      setTimeout(() => {
        clearStoredCookie();
        wx.reLaunch({ url: "/pages/login/index" });
      }, 2000);
    } catch (e) {
      const msg = String((e && e.message) || "");
      if (msg.toLowerCase().includes("invalid login credentials")) {
        this.setData({ error: "当前密码错误" });
      } else {
        this.setData({ error: "密码修改失败，请稍后重试" });
      }
    } finally {
      this.setData({ isLoading: false });
    }
  },
});
