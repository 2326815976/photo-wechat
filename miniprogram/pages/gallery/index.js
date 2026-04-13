const { dbRpc, getSession, extractSessionUser } = require("../../services/photo-api");
const { resolvePublicUrl } = require("../../utils/storage-url");
const { getSessionId } = require("../../utils/session");
const { normalizeRuntimeConfig } = require("../../utils/runtime-config");
const {
  applyPagePresentationToPage,
  subscribePagePresentation,
} = require("../../utils/page-presentation");
const { guardMiniProgramPageAccess } = require("../../utils/page-access");
const {
  GALLERY_PAGE_CACHE_KEY,
  clearGalleryStorageCache,
  consumeGalleryCacheDirty,
} = require("../../utils/gallery-cache");
const {
  buildStableWaterfallColumns,
  shouldResetStableColumnMap,
} = require("../../utils/stable-waterfall");
const {
  STORY_OPENING_DURATION_MS,
  STORY_CLOSING_DURATION_MS,
  STORY_IMAGE_ENTER_DURATION_MS,
  createStoryOpeningState,
  createStoryOpenedState,
  createStoryClosingState,
  createStoryClosedState,
  clearStoryImagePhase,
} = require("../../utils/story-motion");

const PAGE_SIZE = 20;
const GALLERY_LOAD_AHEAD_PX = 260;
const GALLERY_VIEWPORT_FILL_BUFFER_PX = 48;
const GALLERY_INITIAL_AUTOFILL_MAX_BATCHES = 2;
const GALLERY_SWITCH_OVERLAY_TRACK_COUNT = 6;
const GALLERY_CACHE_KEY = GALLERY_PAGE_CACHE_KEY;
const GALLERY_CACHE_TTL = 30 * 60 * 1000;
const ROOT_FOLDER_ID = "__ROOT__";
const SHARE_IMAGE_URL = "/images/share/shiguangyao-share.jpg";
const SHARE_TITLE = "拾光谣｜定格美好瞬间";

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

function formatDateDashUTC8(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = pad2(shifted.getUTCMonth() + 1);
  const d = pad2(shifted.getUTCDate());
  return `${y}-${m}-${d}`;
}

function getTodayDateUTC8() {
  return formatDateDashUTC8(new Date());
}

function formatDateDisplayUTC8(value) {
  const date = parseDateTimeUTC8(value);
  if (!date) return "";
  return formatDateSlashUTC8(date);
}

function normalizeDateOnlyText(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const matched = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!matched) return "";
  return `${matched[1]}-${matched[2]}-${matched[3]}`;
}

function normalizeMaybeText(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return "";
  const lowered = raw.toLowerCase();
  if (lowered === "null" || lowered === "undefined" || lowered === "none" || lowered === "nil") {
    return "";
  }
  return raw;
}

function normalizeMiniProgramPagePathText(value) {
  return String(value || "").trim().replace(/^\/+/, "");
}

function resolveGalleryLoadingCopy(runtimeConfig, isLoggedIn) {
  const normalized = normalizeRuntimeConfig(runtimeConfig);
  const tabBarItems = Array.isArray(normalized.tabBarItems) ? normalized.tabBarItems : [];
  const galleryTabItem = tabBarItems.find(
    (item) => normalizeMiniProgramPagePathText(item && item.pagePath) === "pages/gallery/index"
  );
  const managedMetaMap =
    normalized.managedPageMetaMap && typeof normalized.managedPageMetaMap === "object"
      ? normalized.managedPageMetaMap
      : {};
  const managedMeta =
    managedMetaMap.gallery && typeof managedMetaMap.gallery === "object"
      ? managedMetaMap.gallery
      : {};
  const pageLabel =
    normalizeMaybeText(
      isLoggedIn
        ? (galleryTabItem && (galleryTabItem.text || galleryTabItem.guestText))
        : (galleryTabItem && (galleryTabItem.guestText || galleryTabItem.text))
    ) ||
    normalizeMaybeText(managedMeta.title) ||
    (normalized.hideAudit ? "拾光谣" : "照片墙");

  return {
    title: "拾光中...",
    pageDescription: `正在加载${pageLabel}`,
    switchDescription: `正在切换${pageLabel}标签`,
  };
}

function normalizeGalleryFolderId(folderId) {
  const rawFolderId = String(folderId == null ? "" : folderId).trim();
  const normalizedLower = rawFolderId.toLowerCase();
  if (!rawFolderId || rawFolderId === ROOT_FOLDER_ID || normalizedLower === "root") {
    return ROOT_FOLDER_ID;
  }
  return rawFolderId;
}

function doesPhotoBelongToGalleryFolder(photo, folderId) {
  return normalizeGalleryFolderId(photo && photo.folder_id) === normalizeGalleryFolderId(folderId);
}

function resolvePhotoLocationText(photo) {
  const explicitLocation = normalizeMaybeText(
    (photo && (photo.shot_location || photo.location || photo.place || photo.city_name || photo.address)) ||
      (photo && photo.location_text)
  );
  if (explicitLocation) return explicitLocation;
  return "未知";
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

function normalizePhoto(photo, options) {
  const width = Number((photo && photo.width) || 0);
  const height = Number((photo && photo.height) || 0);
  const ratio = clampGalleryLayoutRatio(width > 0 && height > 0 ? height / width : 1, 1);
  const storyText = normalizeMaybeText(photo && photo.story_text);
  const hasStory = Boolean(storyText);
  const isHighlight = Boolean(photo && photo.is_highlight);
  const locationText = resolvePhotoLocationText(photo, options);

  return Object.assign({}, photo, {
    thumbnail_url_resolved: resolvePublicUrl(photo && photo.thumbnail_url),
    preview_url_resolved: resolvePublicUrl(photo && photo.preview_url),
    original_url_resolved: resolvePublicUrl(photo && photo.original_url),
    created_at_text: formatDateDisplayUTC8((photo && photo.shot_date) || (photo && photo.created_at)),
    location_text: locationText,
    story_text: storyText,
    has_story: hasStory,
    is_highlight: isHighlight,
    story_open: false,
    story_visible: false,
    story_phase: "",
    story_image_phase: "",
    story_highlight: hasStory || isHighlight,
    _imageLoaded: Boolean(photo && photo._imageLoaded),
    _imageLoadFailed: Boolean(photo && photo._imageLoadFailed),
    __ratio: ratio,
    __media_padding_top: `${ratio * 100}%`,
  });
}

const GALLERY_LAYOUT_RATIO_MIN = 0.72;
const GALLERY_LAYOUT_RATIO_MAX = 2.6;
const GALLERY_CARD_CHROME_RATIO = 0.34;
const GALLERY_STORY_BASE_RATIO = 1.12;
const GALLERY_STORY_LINE_RATIO = 0.1;
const GALLERY_STORY_CHARS_PER_LINE = 14;
const GALLERY_SOFT_RELAYOUT_DELAY = 160;

function clampGalleryLayoutRatio(value, fallback) {
  const numericValue = Number(value || 0);
  if (!(numericValue > 0)) return fallback;
  return Math.min(GALLERY_LAYOUT_RATIO_MAX, Math.max(GALLERY_LAYOUT_RATIO_MIN, numericValue));
}

function estimateGalleryTextLines(value, charsPerLine) {
  const text = String(value || "").trim();
  if (!text) return 0;

  const perLine = Math.max(8, Number(charsPerLine || 0) || GALLERY_STORY_CHARS_PER_LINE);
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / perLine)), 0);
}

function resolveGalleryPhotoRatio(photo, ratioMap) {
  const id =
    photo && photo.id !== undefined && photo.id !== null
      ? String(photo.id)
      : "";
  const runtimeRatio = id && ratioMap ? Number(ratioMap[id] || 0) : 0;
  if (runtimeRatio > 0) {
    return clampGalleryLayoutRatio(runtimeRatio, 1);
  }

  const photoRatio = Number(photo && photo.__ratio);
  if (photoRatio > 0) {
    return clampGalleryLayoutRatio(photoRatio, 1);
  }

  const width = Number((photo && photo.width) || 0);
  const height = Number((photo && photo.height) || 0);
  const ratio = width > 0 && height > 0 ? height / width : 1;
  return clampGalleryLayoutRatio(ratio, 1);
}

function estimateGalleryCardHeight(photo, ratioMap) {
  if (photo && photo.story_open && photo.has_story) {
    const lines = estimateGalleryTextLines(photo.story_text, GALLERY_STORY_CHARS_PER_LINE);
    const storyRatio = GALLERY_STORY_BASE_RATIO + Math.min(1.28, lines * GALLERY_STORY_LINE_RATIO);
    return Math.max(1.28, storyRatio);
  }

  return resolveGalleryPhotoRatio(photo, ratioMap) + GALLERY_CARD_CHROME_RATIO;
}

function resolveGalleryPhotoListRatios(list, ratioMap) {
  return (Array.isArray(list) ? list : []).map((photo) => {
    const nextRatio = resolveGalleryPhotoRatio(photo, ratioMap);
    const currentRatio = Number(photo && photo.__ratio);
    const nextPaddingTop = `${nextRatio * 100}%`;
    if (
      Math.abs(nextRatio - currentRatio) < 0.001 &&
      String((photo && photo.__media_padding_top) || "") === nextPaddingTop
    ) {
      return photo;
    }
    return Object.assign({}, photo, {
      __ratio: nextRatio,
      __media_padding_top: nextPaddingTop,
    });
  });
}

function hasGalleryPhotoRatioDrift(currentList, nextList) {
  const current = Array.isArray(currentList) ? currentList : [];
  const next = Array.isArray(nextList) ? nextList : [];
  if (current.length !== next.length) return true;

  for (let index = 0; index < current.length; index += 1) {
    const currentItem = current[index] || {};
    const nextItem = next[index] || {};
    if (String(currentItem.id || "") !== String(nextItem.id || "")) {
      return true;
    }
    if (Math.abs(Number(currentItem.__ratio || 0) - Number(nextItem.__ratio || 0)) >= 0.001) {
      return true;
    }
  }

  return false;
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

function computeTagbarStickyTop(safeTop) {
  let windowWidth = 375;
  try {
    if (typeof wx !== "undefined" && typeof wx.getWindowInfo === "function") {
      const info = wx.getWindowInfo();
      windowWidth = Number(info && info.windowWidth) || windowWidth;
    } else if (typeof wx !== "undefined" && typeof wx.getSystemInfoSync === "function") {
      const info = wx.getSystemInfoSync();
      windowWidth = Number(info && info.windowWidth) || windowWidth;
    }
  } catch (error) {
    // ignore
  }

  const unit = Math.max(windowWidth, 320) / 750;
  const headerInnerHeight = 88 * unit; // app-header 默认内层高度（无返回按钮）
  const top = Number(safeTop || 0) + headerInnerHeight;
  return Math.max(0, Math.round(top));
}

function readWindowHeight() {
  try {
    if (typeof wx !== "undefined" && typeof wx.getWindowInfo === "function") {
      const info = wx.getWindowInfo();
      const windowHeight = Number(info && info.windowHeight);
      if (Number.isFinite(windowHeight) && windowHeight > 0) {
        return windowHeight;
      }
    }
  } catch (error) {
    // ignore
  }

  try {
    if (typeof wx !== "undefined" && typeof wx.getSystemInfoSync === "function") {
      const info = wx.getSystemInfoSync();
      const windowHeight = Number(info && info.windowHeight);
      if (Number.isFinite(windowHeight) && windowHeight > 0) {
        return windowHeight;
      }
    }
  } catch (error) {
    // ignore
  }

  return 0;
}

Page({
  data: {
    safeTop: 0,
    tagbarStickyTop: 0,
    serviceMissing: false,
    hideAudit: false,
    backendReady: false,
    backendReconnecting: false,

    loading: true,
    switchingFolderLoading: false,
    pendingSwitchPhotoIds: [],
    loadingMore: false,
    hasMore: true,
    pageLoadingTitle: "拾光中...",
    pageLoadingDescription: "正在加载照片墙",
    tagSwitchLoadingDescription: "正在切换照片墙标签",

    isLoggedIn: false,

    pageNo: 1,
    total: 0,
    selectedFolder: ROOT_FOLDER_ID,
    rootFolderName: "根目录",
    folders: [{ id: ROOT_FOLDER_ID, name: "根目录" }],
    showTagGuide: false,
    tagWaveActiveIndex: -1,
    tagWaveTick: 0,

    sourcePhotos: [],
    photos: [],
    left: [],
    right: [],
    sortMode: "time_desc",
    filterMode: "all",
    filterDateStart: "",
    filterDateEnd: "",
    showFilterModal: false,
    activeFilterPreset: "default_desc",
    tempFilterPreset: "default_desc",
    tempFolderId: ROOT_FOLDER_ID,
    tempFilterDateStart: "",
    tempFilterDateEnd: "",
    maxFilterDate: getTodayDateUTC8(),

    previewPhoto: null,
    showLoginPrompt: false,
    tagbarPinned: false,
    pagePresentationMode: "tabbar",
    pageFallbackRoute: "",
    pageFallbackTab: "pages/index/index",
    hasBottomTabbar: true,

  },

  leftHeight: 0,
  rightHeight: 0,
  photoRatioMap: null,
  photoColumnMap: null,
  relayoutTimer: null,
  scrollMetricsTimer: null,
  viewportHeight: 0,
  pageHeight: 0,
  loadingNextPage: false,
  galleryLoadZoneArmed: true,
  galleryAutoFillRemaining: GALLERY_INITIAL_AUTOFILL_MAX_BATCHES,
  galleryLoadTicket: 0,
  tagGuideTimer: null,
  tagWaveTimer: null,
  tagWaveRunToken: 0,
  storyMotionTimers: null,

  applyRuntimeConfig(runtimeConfig) {
    const normalized = normalizeRuntimeConfig(runtimeConfig);
    const enabled = Boolean(normalized.hideAudit);
    const loadingCopy = resolveGalleryLoadingCopy(normalized, this.data.isLoggedIn);
    this.setData({
      hideAudit: enabled,
      previewPhoto: enabled ? null : this.data.previewPhoto,
      showLoginPrompt: enabled ? false : this.data.showLoginPrompt,
      pageLoadingTitle: loadingCopy.title,
      pageLoadingDescription: loadingCopy.pageDescription,
      tagSwitchLoadingDescription: loadingCopy.switchDescription,
    });
    return normalized;
  },

  applyPagePresentation() {
    const app = typeof getApp === "function" ? getApp() : null;
    return applyPagePresentationToPage(this, app, "pages/gallery/index");
  },

  onLoad() {
    const app = getApp();
    const globalData = app && app.globalData ? app.globalData : {};
    const safeTop = Number(globalData.statusBarHeight || 0);
    const serviceMissing = !String(globalData.cloudRunService || "").trim();
    const backendReady = serviceMissing ? true : Boolean(globalData.backendReady);
    const backendReconnecting = !backendReady && Boolean(globalData.backendReconnecting);

    this.photoRatioMap = Object.create(null);
    this.photoColumnMap = Object.create(null);
    this.relayoutTimer = null;
    this.scrollMetricsTimer = null;
    this.viewportHeight = 0;
    this.pageHeight = 0;
    this.loadingNextPage = false;
    this.galleryLoadZoneArmed = true;
    this.galleryAutoFillRemaining = GALLERY_INITIAL_AUTOFILL_MAX_BATCHES;
    this.galleryLoadTicket = 0;
    this._galleryBootstrapped = false;
    const currentAppEnterSeq = Math.max(0, Number(globalData.appEnterSeq || 0));
    // 首次进入页面时也需要展示一次引导：将“已见序号”回退一位，确保首帧可触发。
    this._lastSeenAppEnterSeq = Math.max(0, currentAppEnterSeq - 1);
    this._pendingTagGuideOnAppEntry = true;
    this.setData({
      safeTop,
      tagbarStickyTop: computeTagbarStickyTop(safeTop),
      serviceMissing,
      backendReady,
      backendReconnecting,
    });

    this.viewportHeight = readWindowHeight();
    this.applyRuntimeConfig(globalData.runtimeConfig || { hideAudit: globalData.hideAudit });
    this.applyPagePresentation();

    if (app && typeof app.subscribeMiniProgramRuntimeConfig === "function") {
      this._unsubscribeAuditConfig = app.subscribeMiniProgramRuntimeConfig((runtimeConfig) => {
        this.applyRuntimeConfig(runtimeConfig);
      });
    }
    this._unsubscribePagePresentation = subscribePagePresentation(app, this, "pages/gallery/index");
    if (app && typeof app.subscribeBackendStatus === "function") {
      this._unsubscribeBackendStatus = app.subscribeBackendStatus((status) => {
        const ready = Boolean(status && status.backendReady);
        const reconnecting = !ready && Boolean(status && status.backendReconnecting);
        this.setData({
          backendReady: ready,
          backendReconnecting: reconnecting,
        });
        if (ready) {
          this.startGalleryBootstrapIfReady();
        }
      });
    }

    if (!serviceMissing) {
      if (backendReady) {
        this.startGalleryBootstrapIfReady();
      } else {
        this.setData({ loading: true });
        if (app && typeof app.ensureBackendReady === "function") {
          void app.ensureBackendReady();
        }
      }
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
    this.applyRuntimeConfig(
      app && app.globalData
        ? app.globalData.runtimeConfig || { hideAudit: app.globalData.hideAudit }
        : { hideAudit: false }
    );
    const presentationState = this.applyPagePresentation();
    if (!this.data.serviceMissing) {
      const accessResult = await guardMiniProgramPageAccess({
        pageKey: "gallery",
        presentationMode: presentationState.accessMode || presentationState.mode,
      });
      if (!accessResult.allowed) {
        return;
      }
    }

    const appEnterSeq = Math.max(
      0,
      Number(app && app.globalData ? app.globalData.appEnterSeq : 0)
    );
    const lastSeenAppEnterSeq = Math.max(0, Number(this._lastSeenAppEnterSeq || 0));
    const hasPendingGuide = Boolean(this._pendingTagGuideOnAppEntry);
    const hasNewAppEntry = appEnterSeq > lastSeenAppEnterSeq || hasPendingGuide;
    if (hasNewAppEntry) {
      this._lastSeenAppEnterSeq = Math.max(appEnterSeq, lastSeenAppEnterSeq);
      this._pendingTagGuideOnAppEntry = true;
    }

    this.syncTabBar("pages/gallery/index");
    if (this.data.serviceMissing) return;
    if (app && typeof app.ensureBackendReady === "function") {
      if (!this.data.backendReady) {
        this.setData({
          loading: true,
          backendReconnecting: true,
        });
      }
      try {
        await app.ensureBackendReady();
      } catch (error) {
        // ignore
      }
    }
    const nextBackendReady = this.data.serviceMissing
      ? true
      : Boolean(app && app.globalData && app.globalData.backendReady);
    const nextBackendReconnecting = !nextBackendReady && Boolean(
      app && app.globalData && app.globalData.backendReconnecting
    );
    this.setData({
      backendReady: nextBackendReady,
      backendReconnecting: nextBackendReconnecting,
    });
    this.startGalleryBootstrapIfReady();
    if (hasNewAppEntry || this._pendingTagGuideOnAppEntry) {
      this.triggerTagGuideForEntry();
    }
    if (this.consumeSuppressRefreshOnShow()) return;
    if (this.data.loading || this.data.loadingMore) {
      void this.refreshLoginState();
      return;
    }

    const shouldForceRefresh = consumeGalleryCacheDirty();
    const hasLoadedPhotos = Array.isArray(this.data.photos) && this.data.photos.length > 0;
    if (hasNewAppEntry && hasLoadedPhotos && !shouldForceRefresh) {
      void this.refreshLoginState();
      this.scheduleScrollMetricsRefresh();
      return;
    }
    if (shouldForceRefresh) {
      this.resetGalleryStateForRefresh();
      void this.refreshLoginState();
      void this.loadPage(1, {
        silent: false,
        folderId: String(this.data.selectedFolder || ROOT_FOLDER_ID),
      });
      return;
    }

    void this.refreshLoginState();
    void this.loadPage(1, {
      silent: true,
      folderId: String(this.data.selectedFolder || ROOT_FOLDER_ID),
    });
  },

  onUnload() {
    this.clearRelayoutTimer();
    this.clearScrollMetricsTimer();
    this.clearTagGuideTimer();
    this.clearTagWaveTimer();
    this.clearAllStoryMotionTimers();
    this.loadingNextPage = false;
    this.galleryLoadTicket += 1;
    this._galleryBootstrapped = false;
    if (typeof this._unsubscribeAuditConfig === "function") {
      this._unsubscribeAuditConfig();
    }
    this._unsubscribeAuditConfig = null;
    if (typeof this._unsubscribeBackendStatus === "function") {
      this._unsubscribeBackendStatus();
    }
    this._unsubscribeBackendStatus = null;
    if (typeof this._unsubscribePagePresentation === "function") {
      this._unsubscribePagePresentation();
    }
    this._unsubscribePagePresentation = null;
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

  clearStoryMotionTimer(id, phase) {
    if (!this.storyMotionTimers) return;
    const key = `${String(id || "")}:${String(phase || "")}`;
    const timer = this.storyMotionTimers[key];
    if (!timer) return;
    clearTimeout(timer);
    delete this.storyMotionTimers[key];
  },

  clearStoryMotionTimersForPhoto(id) {
    ["open", "close", "image"].forEach((phase) => {
      this.clearStoryMotionTimer(id, phase);
    });
  },

  clearAllStoryMotionTimers() {
    if (!this.storyMotionTimers) return;
    Object.keys(this.storyMotionTimers).forEach((key) => {
      clearTimeout(this.storyMotionTimers[key]);
    });
    this.storyMotionTimers = null;
  },

  scheduleStoryMotionTimer(id, phase, handler, delay) {
    if (typeof handler !== "function") return;
    if (!this.storyMotionTimers) {
      this.storyMotionTimers = Object.create(null);
    }
    this.clearStoryMotionTimer(id, phase);
    const key = `${String(id || "")}:${String(phase || "")}`;
    this.storyMotionTimers[key] = setTimeout(() => {
      if (this.storyMotionTimers) {
        delete this.storyMotionTimers[key];
      }
      handler();
    }, Math.max(0, Number(delay || 0)));
  },

  clearTagGuideTimer() {
    if (!this.tagGuideTimer) return;
    clearTimeout(this.tagGuideTimer);
    this.tagGuideTimer = null;
  },

  clearTagWaveTimer() {
    this.tagWaveRunToken += 1;
    if (!this.tagWaveTimer) return;
    clearTimeout(this.tagWaveTimer);
    this.tagWaveTimer = null;
  },

  startTagWaveAnimation() {
    this.clearTagWaveTimer();
    const folderCount = Array.isArray(this.data.folders) ? this.data.folders.length : 0;
    if (folderCount <= 0) {
      if (this.data.tagWaveActiveIndex !== -1 || this.data.tagWaveTick !== 0) {
        this.setData({ tagWaveActiveIndex: -1, tagWaveTick: 0 });
      }
      return;
    }

    const waveRounds = 3;
    const stepDelayMs = 380;
    const roundGapMs = 240;
    const runToken = this.tagWaveRunToken;
    let round = 0;
    let index = 0;
    let tick = Number(this.data.tagWaveTick || 0) === 1 ? 1 : 0;

    const schedule = (delay, task) => {
      this.tagWaveTimer = setTimeout(() => {
        if (runToken !== this.tagWaveRunToken) return;
        task();
      }, delay);
    };

    const triggerNext = () => {
      if (runToken !== this.tagWaveRunToken) return;
      if (round >= waveRounds) {
        this.setData({ tagWaveActiveIndex: -1, tagWaveTick: 0 });
        this.tagWaveTimer = null;
        return;
      }

      tick = tick === 1 ? 0 : 1;
      const nextIndex = index;
      index += 1;

      let nextDelay = stepDelayMs;
      if (index >= folderCount) {
        index = 0;
        round += 1;
        if (round < waveRounds) {
          nextDelay += roundGapMs;
        }
      }

      this.setData(
        {
          tagWaveActiveIndex: nextIndex,
          tagWaveTick: tick,
        },
        () => {
          if (runToken !== this.tagWaveRunToken) return;
          schedule(nextDelay, triggerNext);
        }
      );
    };

    this.setData({ tagWaveActiveIndex: -1 }, () => {
      if (runToken !== this.tagWaveRunToken) return;
      schedule(120, () => {
        if (runToken !== this.tagWaveRunToken) return;
        wx.nextTick(() => {
          if (runToken !== this.tagWaveRunToken) return;
          triggerNext();
        });
      });
    });
  },

  startTagGuideAutoDismiss() {
    this.clearTagGuideTimer();
    this.tagGuideTimer = setTimeout(() => {
      this.dismissTagGuide();
    }, 15000);
  },

  triggerTagGuideForEntry() {
    const folderCount = Array.isArray(this.data.folders) ? this.data.folders.length : 0;
    if (folderCount <= 1) {
      this.clearTagGuideTimer();
      this.clearTagWaveTimer();
      if (this.data.showTagGuide) {
        this.setData({ showTagGuide: false });
      }
      if (this.data.tagWaveActiveIndex !== -1 || this.data.tagWaveTick !== 0) {
        this.setData({ tagWaveActiveIndex: -1, tagWaveTick: 0 });
      }
      // 仍在加载时保留待触发状态，待分组数据到位后再次尝试展示
      this._pendingTagGuideOnAppEntry = Boolean(this.data.loading || this.data.loadingMore);
      return;
    }

    if (this.data.loading || this.data.loadingMore) {
      this._pendingTagGuideOnAppEntry = true;
      return;
    }

    this._pendingTagGuideOnAppEntry = false;
    if (this.data.showTagGuide) {
      this.startTagGuideAutoDismiss();
      this.startTagWaveAnimation();
      return;
    }

    this.setData({ showTagGuide: true }, () => {
      this.startTagGuideAutoDismiss();
      this.startTagWaveAnimation();
    });
  },

  dismissTagGuide() {
    this.clearTagGuideTimer();
    this.clearTagWaveTimer();
    if (!this.data.showTagGuide) return;
    this.setData({
      showTagGuide: false,
      tagWaveActiveIndex: -1,
      tagWaveTick: 0,
    });
  },

  startGalleryBootstrapIfReady() {
    if (this._galleryBootstrapped) return;
    if (this.data.serviceMissing) return;
    if (!this.data.backendReady) return;
    this._galleryBootstrapped = true;
    this.loadCachedGallery();
    this.scheduleScrollMetricsRefresh();
    this.bootstrap();
  },

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
    if (this.data.showTagGuide) {
      this.dismissTagGuide();
    }
    this.clearTagWaveTimer();

    clearGalleryMemoryCache();
    clearGalleryStorageCache();
    this.clearRelayoutTimer();
    this.leftHeight = 0;
    this.rightHeight = 0;
    this.pageHeight = 0;
    this.loadingNextPage = false;
    this.galleryLoadZoneArmed = true;
    this.galleryAutoFillRemaining = GALLERY_INITIAL_AUTOFILL_MAX_BATCHES;
    this.galleryLoadTicket += 1;
    this.photoRatioMap = Object.create(null);
    this.photoColumnMap = Object.create(null);

    this.setData({
      selectedFolder: nextId,
      loading: false,
      switchingFolderLoading: true,
      pendingSwitchPhotoIds: [],
      loadingMore: false,
      hasMore: true,
      pageNo: 1,
      total: 0,
      showFilterModal: false,
      previewPhoto: null,
      tagWaveActiveIndex: -1,
      tagWaveTick: 0,
    });

    try {
      wx.pageScrollTo({ scrollTop: 0, duration: 0 });
    } catch (error) {
      // ignore
    }

    void this.loadPage(1, { keepCurrentContent: true, folderId: nextId });
  },

  toggleStory(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "").trim()
        : "";
    if (!id) return;

    const source = Array.isArray(this.data.sourcePhotos) ? this.data.sourcePhotos : [];
    const current = source.find((photo) => String((photo && photo.id) || "") === id);
    if (!current || !current.has_story) return;

    this.clearStoryMotionTimersForPhoto(id);

    if (current.story_visible) {
      this.updatePhoto(id, (photo) => createStoryClosingState(photo), { skipPersist: true });
      this.scheduleStoryMotionTimer(
        id,
        "close",
        () => {
          this.updatePhoto(id, (photo) => createStoryClosedState(photo), { skipPersist: true });
          this.scheduleStoryMotionTimer(
            id,
            "image",
            () => {
              this.updatePhoto(id, (photo) => clearStoryImagePhase(photo), { skipPersist: true });
            },
            STORY_IMAGE_ENTER_DURATION_MS
          );
        },
        STORY_CLOSING_DURATION_MS
      );
      return;
    }

    this.updatePhoto(id, (photo) => createStoryOpeningState(photo), { skipPersist: true });
    this.scheduleStoryMotionTimer(
      id,
      "open",
      () => {
        this.updatePhoto(id, (photo) => createStoryOpenedState(photo), { skipPersist: true });
      },
      STORY_OPENING_DURATION_MS
    );
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
    this.galleryLoadZoneArmed = true;
    this.galleryAutoFillRemaining = GALLERY_INITIAL_AUTOFILL_MAX_BATCHES;
    this.galleryLoadTicket += 1;
    this.photoRatioMap = Object.create(null);
    this.photoColumnMap = Object.create(null);

    this.setData({
      pageNo: 1,
      total: 0,
      hasMore: true,
      pendingSwitchPhotoIds: [],
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
    await this.loadPage(1, {
      silent: hasCachedPhotos,
      folderId: String(this.data.selectedFolder || ROOT_FOLDER_ID),
    });
  },

  async refreshLoginState() {
    const app = typeof getApp === "function" ? getApp() : null;
    const globalData = app && app.globalData ? app.globalData : {};
    const runtimeConfig = globalData.runtimeConfig || { hideAudit: globalData.hideAudit };

    try {
      const session = await getSession();
      const user = extractSessionUser(session);
      this.setData({ isLoggedIn: Boolean(user && user.id) }, () => {
        this.applyRuntimeConfig(runtimeConfig);
      });
    } catch (e) {
      this.setData({ isLoggedIn: false }, () => {
        this.applyRuntimeConfig(runtimeConfig);
      });
    }
  },

  loadCachedGallery() {
    if (String(this.data.selectedFolder || ROOT_FOLDER_ID) !== ROOT_FOLDER_ID) return;
    const memory = readGalleryMemoryCache();
    const storage = memory ? null : readGalleryStorageCache();
    const cached = memory || storage;
    if (!cached || !Array.isArray(cached.photos) || cached.photos.length === 0) return;

    const photos = cached.photos.map((row) => normalizePhoto(row));
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

  getPhotoDateText(photo) {
    const parsed = parseDateTimeUTC8((photo && photo.shot_date) || (photo && photo.created_at));
    if (!parsed) return "";
    return formatDateDashUTC8(parsed);
  },

  applyGalleryViewFromSource(sourceRows, opts) {
    const source = Array.isArray(sourceRows)
      ? sourceRows.slice()
      : (Array.isArray(this.data.sourcePhotos) ? this.data.sourcePhotos.slice() : []);

    const sortMode = String(this.data.sortMode || "time_desc");
    const filterMode = String(this.data.filterMode || "all");
    const filterDateStart = normalizeDateOnlyText(this.data.filterDateStart);
    const filterDateEnd = normalizeDateOnlyText(this.data.filterDateEnd);
    const selectedFolderId = String(this.data.selectedFolder || ROOT_FOLDER_ID);

    let viewRows = source.filter((photo) => doesPhotoBelongToGalleryFolder(photo, selectedFolderId));
    if (filterDateStart || filterDateEnd) {
      viewRows = viewRows.filter((photo) => {
        const photoDate = this.getPhotoDateText(photo);
        if (!photoDate) return false;
        if (filterDateStart && photoDate < filterDateStart) return false;
        if (filterDateEnd && photoDate > filterDateEnd) return false;
        return true;
      });
    }

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

    const resolvedViewRows = resolveGalleryPhotoListRatios(viewRows, this.photoRatioMap);
    if (Boolean(opts && opts.preferAppend) && this.canAppendResolvedPhotoList(resolvedViewRows)) {
      this.appendResolvedPhotoList(resolvedViewRows);
      return;
    }

    this.applyPhotoList(resolvedViewRows, { resolved: true });
  },

  clearPhotoColumnMap() {
    this.photoColumnMap = Object.create(null);
  },

  shouldResetPhotoColumnMap(nextList) {
    return shouldResetStableColumnMap(this.data.photos || [], nextList);
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
      tempFilterDateStart: normalizeDateOnlyText(this.data.filterDateStart),
      tempFilterDateEnd: normalizeDateOnlyText(this.data.filterDateEnd),
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

  onChangeFilterDateStart(e) {
    const value = normalizeDateOnlyText(e && e.detail ? e.detail.value : "");
    this.setData({ tempFilterDateStart: value });
  },

  onChangeFilterDateEnd(e) {
    const value = normalizeDateOnlyText(e && e.detail ? e.detail.value : "");
    this.setData({ tempFilterDateEnd: value });
  },

  onClearFilterDateRange() {
    this.setData({
      tempFilterDateStart: "",
      tempFilterDateEnd: "",
    });
  },

  onResetFilterSelector() {
    this.setData({
      tempFolderId: ROOT_FOLDER_ID,
      tempFilterPreset: "default_desc",
      tempFilterDateStart: "",
      tempFilterDateEnd: "",
    });
  },

  onApplyFilterSelector() {
    const nextPreset = String(this.data.tempFilterPreset || this.getActiveFilterPreset());
    const nextFolderId = String(this.data.tempFolderId || ROOT_FOLDER_ID);
    const currentFolderId = String(this.data.selectedFolder || ROOT_FOLDER_ID);
    const resolved = this.resolveFilterPreset(nextPreset);
    const nextFilterDateStart = normalizeDateOnlyText(this.data.tempFilterDateStart);
    const nextFilterDateEnd = normalizeDateOnlyText(this.data.tempFilterDateEnd);

    if (nextFilterDateStart && nextFilterDateEnd && nextFilterDateStart > nextFilterDateEnd) {
      wx.showToast({ title: "开始日期不能晚于结束日期", icon: "none" });
      return;
    }

    if (nextFolderId !== currentFolderId) {
      this.setData(
        {
          showFilterModal: false,
          activeFilterPreset: resolved.preset,
          sortMode: resolved.sortMode,
          filterMode: resolved.filterMode,
          filterDateStart: nextFilterDateStart,
          filterDateEnd: nextFilterDateEnd,
        },
        () => this.switchFolder(nextFolderId)
      );
      return;
    }

    this.setData(
      {
        showFilterModal: false,
        activeFilterPreset: resolved.preset,
        sortMode: resolved.sortMode,
        filterMode: resolved.filterMode,
        filterDateStart: nextFilterDateStart,
        filterDateEnd: nextFilterDateEnd,
      },
      () => this.applyGalleryViewFromSource()
    );
  },

  buildColumnsFromPhotos(photos, seed) {
    const columns = buildStableWaterfallColumns(photos, {
      left: seed && seed.left,
      right: seed && seed.right,
      leftHeight: seed && seed.leftHeight,
      rightHeight: seed && seed.rightHeight,
      columnMap: this.photoColumnMap,
      estimateHeight: (photo) => estimateGalleryCardHeight(photo, this.photoRatioMap),
    });
    this.photoColumnMap = columns.columnMap || Object.create(null);
    return columns;
  },

  calculatePhotoListHeight(list) {
    return (Array.isArray(list) ? list : []).reduce(
      (total, photo) => total + estimateGalleryCardHeight(photo, this.photoRatioMap),
      0
    );
  },

  canAppendResolvedPhotoList(nextList) {
    const currentList = Array.isArray(this.data.photos) ? this.data.photos : [];
    const resolvedNextList = Array.isArray(nextList) ? nextList : [];
    if (currentList.length <= 0 || resolvedNextList.length <= currentList.length) {
      return false;
    }

    for (let index = 0; index < currentList.length; index += 1) {
      if (String((currentList[index] && currentList[index].id) || "") !== String((resolvedNextList[index] && resolvedNextList[index].id) || "")) {
        return false;
      }
    }

    return true;
  },

  appendResolvedPhotoList(nextList) {
    const resolvedNextList = Array.isArray(nextList) ? nextList : [];
    if (!this.canAppendResolvedPhotoList(resolvedNextList)) {
      this.applyPhotoList(resolvedNextList, { resolved: true });
      return;
    }

    const baseLeft = resolveGalleryPhotoListRatios(this.data.left || [], this.photoRatioMap);
    const baseRight = resolveGalleryPhotoListRatios(this.data.right || [], this.photoRatioMap);
    const incremental = resolvedNextList.slice((this.data.photos || []).length);
    const columns = this.buildColumnsFromPhotos(incremental, {
      left: baseLeft,
      right: baseRight,
      leftHeight: this.calculatePhotoListHeight(baseLeft),
      rightHeight: this.calculatePhotoListHeight(baseRight),
    });

    this.leftHeight = columns.leftHeight;
    this.rightHeight = columns.rightHeight;
    this.setData({
      photos: resolvedNextList,
      left: columns.left,
      right: columns.right,
    });
    this.scheduleScrollMetricsRefresh();
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
        this.viewportHeight = readWindowHeight();
      }
      this.maybeAutoFillViewport("viewport-fill");
    });
  },

  maybeAutoFillViewport(reason) {
    if (this.data.serviceMissing) return false;
    if (this.data.loading) return false;
    if (this.data.loadingMore) return false;
    if (!this.data.hasMore) return false;
    if (!(this.galleryAutoFillRemaining > 0)) return false;

    const viewportHeight = Number(this.viewportHeight || readWindowHeight() || 0);
    const pageHeight = Number(this.pageHeight || 0);
    if (!(viewportHeight > 0) || !(pageHeight > 0)) return false;
    if (pageHeight > viewportHeight + GALLERY_VIEWPORT_FILL_BUFFER_PX) return false;

    this.galleryAutoFillRemaining -= 1;
    const hasRequested = this.loadNextPage(reason || "viewport-fill");
    if (!hasRequested) {
      this.galleryAutoFillRemaining += 1;
    }
    return hasRequested;
  },

  loadNextPage(reason) {
    if (this.data.serviceMissing) return false;
    if (this.data.loading) return false;
    if (this.data.loadingMore) return false;
    if (!this.data.hasMore) return false;
    if (this.loadingNextPage) return false;

    this.loadingNextPage = true;
    this.galleryLoadZoneArmed = false;
    const nextPage = Number(this.data.pageNo || 1) + 1;
    Promise.resolve(this.loadPage(nextPage, {
      folderId: String(this.data.selectedFolder || ROOT_FOLDER_ID),
    }))
      .finally(() => {
        this.loadingNextPage = false;
        this.scheduleScrollMetricsRefresh(120);
      });
    return true;
  },

  onPageScroll(e) {
    this.syncTagbarPinnedByScrollTop(e && e.scrollTop);

    if (this.data.serviceMissing) return;
    if (this.data.loading) return;
    if (this.data.loadingMore) return;
    if (!this.data.hasMore) return;

    const scrollTop = Number(e && e.scrollTop);
    const viewportHeight = Number(this.viewportHeight || 0);
    const pageHeight = Number(this.pageHeight || 0);
    if (!Number.isFinite(scrollTop) || scrollTop < 0) return;
    if (!(viewportHeight > 0) || !(pageHeight > viewportHeight)) return;

    const distanceToBottom = pageHeight - (scrollTop + viewportHeight);
    if (distanceToBottom > GALLERY_LOAD_AHEAD_PX) {
      this.galleryLoadZoneArmed = true;
      return;
    }

    if (!this.galleryLoadZoneArmed) {
      return;
    }

    this.galleryLoadZoneArmed = false;
    this.loadNextPage("scroll-ahead");
  },

  syncTagbarPinnedByScrollTop(scrollTop) {
    const numericTop = Number(scrollTop || 0);
    if (!Number.isFinite(numericTop)) return;
    const nextPinned = numericTop > 2;
    if (nextPinned === Boolean(this.data.tagbarPinned)) return;
    this.setData({ tagbarPinned: nextPinned });
  },

  scheduleRelayout() {
    if (this.relayoutTimer) return;
    this.relayoutTimer = setTimeout(() => {
      this.relayoutTimer = null;
      const nextPhotos = resolveGalleryPhotoListRatios(this.data.photos || [], this.photoRatioMap);
      const nextLeft = resolveGalleryPhotoListRatios(this.data.left || [], this.photoRatioMap);
      const nextRight = resolveGalleryPhotoListRatios(this.data.right || [], this.photoRatioMap);
      const shouldSyncVisible =
        hasGalleryPhotoRatioDrift(this.data.photos, nextPhotos) ||
        hasGalleryPhotoRatioDrift(this.data.left, nextLeft) ||
        hasGalleryPhotoRatioDrift(this.data.right, nextRight);

      this.leftHeight = this.calculatePhotoListHeight(nextLeft);
      this.rightHeight = this.calculatePhotoListHeight(nextRight);

      if (shouldSyncVisible) {
        this.setData({
          photos: nextPhotos,
          left: nextLeft,
          right: nextRight,
        });
      }
      this.scheduleScrollMetricsRefresh();
      this.persistGalleryCache(
        { writeStorage: Number(this.data.pageNo || 1) === 1 },
        this.data.sourcePhotos
      );
    }, GALLERY_SOFT_RELAYOUT_DELAY);
  },

  applyPhotoList(photos, opts) {
    const source = Array.isArray(photos) ? photos : [];
    const list = Boolean(opts && opts.resolved)
      ? source.slice()
      : resolveGalleryPhotoListRatios(source, this.photoRatioMap);
    if (Boolean(opts && opts.resetColumnMap) || this.shouldResetPhotoColumnMap(list)) {
      this.clearPhotoColumnMap();
    }
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

    const current = this.findPhotoById(id);
    if (current && (!current._imageLoaded || current._imageLoadFailed)) {
      this.patchPhotoVisualState(id, (photo) => Object.assign({}, photo, {
        _imageLoaded: true,
        _imageLoadFailed: false,
      }));
    }
    this.markPendingSwitchPhotoSettled(id);

    const stablePhoto = current || this.findPhotoById(id);
    const hasStableStoredRatio = Boolean(
      stablePhoto
      && (
        Number(stablePhoto.__ratio || 0) > 0
        || (Number(stablePhoto.width || 0) > 0 && Number(stablePhoto.height || 0) > 0)
      )
    );
    if (hasStableStoredRatio) return;

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

    const nextCurrent = this.findPhotoById(id);
    if (!nextCurrent) return;

    const currentRatio = Number(nextCurrent.__ratio || 0);
    if (currentRatio > 0 && Math.abs(currentRatio - ratio) < 0.08) {
      return;
    }

    this.scheduleRelayout();
  },

  onPhotoError(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;

    const current = this.findPhotoById(id);
    if (!current || current._imageLoadFailed) return;

    this.patchPhotoVisualState(id, (photo) => Object.assign({}, photo, {
      _imageLoaded: false,
      _imageLoadFailed: true,
    }));
    this.markPendingSwitchPhotoSettled(id);
  },

  markPendingSwitchPhotoSettled(photoId) {
    const normalizedPhotoId = String(photoId || "").trim();
    if (!normalizedPhotoId) return;

    const pendingSwitchPhotoIds = Array.isArray(this.data.pendingSwitchPhotoIds)
      ? this.data.pendingSwitchPhotoIds
      : [];
    if (!pendingSwitchPhotoIds.includes(normalizedPhotoId)) {
      return;
    }

    const nextPendingSwitchPhotoIds = pendingSwitchPhotoIds.filter((currentPhotoId) => currentPhotoId !== normalizedPhotoId);
    this.setData({
      pendingSwitchPhotoIds: nextPendingSwitchPhotoIds,
      switchingFolderLoading: nextPendingSwitchPhotoIds.length > 0,
    });
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
    const keepCurrentContent = Boolean(opts && opts.keepCurrentContent);
    const targetFolderId = String(
      (opts && opts.folderId) || this.data.selectedFolder || ROOT_FOLDER_ID
    ).trim() || ROOT_FOLDER_ID;
    const ticket = Number(this.galleryLoadTicket || 0) + 1;
    this.galleryLoadTicket = ticket;
    const shouldTrackSwitchOverlay = pageNo === 1 && keepCurrentContent;
    let nextPendingSwitchPhotoIds = null;
    if (pageNo === 1) {
      if (!silent && !keepCurrentContent) {
        this.setData({ loading: true });
      }
    } else {
      this.setData({ loadingMore: true });
    }

    try {
      const r = await dbRpc("get_public_gallery", {
        page_no: pageNo,
        page_size: PAGE_SIZE,
        folder_id: targetFolderId,
      });

      if (ticket !== this.galleryLoadTicket) {
        return false;
      }
      if (String(this.data.selectedFolder || ROOT_FOLDER_ID) !== targetFolderId) {
        return false;
      }

      if (r && r.error) {
        if (!(pageNo === 1 && silent)) {
          wx.showToast({ title: r.error.message || "加载失败", icon: "none" });
        }
        return false;
      }

      const payload = (r && r.data) || {};
      if (hasExplicitRpcFailure(payload)) {
        if (!(pageNo === 1 && silent)) {
          wx.showToast({ title: readRpcFailureMessage(payload, "加载失败"), icon: "none" });
        }
        return false;
      }
      const rows = extractGalleryRows(payload);
      const rootFolderName = readRootFolderName(payload);
      const rpcFolders = readGalleryFolders(payload);
      const folders = [{ id: ROOT_FOLDER_ID, name: rootFolderName }].concat(
        rpcFolders.filter((item) => String(item.id) !== ROOT_FOLDER_ID)
      );
      const photos = rows.map((row) => normalizePhoto(row));
      const total = readGalleryTotal(payload, photos.length);

      const currentSource = Array.isArray(this.data.sourcePhotos) ? this.data.sourcePhotos : [];
      let mergedSource = currentSource;
      if (pageNo === 1) {
        mergedSource = photos;
      } else if (photos.length > 0) {
        const existingIds = new Set(currentSource.map((p) => String(p.id)));
        const incremental = photos.filter((p) => !existingIds.has(String(p.id)));
        mergedSource = incremental.length > 0 ? currentSource.concat(incremental) : currentSource;
      }

      this.applyGalleryViewFromSource(mergedSource, { preferAppend: pageNo > 1 });

      const loadedCount = mergedSource.length;
      const hasKnownTotal = total > 0;
      const hasMore = hasKnownTotal
        ? photos.length >= PAGE_SIZE && loadedCount < total
        : photos.length >= PAGE_SIZE;

      if (pageNo === 1) {
        nextPendingSwitchPhotoIds = shouldTrackSwitchOverlay
          ? Array.from(
            new Set(
              mergedSource
                .slice(0, GALLERY_SWITCH_OVERLAY_TRACK_COUNT)
                .filter((photo) => photo && !photo._imageLoaded && !photo._imageLoadFailed)
                .map((photo) => String((photo && photo.id) || "").trim())
                .filter(Boolean)
            )
          )
          : [];
      }

      const nextData = {
        pageNo,
        total,
        hasMore,
        rootFolderName,
        folders,
        sourcePhotos: mergedSource,
      };
      if (pageNo === 1) {
        nextData.pendingSwitchPhotoIds = nextPendingSwitchPhotoIds;
      }

      this.setData(
        nextData,
        () => {
          if (this._pendingTagGuideOnAppEntry) {
            this.triggerTagGuideForEntry();
          }
        }
      );

      this.persistGalleryCache({ writeStorage: pageNo === 1 }, mergedSource, total);
      return true;
    } catch (e) {
      if (ticket !== this.galleryLoadTicket) {
        return false;
      }
      if (String(this.data.selectedFolder || ROOT_FOLDER_ID) !== targetFolderId) {
        return false;
      }
      if (pageNo === 1) {
        nextPendingSwitchPhotoIds = [];
        this.setData({ pendingSwitchPhotoIds: [] });
      }
      if (!(pageNo === 1 && silent)) {
        wx.showToast({ title: "加载失败", icon: "none" });
      }
      return false;
    } finally {
      if (ticket !== this.galleryLoadTicket) {
        return false;
      }
      if (String(this.data.selectedFolder || ROOT_FOLDER_ID) !== targetFolderId) {
        return false;
      }
      const shouldKeepSwitchOverlay = shouldTrackSwitchOverlay
        ? Boolean(Array.isArray(nextPendingSwitchPhotoIds) && nextPendingSwitchPhotoIds.length > 0)
        : false;
      this.setData({ loading: false, switchingFolderLoading: shouldKeepSwitchOverlay, loadingMore: false }, () => {
        if (this._pendingTagGuideOnAppEntry) {
          this.triggerTagGuideForEntry();
        }
      });
    }
  },

  onReachBottom() {
    this.loadNextPage("reach-bottom");
  },

  findPhotoById(id) {
    const photos = this.data.photos || [];
    return photos.find((p) => String(p.id) === String(id)) || null;
  },

  patchPhotoVisualState(id, updater) {
    const targetId = String(id || "");
    if (!targetId || typeof updater !== "function") return;

    const patchList = (list) => {
      if (!Array.isArray(list) || list.length === 0) {
        return { nextList: list, changed: false };
      }

      let changed = false;
      const nextList = list.map((photo) => {
        if (String((photo && photo.id) || "") !== targetId) {
          return photo;
        }
        const nextPhoto = updater(photo);
        if (nextPhoto !== photo) {
          changed = true;
        }
        return nextPhoto;
      });

      return { nextList, changed };
    };

    const sourceResult = patchList(this.data.sourcePhotos || []);
    const photosResult = patchList(this.data.photos || []);
    const leftResult = patchList(this.data.left || []);
    const rightResult = patchList(this.data.right || []);
    const preview = this.data.previewPhoto;
    const nextPreview = preview && String(preview.id) === targetId ? updater(preview) : preview;

    if (!sourceResult.changed && !photosResult.changed && !leftResult.changed && !rightResult.changed && nextPreview === preview) {
      return;
    }

    const nextData = {};
    if (sourceResult.changed) nextData.sourcePhotos = sourceResult.nextList;
    if (photosResult.changed) nextData.photos = photosResult.nextList;
    if (leftResult.changed) nextData.left = leftResult.nextList;
    if (rightResult.changed) nextData.right = rightResult.nextList;
    if (nextPreview !== preview) nextData.previewPhoto = nextPreview;
    this.setData(nextData);
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

  updatePhoto(id, updater, options) {
    const updateOne = (p) => (String(p.id) === String(id) ? updater(p) : p);
    const shouldPersist = !Boolean(options && options.skipPersist);

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
        if (shouldPersist) {
          this.persistGalleryCache(
            { writeStorage: Number(this.data.pageNo || 1) === 1 },
            sourcePhotos
          );
        }
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
      if (r && r.error) {
        return;
      }

      const rawPayload = r ? r.data : null;
      if (typeof rawPayload !== "boolean" && hasExplicitRpcFailure(rawPayload)) {
        return;
      }

      const counted =
        typeof rawPayload === "boolean"
          ? rawPayload
          : Boolean(readFieldFromPayloadChain(rawPayload, "counted"));
      const viewCountValue = readFieldFromPayloadChain(rawPayload, "view_count");
      const serverViewCount = pickFirstNonNegativeInteger([viewCountValue]);
      const fallbackViewCount = toNonNegativeInteger(fallbackPhoto && fallbackPhoto.view_count);
      const nextViewCount =
        serverViewCount !== null
          ? serverViewCount
          : counted
            ? Math.max(0, fallbackViewCount || 0) + 1
            : fallbackViewCount;

      if (nextViewCount === null) {
        return;
      }

      this.updatePhoto(id, (p) => Object.assign({}, p, { view_count: nextViewCount }));
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

  onShareAppMessage() {
    return {
      title: SHARE_TITLE,
      path: "/pages/gallery/index",
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
