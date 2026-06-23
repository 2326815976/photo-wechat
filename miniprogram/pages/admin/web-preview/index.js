const { requireAdminSession } = require("../../../services/photo-admin-api");

function decodeOptionText(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    return decodeURIComponent(raw);
  } catch (error) {
    return raw;
  }
}

function isSupportedPreviewUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

Page({
  data: {
    url: "",
    loading: true,
    errorMessage: "",
    fallbackRoute: "/pages/admin/page-center/index?channel=miniprogram",
  },

  onLoad(options) {
    void this.bootstrap(options);
  },

  async bootstrap(options) {
    const fallbackRoute =
      decodeOptionText(options && options.fallback_route) ||
      "/pages/admin/page-center/index?channel=miniprogram";

    this.setData({
      url: "",
      loading: true,
      errorMessage: "",
      fallbackRoute,
    });

    try {
      await requireAdminSession();

      const url = decodeOptionText(options && options.url);
      if (!url) {
        throw new Error("预览地址缺失");
      }
      if (!isSupportedPreviewUrl(url)) {
        throw new Error("预览地址格式不受支持");
      }

      this.setData({
        url,
        loading: false,
      });
    } catch (error) {
      this.setData({
        loading: false,
        errorMessage:
          error && error.message ? String(error.message) : "预览加载失败",
      });
    }
  },
});
