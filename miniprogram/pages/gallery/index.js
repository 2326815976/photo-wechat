const { dbRpc, getSession, extractSessionUser } = require("../../services/photo-api");
const { resolvePublicUrl } = require("../../utils/storage-url");
const { getSessionId } = require("../../utils/session");
const {
  GALLERY_PAGE_CACHE_KEY,
  clearGalleryStorageCache,
  consumeGalleryCacheDirty,
} = require("../../utils/gallery-cache");

const PAGE_SIZE = 20;
const GALLERY_CACHE_KEY = GALLERY_PAGE_CACHE_KEY;
const GALLERY_CACHE_TTL = 30 * 60 * 1000;
const ROOT_FOLDER_ID = "__ROOT__";

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
  const storyText = String((photo && photo.story_text) || "").trim();
  const hasStory = Boolean(storyText);
  const isHighlight = Boolean(photo && photo.is_highlight);

  return Object.assign({}, photo, {
    thumbnail_url_resolved: resolvePublicUrl(photo && photo.thumbnail_url),
    preview_url_resolved: resolvePublicUrl(photo && photo.preview_url),
    original_url_resolved: resolvePublicUrl(photo && photo.original_url),
    created_at_text: formatDateDisplayUTC8((photo && photo.shot_date) || (photo && photo.created_at)),
    story_text: storyText,
    has_story: hasStory,
    is_highlight: isHighlight,
    story_open: false,
    story_highlight: hasStory || isHighlight,
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

function readGalleryFolders(payload) {
  const folders = readFieldFromPayloadChain(payload, ["folders"]);
  if (!Array.isArray(folders)) return [];
  return folders
    .map((item) => {
      const id = String(item && item.id ? item.id : "").trim();
      const name = String(item && item.name ? item.name : "").trim();
      if (!id || !name) return null;
      return { id, name };
    })
    .filter(Boolean);
}

function readRootFolderName(payload) {
  const direct = String(
    readFieldFromPayloadChain(payload, ["root_folder_name", "rootFolderName"]) || ""
  ).trim();
  return direct || "根目录";
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
    hideAudit: false,

    loading: true,
    loadingMore: false,
    hasMore: true,

    isLoggedIn: false,

    pageNo: 1,
    total: 0,
    selectedFolder: ROOT_FOLDER_ID,
    rootFolderName: "根目录",
    folders: [{ id: ROOT_FOLDER_ID, name: "根目录" }],

    sourcePhotos: [],
    photos: [],
    left: [],
    right: [],
    sortMode: "time_desc",
    filterMode: "all",
    showFilterModal: false,
    activeFilterPreset: "default_desc",
    tempFilterPreset: "default_desc",
    tempFolderId: ROOT_FOLDER_ID,

    previewPhoto: null,
    showLoginPrompt: false,

  },

  leftHeight: 0,
  rightHeight: 0,
  photoRatioMap: null,
  relayoutTimer: null,
  scrollMetricsTimer: null,
  viewportHeight: 0,
  pageHeight: 0,
  loadingNextPage: false,

  onLoad() {
    const app = getApp();
    const globalData = app && app.globalData ? app.globalData : {};
    const safeTop = Number(globalData.statusBarHeight || 0);
    const serviceMissing = !String(globalData.cloudRunService || "").trim();
    const hideAudit = Boolean(globalData.hideAudit);

    this.photoRatioMap = Object.create(null);
    this.relayoutTimer = null;
    this.scrollMetricsTimer = null;
    this.viewportHeight = 0;
    this.pageHeight = 0;
    this.loadingNextPage = false;
    this.setData({ safeTop, serviceMissing, hideAudit });

    try {
      const systemInfo = wx.getSystemInfoSync();
      const windowHeight = Number(systemInfo && systemInfo.windowHeight);
      if (Number.isFinite(windowHeight) && windowHeight > 0) {
        this.viewportHeight = windowHeight;
      }
    } catch (error) {
      this.viewportHeight = 0;
    }

    if (app && typeof app.subscribeAuditConfig === "function") {
      this._unsubscribeAuditConfig = app.subscribeAuditConfig((nextHideAudit) => {
        const enabled = Boolean(nextHideAudit);
        this.setData({
          hideAudit: enabled,
          previewPhoto: enabled ? null : this.data.previewPhoto,
          showLoginPrompt: enabled ? false : this.data.showLoginPrompt,
        });
      });
    }

    this.loadCachedGallery();
    this.scheduleScrollMetricsRefresh();

    if (!serviceMissing) {
      this.bootstrap();
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
    const hideAudit = Boolean(app && app.globalData && app.globalData.hideAudit);
    this.setData({
      hideAudit,
      previewPhoto: hideAudit ? null : this.data.previewPhoto,
      showLoginPrompt: hideAudit ? false : this.data.showLoginPrompt,
    });

    this.syncTabBar("pages/gallery/index");
    if (this.data.serviceMissing) return;
    if (this.consumeSuppressRefreshOnShow()) return;
    if (this.data.loading || this.data.loadingMore) {
      void this.refreshLoginState();
      return;
    }

    const shouldForceRefresh = consumeGalleryCacheDirty();
    if (shouldForceRefresh) {
      this.resetGalleryStateForRefresh();
      void this.refreshLoginState();
      void this.loadPage(1, { silent: false });
      return;
    }

    void this.refreshLoginState();
    void this.loadPage(1, { silent: true });
  },

  onUnload() {
    this.clearRelayoutTimer();
    this.clearScrollMetricsTimer();
    this.loadingNextPage = false;
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

  noop() {},

  onSelectFolder(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || ROOT_FOLDER_ID).trim()
        : ROOT_FOLDER_ID;
    const nextId = id || ROOT_FOLDER_ID;
    this.switchFolder(nextId);
  },

  switchFolder(nextId) {
    if (nextId === String(this.data.selectedFolder || ROOT_FOLDER_ID)) return;

    clearGalleryMemoryCache();
    clearGalleryStorageCache();
    this.clearRelayoutTimer();
    this.leftHeight = 0;
    this.rightHeight = 0;
    this.pageHeight = 0;
    this.loadingNextPage = false;
    this.photoRatioMap = Object.create(null);

    this.setData({
      selectedFolder: nextId,
      loading: true,
      loadingMore: false,
      hasMore: true,
      pageNo: 1,
      total: 0,
      sourcePhotos: [],
      photos: [],
      left: [],
      right: [],
      showFilterModal: false,
      previewPhoto: null,
    });

    void this.loadPage(1, { silent: false });
  },

  toggleStory(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "").trim()
        : "";
    if (!id) return;

    this.updatePhoto(id, (photo) => {
      if (!photo || !photo.has_story) return photo;
      return Object.assign({}, photo, { story_open: !Boolean(photo.story_open) });
    });
  },

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
    this.pageHeight = 0;
    this.loadingNextPage = false;
    this.photoRatioMap = Object.create(null);

    this.setData({
      pageNo: 1,
      total: 0,
      hasMore: true,
      sourcePhotos: [],
      photos: [],
      left: [],
      right: [],
      previewPhoto: null,
    });
  },

  async bootstrap() {
    await this.refreshLoginState();
    const hasCachedPhotos = Array.isArray(this.data.sourcePhotos) && this.data.sourcePhotos.length > 0;
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
    if (String(this.data.selectedFolder || ROOT_FOLDER_ID) !== ROOT_FOLDER_ID) return;
    const memory = readGalleryMemoryCache();
    const storage = memory ? null : readGalleryStorageCache();
    const cached = memory || storage;
    if (!cached || !Array.isArray(cached.photos) || cached.photos.length === 0) return;

    const photos = cached.photos.map(normalizePhoto);
    this.setData({
      loading: false,
      pageNo: 1,
      total: Number(cached.total || photos.length),
      hasMore: photos.length < Number(cached.total || photos.length),
      sourcePhotos: photos,
    });
    this.applyGalleryViewFromSource(photos);

    this.persistGalleryCache(
      { writeStorage: Boolean(storage) },
      photos,
      Number(cached.total || photos.length)
    );
  },

  getPhotoTimeValue(photo) {
    const parsed = parseDateTimeUTC8((photo && photo.shot_date) || (photo && photo.created_at));
    if (!parsed) return 0;
    const timestamp = parsed.getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  },

  applyGalleryViewFromSource(sourceRows) {
    const source = Array.isArray(sourceRows)
      ? sourceRows.slice()
      : (Array.isArray(this.data.sourcePhotos) ? this.data.sourcePhotos.slice() : []);

    const sortMode = String(this.data.sortMode || "time_desc");
    const filterMode = String(this.data.filterMode || "all");

    let viewRows = source;
    if (filterMode === "highlight") {
      viewRows = viewRows.filter((photo) =>
        Boolean(photo && (photo.story_highlight || photo.is_highlight || photo.has_story))
      );
    } else if (filterMode === "story") {
      viewRows = viewRows.filter((photo) => Boolean(photo && photo.has_story));
    }

    viewRows = viewRows.slice().sort((a, b) => {
      const timeA = this.getPhotoTimeValue(a);
      const timeB = this.getPhotoTimeValue(b);
      if (timeA !== timeB) {
        return sortMode === "time_asc" ? timeA - timeB : timeB - timeA;
      }
      return String((b && b.created_at) || "").localeCompare(String((a && a.created_at) || ""), "zh-CN");
    });

    this.applyPhotoList(viewRows);
  },

  getActiveFilterPreset() {
    const filterMode = String(this.data.filterMode || "all");
    const sortMode = String(this.data.sortMode || "time_desc");
    if (filterMode === "highlight") return "highlight";
    if (filterMode === "story") return "story";
    if (sortMode === "time_asc") return "time_asc";
    return "default_desc";
  },

  resolveFilterPreset(preset) {
    const normalized = String(preset || "").trim();
    if (normalized === "time_asc") {
      return { preset: "time_asc", sortMode: "time_asc", filterMode: "all" };
    }
    if (normalized === "highlight") {
      return { preset: "highlight", sortMode: "time_desc", filterMode: "highlight" };
    }
    if (normalized === "story") {
      return { preset: "story", sortMode: "time_desc", filterMode: "story" };
    }
    return { preset: "default_desc", sortMode: "time_desc", filterMode: "all" };
  },

  applyFilterPreset(preset) {
    const resolved = this.resolveFilterPreset(preset);
    this.setData(
      {
        activeFilterPreset: resolved.preset,
        sortMode: resolved.sortMode,
        filterMode: resolved.filterMode,
      },
      () => this.applyGalleryViewFromSource()
    );
  },

  onTapFilter() {
    const activePreset = this.getActiveFilterPreset();
    this.setData({
      showFilterModal: true,
      activeFilterPreset: activePreset,
      tempFilterPreset: activePreset,
      tempFolderId: String(this.data.selectedFolder || ROOT_FOLDER_ID),
    });
  },

  closeFilterModal() {
    this.setData({ showFilterModal: false });
  },

  onSelectModalFolder(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || ROOT_FOLDER_ID).trim()
        : ROOT_FOLDER_ID;
    this.setData({ tempFolderId: id || ROOT_FOLDER_ID });
  },

  onSelectFilterPreset(e) {
    const preset =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.preset || "").trim()
        : "";
    if (!preset) return;
    this.setData({ tempFilterPreset: preset });
  },

  onResetFilterSelector() {
    this.setData({
      tempFolderId: ROOT_FOLDER_ID,
      tempFilterPreset: "default_desc",
    });
  },

  onApplyFilterSelector() {
    const nextPreset = String(this.data.tempFilterPreset || this.getActiveFilterPreset());
    const nextFolderId = String(this.data.tempFolderId || ROOT_FOLDER_ID);
    const currentFolderId = String(this.data.selectedFolder || ROOT_FOLDER_ID);
    const resolved = this.resolveFilterPreset(nextPreset);

    if (nextFolderId !== currentFolderId) {
      this.setData(
        {
          showFilterModal: false,
          activeFilterPreset: resolved.preset,
          sortMode: resolved.sortMode,
          filterMode: resolved.filterMode,
        },
        () => this.switchFolder(nextFolderId)
      );
      return;
    }

    this.setData({ showFilterModal: false }, () => this.applyFilterPreset(nextPreset));
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

    if (left.length === 0 && right.length > 0) {
      return { left: right.slice(), right: [], leftHeight: rightHeight, rightHeight: 0 };
    }

    return { left, right, leftHeight, rightHeight };
  },

  clearRelayoutTimer() {
    if (!this.relayoutTimer) return;
    clearTimeout(this.relayoutTimer);
    this.relayoutTimer = null;
  },

  clearScrollMetricsTimer() {
    if (!this.scrollMetricsTimer) return;
    clearTimeout(this.scrollMetricsTimer);
    this.scrollMetricsTimer = null;
  },

  scheduleScrollMetricsRefresh(delay = 80) {
    this.clearScrollMetricsTimer();
    this.scrollMetricsTimer = setTimeout(() => {
      this.scrollMetricsTimer = null;
      this.refreshScrollMetrics();
    }, Math.max(0, Number(delay || 0)));
  },

  refreshScrollMetrics() {
    const query = wx.createSelectorQuery();
    query
      .select(".page")
      .boundingClientRect();
    query.exec((result) => {
      const rect = Array.isArray(result) ? result[0] : null;
      const nextPageHeight = Number(rect && rect.height);
      if (Number.isFinite(nextPageHeight) && nextPageHeight > 0) {
        this.pageHeight = nextPageHeight;
      }
      if (!(this.viewportHeight > 0)) {
        try {
          const systemInfo = wx.getSystemInfoSync();
          const windowHeight = Number(systemInfo && systemInfo.windowHeight);
          if (Number.isFinite(windowHeight) && windowHeight > 0) {
            this.viewportHeight = windowHeight;
          }
        } catch (error) {
          // ignore
        }
      }
    });
  },

  loadNextPage(reason) {
    if (this.data.serviceMissing) return false;
    if (this.data.loading) return false;
    if (this.data.loadingMore) return false;
    if (!this.data.hasMore) return false;
    if (this.loadingNextPage) return false;

    this.loadingNextPage = true;
    const nextPage = Number(this.data.pageNo || 1) + 1;
    Promise.resolve(this.loadPage(nextPage))
      .finally(() => {
        this.loadingNextPage = false;
        this.scheduleScrollMetricsRefresh(120);
      });
    return true;
  },

  onPageScroll(e) {
    if (this.data.serviceMissing) return;
    if (this.data.loading) return;
    if (this.data.loadingMore) return;
    if (!this.data.hasMore) return;

    const scrollTop = Number(e && e.scrollTop);
    const viewportHeight = Number(this.viewportHeight || 0);
    const pageHeight = Number(this.pageHeight || 0);
    if (!Number.isFinite(scrollTop) || scrollTop < 0) return;
    if (!(viewportHeight > 0) || !(pageHeight > viewportHeight)) return;

    const scrollProgress = (scrollTop + viewportHeight) / pageHeight;
    if (scrollProgress >= 0.8) {
      this.loadNextPage("scroll-80");
    }
  },

  scheduleRelayout() {
    if (this.relayoutTimer) return;
    this.relayoutTimer = setTimeout(() => {
      this.relayoutTimer = null;
      const photos = this.data.photos || [];
      if (!Array.isArray(photos) || photos.length === 0) return;

      this.applyPhotoList(photos);
      this.persistGalleryCache(
        { writeStorage: Number(this.data.pageNo || 1) === 1 },
        this.data.sourcePhotos
      );
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
    this.scheduleScrollMetricsRefresh();
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

  persistGalleryCache(opts, sourceRows, totalOverride) {
    if (String(this.data.selectedFolder || ROOT_FOLDER_ID) !== ROOT_FOLDER_ID) return;
    const photos = Array.isArray(sourceRows)
      ? sourceRows
      : (
        Array.isArray(this.data.sourcePhotos) && this.data.sourcePhotos.length > 0
          ? this.data.sourcePhotos
          : (this.data.photos || [])
      );
    if (!photos.length) return;

    const total = Math.max(Number(totalOverride || this.data.total || 0), photos.length);
    writeGalleryMemoryCache(photos, total);

    if (opts && opts.writeStorage) {
      writeGalleryStorageCache(photos, total);
    }
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
        folder_id: String(this.data.selectedFolder || ROOT_FOLDER_ID),
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
      const rootFolderName = readRootFolderName(payload);
      const rpcFolders = readGalleryFolders(payload);
      const folders = [{ id: ROOT_FOLDER_ID, name: rootFolderName }].concat(
        rpcFolders.filter((item) => String(item.id) !== ROOT_FOLDER_ID)
      );

      const currentSource = Array.isArray(this.data.sourcePhotos) ? this.data.sourcePhotos : [];
      let mergedSource = currentSource;
      if (pageNo === 1) {
        mergedSource = photos;
      } else if (photos.length > 0) {
        const existingIds = new Set(currentSource.map((p) => String(p.id)));
        const incremental = photos.filter((p) => !existingIds.has(String(p.id)));
        mergedSource = incremental.length > 0 ? currentSource.concat(incremental) : currentSource;
      }

      this.applyGalleryViewFromSource(mergedSource);

      const loadedCount = mergedSource.length;
      const hasKnownTotal = total > 0;
      const hasMore = hasKnownTotal
        ? photos.length >= PAGE_SIZE && loadedCount < total
        : photos.length >= PAGE_SIZE;

      this.setData({
        pageNo,
        total,
        hasMore,
        rootFolderName,
        folders,
        sourcePhotos: mergedSource,
      });

      this.persistGalleryCache({ writeStorage: pageNo === 1 }, mergedSource, total);
    } catch (e) {
      if (!(pageNo === 1 && silent)) {
        wx.showToast({ title: "加载失败", icon: "none" });
      }
    } finally {
      this.setData({ loading: false, loadingMore: false });
    }
  },

  onReachBottom() {
    this.loadNextPage("reach-bottom");
  },

  findPhotoById(id) {
    const photos = this.data.photos || [];
    return photos.find((p) => String(p.id) === String(id)) || null;
  },

  openPhotoFullscreenById(id) {
    const photos = this.data.photos || [];
    const previewable = photos.filter(
      (p) => Boolean(p && (p.preview_url_resolved || p.thumbnail_url_resolved || p.original_url_resolved))
    );
    if (!previewable.length) {
      wx.showToast({ title: "图片暂不可用", icon: "none" });
      return;
    }

    const target =
      previewable.find((p) => String(p.id) === String(id)) || previewable[0];
    const currentUrl =
      target.preview_url_resolved ||
      target.thumbnail_url_resolved ||
      target.original_url_resolved;
    if (!currentUrl) {
      wx.showToast({ title: "图片暂不可用", icon: "none" });
      return;
    }

    const urls = previewable
      .map((p) => p.preview_url_resolved || p.thumbnail_url_resolved || p.original_url_resolved)
      .filter(Boolean);
    if (!urls.length) {
      wx.showToast({ title: "图片暂不可用", icon: "none" });
      return;
    }

    this.markTransientForegroundReturn();
    wx.previewImage({
      current: currentUrl,
      urls,
    });
  },

  updatePhoto(id, updater) {
    const updateOne = (p) => (String(p.id) === String(id) ? updater(p) : p);

    const sourceBase =
      Array.isArray(this.data.sourcePhotos) && this.data.sourcePhotos.length > 0
        ? this.data.sourcePhotos
        : (this.data.photos || []);
    const sourcePhotos = sourceBase.map(updateOne);

    const preview = this.data.previewPhoto;
    const nextPreview = preview && String(preview.id) === String(id) ? updater(preview) : preview;

    this.setData(
      {
        sourcePhotos,
        previewPhoto: nextPreview,
      },
      () => {
        this.applyGalleryViewFromSource();
        this.persistGalleryCache(
          { writeStorage: Number(this.data.pageNo || 1) === 1 },
          sourcePhotos
        );
      }
    );
  },

  async incrementPhotoViewCount(photoId, fallbackPhoto) {
    const id = String(photoId || "").trim();
    if (!id) return;

    try {
      const sessionId = getSessionId();
      const r = await dbRpc("increment_photo_view", {
        p_photo_id: id,
        p_session_id: sessionId,
      });

      const rawPayload = r ? r.data : null;
      if (typeof rawPayload !== "boolean" && hasExplicitRpcFailure(rawPayload)) {
        return;
      }

      const counted =
        typeof rawPayload === "boolean"
          ? rawPayload
          : Boolean(readFieldFromPayloadChain(rawPayload, "counted"));
      if (!counted) {
        return;
      }

      const viewCountValue = readFieldFromPayloadChain(rawPayload, "view_count");
      const viewCount = Number(
        (viewCountValue ||
          (fallbackPhoto && fallbackPhoto.view_count) ||
          0)
      );
      this.updatePhoto(id, (p) => Object.assign({}, p, { view_count: viewCount }));
    } catch (e2) {
      // ignore
    }
  },

  async previewPhoto(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;

    const current = this.findPhotoById(id);
    if (!current) return;

    // 审核模式下直接全屏查看，但仍记录浏览量。
    if (this.data.hideAudit) {
      this.incrementPhotoViewCount(id, current);
      this.openPhotoFullscreenById(id);
      return;
    }

    // 兼容缺少预览图的历史数据：直接走全屏查看并计数。
    if (!current.preview_url_resolved) {
      this.incrementPhotoViewCount(id, current);
      this.openPhotoFullscreenById(id);
      return;
    }

    this.setData({ previewPhoto: current });
    await this.incrementPhotoViewCount(id, current);
  },

  async toggleLike(e) {
    if (this.data.hideAudit) return;
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
