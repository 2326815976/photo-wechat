const { getSession, dbQuery, logout, extractSessionUser } = require("../../services/photo-api");
const { clearStoredCookie } = require("../../utils/auth");

Page({
  data: {
    safeTop: 0,
    serviceMissing: false,
    hideAudit: false,

    loading: true,
    isLoggedIn: false,
    isAdmin: false,
    userRole: "",

    userName: "",
    userPhone: "",
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
      this.loadUser();
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
    this.setData({
      hideAudit: Boolean(app && app.globalData && app.globalData.hideAudit),
    });

    this.syncTabBar("pages/profile/index");
    if (!this.data.serviceMissing) {
      this.loadUser();
    }
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
        });
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
      });
    } catch (e) {
      this.setData({
        loading: false,
        isLoggedIn: false,
        isAdmin: false,
        userRole: "",
        userName: "",
        userPhone: "",
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
});
