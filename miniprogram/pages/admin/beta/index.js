const {
  listAdminBetaRoutes,
  saveAdminBetaRoute,
  deleteAdminBetaRoute,
  listAdminBetaVersions,
  saveAdminBetaVersion,
  deleteAdminBetaVersion,
  generateAdminBetaFeatureCode,
} = require("../../../services/photo-admin-api");

const PRESET_ROUTE_OPTIONS = [
  { route_path: "/pages/index/index", route_title: "摆姿推荐" },
  { route_path: "/pages/gallery/index", route_title: "照片墙" },
  { route_path: "/pages/album/index", route_title: "相册提取" },
  { route_path: "/pages/profile/index", route_title: "我的" },
  { route_path: "/pages/profile/about/index", route_title: "关于页面" },
  { route_path: "/pages/booking/index", route_title: "约拍" },
  { route_path: "/pages/admin/index", route_title: "后台管理" },
];

function toErrorMessage(error, fallback) {
  if (error && typeof error === "object") {
    const message = String(error.message || "").trim();
    if (message) return message;
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return String(fallback || "操作失败");
}

function normalizeDbBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value || "").trim().toLowerCase();
  if (!text) return Boolean(fallback);
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return Boolean(fallback);
}

function parseDateTimeUTC8(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsed = new Date(`${raw}T00:00:00+08:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}$/.test(raw)) {
    const parsed = new Date(`${raw.replace(" ", "T")}+08:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatDateTime(value) {
  const parsed = parseDateTimeUTC8(value);
  if (!parsed) return "";
  const shifted = new Date(parsed.getTime() + 8 * 60 * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const month = pad2(shifted.getUTCMonth() + 1);
  const day = pad2(shifted.getUTCDate());
  const hour = pad2(shifted.getUTCHours());
  const minute = pad2(shifted.getUTCMinutes());
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function formatDateOnly(value) {
  const parsed = parseDateTimeUTC8(value);
  if (!parsed) return "";
  const shifted = new Date(parsed.getTime() + 8 * 60 * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const month = pad2(shifted.getUTCMonth() + 1);
  const day = pad2(shifted.getUTCDate());
  return `${year}-${month}-${day}`;
}

function normalizeRoutePath(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const normalized = raw.startsWith("/") ? raw : `/${raw}`;
  return normalized.slice(0, 255);
}

function buildRoutePresetRows(currentRoutePath) {
  const normalizedCurrent = normalizeRoutePath(currentRoutePath);
  const rows = PRESET_ROUTE_OPTIONS.map((item) => ({
    route_path: normalizeRoutePath(item && item.route_path),
    route_title: String((item && item.route_title) || "").trim(),
  })).filter((item) => item.route_path);

  if (normalizedCurrent && !rows.some((item) => item.route_path === normalizedCurrent)) {
    rows.unshift({
      route_path: normalizedCurrent,
      route_title: "历史路由（请核对）",
    });
  }
  return rows;
}

function resolveRoutePresetState(routePath, presetRows) {
  const rows = Array.isArray(presetRows) ? presetRows : [];
  if (!rows.length) {
    return {
      index: 0,
      previewTitle: "",
      previewPath: "",
      presetTitle: "",
    };
  }

  const normalizedPath = normalizeRoutePath(routePath);
  const matchedIndex = rows.findIndex((item) => item.route_path === normalizedPath);
  const nextIndex = matchedIndex >= 0 ? matchedIndex : 0;
  const selected = rows[nextIndex] || rows[0];
  return {
    index: nextIndex,
    previewTitle: String((selected && selected.route_title) || ""),
    previewPath: String((selected && selected.route_path) || ""),
    presetTitle: String((selected && selected.route_title) || ""),
  };
}

function buildDefaultRouteForm() {
  const presetRows = buildRoutePresetRows("");
  const firstRoute = presetRows[0] || null;
  return {
    id: 0,
    route_path: firstRoute ? firstRoute.route_path : "",
    route_title: firstRoute ? firstRoute.route_title : "",
    route_description: "",
    is_active: true,
  };
}

function buildDefaultVersionForm(routes) {
  const rows = Array.isArray(routes) ? routes : [];
  const firstRoute = rows.length > 0 ? rows[0] : null;
  return {
    id: "",
    feature_name: "",
    feature_description: "",
    feature_code: generateAdminBetaFeatureCode(10),
    route_id: firstRoute ? Number(firstRoute.id || 0) : 0,
    is_active: true,
    has_expiry: false,
    expires_date: "",
  };
}

Page({
  data: {
    safeTop: 0,
    loading: true,
    activeTab: "routes",

    routeRows: [],
    versionRows: [],

    routeModalOpen: false,
    routeModalMode: "create",
    routeSaving: false,
    routeForm: buildDefaultRouteForm(),
    routePresetRows: buildRoutePresetRows(""),
    routePresetIndex: 0,
    routePresetPreviewTitle: "",
    routePresetPreviewPath: "",
    routePresetLastTitle: "",

    routeDeleteConfirmOpen: false,
    routeDeletingId: 0,
    routeDeletingTitle: "",
    routeDeleting: false,

    versionModalOpen: false,
    versionModalMode: "create",
    versionSaving: false,
    versionForm: buildDefaultVersionForm([]),
    versionRoutePickerIndex: 0,
    versionRoutePreviewTitle: "",
    versionRoutePreviewPath: "",

    versionDeleteConfirmOpen: false,
    versionDeletingId: "",
    versionDeletingName: "",
    versionDeleting: false,
  },

  onLoad() {
    const app = getApp();
    const globalData = app && app.globalData ? app.globalData : {};
    this.setData({
      safeTop: Number(globalData.statusBarHeight || 0),
    });
  },

  onShow() {
    this.bootstrap();
  },

  onPullDownRefresh() {
    this.bootstrap().finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  async bootstrap() {
    this.setData({ loading: true });
    try {
      const [routes, versions] = await Promise.all([
        listAdminBetaRoutes(500),
        listAdminBetaVersions(500),
      ]);
      this.applyRows(routes, versions);
    } catch (error) {
      wx.showToast({
        title: toErrorMessage(error, "加载内测数据失败"),
        icon: "none",
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  applyRows(routes, versions) {
    const routeRows = (Array.isArray(routes) ? routes : []).map((row) => {
      const routeId = Number(row && row.id);
      const isActive = normalizeDbBoolean(row && row.is_active, true);
      return {
        id: Number.isInteger(routeId) ? routeId : 0,
        route_path: normalizeRoutePath(row && row.route_path),
        route_title: String((row && row.route_title) || "").trim(),
        route_description: String((row && row.route_description) || "").trim(),
        is_active: isActive,
        stateText: isActive ? "启用中" : "已停用",
        stateClass: isActive ? "route-state--active" : "route-state--inactive",
      };
    }).filter((row) => row.id > 0);

    const routeMap = new Map();
    routeRows.forEach((row) => {
      routeMap.set(row.id, row);
    });

    const now = Date.now();
    const versionRows = (Array.isArray(versions) ? versions : []).map((row) => {
      const versionId = String((row && row.id) || "").trim();
      if (!versionId) return null;
      const routeId = Number(row && row.route_id);
      const routeMeta = routeMap.get(routeId);
      const routePath = normalizeRoutePath(
        (row && row.route_path) || (routeMeta && routeMeta.route_path) || ""
      );
      const routeTitle = String(
        (row && row.route_title) || (routeMeta && routeMeta.route_title) || ""
      ).trim();
      const expiresAt = String((row && row.expires_at) || "").trim();
      const parsedExpiresAt = parseDateTimeUTC8(expiresAt);
      const isExpired = Boolean(parsedExpiresAt && parsedExpiresAt.getTime() < now);
      const isActive = normalizeDbBoolean(row && row.is_active, true);

      let stateText = "生效中";
      let stateClass = "version-state--active";
      if (!isActive) {
        stateText = "已停用";
        stateClass = "version-state--inactive";
      } else if (isExpired) {
        stateText = "已过期";
        stateClass = "version-state--expired";
      }

      return {
        id: versionId,
        feature_name: String((row && row.feature_name) || "").trim(),
        feature_description: String((row && row.feature_description) || "").trim(),
        feature_code: String((row && row.feature_code) || "").trim(),
        route_id: Number.isInteger(routeId) ? routeId : 0,
        route_path: routePath,
        route_title: routeTitle,
        is_active: isActive,
        expires_at: expiresAt,
        expires_date: formatDateOnly(expiresAt),
        expires_text: formatDateTime(expiresAt),
        is_expired: isExpired,
        stateText,
        stateClass,
      };
    }).filter(Boolean);

    const selectedRouteId = Number(this.data.versionForm && this.data.versionForm.route_id);
    const nextRouteIndex = Math.max(
      0,
      routeRows.findIndex((row) => row.id === selectedRouteId)
    );
    const previewRoute = routeRows[nextRouteIndex] || routeRows[0] || null;

    this.setData({
      routeRows,
      versionRows,
      versionRoutePickerIndex: nextRouteIndex,
      versionRoutePreviewTitle: previewRoute ? previewRoute.route_title : "",
      versionRoutePreviewPath: previewRoute ? previewRoute.route_path : "",
    });
  },

  onSwitchTab(e) {
    const tab =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.tab || "")
        : "";
    if (tab !== "routes" && tab !== "versions") return;
    this.setData({ activeTab: tab });
  },

  onOpenCreateRoute() {
    const routePresetRows = buildRoutePresetRows("");
    const routePresetState = resolveRoutePresetState("", routePresetRows);
    const routeForm = buildDefaultRouteForm();
    this.setData({
      routeModalOpen: true,
      routeModalMode: "create",
      routeForm,
      routePresetRows,
      routePresetIndex: routePresetState.index,
      routePresetPreviewTitle: routePresetState.previewTitle,
      routePresetPreviewPath: routePresetState.previewPath,
      routePresetLastTitle: routePresetState.presetTitle,
    });
  },

  onOpenEditRoute(e) {
    const routeId =
      e && e.currentTarget && e.currentTarget.dataset
        ? Number(e.currentTarget.dataset.id || 0)
        : 0;
    if (!routeId) return;
    const target = (this.data.routeRows || []).find((row) => row.id === routeId);
    if (!target) return;
    const routePresetRows = buildRoutePresetRows(target.route_path);
    const routePresetState = resolveRoutePresetState(target.route_path, routePresetRows);

    this.setData({
      routeModalOpen: true,
      routeModalMode: "edit",
      routeForm: {
        id: target.id,
        route_path: target.route_path,
        route_title: target.route_title,
        route_description: target.route_description,
        is_active: target.is_active,
      },
      routePresetRows,
      routePresetIndex: routePresetState.index,
      routePresetPreviewTitle: routePresetState.previewTitle,
      routePresetPreviewPath: routePresetState.previewPath,
      routePresetLastTitle: routePresetState.presetTitle,
    });
  },

  onCloseRouteModal() {
    if (this.data.routeSaving) return;
    this.setData({
      routeModalOpen: false,
      routeModalMode: "create",
      routeForm: buildDefaultRouteForm(),
      routePresetRows: buildRoutePresetRows(""),
      routePresetIndex: 0,
      routePresetPreviewTitle: "",
      routePresetPreviewPath: "",
      routePresetLastTitle: "",
    });
  },

  onRouteInput(e) {
    const field =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.field || "")
        : "";
    if (!field) return;
    const value = e && e.detail ? String(e.detail.value || "") : "";

    this.setData({
      [`routeForm.${field}`]: value,
    });
  },

  onRoutePresetChange(e) {
    const index = e && e.detail ? Number(e.detail.value || 0) : 0;
    const rows = Array.isArray(this.data.routePresetRows) ? this.data.routePresetRows : [];
    if (!rows.length) return;

    const safeIndex = index >= 0 && index < rows.length ? index : 0;
    const selected = rows[safeIndex] || rows[0];
    const selectedPath = normalizeRoutePath(selected && selected.route_path);
    const selectedTitle = String((selected && selected.route_title) || "").trim();

    const currentTitle = String((this.data.routeForm && this.data.routeForm.route_title) || "").trim();
    const lastPresetTitle = String(this.data.routePresetLastTitle || "").trim();
    const shouldAutoFillTitle = !currentTitle || currentTitle === lastPresetTitle;

    const nextPatch = {
      routePresetIndex: safeIndex,
      routePresetPreviewTitle: selectedTitle,
      routePresetPreviewPath: selectedPath,
      routePresetLastTitle: selectedTitle,
      "routeForm.route_path": selectedPath,
    };
    if (shouldAutoFillTitle) {
      nextPatch["routeForm.route_title"] = selectedTitle;
    }

    this.setData(nextPatch);
  },

  onRouteActiveChange(e) {
    const checked = Boolean(e && e.detail && e.detail.value);
    this.setData({
      "routeForm.is_active": checked,
    });
  },

  async onSubmitRoute() {
    if (this.data.routeSaving) return;
    const form = this.data.routeForm || buildDefaultRouteForm();
    const routePath = normalizeRoutePath(form.route_path);
    const routeTitle = String(form.route_title || "").trim();

    if (!routePath) {
      wx.showToast({ title: "请选择功能路由", icon: "none" });
      return;
    }
    if (!routeTitle) {
      wx.showToast({ title: "请输入功能名称", icon: "none" });
      return;
    }

    this.setData({ routeSaving: true });
    try {
      await saveAdminBetaRoute({
        id: Number(form.id || 0),
        route_path: routePath,
        route_title: routeTitle,
        route_description: String(form.route_description || "").trim(),
        is_active: Boolean(form.is_active),
      });
      wx.showToast({
        title: this.data.routeModalMode === "edit" ? "路由已更新" : "路由已创建",
        icon: "none",
      });
      this.onCloseRouteModal();
      await this.bootstrap();
    } catch (error) {
      wx.showToast({ title: toErrorMessage(error, "保存内测路由失败"), icon: "none" });
    } finally {
      this.setData({ routeSaving: false });
    }
  },

  onOpenRouteDeleteConfirm(e) {
    const routeId =
      e && e.currentTarget && e.currentTarget.dataset
        ? Number(e.currentTarget.dataset.id || 0)
        : 0;
    if (!routeId) return;
    const target = (this.data.routeRows || []).find((row) => row.id === routeId);
    if (!target) return;

    this.setData({
      routeDeleteConfirmOpen: true,
      routeDeletingId: routeId,
      routeDeletingTitle: target.route_title,
    });
  },

  onCloseRouteDeleteConfirm() {
    if (this.data.routeDeleting) return;
    this.setData({
      routeDeleteConfirmOpen: false,
      routeDeletingId: 0,
      routeDeletingTitle: "",
    });
  },

  async onConfirmRouteDelete() {
    const routeId = Number(this.data.routeDeletingId || 0);
    if (!routeId || this.data.routeDeleting) return;

    this.setData({ routeDeleting: true });
    try {
      await deleteAdminBetaRoute(routeId);
      wx.showToast({ title: "路由已删除", icon: "none" });
      this.onCloseRouteDeleteConfirm();
      await this.bootstrap();
    } catch (error) {
      wx.showToast({ title: toErrorMessage(error, "删除内测路由失败"), icon: "none" });
    } finally {
      this.setData({ routeDeleting: false });
    }
  },

  onOpenCreateVersion() {
    const routes = this.data.routeRows || [];
    if (!routes.length) {
      wx.showToast({ title: "请先创建至少一个内测路由", icon: "none" });
      return;
    }

    this.setData({
      versionModalOpen: true,
      versionModalMode: "create",
      versionForm: buildDefaultVersionForm(routes),
      versionRoutePickerIndex: 0,
      versionRoutePreviewTitle: routes[0] ? routes[0].route_title : "",
      versionRoutePreviewPath: routes[0] ? routes[0].route_path : "",
    });
  },

  onOpenEditVersion(e) {
    const versionId =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!versionId) return;

    const target = (this.data.versionRows || []).find((row) => row.id === versionId);
    if (!target) return;

    this.setData({
      versionModalOpen: true,
      versionModalMode: "edit",
      versionForm: {
        id: target.id,
        feature_name: target.feature_name,
        feature_description: target.feature_description,
        feature_code: target.feature_code,
        route_id: target.route_id,
        is_active: target.is_active,
        has_expiry: Boolean(target.expires_date),
        expires_date: target.expires_date,
      },
      versionRoutePickerIndex: Math.max(
        0,
        (this.data.routeRows || []).findIndex((row) => row.id === Number(target.route_id || 0))
      ),
      versionRoutePreviewTitle: target.route_title || "",
      versionRoutePreviewPath: target.route_path || "",
    });
  },

  onCloseVersionModal() {
    if (this.data.versionSaving) return;
    this.setData({
      versionModalOpen: false,
      versionModalMode: "create",
      versionForm: buildDefaultVersionForm(this.data.routeRows || []),
      versionRoutePickerIndex: 0,
      versionRoutePreviewTitle: "",
      versionRoutePreviewPath: "",
    });
  },

  onVersionInput(e) {
    const field =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.field || "")
        : "";
    if (!field) return;
    const value = e && e.detail ? String(e.detail.value || "") : "";
    this.setData({
      [`versionForm.${field}`]: value,
    });
  },

  onVersionRouteChange(e) {
    const index = e && e.detail ? Number(e.detail.value || 0) : 0;
    const routes = this.data.routeRows || [];
    if (!routes.length) return;
    const target = routes[index] || routes[0];
    this.setData({
      "versionForm.route_id": Number(target.id || 0),
      versionRoutePickerIndex: index,
      versionRoutePreviewTitle: String(target.route_title || ""),
      versionRoutePreviewPath: String(target.route_path || ""),
    });
  },

  onVersionActiveChange(e) {
    this.setData({
      "versionForm.is_active": Boolean(e && e.detail && e.detail.value),
    });
  },

  onVersionExpirySwitch(e) {
    const checked = Boolean(e && e.detail && e.detail.value);
    const nextPatch = {
      "versionForm.has_expiry": checked,
    };
    if (!checked) {
      nextPatch["versionForm.expires_date"] = "";
    }
    this.setData(nextPatch);
  },

  onVersionExpiryDateChange(e) {
    const value = e && e.detail ? String(e.detail.value || "") : "";
    this.setData({
      "versionForm.expires_date": value,
    });
  },

  onGenerateVersionCode() {
    this.setData({
      "versionForm.feature_code": generateAdminBetaFeatureCode(10),
    });
  },

  async onSubmitVersion() {
    if (this.data.versionSaving) return;
    const form = this.data.versionForm || buildDefaultVersionForm(this.data.routeRows || []);
    const featureName = String(form.feature_name || "").trim();
    const featureCode = String(form.feature_code || "").trim().toUpperCase();
    const routeId = Number(form.route_id || 0);

    if (!featureName) {
      wx.showToast({ title: "请输入内测功能名称", icon: "none" });
      return;
    }
    if (!routeId || !Number.isInteger(routeId)) {
      wx.showToast({ title: "请选择功能路由", icon: "none" });
      return;
    }
    if (!featureCode) {
      wx.showToast({ title: "请输入内测码", icon: "none" });
      return;
    }
    if (Boolean(form.has_expiry) && !String(form.expires_date || "").trim()) {
      wx.showToast({ title: "请选择有效期日期", icon: "none" });
      return;
    }

    const expiresAt = Boolean(form.has_expiry)
      ? `${String(form.expires_date || "").trim()} 23:59:59`
      : null;

    this.setData({ versionSaving: true });
    try {
      await saveAdminBetaVersion({
        id: String(form.id || "").trim(),
        feature_name: featureName,
        feature_description: String(form.feature_description || "").trim(),
        feature_code: featureCode,
        route_id: routeId,
        is_active: Boolean(form.is_active),
        expires_at: expiresAt,
      });
      wx.showToast({
        title: this.data.versionModalMode === "edit" ? "版本已更新" : "版本已创建",
        icon: "none",
      });
      this.onCloseVersionModal();
      await this.bootstrap();
    } catch (error) {
      wx.showToast({ title: toErrorMessage(error, "保存内测版本失败"), icon: "none" });
    } finally {
      this.setData({ versionSaving: false });
    }
  },

  onOpenVersionDeleteConfirm(e) {
    const versionId =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!versionId) return;

    const target = (this.data.versionRows || []).find((row) => row.id === versionId);
    if (!target) return;

    this.setData({
      versionDeleteConfirmOpen: true,
      versionDeletingId: versionId,
      versionDeletingName: target.feature_name,
    });
  },

  onCloseVersionDeleteConfirm() {
    if (this.data.versionDeleting) return;
    this.setData({
      versionDeleteConfirmOpen: false,
      versionDeletingId: "",
      versionDeletingName: "",
    });
  },

  async onConfirmVersionDelete() {
    const versionId = String(this.data.versionDeletingId || "").trim();
    if (!versionId || this.data.versionDeleting) return;

    this.setData({ versionDeleting: true });
    try {
      await deleteAdminBetaVersion(versionId);
      wx.showToast({ title: "版本已删除", icon: "none" });
      this.onCloseVersionDeleteConfirm();
      await this.bootstrap();
    } catch (error) {
      wx.showToast({ title: toErrorMessage(error, "删除内测版本失败"), icon: "none" });
    } finally {
      this.setData({ versionDeleting: false });
    }
  },

  onCopyVersionCode(e) {
    const code =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.code || "").trim()
        : "";
    if (!code) return;
    wx.setClipboardData({
      data: code,
      success: () => {
        wx.showToast({ title: "内测码已复制", icon: "none" });
      },
      fail: () => {
        wx.showToast({ title: "复制失败，请重试", icon: "none" });
      },
    });
  },

  onStopPropagation() {},
});
