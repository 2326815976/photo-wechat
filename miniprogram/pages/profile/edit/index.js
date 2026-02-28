const { getSession, dbQuery, extractSessionUser } = require("../../../services/photo-api");
const {
  clampChinaMobileInput,
  isValidChinaMobile,
  normalizeChinaMobile,
} = require("../../../utils/phone");

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

  onLoad() {
    const app = getApp();
    const globalData = app && app.globalData ? app.globalData : {};
    const safeTop = Number(globalData.statusBarHeight || 0);
    const serviceMissing = !String(globalData.cloudRunService || "").trim();
    this.setData({
      safeTop,
      serviceMissing,
      hideAudit: Boolean(globalData.hideAudit),
    });

    if (app && typeof app.subscribeAuditConfig === "function") {
      this._unsubscribeAuditConfig = app.subscribeAuditConfig((hideAudit) => {
        this.setData({ hideAudit: Boolean(hideAudit) });
      });
    }

    if (!serviceMissing) {
      this.loadProfile();
    } else {
      this.setData({ loading: false });
    }
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
      this.setData({
        loading: false,
        formData: {
          name: profile && profile.name ? String(profile.name) : "",
          phone: profile && profile.phone ? String(profile.phone) : "",
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

      const profileValues = {
        name,
        phone: phone || null,
        wechat: wechat || null,
      };

      const updatePayload = {
        table: "profiles",
        action: "update",
        values: profileValues,
        filters: [{ column: "id", operator: "eq", value: user.id }],
        selectAfterWrite: true,
        maybeSingle: true,
        columns: "id",
      };
      let updateRes = await dbQuery(updatePayload);
      if (updateRes && updateRes.error) {
        const msg = String(updateRes.error.message || "保存失败，请重试");
        this.setData({ error: `保存失败：${msg}` });
        return;
      }

      if (!updateRes || !updateRes.data) {
        const insertRes = await dbQuery({
          table: "profiles",
          action: "insert",
          values: Object.assign({ id: user.id }, profileValues),
          selectAfterWrite: true,
          maybeSingle: true,
          columns: "id",
        });
        if (insertRes && insertRes.error) {
          const insertMessage = String(insertRes.error.message || "").toLowerCase();
          const duplicated =
            insertMessage.includes("duplicate") ||
            insertMessage.includes("already exists") ||
            insertMessage.includes("23505") ||
            insertMessage.includes("1062");
          if (!duplicated) {
            const msg = String(insertRes.error.message || "保存失败，请重试");
            this.setData({ error: `保存失败：${msg}` });
            return;
          }

          // 并发创建场景：插入冲突后再重试一次更新
          updateRes = await dbQuery(updatePayload);
          if (updateRes && updateRes.error) {
            const msg = String(updateRes.error.message || "保存失败，请重试");
            this.setData({ error: `保存失败：${msg}` });
            return;
          }
          if (!updateRes || !updateRes.data) {
            this.setData({ error: "保存失败：请稍后重试" });
            return;
          }
        } else if (!insertRes || !insertRes.data) {
          this.setData({ error: "保存失败：请稍后重试" });
          return;
        }
      }

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
