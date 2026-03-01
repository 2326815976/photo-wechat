const BOOKING_PAGE_PATH = "pages/booking/index";
const DEFAULT_TAB_LIST = [
  {
    pagePath: "pages/index/index",
    text: "首页",
    iconPath: "/images/tab/house.svg",
    selectedIconPath: "/images/tab/house-active.svg",
  },
  {
    pagePath: "pages/album/index",
    text: "返图",
    iconPath: "/images/tab/lock.svg",
    selectedIconPath: "/images/tab/lock-active.svg",
  },
  {
    pagePath: "pages/gallery/index",
    text: "照片墙",
    iconPath: "/images/tab/image.svg",
    selectedIconPath: "/images/tab/image-active.svg",
  },
  {
    pagePath: BOOKING_PAGE_PATH,
    text: "约拍",
    iconPath: "/images/tab/calendar.svg",
    selectedIconPath: "/images/tab/calendar-active.svg",
  },
  {
    pagePath: "pages/profile/index",
    text: "我的",
    iconPath: "/images/tab/user.svg",
    selectedIconPath: "/images/tab/user-active.svg",
  },
];
const HIDE_AUDIT_TAB_LIST = [
  {
    pagePath: "pages/gallery/index",
    text: "照片墙",
    iconPath: "/images/tab/image.svg",
    selectedIconPath: "/images/tab/image-active.svg",
  },
  {
    pagePath: "pages/album/index",
    text: "提取",
    iconPath: "/images/tab/lock.svg",
    selectedIconPath: "/images/tab/lock-active.svg",
  },
  {
    pagePath: "pages/profile/index",
    text: "关于",
    iconPath: "/images/tab/user.svg",
    selectedIconPath: "/images/tab/user-active.svg",
  },
];

Component({
  data: {
    selected: 0,
    selectedPath: "pages/index/index",
    visible: true,
    hideAudit: false,
    list: DEFAULT_TAB_LIST.slice(),
  },
  lifetimes: {
    attached() {
      const app = typeof getApp === "function" ? getApp() : null;
      const globalData = app && app.globalData ? app.globalData : {};
      const hideAudit = Boolean(globalData.hideAudit);
      this.applyAuditConfig(hideAudit);

      if (app && typeof app.subscribeAuditConfig === "function") {
        this._unsubscribeAuditConfig = app.subscribeAuditConfig((nextHideAudit) => {
          this.applyAuditConfig(Boolean(nextHideAudit));
        });
      }
    },
    detached() {
      if (typeof this._unsubscribeAuditConfig === "function") {
        this._unsubscribeAuditConfig();
      }
      this._unsubscribeAuditConfig = null;
    },
  },
  methods: {
    applyAuditConfig(hideAudit) {
      const nextHideAudit = Boolean(hideAudit);
      const nextList = nextHideAudit
        ? HIDE_AUDIT_TAB_LIST.slice()
        : DEFAULT_TAB_LIST.slice();

      const selectedPath = String(this.data.selectedPath || "")
        .trim()
        .replace(/^\/+/, "");
      const selectedIndex = Number(this.data.selected);

      let nextSelected = -1;
      if (selectedPath) {
        nextSelected = nextList.findIndex((item) => item.pagePath === selectedPath);
      }

      if (nextSelected < 0) {
        const safeIndex = Number.isFinite(selectedIndex) ? Math.round(selectedIndex) : 0;
        nextSelected =
          safeIndex >= 0 && safeIndex < nextList.length ? safeIndex : 0;
      }

      const nextSelectedPath = nextList[nextSelected]
        ? String(nextList[nextSelected].pagePath || "")
        : "";

      this.setData({
        hideAudit: nextHideAudit,
        list: nextList,
        selected: nextSelected,
        selectedPath: nextSelectedPath,
      });
    },

    switchTab(e) {
      const path = String(
        (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.path) || ""
      )
        .trim()
        .replace(/^\/+/, "");
      if (!path) return;

      const list = Array.isArray(this.data.list) ? this.data.list : [];
      const selectedPath = String(this.data.selectedPath || "").trim().replace(/^\/+/, "");
      const index = list.findIndex((item) => item.pagePath === path);

      if (selectedPath === path && index >= 0 && index === Number(this.data.selected)) {
        return;
      }

      if (index >= 0) {
        this.setData({ selected: index, selectedPath: path });
      } else {
        this.setData({ selectedPath: path });
      }

      wx.switchTab({ url: `/${path}` });
    },
  },
});
