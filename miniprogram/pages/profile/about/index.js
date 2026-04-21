const { dbQuery } = require("../../../services/photo-api");
const { resolvePublicUrl } = require("../../../utils/storage-url");
const { guardMiniProgramPageAccess } = require("../../../utils/page-access");

const ABOUT_COLUMNS = "id,author_name,phone,wechat,email,donation_qr_code,author_message";
const EMPTY_ABOUT = {
  id: null,
  author_name: "",
  phone: "",
  wechat: "",
  email: "",
  donation_qr_code: "",
  author_message: "",
};

const CONTACT_ICON_MAP = {
  phone: "/images/icons/phone-yellow.svg",
  wechat: "/images/icons/message-square-yellow.svg",
  email: "/images/icons/message-square-yellow.svg",
};

function toText(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text) return "";
  const normalized = text.toLowerCase();
  return normalized === "null" || normalized === "undefined" || normalized === "nil" || normalized === "none"
    ? ""
    : text;
}

function toMessageText(value) {
  const raw = String(value == null ? "" : value);
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const normalized = trimmed.toLowerCase();
  if (
    normalized === "null" ||
    normalized === "undefined" ||
    normalized === "nil" ||
    normalized === "none"
  ) {
    return "";
  }
  return raw.replace(/\r\n/g, "\n");
}

function readErrorMessage(error, fallback) {
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }

  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") break;

    const message = toText(current.message);
    if (message) {
      return message;
    }

    if (typeof current.error === "string" && toText(current.error)) {
      return toText(current.error);
    }

    current =
      current.error && typeof current.error === "object"
        ? current.error
        : current.data && typeof current.data === "object"
          ? current.data
          : null;
  }

  return toText(fallback || "请求失败") || "请求失败";
}

function isColumnMissingError(error, columnName) {
  const message = readErrorMessage(error, "").toLowerCase();
  const column = toText(columnName).toLowerCase();
  if (!message || !column) {
    return false;
  }

  return (
    message.includes(column) &&
    (
      message.includes("unknown column") ||
      message.includes("does not exist") ||
      message.includes("could not find") ||
      (message.includes("column") && message.includes("not found"))
    )
  );
}

function normalizeAboutRecord(row) {
  const source = row && typeof row === "object" ? row : {};
  const rawId = Number(source.id || 0);
  return {
    id: Number.isFinite(rawId) && rawId > 0 ? rawId : null,
    author_name: toText(source.author_name),
    phone: toText(source.phone),
    wechat: toText(source.wechat),
    email: toText(source.email),
    donation_qr_code: resolvePublicUrl(source.donation_qr_code),
    author_message: toMessageText(source.author_message),
  };
}

function readSingleRow(data) {
  if (Array.isArray(data)) {
    return data[0] || null;
  }
  return data && typeof data === "object" ? data : null;
}

function buildContactItems(about) {
  const source = about && typeof about === "object" ? about : EMPTY_ABOUT;
  return [
    {
      key: "phone",
      label: "手机号",
      value: source.phone,
      iconSrc: CONTACT_ICON_MAP.phone,
      breakAll: false,
    },
    {
      key: "wechat",
      label: "微信号",
      value: source.wechat,
      iconSrc: CONTACT_ICON_MAP.wechat,
      breakAll: false,
    },
    {
      key: "email",
      label: "邮箱",
      value: source.email,
      iconSrc: CONTACT_ICON_MAP.email,
      breakAll: true,
    },
  ].filter((item) => item.value);
}

function buildAboutViewState(about, loadError) {
  const current = about && typeof about === "object" ? about : EMPTY_ABOUT;
  const contactItems = buildContactItems(current);
  const authorName = current.author_name || "拾光谣";
  const authorInitial = authorName.slice(0, 1) || "谣";
  const hasContent = Boolean(
    current.author_name ||
      current.author_message ||
      contactItems.length > 0 ||
      current.donation_qr_code
  );

  return {
    about: current,
    authorName,
    authorInitial,
    contactItems,
    hasContent,
    showEmptyState: !hasContent && !toText(loadError),
  };
}

async function queryAboutSettings() {
  let result = await dbQuery({
    table: "about_settings",
    action: "select",
    columns: ABOUT_COLUMNS,
    orders: [
      { column: "updated_at", ascending: false },
      { column: "id", ascending: false },
    ],
    limit: 1,
    maybeSingle: true,
  });

  if (result && result.error && isColumnMissingError(result.error, "updated_at")) {
    result = await dbQuery({
      table: "about_settings",
      action: "select",
      columns: ABOUT_COLUMNS,
      orders: [{ column: "id", ascending: false }],
      limit: 1,
      maybeSingle: true,
    });
  }

  if (result && result.error) {
    throw new Error(readErrorMessage(result.error, "加载关于信息失败"));
  }

  return normalizeAboutRecord(readSingleRow(result && result.data));
}

Page({
  data: Object.assign(
    {
      serviceMissing: false,
      loading: true,
      loadError: "",
      actionNoticeType: "",
      actionNoticeMessage: "",
    },
    buildAboutViewState(EMPTY_ABOUT, "")
  ),

  async onLoad() {
    this._bootstrapped = false;
    const managedBlocked = await this.syncManagedAccess();
    if (managedBlocked) {
      return;
    }

    const app = typeof getApp === "function" ? getApp() : null;
    const globalData = app && app.globalData ? app.globalData : {};
    const serviceMissing = !toText(globalData.cloudRunService);
    this.setData({ serviceMissing });

    if (serviceMissing) {
      this.setData({ loading: false });
      return;
    }

    await this.loadAbout();
  },

  async onShow() {
    const managedBlocked = await this.syncManagedAccess();
    if (managedBlocked) {
      return;
    }

    if (!this.data.serviceMissing && !this._bootstrapped) {
      await this.loadAbout();
    }
  },

  onHide() {
    this.clearActionNoticeTimer();
  },

  onUnload() {
    this.clearActionNoticeTimer();
  },

  noop() {},

  async syncManagedAccess() {
    const result = await guardMiniProgramPageAccess({
      pageKey: "about",
      fallbackTab: "pages/profile/index",
    });
    return !result.allowed;
  },

  clearActionNoticeTimer() {
    if (this._actionNoticeTimer) {
      clearTimeout(this._actionNoticeTimer);
      this._actionNoticeTimer = null;
    }
  },

  showActionNotice(message, type) {
    this.clearActionNoticeTimer();
    this.setData({
      actionNoticeType: toText(type) || "success",
      actionNoticeMessage: toText(message),
    });

    this._actionNoticeTimer = setTimeout(() => {
      this.setData({
        actionNoticeType: "",
        actionNoticeMessage: "",
      });
      this._actionNoticeTimer = null;
    }, 2600);
  },

  async loadAbout() {
    this.setData({
      loading: true,
      loadError: "",
      actionNoticeType: "",
      actionNoticeMessage: "",
    });

    try {
      const about = await queryAboutSettings();
      this._bootstrapped = true;
      this.setData(
        Object.assign(
          {
            loading: false,
            loadError: "",
          },
          buildAboutViewState(about, "")
        )
      );
    } catch (error) {
      const loadError = readErrorMessage(error, "加载关于信息失败");
      this._bootstrapped = true;
      this.setData(
        Object.assign(
          {
            loading: false,
            loadError,
          },
          buildAboutViewState(EMPTY_ABOUT, loadError)
        )
      );
    }
  },

  onCopyContact(e) {
    const dataset = e && e.currentTarget ? e.currentTarget.dataset : {};
    const label = toText(dataset.label) || "内容";
    const value = toText(dataset.value);
    if (!value) {
      this.showActionNotice(`暂无可复制${label}`, "error");
      return;
    }

    wx.setClipboardData({
      data: value,
      success: () => {
        this.showActionNotice(`${label}已复制`, "success");
      },
      fail: () => {
        this.showActionNotice(`${label}复制失败，请稍后重试`, "error");
      },
    });
  },

  onPreviewDonationQr() {
    const url = toText(this.data.about && this.data.about.donation_qr_code);
    if (!url) {
      this.showActionNotice("暂无赞赏码", "error");
      return;
    }

    wx.previewImage({
      current: url,
      urls: [url],
      fail: () => {
        this.showActionNotice("预览赞赏码失败，请稍后重试", "error");
      },
    });
  },
});
