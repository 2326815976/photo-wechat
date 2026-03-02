const { dbRpc, getSession, extractSessionUser } = require("../../services/photo-api");
const { getCachedAlbumRootName, setCachedAlbumRootName } = require("../../utils/album-root-name-cache");
const { resolvePublicUrl } = require("../../utils/storage-url");

const SHARE_IMAGE_URL = "/images/share/shiguangyao-share.jpg";
const SHARE_TITLE = "拾光谣｜相册提取";

function parseDateTimeUTC8(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsed = new Date(`${raw}T00:00:00+08:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(raw)) {
    const parsed = new Date(`${raw.replace(" ", "T")}+08:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatDateSlashUTC8(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = pad2(shifted.getUTCMonth() + 1);
  const d = pad2(shifted.getUTCDate());
  return `${y}/${m}/${d}`;
}

function formatDate(dateStr) {
  const date = parseDateTimeUTC8(dateStr);
  if (!date) return "";
  return formatDateSlashUTC8(date);
}

function getDaysRemaining(expiresAt) {
  const expiry = parseDateTimeUTC8(expiresAt);
  if (!expiry) return 0;
  return Math.ceil((expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

function normalizeMaybeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const lowered = raw.toLowerCase();
  if (lowered === "null" || lowered === "undefined") return "";
  return resolvePublicUrl(raw);
}

function isTransientConnectionError(message) {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("connect timeout") ||
    normalized.includes("request timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("etimedout") ||
    normalized.includes("esockettimedout") ||
    normalized.includes("network")
  );
}

function hasExplicitRpcFailure(payload) {
  if (payload === false) return true;
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") break;
    if (current.error) return true;
    if (Object.prototype.hasOwnProperty.call(current, "success") && current.success === false) return true;
    if (Object.prototype.hasOwnProperty.call(current, "ok") && current.ok === false) return true;
    if (Object.prototype.hasOwnProperty.call(current, "deleted") && current.deleted === false) return true;
    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }
  return false;
}

function readRpcFailureMessage(payload) {
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") break;
    const directMessage = String(current.message || "").trim();
    if (directMessage) return directMessage;
    const directError = current.error;
    if (typeof directError === "string" && directError.trim()) {
      return directError.trim();
    }
    if (current.error && typeof current.error === "object") {
      const nestedErrorMessage = String(current.error.message || "").trim();
      if (nestedErrorMessage) return nestedErrorMessage;
    }
    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }
  return "";
}

function extractAlbumRows(payload) {
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (Array.isArray(current)) return current;
    if (!current || typeof current !== "object") break;
    if (Array.isArray(current.rows)) return current.rows;
    if (Array.isArray(current.list)) return current.list;
    if (Array.isArray(current.items)) return current.items;
    if (Array.isArray(current.albums)) return current.albums;
    if (Array.isArray(current.data)) return current.data;
    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }
  return [];
}

function resolveAlbumContentPayload(payload) {
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) break;
    if (
      Object.prototype.hasOwnProperty.call(current, "album") ||
      Object.prototype.hasOwnProperty.call(current, "photos") ||
      Object.prototype.hasOwnProperty.call(current, "folders")
    ) {
      return current;
    }
    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload;
  }
  return null;
}

function readRootFolderNameFromPayload(payload) {
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) break;

    const directName = String(current.root_folder_name || current.rootFolderName || "").trim();
    if (directName) return directName;

    const album = current.album;
    if (album && typeof album === "object" && !Array.isArray(album)) {
      const albumName = String(album.root_folder_name || album.rootFolderName || "").trim();
      if (albumName) return albumName;
    }

    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }
  return "";
}

Page({
  data: {
    safeTop: 0,
    serviceMissing: false,
    hideAudit: false,
    backendReady: false,
    backendReconnecting: false,

    pageLoading: true,
    isLoggedIn: false,
    boundAlbums: [],
    showKeyInput: false,

    accessKey: "",
    submitting: false,
    error: "",
    listNotice: null,
    unbindingAlbumId: "",
    unbindTargetAlbum: null,
  },

  onLoad() {
    const app = getApp();
    const globalData = app && app.globalData ? app.globalData : {};
    const safeTop = Number(globalData.statusBarHeight || 0);
    const serviceMissing = !String(globalData.cloudRunService || "").trim();
    const backendReady = serviceMissing ? true : Boolean(globalData.backendReady);
    const backendReconnecting = !backendReady && Boolean(globalData.backendReconnecting);
    this.setData({
      safeTop,
      serviceMissing,
      hideAudit: Boolean(globalData.hideAudit),
      backendReady,
      backendReconnecting,
    });

    if (app && typeof app.subscribeAuditConfig === "function") {
      this._unsubscribeAuditConfig = app.subscribeAuditConfig((hideAudit) => {
        this.setData({ hideAudit: Boolean(hideAudit) });
      });
    }
    if (app && typeof app.subscribeBackendStatus === "function") {
      this._unsubscribeBackendStatus = app.subscribeBackendStatus((status) => {
        const ready = Boolean(status && status.backendReady);
        const reconnecting = !ready && Boolean(status && status.backendReconnecting);
        this.setData({
          backendReady: ready,
          backendReconnecting: reconnecting,
        });
      });
    }
    if (!serviceMissing && !backendReady && app && typeof app.ensureBackendReady === "function") {
      this.setData({ pageLoading: true });
      void app.ensureBackendReady();
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

    this.syncTabBar("pages/album/index");
    if (!this.data.serviceMissing) {
      if (app && typeof app.ensureBackendReady === "function") {
        if (!this.data.backendReady) {
          this.setData({
            pageLoading: true,
            backendReconnecting: true,
          });
        }
        try {
          await app.ensureBackendReady();
        } catch (error) {
          // ignore
        }
      }
      const nextBackendReady = Boolean(app && app.globalData && app.globalData.backendReady);
      const nextBackendReconnecting = !nextBackendReady && Boolean(
        app && app.globalData && app.globalData.backendReconnecting
      );
      this.setData({
        backendReady: nextBackendReady,
        backendReconnecting: nextBackendReconnecting,
      });
      this.loadUserData();
    } else {
      this.setData({ pageLoading: false });
    }
  },

  onUnload() {
    if (this._listNoticeTimer) {
      clearTimeout(this._listNoticeTimer);
      this._listNoticeTimer = null;
    }
    if (typeof this._unsubscribeAuditConfig === "function") {
      this._unsubscribeAuditConfig();
    }
    this._unsubscribeAuditConfig = null;
    if (typeof this._unsubscribeBackendStatus === "function") {
      this._unsubscribeBackendStatus();
    }
    this._unsubscribeBackendStatus = null;
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

  noop() {},

  showListNotice(type, message, duration) {
    const finalType = type === "success" ? "success" : "error";
    const ttl = Math.max(1200, Number(duration || 3000));
    if (this._listNoticeTimer) {
      clearTimeout(this._listNoticeTimer);
      this._listNoticeTimer = null;
    }

    this.setData({
      listNotice: {
        type: finalType,
        message: String(message || "").trim(),
      },
    });

    this._listNoticeTimer = setTimeout(() => {
      this.setData({ listNotice: null });
      this._listNoticeTimer = null;
    }, ttl);
  },

  async loadUserData() {
    this.setData({ pageLoading: true, error: "", listNotice: null });

    try {
      let session;
      try {
        session = await getSession();
      } catch (firstError) {
        const firstMsg = String((firstError && firstError.message) || "").trim();
        const shouldRetry =
          isTransientConnectionError(firstMsg) ||
          firstMsg.toLowerCase().includes("database connection failed") ||
          firstMsg.toLowerCase().includes("invalidparameter");
        if (!shouldRetry) {
          throw firstError;
        }
        await new Promise((resolve) => setTimeout(resolve, 320));
        session = await getSession();
      }
      const user = extractSessionUser(session);
      const isLoggedIn = Boolean(user && user.id);

      if (!isLoggedIn) {
        this.setData({
          isLoggedIn: false,
          boundAlbums: [],
          pageLoading: false,
        });
        return;
      }

      const r = await dbRpc("get_user_bound_albums");
      const payload = r ? r.data : null;
      const albums = extractAlbumRows(payload);
      const rpcError = r && r.error ? String(r.error.message || "").trim() : "";
      const payloadError = hasExplicitRpcFailure(payload) ? readRpcFailureMessage(payload) : "";
      const listError = rpcError || payloadError;

      if (listError) {
        this.showListNotice(
          "error",
          isTransientConnectionError(listError)
            ? "空间列表加载超时，请稍后重试"
            : "空间列表加载失败，请稍后重试"
        );
      }

      const boundAlbums = albums.map((a) => {
        const daysRemaining = a && a.expires_at ? getDaysRemaining(a.expires_at) : 7;
        const hasExpiryDate = Boolean(a && a.expires_at);
        const isExpired = Boolean(a && (a.is_expired || (hasExpiryDate && daysRemaining <= 0)));
        const accessKey = String((a && a.access_key) || "").trim().toUpperCase();
        const rootFolderName =
          readRootFolderNameFromPayload(a) ||
          getCachedAlbumRootName(accessKey);
        if (accessKey && rootFolderName) {
          setCachedAlbumRootName(accessKey, rootFolderName);
        }
        return Object.assign({}, a, {
          cover_url: normalizeMaybeUrl(a && a.cover_url),
          created_at_text: formatDate(a && a.created_at),
          root_folder_name: rootFolderName,
          is_expired: isExpired,
          days_remaining: daysRemaining,
          expiry_text: isExpired ? "⚠️ 已过期" : `✨ 剩余 ${Math.max(daysRemaining, 0)} 天`,
        });
      });

      this.setData({
        isLoggedIn: true,
        boundAlbums,
        pageLoading: false,
      });
    } catch (e) {
      const msg = String((e && e.message) || "").trim();
      this.showListNotice(
        "error",
        isTransientConnectionError(msg)
          ? "⚠️ 会话连接超时，请稍后重试"
          : "⚠️ 会话校验失败，请稍后重试"
      );
      this.setData({ pageLoading: false, isLoggedIn: false, boundAlbums: [] });
    }
  },

  showKeyInput() {
    this.setData({ showKeyInput: true, error: "", accessKey: "" });
  },

  hideKeyInput() {
    this.setData({ showKeyInput: false, error: "", accessKey: "" });
  },

  onAccessKeyInput(e) {
    const value = e && e.detail ? e.detail.value : "";
    this.setData({ accessKey: value || "" });
  },

  async pasteAccessKey() {
    try {
      const r = await wx.getClipboardData();
      const text = String((r && r.data) || "").trim().toUpperCase();
      if (!text) {
        wx.showToast({ title: "剪贴板为空", icon: "none" });
        return;
      }
      this.setData({ accessKey: text, error: "" });
    } catch (e) {
      wx.showToast({ title: "无法读取剪贴板", icon: "none" });
    }
  },

  openAlbum(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const key = String(dataset.key || "").trim();
    const rootFolderName =
      String(dataset.rootFolderName || "").trim() ||
      getCachedAlbumRootName(key);
    if (!key) return;
    const rootParam = rootFolderName
      ? `&rootFolderName=${encodeURIComponent(rootFolderName)}`
      : "";
    wx.navigateTo({ url: `/pages/album/detail?key=${encodeURIComponent(key)}${rootParam}` });
  },

  requestUnbindAlbum(e) {
    if (this.data.unbindingAlbumId) return;
    const dataset = (e && e.currentTarget && e.currentTarget.dataset) || {};
    const albumId = String(dataset.albumId || "").trim();
    if (!albumId) return;

    const target =
      (this.data.boundAlbums || []).find((item) => String(item.id) === albumId) || null;
    if (!target) return;

    this.setData({ unbindTargetAlbum: target, listNotice: null });
  },

  cancelUnbindAlbum() {
    if (this.data.unbindingAlbumId) return;
    this.setData({ unbindTargetAlbum: null });
  },

  async confirmUnbindAlbum() {
    const target = this.data.unbindTargetAlbum;
    if (!target || this.data.unbindingAlbumId) return;

    const albumId = String(target.id || "").trim();
    if (!albumId) {
      this.setData({ unbindTargetAlbum: null });
      return;
    }

    const albumTitle = String(target.title || "").trim() || "未命名空间";
    this.setData({ unbindingAlbumId: albumId, listNotice: null });

    try {
      const r = await dbRpc("unbind_user_from_album", { p_album_id: albumId });
      const rawPayload = r ? r.data : null;
      const payload = rawPayload === null || rawPayload === undefined ? r : rawPayload;
      const rpcError = r && r.error ? String(r.error.message || "").trim() : "";
      const payloadError = hasExplicitRpcFailure(payload) ? readRpcFailureMessage(payload) : "";
      if (rpcError || payloadError) {
        this.setData({ unbindingAlbumId: "", unbindTargetAlbum: null });
        this.showListNotice("error", `解除绑定失败：${rpcError || payloadError || "请稍后重试"}`);
        return;
      }

      const nextAlbums = (this.data.boundAlbums || []).filter(
        (item) => String(item.id) !== albumId
      );
      this.setData({
        boundAlbums: nextAlbums,
        unbindingAlbumId: "",
        unbindTargetAlbum: null,
      });
      this.showListNotice("success", `已解除绑定「${albumTitle}」`);
    } catch (e) {
      const msg = String((e && e.message) || "").trim();
      this.setData({ unbindingAlbumId: "", unbindTargetAlbum: null });
      this.showListNotice("error", `解除绑定失败：${msg || "未知错误"}`);
    }
  },

  async submit() {
    if (this.data.serviceMissing) return;
    if (this.data.submitting) return;

    const accessKey = String(this.data.accessKey || "").trim().toUpperCase();
    if (!accessKey) {
      this.setData({ error: "请输入密钥" });
      return;
    }

    this.setData({ submitting: true, error: "" });
    try {
      const r = await dbRpc("get_album_content", {
        input_key: accessKey,
        include_photos: false,
      });
      const rawData = r ? r.data : null;
      const payload = rawData === null || rawData === undefined ? r : rawData;
      const data = resolveAlbumContentPayload(payload);
      const err = r ? r.error : null;
      const dataError =
        hasExplicitRpcFailure(payload) || hasExplicitRpcFailure(data)
          ? readRpcFailureMessage(payload || data)
          : "";

      if (err || !data || !data.album) {
        const errMsg = String((err && err.message) || dataError || "").toLowerCase();
        if (errMsg.includes("过期") || errMsg.includes("expired")) {
          this.setData({ error: "⏰ 该空间已过期" });
        } else if (errMsg.includes("无权") || errMsg.includes("权限") || errMsg.includes("forbidden")) {
          this.setData({ error: "🚫 您暂无该空间访问权限" });
        } else {
          this.setData({ error: "❌ 密钥不存在，请检查后重试" });
        }
        return;
      }

      if (data.album && data.album.is_expired) {
        this.setData({ error: "⏰ 该空间已过期" });
        return;
      }

      // 已登录则尝试绑定（失败不影响进入）
      if (this.data.isLoggedIn) {
        try {
          const bindResult = await dbRpc("bind_user_to_album", { p_access_key: accessKey });
          const rawBindPayload = bindResult ? bindResult.data : null;
          const bindPayload =
            rawBindPayload === null || rawBindPayload === undefined ? bindResult : rawBindPayload;
          if (!(bindResult && bindResult.error) && !hasExplicitRpcFailure(bindPayload)) {
            try {
              wx.setStorageSync(`album_bind_notice_${accessKey}`, "1");
            } catch (_) {
              // ignore storage failure
            }
          }
        } catch (e) {
          // ignore
        }
      }

      const rootFolderName =
        readRootFolderNameFromPayload(data) ||
        readRootFolderNameFromPayload(payload) ||
        getCachedAlbumRootName(accessKey);
      if (rootFolderName) {
        setCachedAlbumRootName(accessKey, rootFolderName);
      }
      const rootParam = rootFolderName
        ? `&rootFolderName=${encodeURIComponent(rootFolderName)}`
        : "";
      wx.navigateTo({ url: `/pages/album/detail?key=${encodeURIComponent(accessKey)}${rootParam}` });
    } catch (e) {
      this.setData({ error: String((e && e.message) || "验证失败") });
    } finally {
      this.setData({ submitting: false });
    }
  },

  onShareAppMessage() {
    return {
      title: SHARE_TITLE,
      path: "/pages/album/index",
      imageUrl: SHARE_IMAGE_URL,
    };
  },

  onShareTimeline() {
    return {
      title: SHARE_TITLE,
      query: "",
      imageUrl: SHARE_IMAGE_URL,
    };
  },
});
