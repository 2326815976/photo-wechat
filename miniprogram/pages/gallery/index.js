const { dbRpc, getSession, extractSessionUser } = require("../../services/photo-api");
const { resolvePublicUrl } = require("../../utils/storage-url");
const { getSessionId } = require("../../utils/session");
const {
  GALLERY_PAGE_CACHE_KEY,
  clearGalleryStorageCache,
  consumeGalleryCacheDirty,
} = require("../../utils/gallery-cache");

const PAGE_SIZE = 20;
const PRELOAD_LIMIT_WIFI = 1;
const PRELOAD_LIMIT_FALLBACK = 0;
const GALLERY_CACHE_KEY = GALLERY_PAGE_CACHE_KEY;
const GALLERY_CACHE_TTL = 30 * 60 * 1000;

let galleryMemoryCache = {
  photos: [],
  total: 0,
  cachedAt: 0,
};

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

function formatDateDisplayUTC8(value) {
  const date = parseDateTimeUTC8(value);
  if (!date) return "";
  return formatDateSlashUTC8(date);
}

function readGalleryMemoryCache() {
  if (!Array.isArray(galleryMemoryCache.photos) || galleryMemoryCache.photos.length === 0) {
    return null;
  }

  const expired = Date.now() - Number(galleryMemoryCache.cachedAt || 0) > GALLERY_CACHE_TTL;
  if (expired) {
    galleryMemoryCache = { photos: [], total: 0, cachedAt: 0 };
    return null;
  }

  return {
    photos: galleryMemoryCache.photos.map((x) => Object.assign({}, x)),
    total: Number(galleryMemoryCache.total || 0),
  };
}

function writeGalleryMemoryCache(photos, total) {
  const rows = Array.isArray(photos) ? photos : [];
  if (!rows.length) {
    galleryMemoryCache = { photos: [], total: 0, cachedAt: 0 };
    return;
  }

  galleryMemoryCache = {
    photos: rows.map((x) => Object.assign({}, x)),
    total: Number(total || rows.length),
    cachedAt: Date.now(),
  };
}

function clearGalleryMemoryCache() {
  galleryMemoryCache = { photos: [], total: 0, cachedAt: 0 };
}

function readGalleryStorageCache() {
  try {
    const raw = wx.getStorageSync(GALLERY_CACHE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    const photos = parsed && Array.isArray(parsed.photos) ? parsed.photos : [];
    const cachedAt = Number((parsed && parsed.cachedAt) || 0);
    if (!photos.length || !cachedAt) return null;

    const expired = Date.now() - cachedAt > GALLERY_CACHE_TTL;
    if (expired) return null;

    return {
      photos,
      total: Number((parsed && parsed.total) || photos.length),
    };
  } catch (e) {
    return null;
  }
}

function writeGalleryStorageCache(photos, total) {
  const rows = Array.isArray(photos) ? photos : [];
  if (!rows.length) return;

  try {
    wx.setStorageSync(
      GALLERY_CACHE_KEY,
      JSON.stringify({
        photos: rows,
        total: Number(total || rows.length),
        cachedAt: Date.now(),
      })
    );
  } catch (e) {
    // ignore
  }
}

function normalizePhoto(photo) {
  const width = Number((photo && photo.width) || 0);
  const height = Number((photo && photo.height) || 0);
  const ratio = width > 0 && height > 0 ? height / width : 1;

  return Object.assign({}, photo, {
    thumbnail_url_resolved: resolvePublicUrl(photo && photo.thumbnail_url),
    preview_url_resolved: resolvePublicUrl(photo && photo.preview_url),
    original_url_resolved: resolvePublicUrl(photo && photo.original_url),
    created_at_text: formatDateDisplayUTC8(photo && photo.created_at),
    __ratio: ratio,
  });
}

function hasExplicitRpcFailure(payload) {
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

function readRpcFailureMessage(payload, fallback) {
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") break;
    const direct = String(current.message || "").trim();
    if (direct) return direct;
    const directError = current.error;
    if (typeof directError === "string" && directError.trim()) {
      return directError.trim();
    }
    if (current.error && typeof current.error === "object") {
      const nested = String(current.error.message || "").trim();
      if (nested) return nested;
    }
    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }
  return String(fallback || "操作失败");
}

function extractGalleryRows(payload) {
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (Array.isArray(current)) return current;
    if (!current || typeof current !== "object") break;
    if (Array.isArray(current.photos)) return current.photos;
    if (Array.isArray(current.rows)) return current.rows;
    if (Array.isArray(current.list)) return current.list;
    if (Array.isArray(current.items)) return current.items;
    if (Array.isArray(current.data)) return current.data;
    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }
  return [];
}

function toNonNegativeInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.round(numeric);
}

function pickFirstNonNegativeInteger(values) {
  const source = Array.isArray(values) ? values : [];
  for (let i = 0; i < source.length; i += 1) {
    const parsed = toNonNegativeInteger(source[i]);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function readGalleryTotal(payload, fallbackCount) {
  const fallback = Math.max(0, Number(fallbackCount || 0));
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") break;
    const direct = pickFirstNonNegativeInteger([current.total, current.count, current.totalCount]);
    if (direct !== null) return direct;
    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }

  return fallback;
}

function readFieldFromPayloadChain(payload, fields) {
  const keys = Array.isArray(fields) ? fields : [fields];
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") break;
    for (let i = 0; i < keys.length; i += 1) {
      const key = String(keys[i] || "").trim();
      if (!key || !Object.prototype.hasOwnProperty.call(current, key)) continue;
      const value = current[key];
      if (value !== undefined && value !== null) {
        return value;
      }
    }
    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }
  return undefined;
}

Page({
  data: {
    safeTop: 0,
    serviceMissing: false,

    loading: true,
    loadingMore: false,
    hasMore: true,

    isLoggedIn: false,

    pageNo: 1,
    total: 0,

    photos: [],
    left: [],
    right: [],

    previewPhoto: null,
    showLoginPrompt: false,
    networkType: "",

  },

  leftHeight: 0,
  rightHeight: 0,
  preloadedPreviewUrls: null,
  photoRatioMap: null,
  relayoutTimer: null,

  onLoad() {
    const app = getApp();
    const globalData = app && app.globalData ? app.globalData : {};
    const safeTop = Number(globalData.statusBarHeight || 0);
    const serviceMissing = !String(globalData.cloudRunService || "").trim();

    this.preloadedPreviewUrls = new Set();
    this.photoRatioMap = Object.create(null);
    this.relayoutTimer = null;
    this.setData({ safeTop, serviceMissing });
    this.refreshNetworkType();

    this.loadCachedGallery();

    if (!serviceMissing) {
      this.bootstrap();
    } else {
      this.setData({ loading: false });
    }
  },

  onShow() {
    this.syncTabBar("pages/gallery/index");
    if (this.data.serviceMissing) return;
    this.refreshNetworkType();
    if (this.consumeSuppressRefreshOnShow()) return;

    const shouldForceRefresh = consumeGalleryCacheDirty();
    if (shouldForceRefresh) {
      this.resetGalleryStateForRefresh();
      void this.refreshLoginState();
      void this.loadPage(1, { silent: false });
      return;
    }

    void this.refreshLoginState();
  },

  onUnload() {
    this.clearRelayoutTimer();
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

  markTransientForegroundReturn() {
    this._suppressRefreshOnNextShow = true;
    this._suppressRefreshMarkedAt = Date.now();
  },

  consumeSuppressRefreshOnShow() {
    if (!this._suppressRefreshOnNextShow) return false;
    const markedAt = Number(this._suppressRefreshMarkedAt || 0);
    const expired = markedAt > 0 && Date.now() - markedAt > 2 * 60 * 1000;
    this._suppressRefreshOnNextShow = false;
    this._suppressRefreshMarkedAt = 0;
    return !expired;
  },

  resetGalleryStateForRefresh() {
    clearGalleryMemoryCache();
    clearGalleryStorageCache();
    this.clearRelayoutTimer();
    this.leftHeight = 0;
    this.rightHeight = 0;
    this.preloadedPreviewUrls = new Set();
    this.photoRatioMap = Object.create(null);

    this.setData({
      pageNo: 1,
      total: 0,
      hasMore: true,
      photos: [],
      left: [],
      right: [],
      previewPhoto: null,
    });
  },

  async bootstrap() {
    await this.refreshLoginState();
    const hasCachedPhotos = Array.isArray(this.data.photos) && this.data.photos.length > 0;
    await this.loadPage(1, { silent: hasCachedPhotos });
  },

  async refreshLoginState() {
    try {
      const session = await getSession();
      const user = extractSessionUser(session);
      this.setData({ isLoggedIn: Boolean(user && user.id) });
    } catch (e) {
      this.setData({ isLoggedIn: false });
    }
  },

  loadCachedGallery() {
    const memory = readGalleryMemoryCache();
    const storage = memory ? null : readGalleryStorageCache();
    const cached = memory || storage;
    if (!cached || !Array.isArray(cached.photos) || cached.photos.length === 0) return;

    const photos = cached.photos.map(normalizePhoto);
    this.applyPhotoList(photos);
    this.setData({
      loading: false,
      pageNo: 1,
      total: Number(cached.total || photos.length),
      hasMore: photos.length < Number(cached.total || photos.length),
    });

    this.persistGalleryCache({ writeStorage: Boolean(storage) });
    this.preloadPreviewImages();
  },

  buildColumnsFromPhotos(photos) {
    let leftHeight = 0;
    let rightHeight = 0;
    const left = [];
    const right = [];

    (photos || []).forEach((p) => {
      if (leftHeight <= rightHeight) {
        left.push(p);
        leftHeight += Number(p.__ratio || 1);
      } else {
        right.push(p);
        rightHeight += Number(p.__ratio || 1);
      }
    });

    return { left, right, leftHeight, rightHeight };
  },

  clearRelayoutTimer() {
    if (!this.relayoutTimer) return;
    clearTimeout(this.relayoutTimer);
    this.relayoutTimer = null;
  },

  refreshNetworkType() {
    wx.getNetworkType({
      success: (res) => {
        const type = String((res && res.networkType) || "").trim().toLowerCase();
        this.setData({ networkType: type });
      },
      fail: () => {
        this.setData({ networkType: "" });
      },
    });
  },

  getPreviewPreloadLimit() {
    const networkType = String(this.data.networkType || "").trim().toLowerCase();
    if (networkType === "wifi") return PRELOAD_LIMIT_WIFI;
    if (!networkType || networkType === "unknown") return PRELOAD_LIMIT_FALLBACK;
    return 0;
  },

  scheduleRelayout() {
    if (this.relayoutTimer) return;
    this.relayoutTimer = setTimeout(() => {
      this.relayoutTimer = null;
      const photos = this.data.photos || [];
      if (!Array.isArray(photos) || photos.length === 0) return;

      this.applyPhotoList(photos);
      this.persistGalleryCache({ writeStorage: Number(this.data.pageNo || 1) === 1 });
    }, 48);
  },

  applyPhotoList(photos) {
    const source = Array.isArray(photos) ? photos : [];
    const ratioMap = this.photoRatioMap || {};
    const list = source.map((photo) => {
      const id =
        photo && photo.id !== undefined && photo.id !== null
          ? String(photo.id)
          : "";
      if (!id || !Object.prototype.hasOwnProperty.call(ratioMap, id)) {
        return photo;
      }

      const runtimeRatio = Number(ratioMap[id] || 0);
      if (!(runtimeRatio > 0)) return photo;

      const currentRatio = Number(photo.__ratio || 0);
      if (Math.abs(runtimeRatio - currentRatio) < 0.001) return photo;

      return Object.assign({}, photo, { __ratio: runtimeRatio });
    });
    const columns = this.buildColumnsFromPhotos(list);
    this.leftHeight = columns.leftHeight;
    this.rightHeight = columns.rightHeight;

    this.setData({
      photos: list,
      left: columns.left,
      right: columns.right,
    });
  },

  appendPhotos(photos) {
    const merged = (this.data.photos || []).concat(Array.isArray(photos) ? photos : []);
    this.applyPhotoList(merged);
  },

  onPhotoLoad(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;

    const detail = (e && e.detail) || {};
    const width = Number(detail.width || 0);
    const height = Number(detail.height || 0);
    if (!(width > 0 && height > 0)) return;

    const ratio = height / width;
    if (!(ratio > 0)) return;

    if (!this.photoRatioMap) {
      this.photoRatioMap = Object.create(null);
    }

    const prevRatio = Number(this.photoRatioMap[id] || 0);
    if (prevRatio > 0 && Math.abs(prevRatio - ratio) < 0.01) {
      return;
    }
    this.photoRatioMap[id] = ratio;

    const current = this.findPhotoById(id);
    if (!current) return;

    const currentRatio = Number(current.__ratio || 0);
    if (currentRatio > 0 && Math.abs(currentRatio - ratio) < 0.08) {
      return;
    }

    this.scheduleRelayout();
  },

  persistGalleryCache(opts) {
    const photos = this.data.photos || [];
    if (!photos.length) return;

    const total = Math.max(Number(this.data.total || 0), photos.length);
    writeGalleryMemoryCache(photos, total);

    if (opts && opts.writeStorage) {
      writeGalleryStorageCache(photos, total);
    }
  },

  preloadPreviewImages() {
    const rows = this.data.photos || [];
    const limit = this.getPreviewPreloadLimit();
    if (limit <= 0) return;

    rows.slice(0, limit).forEach((photo) => {
      const url = String(photo && photo.preview_url_resolved ? photo.preview_url_resolved : "").trim();
      if (!url) return;
      if (this.preloadedPreviewUrls && this.preloadedPreviewUrls.has(url)) return;

      if (this.preloadedPreviewUrls) {
        this.preloadedPreviewUrls.add(url);
      }

      wx.getImageInfo({
        src: url,
        fail: () => {},
      });
    });
  },

  async loadPage(pageNo, opts) {
    if (this.data.serviceMissing) return;

    const silent = Boolean(opts && opts.silent);
    if (pageNo === 1) {
      if (!silent) {
        this.setData({ loading: true });
      }
    } else {
      this.setData({ loadingMore: true });
    }

    try {
      const r = await dbRpc("get_public_gallery", {
        page_no: pageNo,
        page_size: PAGE_SIZE,
      });

      if (r && r.error) {
        if (!(pageNo === 1 && silent)) {
          wx.showToast({ title: r.error.message || "加载失败", icon: "none" });
        }
        return;
      }

      const payload = (r && r.data) || {};
      if (hasExplicitRpcFailure(payload)) {
        if (!(pageNo === 1 && silent)) {
          wx.showToast({ title: readRpcFailureMessage(payload, "加载失败"), icon: "none" });
        }
        return;
      }
      const rows = extractGalleryRows(payload);
      const photos = rows.map(normalizePhoto);
      const total = readGalleryTotal(payload, photos.length);

      if (pageNo === 1) {
        this.applyPhotoList(photos);
      } else if (photos.length > 0) {
        const existingIds = new Set((this.data.photos || []).map((p) => String(p.id)));
        const incremental = photos.filter((p) => !existingIds.has(String(p.id)));
        if (incremental.length > 0) {
          this.appendPhotos(incremental);
        }
      }

      const loadedCount = (this.data.photos || []).length;
      const hasKnownTotal = total > 0;
      const hasMore = hasKnownTotal
        ? photos.length >= PAGE_SIZE && loadedCount < total
        : photos.length >= PAGE_SIZE;

      this.setData({
        pageNo,
        total,
        hasMore,
      });

      this.persistGalleryCache({ writeStorage: pageNo === 1 });
      this.preloadPreviewImages();
    } catch (e) {
      if (!(pageNo === 1 && silent)) {
        wx.showToast({ title: "加载失败", icon: "none" });
      }
    } finally {
      this.setData({ loading: false, loadingMore: false });
    }
  },

  onReachBottom() {
    if (this.data.serviceMissing) return;
    if (this.data.loadingMore) return;
    if (!this.data.hasMore) return;
    void this.loadPage(this.data.pageNo + 1);
  },

  findPhotoById(id) {
    const photos = this.data.photos || [];
    return photos.find((p) => String(p.id) === String(id)) || null;
  },

  updatePhoto(id, updater) {
    const updateOne = (p) => (String(p.id) === String(id) ? updater(p) : p);

    const photos = (this.data.photos || []).map(updateOne);
    const left = (this.data.left || []).map(updateOne);
    const right = (this.data.right || []).map(updateOne);

    const preview = this.data.previewPhoto;
    const nextPreview = preview && String(preview.id) === String(id) ? updater(preview) : preview;

    this.setData({ photos, left, right, previewPhoto: nextPreview });
    this.persistGalleryCache({ writeStorage: Number(this.data.pageNo || 1) === 1 });
  },

  async previewPhoto(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;

    const current = this.findPhotoById(id);
    if (!current || !current.preview_url_resolved) return;

    this.setData({ previewPhoto: current });

    // 增加浏览量（匿名使用 session_id 去重）
    try {
      const sessionId = getSessionId();
      const r = await dbRpc("increment_photo_view", {
        p_photo_id: id,
        p_session_id: sessionId,
      });

      const rawPayload = r ? r.data : null;
      const counted =
        typeof rawPayload === "boolean"
          ? rawPayload
          : Boolean(readFieldFromPayloadChain(rawPayload, "counted"));
      if ((typeof rawPayload === "boolean" || !hasExplicitRpcFailure(rawPayload)) && counted) {
        const viewCountValue = readFieldFromPayloadChain(rawPayload, "view_count");
        const viewCount = Number((viewCountValue || current.view_count) || 0);
        this.updatePhoto(id, (p) => Object.assign({}, p, { view_count: viewCount }));
      }
    } catch (e2) {
      // ignore
    }
  },

  async toggleLike(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;

    if (!this.data.isLoggedIn) {
      this.setData({ showLoginPrompt: true });
      return;
    }

    if (typeof wx.vibrateShort === "function") {
      wx.vibrateShort({ type: "light" });
    }

    try {
      const r = await dbRpc("like_photo", { p_photo_id: id });
      if (r && r.error) {
        wx.showToast({ title: r.error.message || "操作失败", icon: "none" });
        return;
      }

      const rawPayload = r ? r.data : null;
      if (typeof rawPayload !== "boolean" && hasExplicitRpcFailure(rawPayload)) {
        wx.showToast({ title: readRpcFailureMessage(rawPayload, "操作失败"), icon: "none" });
        return;
      }

      const likedValue =
        typeof rawPayload === "boolean"
          ? rawPayload
          : readFieldFromPayloadChain(rawPayload, ["liked", "is_liked"]);
      const liked = likedValue === undefined ? null : Boolean(likedValue);
      const serverLikeCount = Number(readFieldFromPayloadChain(rawPayload, "like_count"));
      const hasServerLikeCount = Number.isFinite(serverLikeCount) && serverLikeCount >= 0;
      this.updatePhoto(id, (p) => {
        const nextLiked = liked === null ? !Boolean(p && p.is_liked) : liked;
        const localLikeCount = Number((p && p.like_count) || 0);
        const nextLikeCount = hasServerLikeCount
          ? Math.round(serverLikeCount)
          : nextLiked
            ? localLikeCount + 1
            : Math.max(0, localLikeCount - 1);
        return Object.assign({}, p, { is_liked: nextLiked, like_count: nextLikeCount });
      });
    } catch (e2) {
      wx.showToast({ title: "操作失败", icon: "none" });
    }
  },

  closePreview() {
    this.setData({ previewPhoto: null });
  },

  openFullscreen() {
    const preview = this.data.previewPhoto;
    if (!preview) return;

    const previewable = (this.data.photos || []).filter((p) => Boolean(p.preview_url_resolved));
    if (!previewable.length) return;

    const urls = previewable
      // 照片墙全屏优先高清预览图，避免直接拉取原图
      .map((p) => p.preview_url_resolved || p.thumbnail_url_resolved || p.original_url_resolved)
      .filter(Boolean);
    if (!urls.length) return;

    const currentPhoto = previewable.find((p) => String(p.id) === String(preview.id)) || previewable[0];
    const currentUrl =
      currentPhoto.preview_url_resolved ||
      currentPhoto.thumbnail_url_resolved ||
      currentPhoto.original_url_resolved;
    if (!currentUrl) return;

    this.markTransientForegroundReturn();
    wx.previewImage({
      current: currentUrl,
      urls,
    });
  },

  closeLoginPrompt() {
    this.setData({ showLoginPrompt: false });
  },

  goLogin() {
    this.setData({ showLoginPrompt: false });
    wx.navigateTo({ url: "/pages/login/index" });
  },
});
