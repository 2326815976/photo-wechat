const { dbRpc } = require("../../services/photo-api");
const { resolvePublicUrl } = require("../../utils/storage-url");
const { markGalleryCacheDirty } = require("../../utils/gallery-cache");
const { getCachedAlbumRootName, setCachedAlbumRootName } = require("../../utils/album-root-name-cache");
const { getSessionId } = require("../../utils/session");
const { getManagedPageAccess, normalizeRuntimeConfig } = require("../../utils/runtime-config");
const { guardMiniProgramPageAccess } = require("../../utils/page-access");
const {
  buildStableWaterfallColumns,
  shouldResetStableColumnMap,
} = require("../../utils/stable-waterfall");
const { createPagingSkeletonItems, createPagingSkeletonItemsFromPhotos } = require("../../utils/paging-skeleton");
const { hydratePhotoDimensions } = require("../../utils/photo-dimensions");
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

const SHARE_IMAGE_URL = "/images/share/shiguangyao-share.jpg";
const ALBUM_SWITCH_OVERLAY_TRACK_COUNT = 6;
const ALBUM_PAGING_SKELETON_COUNT = 8;
const ALBUM_LOAD_AHEAD_PX = 720;
const ALBUM_VIEWPORT_FILL_BUFFER_PX = 48;
const ALBUM_INITIAL_AUTOFILL_MAX_BATCHES = 2;
const SHARE_TITLE = "拾光谣｜相册分享";

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

function resolveOriginalUrl(photo) {
  const originalRaw = String((photo && photo.original_url) || "").trim();
  if (originalRaw) {
    return resolvePublicUrl(originalRaw);
  }
  // 兼容历史数据：部分记录只含 url 字段
  const legacyRaw = String((photo && photo.url) || "").trim();
  if (legacyRaw) {
    return resolvePublicUrl(legacyRaw);
  }
  return "";
}

function normalizeMaybeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const lowered = raw.toLowerCase();
  if (lowered === "null" || lowered === "undefined") return "";
  return resolvePublicUrl(raw);
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

function resolveManagedAlbumDetailTitle(runtimeConfig) {
  const access = getManagedPageAccess(runtimeConfig, "album-detail");
  return String((access && (access.headerTitle || access.navText)) || "").trim() || "专属返图空间";
}

function resolveAlbumHeaderTitle(options) {
  const current = options && typeof options === "object" ? options : {};
  return String(
    current.albumTitle ||
      current.rootFolderName ||
      current.initialRootFolderName ||
      current.managedTitle ||
      "专属返图空间"
  ).trim();
}

const ALBUM_LAYOUT_RATIO_MIN = 0.78;
const ALBUM_LAYOUT_RATIO_MAX = 2.5;
const ALBUM_CARD_CHROME_RATIO = 0.24;
const ALBUM_STORY_BASE_RATIO = 1.16;
const ALBUM_STORY_LINE_RATIO = 0.1;
const ALBUM_STORY_CHARS_PER_LINE = 14;
const ALBUM_SOFT_RELAYOUT_DELAY = 160;

function clampAlbumLayoutRatio(value, fallback) {
  const numericValue = Number(value || 0);
  if (!(numericValue > 0)) return fallback;
  return numericValue;
}

function estimateAlbumTextLines(value, charsPerLine) {
  const text = String(value || "").trim();
  if (!text) return 0;

  const perLine = Math.max(8, Number(charsPerLine || 0) || ALBUM_STORY_CHARS_PER_LINE);
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / perLine)), 0);
}

function resolveAlbumPhotoRatio(photo, ratioMap) {
  const id =
    photo && photo.id !== undefined && photo.id !== null
      ? String(photo.id)
      : "";
  const runtimeRatio = id && ratioMap ? Number(ratioMap[id] || 0) : 0;
  if (runtimeRatio > 0) {
    return clampAlbumLayoutRatio(runtimeRatio, 4 / 3);
  }

  const width = Number((photo && photo.width) || 0);
  const height = Number((photo && photo.height) || 0);
  if (width > 0 && height > 0) {
    return clampAlbumLayoutRatio(height / width, 4 / 3);
  }

  const photoRatio = Number(photo && photo.__ratio);
  if (photoRatio > 0) {
    return clampAlbumLayoutRatio(photoRatio, 4 / 3);
  }

  return 4 / 3;
}

function estimateAlbumCardHeight(photo, ratioMap) {
  if (photo && photo.story_open && photo.has_story) {
    const lines = estimateAlbumTextLines(photo.story_text, ALBUM_STORY_CHARS_PER_LINE);
    const storyRatio = ALBUM_STORY_BASE_RATIO + Math.min(1.32, lines * ALBUM_STORY_LINE_RATIO);
    return Math.max(1.3, storyRatio);
  }

  return resolveAlbumPhotoRatio(photo, ratioMap) + ALBUM_CARD_CHROME_RATIO;
}

function resolveAlbumPhotoListRatios(list, ratioMap) {
  return (Array.isArray(list) ? list : []).map((photo) => {
    const nextRatio = resolveAlbumPhotoRatio(photo, ratioMap);
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

function hasAlbumPhotoRatioDrift(currentList, nextList) {
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

function normalizePhoto(photo) {
  const thumbnailUrl = resolvePublicUrl(photo && photo.thumbnail_url);
  const previewUrl = resolvePublicUrl(photo && photo.preview_url);
  const originalUrl = resolveOriginalUrl(photo);
  const storyText = normalizeMaybeText(photo && photo.story_text);
  const hasStory = Boolean(storyText);
  const isHighlight = Boolean(photo && photo.is_highlight);
  return Object.assign({}, photo, {
    thumbnail_url_resolved: thumbnailUrl,
    preview_url_resolved: previewUrl,
    original_url_resolved: originalUrl,
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
    __ratio: resolveAlbumPhotoRatio(photo, null),
    __media_padding_top: `${resolveAlbumPhotoRatio(photo, null) * 100}%`,
    // 列表卡片优先走缩略图，保证清晰度同时降低首屏体积
    card_url_resolved: thumbnailUrl || previewUrl || originalUrl,
    // 全屏查看优先走原图，历史数据回退预览/缩略图
    fullscreen_url_resolved: originalUrl || previewUrl || thumbnailUrl,
  });
}

function withPhotoUiState(list, selectedMap, pinningPhotoIds) {
  const map = selectedMap || {};
  const pinningSet = pinningPhotoIds instanceof Set
    ? pinningPhotoIds
    : new Set(Array.isArray(pinningPhotoIds) ? pinningPhotoIds : []);
  return (list || []).map((item) =>
    Object.assign({}, item, {
      _selected: Boolean(map[String(item.id)]),
      _pinning: pinningSet.has(String(item.id)),
    })
  );
}

function withSelection(list, selectedMap) {
  return withPhotoUiState(list, selectedMap, null);
}

function isExplicitRpcFailure(payload) {
  if (payload === false) return true;
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") break;
    if (current.error) return true;
    if (Object.prototype.hasOwnProperty.call(current, "success") && current.success === false) return true;
    if (Object.prototype.hasOwnProperty.call(current, "deleted") && current.deleted === false) return true;
    if (Object.prototype.hasOwnProperty.call(current, "ok") && current.ok === false) return true;
    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }
  return false;
}

function readRpcPayloadErrorMessage(payload) {
  if (typeof payload === "string" && payload.trim()) {
    return payload.trim();
  }
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") break;
    const directMessage = String(current.message || "").trim();
    if (directMessage) return directMessage;
    const directError = current.error;
    if (typeof directError === "string" && directError.trim()) {
      return directError.trim();
    }
    if (directError && typeof directError === "object") {
      const nestedMessage = String(directError.message || "").trim();
      if (nestedMessage) return nestedMessage;
    }
    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }
  return "";
}

function resolveAlbumContentPayload(payload) {
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) break;
    if (
      Object.prototype.hasOwnProperty.call(current, "album") ||
      Object.prototype.hasOwnProperty.call(current, "folders") ||
      Object.prototype.hasOwnProperty.call(current, "photos")
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

function buildExpiryNotice(album) {
  const expiresAt = album && album.expires_at;
  if (!expiresAt) {
    return "✨ 当前空间内照片默认保留 7 天，请及时下载保存。";
  }

  const expiryDate = parseDateTimeUTC8(expiresAt);
  if (!expiryDate) {
    return "✨ 当前空间内照片默认保留 7 天，请及时下载保存。";
  }

  const daysLeft = Math.ceil((expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  if (daysLeft > 0) {
    return `✨ 当前空间还可查看 ${daysLeft} 天，请及时下载保存。`;
  }
  return "✨ 当前空间有效期已结束，照片已不可查看。";
}

function getExpiryDays(album) {
  const expiresAt = album && album.expires_at;
  if (!expiresAt) return 7;

  const expiryDate = parseDateTimeUTC8(expiresAt);
  if (!expiryDate) return 7;

  const diffTime = expiryDate.getTime() - Date.now();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return Math.max(diffDays, 0);
}

function resolveAlbumAccessErrorMessage(errorMessage) {
  const message = String(errorMessage || "").toLowerCase();
  if (message.includes("过期") || message.includes("expired")) {
    return "该空间已过期";
  }
  if (message.includes("无权") || message.includes("权限") || message.includes("forbidden")) {
    return "您暂无该空间访问权限";
  }
  return "空间不存在或已过期";
}

const ROOT_FOLDER_ID = "__ROOT__";
const FOLDER_GUIDE_SEEN_KEY = "album_folder_tabs_guide_seen_v1";
const PHOTO_PAGE_SIZE = 20;
const PHOTO_BULK_PAGE_SIZE = 100;

function readWindowWidth() {
  try {
    if (typeof wx !== "undefined" && typeof wx.getWindowInfo === "function") {
      const info = wx.getWindowInfo();
      const windowWidth = Number(info && info.windowWidth);
      if (Number.isFinite(windowWidth) && windowWidth > 0) {
        return windowWidth;
      }
    }
  } catch (error) {
    // ignore
  }

  try {
    if (typeof wx !== "undefined" && typeof wx.getSystemInfoSync === "function") {
      const info = wx.getSystemInfoSync();
      const windowWidth = Number(info && info.windowWidth);
      if (Number.isFinite(windowWidth) && windowWidth > 0) {
        return windowWidth;
      }
    }
  } catch (error) {
    // ignore
  }

  return 375;
}

function convertRpxToPx(value) {
  const windowWidth = Math.max(readWindowWidth(), 320);
  return Math.round((Number(value || 0) * windowWidth) / 750);
}

function computeToolbarStickyTop(safeTop) {
  const unit = Math.max(readWindowWidth(), 320) / 750;
  const headerInnerHeight = 112 * unit; // app-header simple 高度
  // 与页面头部无缝衔接：吸顶时不再额外叠加页头下边框高度，避免出现细缝
  const top = Number(safeTop || 0) + headerInnerHeight - 1;
  return Math.max(0, Math.round(top));
}

function computeAlbumSwitchOverlayTop(safeTop) {
  return computeToolbarStickyTop(safeTop) + convertRpxToPx(92);
}

function splitWaterfallColumns(list, options) {
  const ratioMap = options && options.ratioMap ? options.ratioMap : null;
  const resolvedList = resolveAlbumPhotoListRatios(list, ratioMap);
  return buildStableWaterfallColumns(resolvedList, {
    left: options && options.left,
    right: options && options.right,
    leftHeight: options && options.leftHeight,
    rightHeight: options && options.rightHeight,
    columnMap: options && options.columnMap,
    estimateHeight: (item) => estimateAlbumCardHeight(item, ratioMap),
  });
}

function resolveAlbumPhotoPagePayload(payload) {
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) break;
    if (Array.isArray(current.photos) || Array.isArray(current.rows) || Array.isArray(current.items)) {
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

function toPageNumber(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return Math.max(1, Number(fallback || 1));
  }
  return Math.max(1, Math.round(numeric));
}

function readPageTotal(payload, fallbackCount) {
  const fallback = Math.max(0, Number(fallbackCount || 0));
  if (!payload || typeof payload !== "object") {
    return fallback;
  }

  const candidates = [payload.total, payload.count, payload.totalCount];
  for (let i = 0; i < candidates.length; i += 1) {
    const numeric = Number(candidates[i]);
    if (Number.isFinite(numeric) && numeric >= 0) {
      return Math.round(numeric);
    }
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

function toNonNegativeInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.round(numeric);
}

function isRpcFunctionNotImplemented(errorMessage) {
  const text = String(errorMessage || "").toLowerCase();
  if (!text) return false;
  return (
    text.includes("鏈疄鐜扮殑 rpc") ||
    text.includes("not implemented") ||
    text.includes("not support") ||
    text.includes("unknown rpc")
  );
}

function hasStorageCleanupFailed(payload) {
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") break;
    if (Object.prototype.hasOwnProperty.call(current, "storage_cleanup_failed")) {
      return Boolean(current.storage_cleanup_failed);
    }
    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }
  return false;
}

function filterPhotosByFolder(list, folderId) {
  const targetFolderId = String(folderId || ROOT_FOLDER_ID);
  const rows = Array.isArray(list) ? list : [];

  if (targetFolderId === ROOT_FOLDER_ID) {
    return rows.filter((item) => !String(item && item.folder_id ? item.folder_id : "").trim());
  }

  return rows.filter((item) => String(item && item.folder_id ? item.folder_id : "") === targetFolderId);
}

function normalizeWelcomeLetterMode(mode, enabledFallback) {
  const normalized = String(mode || "").trim().toLowerCase();
  if (normalized === "envelope" || normalized === "stamp" || normalized === "none") {
    return normalized;
  }
  return enabledFallback === false ? "none" : "envelope";
}

function normalizeWelcomeStoragePart(value) {
  return String(value == null ? "" : value).replace(/\r\n/g, "\n").trim();
}

function buildWelcomeStorageToken(album) {
  const source = album && typeof album === "object" ? album : {};
  const mode = normalizeWelcomeLetterMode(
    source.welcome_letter_mode,
    source.enable_welcome_letter !== false
  );
  return [
    mode,
    normalizeWelcomeStoragePart(source.recipient_name),
    normalizeWelcomeStoragePart(source.welcome_letter),
  ].join("::");
}

Page({
  data: {
    safeTop: 0,
    toolbarStickyTop: 0,
    folderSwitchOverlayTopPx: 0,
    serviceMissing: false,
    backendReady: false,
    backendReconnecting: false,

    key: "",
    loading: true,
    loadingMore: false,
    switchingFolderLoading: false,
    pendingFolderPhotoIds: [],
    hasMore: false,
    pageNo: 0,
    total: 0,

    album: null,
    managedTitle: "专属返图空间",
    headerTitle: "",
    pageScaffoldReady: false,
    expiryDays: 7,
    expiryNotice: "",
    showNotice: true,
    welcomeText: "",
    rootFolderName: "根目录",
    initialRootFolderName: "",

    folders: [],
    selectedFolder: ROOT_FOLDER_ID,
    showFolderGuide: false,
    folderWaveActiveIndex: -1,
    folderWaveTick: 0,
    allPhotos: [],
    photos: [],
    leftPhotos: [],
    rightPhotos: [],
    pagingSkeletonLeftPhotos: [],
    pagingSkeletonRightPhotos: [],

    selectedPhotoMap: {},
    selectedCount: 0,
    isSelectAll: false,
    batchLoading: false,
    downloadProgressVisible: false,
    downloadProgressRunning: false,
    downloadProgressDone: false,
    downloadProgressCurrent: 0,
    downloadProgressTotal: 0,
    downloadProgressSuccess: 0,
    downloadProgressFail: 0,
    downloadProgressPercent: 0,
    downloadProgressTitle: "",
    downloadProgressMessage: "",

    confirmPhotoId: "",
    pinConfirmPending: false,
    showDeleteConfirm: false,
    showWelcomeLetter: false,
    showWelcomeEasterEgg: false,
    welcomeLetterMode: "envelope",
    welcomeOpenedFromEgg: false,
    pendingFolderWaveAfterLetterClose: false,
    showDonationModal: false,
    donationSaving: false,
    welcomeStorageKey: "",
    welcomeEggStorageKey: "",
    welcomeStorageToken: "",

    toast: null,

    // Web 鍚屾鎷嗕俊浜や簰锛歟nvelope -> opening -> letter -> closing
    letterStage: "envelope",

  },

  toastTimer: null,
  folderGuideTimer: null,
  folderWaveTimer: null,
  folderWaveRunToken: 0,
  storyMotionTimers: null,
  leftHeight: 0,
  rightHeight: 0,
  photoRatioMap: null,
  photoColumnMap: null,
  relayoutTimer: null,
  photoLoadTicket: 0,
  pendingPinPhotoIds: null,
  useLegacyPhotoPaging: false,
  legacyPhotosByFolder: null,
  fullPhotosByFolder: null,
  _lastAlbumAutoLoadAt: 0,
  _windowHeight: 0,
  albumAutoFillRemaining: ALBUM_INITIAL_AUTOFILL_MAX_BATCHES,
  albumLoadZoneArmed: true,
  autoFillTimer: null,
  downloadProgressTimer: null,
  loadingNextPhotoPage: false,
  currentScrollTop: 0,
  albumPrefetchToken: 0,
  albumPrefetchPromise: null,
  prefetchingAlbumPageNo: 0,
  prefetchingAlbumFolderId: "",
  prefetchedAlbumPage: null,

  async onLoad(options) {
    const app = getApp();
    const globalData = app && app.globalData ? app.globalData : {};
    const safeTop = Number(globalData.statusBarHeight || 0);
    const serviceMissing = !String(globalData.cloudRunService || "").trim();
    const backendReady = serviceMissing ? true : Boolean(globalData.backendReady);
    const backendReconnecting = !backendReady && Boolean(globalData.backendReconnecting);
    const runtimeConfig = normalizeRuntimeConfig(globalData.runtimeConfig || null);
    const managedTitle = resolveManagedAlbumDetailTitle(runtimeConfig);
    this.useLegacyPhotoPaging = false;
    this.legacyPhotosByFolder = Object.create(null);
    this.fullPhotosByFolder = Object.create(null);
    this.leftHeight = 0;
    this.rightHeight = 0;
    this.photoRatioMap = Object.create(null);
    this.photoColumnMap = Object.create(null);
    this.pendingPinPhotoIds = new Set();
    this.relayoutTimer = null;
    this._lastAlbumAutoLoadAt = 0;
    this._windowHeight = 0;
    this.albumAutoFillRemaining = ALBUM_INITIAL_AUTOFILL_MAX_BATCHES;
    this.albumLoadZoneArmed = true;
    this.autoFillTimer = null;
    this.currentScrollTop = 0;
    this.albumPrefetchToken = 0;
    this.albumPrefetchPromise = null;
    this.prefetchingAlbumPageNo = 0;
    this.prefetchingAlbumFolderId = "";
    this.prefetchedAlbumPage = null;
    const currentAppEnterSeq = Math.max(0, Number(globalData.appEnterSeq || 0));
    this._lastSeenAppEnterSeq = Math.max(0, currentAppEnterSeq - 1);
    try {
      if (typeof wx.getWindowInfo === "function") {
        const info = wx.getWindowInfo();
        this._windowHeight = Number(info && info.windowHeight) || 0;
      } else if (typeof wx.getSystemInfoSync === "function") {
        const info = wx.getSystemInfoSync();
        this._windowHeight = Number(info && info.windowHeight) || 0;
      }
    } catch (error) {
      this._windowHeight = 0;
    }

    const key = String((options && options.key) || "").trim().toUpperCase();
    const cachedRootFolderName = getCachedAlbumRootName(key);
    const rawRootFolderName = String(
      (options && (options.rootFolderName || options.root_folder_name || options.root)) || ""
    ).trim();
    let initialRootFolderName = rawRootFolderName;
    try {
      initialRootFolderName = rawRootFolderName ? decodeURIComponent(rawRootFolderName) : "";
    } catch (error) {
      initialRootFolderName = rawRootFolderName;
    }

    if (!key) {
      wx.showToast({ title: "缺少密钥", icon: "none" });
      wx.switchTab({ url: "/pages/album/index" });
      return;
    }

    this.setData({
      safeTop,
      toolbarStickyTop: computeToolbarStickyTop(safeTop),
      folderSwitchOverlayTopPx: computeAlbumSwitchOverlayTop(safeTop),
      serviceMissing,
      backendReady,
      backendReconnecting,
      key,
      managedTitle,
      headerTitle: serviceMissing ? (cachedRootFolderName || initialRootFolderName || managedTitle) : "",
      pageScaffoldReady: Boolean(serviceMissing),
      welcomeStorageKey: `album_welcome_seen_${key}`,
      welcomeEggStorageKey: `album_welcome_egg_seen_${key}`,
      rootFolderName: cachedRootFolderName || initialRootFolderName || "根目录",
      initialRootFolderName: cachedRootFolderName || initialRootFolderName || "",
    }, () => {
      this.scheduleToolbarStickyTopSync();
    });

    if (app && typeof app.subscribeMiniProgramRuntimeConfig === "function") {
      this._unsubscribeAuditConfig = app.subscribeMiniProgramRuntimeConfig((runtimeConfig) => {
        const normalized = normalizeRuntimeConfig(runtimeConfig);
        const nextManagedTitle = resolveManagedAlbumDetailTitle(normalized);
        this.setData({
          managedTitle: nextManagedTitle,
          headerTitle: resolveAlbumHeaderTitle({
            albumTitle: this.data.album && this.data.album.title,
            rootFolderName: this.data.rootFolderName,
            initialRootFolderName: this.data.initialRootFolderName,
            managedTitle: nextManagedTitle,
          }),
        });
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
    const accessDenied = await this.guardManagedAccess();
    if (accessDenied) {
      return;
    }
    if (!serviceMissing) {
      if (backendReady) {
        this.loadAlbum();
      } else if (app && typeof app.ensureBackendReady === "function") {
        this.setData({ loading: true });
        void app.ensureBackendReady();
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

    const normalized = normalizeRuntimeConfig(
      app && app.globalData
        ? app.globalData.runtimeConfig || null
        : null
    );
    const managedTitle = resolveManagedAlbumDetailTitle(normalized);
    this.setData({
      managedTitle,
      headerTitle: resolveAlbumHeaderTitle({
        albumTitle: this.data.album && this.data.album.title,
        rootFolderName: this.data.rootFolderName,
        initialRootFolderName: this.data.initialRootFolderName,
        managedTitle,
      }),
    });
    this.scheduleToolbarStickyTopSync();
    const accessDenied = await this.guardManagedAccess();
    if (accessDenied) return false;

    const appEnterSeq = Math.max(
      0,
      Number(app && app.globalData ? app.globalData.appEnterSeq : 0)
    );
    const lastSeenAppEnterSeq = Math.max(0, Number(this._lastSeenAppEnterSeq || 0));
    const hasNewAppEntry = appEnterSeq > lastSeenAppEnterSeq;
    if (hasNewAppEntry) {
      this._lastSeenAppEnterSeq = Math.max(appEnterSeq, lastSeenAppEnterSeq);
    }

    if (this.data.serviceMissing) return false;
    if (!String(this.data.key || "").trim()) return;
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
    const nextBackendReady = Boolean(app && app.globalData && app.globalData.backendReady);
    const nextBackendReconnecting = !nextBackendReady && Boolean(
      app && app.globalData && app.globalData.backendReconnecting
    );
    this.setData({
      backendReady: nextBackendReady,
      backendReconnecting: nextBackendReconnecting,
    });
    if (!this.data.album) {
      this.loadAlbum();
      return;
    }
    if (this.consumeSuppressRefreshOnShow()) return;
    if (this.data.loading || this.data.loadingMore) return;

    const hasLoadedPhotos = Array.isArray(this.data.photos) && this.data.photos.length > 0;
    if (hasNewAppEntry) {
      this.triggerFolderGuideForEntry();
      if (hasLoadedPhotos) {
        return false;
      }
    } else {
      this.triggerFolderGuideForEntry();
    }

    void this.loadPhotoPage(this.data.selectedFolder || ROOT_FOLDER_ID, 1, {
      reset: true,
      silent: true,
      skipWave: true,
    });
  },

  async guardManagedAccess() {
    const result = await guardMiniProgramPageAccess({
      pageKey: "album-detail",
      fallbackTab: "pages/album/index",
    });
    return !result.allowed;
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

  scheduleToolbarStickyTopSync() {
    if (typeof wx === "undefined" || typeof wx.nextTick !== "function") return;
    wx.nextTick(() => {
      this.syncToolbarStickyTop();
    });
  },

  syncToolbarStickyTop() {
    const safeTop = Number(this.data.safeTop || 0);
    const nextToolbarStickyTop = computeToolbarStickyTop(safeTop);
    const nextFolderSwitchOverlayTopPx = computeAlbumSwitchOverlayTop(safeTop);
    const nextData = {};

    if (Math.abs(nextToolbarStickyTop - Number(this.data.toolbarStickyTop || 0)) >= 1) {
      nextData.toolbarStickyTop = nextToolbarStickyTop;
    }
    if (Math.abs(nextFolderSwitchOverlayTopPx - Number(this.data.folderSwitchOverlayTopPx || 0)) >= 1) {
      nextData.folderSwitchOverlayTopPx = nextFolderSwitchOverlayTopPx;
    }

    if (Object.keys(nextData).length > 0) {
      this.setData(nextData);
    }
  },

  onUnload() {
    this.clearToastTimer();
    this.clearDownloadProgressTimer();
    this.clearFolderGuideTimer();
    this.clearFolderWaveTimer();
    this.clearRelayoutTimer();
    this.clearAutoFillTimer();
    this.clearAllStoryMotionTimers();
    this.photoLoadTicket += 1;
    this.invalidateAlbumPrefetch();
    this._lastAlbumAutoLoadAt = 0;
    if (typeof this._unsubscribeAuditConfig === "function") {
      this._unsubscribeAuditConfig();
    }
    this._unsubscribeAuditConfig = null;
    if (typeof this._unsubscribeBackendStatus === "function") {
      this._unsubscribeBackendStatus();
    }
    this._unsubscribeBackendStatus = null;
  },

  noop() {},

  clearToastTimer() {
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
  },

  clearDownloadProgressTimer() {
    if (this.downloadProgressTimer) {
      clearTimeout(this.downloadProgressTimer);
      this.downloadProgressTimer = null;
    }
  },

  hideDownloadProgress() {
    this.clearDownloadProgressTimer();
    this.setData({
      downloadProgressVisible: false,
      downloadProgressRunning: false,
      downloadProgressDone: false,
      downloadProgressCurrent: 0,
      downloadProgressTotal: 0,
      downloadProgressSuccess: 0,
      downloadProgressFail: 0,
      downloadProgressPercent: 0,
      downloadProgressTitle: "",
      downloadProgressMessage: "",
    });
  },

  openDownloadProgress(options) {
    const config = options && typeof options === "object" ? options : {};
    const total = Math.max(0, Number(config.total || 0));
    const currentRaw = Number(config.current || 0);
    const current = total > 0 ? Math.max(0, Math.min(total, currentRaw)) : Math.max(0, currentRaw);
    const success = Math.max(0, Number(config.success || 0));
    const fail = Math.max(0, Number(config.fail || 0));
    const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((current / total) * 100))) : 0;

    this.clearDownloadProgressTimer();
    this.setData({
      downloadProgressVisible: true,
      downloadProgressRunning: config.running !== false,
      downloadProgressDone: Boolean(config.done),
      downloadProgressCurrent: current,
      downloadProgressTotal: total,
      downloadProgressSuccess: success,
      downloadProgressFail: fail,
      downloadProgressPercent: percent,
      downloadProgressTitle: String(config.title || ""),
      downloadProgressMessage: String(config.message || ""),
    });
  },

  updateDownloadProgress(patch) {
    const nextPatch = patch && typeof patch === "object" ? patch : {};
    const total = Object.prototype.hasOwnProperty.call(nextPatch, "total")
      ? Math.max(0, Number(nextPatch.total || 0))
      : Math.max(0, Number(this.data.downloadProgressTotal || 0));
    const currentRaw = Object.prototype.hasOwnProperty.call(nextPatch, "current")
      ? Number(nextPatch.current || 0)
      : Number(this.data.downloadProgressCurrent || 0);
    const current = total > 0 ? Math.max(0, Math.min(total, currentRaw)) : Math.max(0, currentRaw);
    const success = Object.prototype.hasOwnProperty.call(nextPatch, "success")
      ? Math.max(0, Number(nextPatch.success || 0))
      : Math.max(0, Number(this.data.downloadProgressSuccess || 0));
    const fail = Object.prototype.hasOwnProperty.call(nextPatch, "fail")
      ? Math.max(0, Number(nextPatch.fail || 0))
      : Math.max(0, Number(this.data.downloadProgressFail || 0));
    const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((current / total) * 100))) : 0;

    const nextData = {
      downloadProgressVisible: true,
      downloadProgressCurrent: current,
      downloadProgressTotal: total,
      downloadProgressSuccess: success,
      downloadProgressFail: fail,
      downloadProgressPercent: percent,
    };

    if (Object.prototype.hasOwnProperty.call(nextPatch, "running")) {
      nextData.downloadProgressRunning = Boolean(nextPatch.running);
    }
    if (Object.prototype.hasOwnProperty.call(nextPatch, "done")) {
      nextData.downloadProgressDone = Boolean(nextPatch.done);
    }
    if (Object.prototype.hasOwnProperty.call(nextPatch, "title")) {
      nextData.downloadProgressTitle = String(nextPatch.title || "");
    }
    if (Object.prototype.hasOwnProperty.call(nextPatch, "message")) {
      nextData.downloadProgressMessage = String(nextPatch.message || "");
    }

    this.setData(nextData);
  },

  finishDownloadProgress(options) {
    const config = options && typeof options === "object" ? options : {};
    const total = Math.max(0, Number(config.total || this.data.downloadProgressTotal || 0));
    const success = Math.max(0, Number(config.success || 0));
    const fail = Math.max(0, Number(config.fail || 0));

    if (total <= 0) {
      this.hideDownloadProgress();
      return;
    }

    this.clearDownloadProgressTimer();
    this.setData({
      downloadProgressVisible: true,
      downloadProgressRunning: false,
      downloadProgressDone: true,
      downloadProgressCurrent: total,
      downloadProgressTotal: total,
      downloadProgressSuccess: success,
      downloadProgressFail: fail,
      downloadProgressPercent: 100,
      downloadProgressTitle: "保存完成",
      downloadProgressMessage: fail > 0
        ? `成功 ${success} 张 · 失败 ${fail} 张`
        : `已成功保存 ${success} 张照片`,
    });

    this.downloadProgressTimer = setTimeout(() => {
      this.hideDownloadProgress();
    }, 3200);
  },

  clearFolderGuideTimer() {
    if (this.folderGuideTimer) {
      clearTimeout(this.folderGuideTimer);
      this.folderGuideTimer = null;
    }
  },

  clearFolderWaveTimer() {
    this.folderWaveRunToken += 1;
    if (this.folderWaveTimer) {
      clearTimeout(this.folderWaveTimer);
      this.folderWaveTimer = null;
    }
  },

  clearRelayoutTimer() {
    if (!this.relayoutTimer) return;
    clearTimeout(this.relayoutTimer);
    this.relayoutTimer = null;
  },

  clearAutoFillTimer() {
    if (!this.autoFillTimer) return;
    clearTimeout(this.autoFillTimer);
    this.autoFillTimer = null;
  },

  ensureWindowHeight() {
    if (Number(this._windowHeight || 0) > 0) {
      return Number(this._windowHeight || 0);
    }

    try {
      if (typeof wx.getWindowInfo === "function") {
        const info = wx.getWindowInfo();
        this._windowHeight = Number(info && info.windowHeight) || 0;
      } else if (typeof wx.getSystemInfoSync === "function") {
        const info = wx.getSystemInfoSync();
        this._windowHeight = Number(info && info.windowHeight) || 0;
      }
    } catch (error) {
      this._windowHeight = 0;
    }

    return Number(this._windowHeight || 0);
  },

  scheduleAutoFillCheck(delay) {
    this.clearAutoFillTimer();
    this.autoFillTimer = setTimeout(() => {
      this.autoFillTimer = null;
      this.maybeAutoFillViewport("scheduled");
    }, Math.max(0, Number(delay || 0)));
  },

  maybeAutoFillViewport(reason) {
    if (this.data.serviceMissing) return false;
    if (this.data.loading || this.data.loadingMore) return false;
    if (this.data.switchingFolderLoading) return false;
    if (!this.data.hasMore) return false;
    if (!(this.albumAutoFillRemaining > 0)) return false;

    const viewportHeight = this.ensureWindowHeight();
    if (!(viewportHeight > 0)) return false;

    wx.createSelectorQuery()
      .selectViewport()
      .scrollOffset((offset) => {
        if (this.data.loading || this.data.loadingMore || this.data.switchingFolderLoading || !this.data.hasMore) {
          return;
        }

        const scrollHeight = Number((offset && offset.scrollHeight) || 0);
        if (!(scrollHeight > 0)) return;
        if (scrollHeight > viewportHeight + ALBUM_VIEWPORT_FILL_BUFFER_PX) return;
        if (!(this.albumAutoFillRemaining > 0)) return;

        this.albumAutoFillRemaining -= 1;
        this._lastAlbumAutoLoadAt = Date.now();
        Promise.resolve(
          this.loadPhotoPage(this.data.selectedFolder || ROOT_FOLDER_ID, Number(this.data.pageNo || 0) + 1, {
            reset: false,
            silent: false,
          })
        ).then((success) => {
          if (!success) {
            this.albumAutoFillRemaining += 1;
          }
        });
      })
      .exec();

    return true;
  },

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

  calculateWaterfallHeight(list) {
    return (Array.isArray(list) ? list : []).reduce(
      (total, photo) => total + estimateAlbumCardHeight(photo, this.photoRatioMap),
      0
    );
  },

  canAppendWaterfall(nextList) {
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

  applyWaterfallPhotos(photos, opts) {
    const resolvedPhotos = resolveAlbumPhotoListRatios(photos, this.photoRatioMap);
    if (Boolean(opts && opts.resetColumnMap) || shouldResetStableColumnMap(this.data.photos || [], resolvedPhotos)) {
      this.photoColumnMap = Object.create(null);
    }

    if (Boolean(opts && opts.preferAppend) && this.canAppendWaterfall(resolvedPhotos)) {
      const preservedScrollTop = Math.max(0, Number(this.currentScrollTop || 0));
      const baseLeft = resolveAlbumPhotoListRatios(this.data.leftPhotos || [], this.photoRatioMap);
      const baseRight = resolveAlbumPhotoListRatios(this.data.rightPhotos || [], this.photoRatioMap);
      const incremental = resolvedPhotos.slice((this.data.photos || []).length);
      const columns = splitWaterfallColumns(incremental, {
        left: baseLeft,
        right: baseRight,
        leftHeight: this.calculateWaterfallHeight(baseLeft),
        rightHeight: this.calculateWaterfallHeight(baseRight),
        ratioMap: this.photoRatioMap,
        columnMap: this.photoColumnMap,
      });
      this.photoColumnMap = columns.columnMap || Object.create(null);
      this.leftHeight = columns.leftHeight;
      this.rightHeight = columns.rightHeight;
      this.setData(
        {
          photos: resolvedPhotos,
          leftPhotos: columns.left,
          rightPhotos: columns.right,
        },
        () => {
          if (preservedScrollTop > 0) {
            try {
              wx.pageScrollTo({
                scrollTop: preservedScrollTop,
                duration: 0,
              });
            } catch (error) {
            }
          }
          this.refreshSelectionMeta();
        }
      );
      return true;
    }

    const columns = splitWaterfallColumns(resolvedPhotos, {
      ratioMap: this.photoRatioMap,
      columnMap: this.photoColumnMap,
    });
    this.photoColumnMap = columns.columnMap || Object.create(null);
    this.leftHeight = columns.leftHeight;
    this.rightHeight = columns.rightHeight;
    this.setData(
      {
        photos: resolvedPhotos,
        leftPhotos: columns.left,
        rightPhotos: columns.right,
      },
      () => this.refreshSelectionMeta()
    );
  },

  clearPagingSkeletons() {
    if (
      (!Array.isArray(this.data.pagingSkeletonLeftPhotos) || this.data.pagingSkeletonLeftPhotos.length === 0) &&
      (!Array.isArray(this.data.pagingSkeletonRightPhotos) || this.data.pagingSkeletonRightPhotos.length === 0)
    ) {
      return;
    }

    this.setData({
      pagingSkeletonLeftPhotos: [],
      pagingSkeletonRightPhotos: [],
    });
  },

  buildPagingSkeletonColumns(skeletonItems) {
    const source = Array.isArray(skeletonItems) ? skeletonItems : [];
    if (source.length <= 0) {
      return { left: [], right: [] };
    }

    const columns = splitWaterfallColumns(source, {
      left: [],
      right: [],
      leftHeight: Math.max(0, Number(this.leftHeight || 0)),
      rightHeight: Math.max(0, Number(this.rightHeight || 0)),
      ratioMap: this.photoRatioMap,
      columnMap: Object.assign(Object.create(null), this.photoColumnMap || Object.create(null)),
    });

    return {
      left: columns.left || [],
      right: columns.right || [],
    };
  },

  showPagingSkeletons(count, photos) {
    const safeCount = Math.max(0, Number(count || 0));
    if (!(safeCount > 0)) {
      this.clearPagingSkeletons();
      return;
    }

    const skeletonItems = Array.isArray(photos) && photos.length > 0
      ? createPagingSkeletonItemsFromPhotos(photos, {
        prefix: "album",
        seed: Date.now(),
      })
      : createPagingSkeletonItems(safeCount, {
        prefix: "album",
        seed: Date.now(),
      });
    const columns = this.buildPagingSkeletonColumns(skeletonItems);
    this.setData({
      pagingSkeletonLeftPhotos: columns.left,
      pagingSkeletonRightPhotos: columns.right,
    });
  },

  invalidateAlbumPrefetch() {
    this.albumPrefetchToken = Number(this.albumPrefetchToken || 0) + 1;
    this.albumPrefetchPromise = null;
    this.prefetchingAlbumPageNo = 0;
    this.prefetchingAlbumFolderId = "";
    this.prefetchedAlbumPage = null;
  },

  canUsePrefetchedAlbumPage(folderId, pageNo) {
    const prefetched = this.prefetchedAlbumPage;
    if (!prefetched || typeof prefetched !== "object") {
      return false;
    }
    return (
      Number(prefetched.pageNo || 0) === Number(pageNo || 0) &&
      String(prefetched.folderId || "") === String(folderId || "")
    );
  },

  async fetchAlbumPhotoPageData(folderId, pageNo) {
    const normalizedFolderId = String(folderId || ROOT_FOLDER_ID);
    const nextPageNo = toPageNumber(pageNo, 1);
    const r = await dbRpc("get_album_photo_page", {
      input_key: this.data.key,
      folder_id: normalizedFolderId,
      page_no: nextPageNo,
      page_size: PHOTO_PAGE_SIZE,
    });

    const rawPayload = r ? r.data : null;
    const payload = resolveAlbumPhotoPagePayload(rawPayload);
    const rpcErrorMessage = String((r && r.error && r.error.message) || "").trim();
    const payloadErrorMessage =
      isExplicitRpcFailure(rawPayload) || isExplicitRpcFailure(payload)
        ? readRpcPayloadErrorMessage(rawPayload || payload)
        : "";

    if (isRpcFunctionNotImplemented(rpcErrorMessage || payloadErrorMessage)) {
      return {
        errorMessage: "",
        fallbackLegacy: true,
        folderId: normalizedFolderId,
        pageNo: nextPageNo,
        rows: [],
        total: 0,
        hasMore: false,
      };
    }

    if (rpcErrorMessage || payloadErrorMessage || !payload) {
      return {
        errorMessage: rpcErrorMessage || payloadErrorMessage || "加载失败",
        fallbackLegacy: false,
        folderId: normalizedFolderId,
        pageNo: nextPageNo,
        rows: [],
        total: 0,
        hasMore: false,
      };
    }

    const rows = Array.isArray(payload.photos) ? payload.photos : [];
    const normalizedRows = rows.map(normalizePhoto);
    const hydratedRows = normalizedRows.length > 0
      ? await hydratePhotoDimensions(normalizedRows)
      : normalizedRows;
    const total = readPageTotal(payload, hydratedRows.length);
    const hasMoreFromPayload = Object.prototype.hasOwnProperty.call(payload, "has_more")
      ? Boolean(payload.has_more)
      : null;
    const hasMore = hasMoreFromPayload === null
      ? hydratedRows.length >= PHOTO_PAGE_SIZE
      : hasMoreFromPayload;

    return {
      errorMessage: "",
      fallbackLegacy: false,
      folderId: normalizedFolderId,
      pageNo: nextPageNo,
      rows: hydratedRows,
      total,
      hasMore,
    };
  },

  commitAlbumPhotoPageData(folderId, pageNo, pageData, opts) {
    const reset = Boolean(opts && opts.reset);
    const silent = Boolean(opts && opts.silent);
    const targetFolderId = String(folderId || ROOT_FOLDER_ID);
    const currentRows = reset
      ? []
      : (Array.isArray(this.data.allPhotos) ? this.data.allPhotos : []);
    const incomingRows = Array.isArray(pageData && pageData.rows) ? pageData.rows : [];
    let mergedRows = incomingRows;

    if (!reset) {
      const existingIds = new Set(currentRows.map((item) => String(item.id)));
      const incrementalRows = incomingRows.filter((item) => !existingIds.has(String(item.id)));
      mergedRows = currentRows.concat(incrementalRows);
    }

    const total = Math.max(0, Number(pageData && pageData.total) || 0);
    const hasKnownTotal = total > 0;
    const hasMore = hasKnownTotal
      ? mergedRows.length < total
      : Boolean(pageData && pageData.hasMore);
    const selectedPhotos = withSelection(mergedRows, this.data.selectedPhotoMap || {});
    if (!hasMore && mergedRows.length > 0) {
      this.cacheFullPhotosForFolder(targetFolderId, mergedRows);
    }

    let nextPendingFolderPhotoIds = null;
    if (reset) {
      nextPendingFolderPhotoIds = silent
        ? Array.from(
          new Set(
            mergedRows
              .slice(0, ALBUM_SWITCH_OVERLAY_TRACK_COUNT)
              .filter((photo) => photo && !photo._imageLoaded && !photo._imageLoadFailed)
              .map((photo) => String((photo && photo.id) || "").trim())
              .filter(Boolean)
          )
        )
        : [];
    }

    const nextData = {
      allPhotos: mergedRows,
      pageNo,
      total,
      hasMore,
    };
    if (reset) {
      nextData.pendingFolderPhotoIds = nextPendingFolderPhotoIds;
    }

    this.setData(
      nextData,
      () => this.applyWaterfallPhotos(selectedPhotos, { preferAppend: !reset })
    );

    if (hasMore) {
      void this.prefetchAlbumPhotoPage(targetFolderId, pageNo + 1);
    } else {
      this.invalidateAlbumPrefetch();
    }

    return {
      success: true,
      nextPendingFolderPhotoIds,
    };
  },

  async prefetchAlbumPhotoPage(folderId, pageNo) {
    if (this.data.serviceMissing) return null;
    if (this.useLegacyPhotoPaging) return null;

    const targetFolderId = String(folderId || ROOT_FOLDER_ID);
    const nextPageNo = toPageNumber(pageNo, 1);
    if (!(nextPageNo > 1)) return null;
    if (String(this.data.selectedFolder || ROOT_FOLDER_ID) !== targetFolderId) {
      return null;
    }
    if (this.canUsePrefetchedAlbumPage(targetFolderId, nextPageNo)) {
      return this.prefetchedAlbumPage;
    }
    if (
      Number(this.prefetchingAlbumPageNo || 0) === nextPageNo &&
      String(this.prefetchingAlbumFolderId || "") === targetFolderId &&
      this.albumPrefetchPromise
    ) {
      return this.albumPrefetchPromise;
    }

    const token = Number(this.albumPrefetchToken || 0) + 1;
    this.albumPrefetchToken = token;
    this.prefetchedAlbumPage = null;
    this.prefetchingAlbumPageNo = nextPageNo;
    this.prefetchingAlbumFolderId = targetFolderId;

    const task = Promise.resolve(this.fetchAlbumPhotoPageData(targetFolderId, nextPageNo))
      .then((pageData) => {
        if (token !== this.albumPrefetchToken) {
          return null;
        }
        if (!pageData || pageData.errorMessage || pageData.fallbackLegacy) {
          return null;
        }
        if (String(this.data.selectedFolder || ROOT_FOLDER_ID) !== targetFolderId) {
          return null;
        }
        this.prefetchedAlbumPage = Object.assign({}, pageData);
        return this.prefetchedAlbumPage;
      })
      .catch(() => null)
      .finally(() => {
        if (token === this.albumPrefetchToken) {
          this.albumPrefetchPromise = null;
          this.prefetchingAlbumPageNo = 0;
          this.prefetchingAlbumFolderId = "";
        }
      });

    this.albumPrefetchPromise = task;
    return task;
  },

  scheduleRelayout() {
    if (this.relayoutTimer) return;
    this.relayoutTimer = setTimeout(() => {
      this.relayoutTimer = null;
      const nextPhotos = resolveAlbumPhotoListRatios(this.data.photos || [], this.photoRatioMap);
      const nextLeftPhotos = resolveAlbumPhotoListRatios(this.data.leftPhotos || [], this.photoRatioMap);
      const nextRightPhotos = resolveAlbumPhotoListRatios(this.data.rightPhotos || [], this.photoRatioMap);
      const shouldSyncVisible =
        hasAlbumPhotoRatioDrift(this.data.photos, nextPhotos) ||
        hasAlbumPhotoRatioDrift(this.data.leftPhotos, nextLeftPhotos) ||
        hasAlbumPhotoRatioDrift(this.data.rightPhotos, nextRightPhotos);

      this.leftHeight = this.calculateWaterfallHeight(nextLeftPhotos);
      this.rightHeight = this.calculateWaterfallHeight(nextRightPhotos);

      if (!shouldSyncVisible) {
        this.scheduleAutoFillCheck(100);
        return false;
      }
      this.setData({
        photos: nextPhotos,
        leftPhotos: nextLeftPhotos,
        rightPhotos: nextRightPhotos,
      }, () => this.scheduleAutoFillCheck(100));
    }, ALBUM_SOFT_RELAYOUT_DELAY);
  },

  onPhotoLoad(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id || this.isPinActionPending(id)) return;

    const current = this.findPhotoById(id);
    if (current && (!current._imageLoaded || current._imageLoadFailed)) {
      this.patchPhotoVisualState(id, (photo) => Object.assign({}, photo, {
        _imageLoaded: true,
        _imageLoadFailed: false,
      }));
    }
    this.markPendingFolderPhotoSettled(id);

    const stablePhoto = current || this.findPhotoById(id);
    const hasStableStoredRatio = Boolean(
      stablePhoto
      && (
        Number(stablePhoto.width || 0) > 0
        && Number(stablePhoto.height || 0) > 0
      )
    );
    if (hasStableStoredRatio) return;

    const shouldAllowLiveRelayout = Boolean(
      this.data.switchingFolderLoading ||
      (Array.isArray(this.data.pendingFolderPhotoIds) && this.data.pendingFolderPhotoIds.length > 0)
    );
    if (!shouldAllowLiveRelayout) return;

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
    if (!(Number(nextCurrent.width || 0) > 0 && Number(nextCurrent.height || 0) > 0)) {
      this.patchPhotoVisualState(id, (photo) => Object.assign({}, photo, {
        width,
        height,
      }));
    }

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
    if (!id || this.isPinActionPending(id)) return;

    const current = this.findPhotoById(id);
    if (!current || current._imageLoadFailed) return;

    this.patchPhotoVisualState(id, (photo) => Object.assign({}, photo, {
      _imageLoaded: false,
      _imageLoadFailed: true,
    }));
    this.markPendingFolderPhotoSettled(id);
  },

  markPendingFolderPhotoSettled(photoId) {
    const normalizedPhotoId = String(photoId || "").trim();
    if (!normalizedPhotoId) return;

    const pendingFolderPhotoIds = Array.isArray(this.data.pendingFolderPhotoIds)
      ? this.data.pendingFolderPhotoIds
      : [];
    if (!pendingFolderPhotoIds.includes(normalizedPhotoId)) {
      return;
    }

    const nextPendingFolderPhotoIds = pendingFolderPhotoIds.filter((currentPhotoId) => currentPhotoId !== normalizedPhotoId);
    this.setData({
      pendingFolderPhotoIds: nextPendingFolderPhotoIds,
      switchingFolderLoading: nextPendingFolderPhotoIds.length > 0,
    });
  },

  startFolderWaveAnimation() {
    this.clearFolderWaveTimer();
    const folderCount = Array.isArray(this.data.folders) ? this.data.folders.length : 0;
    if (folderCount <= 0) {
      if (this.data.folderWaveActiveIndex !== -1 || this.data.folderWaveTick !== 0) {
        this.setData({ folderWaveActiveIndex: -1, folderWaveTick: 0 });
      }
      return;
    }

    const waveRounds = 3;
    const stepDelayMs = 380;
    const roundGapMs = 240;
    const runToken = this.folderWaveRunToken;
    let round = 0;
    let index = 0;
    let tick = Number(this.data.folderWaveTick || 0) === 1 ? 1 : 0;

    const schedule = (delay, task) => {
      this.folderWaveTimer = setTimeout(() => {
        if (runToken !== this.folderWaveRunToken) return;
        task();
      }, delay);
    };

    const triggerNext = () => {
      if (runToken !== this.folderWaveRunToken) return;
      if (round >= waveRounds) {
        this.setData({ folderWaveActiveIndex: -1, folderWaveTick: 0 });
        this.folderWaveTimer = null;
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
          folderWaveActiveIndex: nextIndex,
          folderWaveTick: tick,
        },
        () => {
          if (runToken !== this.folderWaveRunToken) return;
          schedule(nextDelay, triggerNext);
        }
      );
    };

    this.setData({ folderWaveActiveIndex: -1 }, () => {
      if (runToken !== this.folderWaveRunToken) return;
      schedule(120, () => {
        if (runToken !== this.folderWaveRunToken) return;
        wx.nextTick(() => {
          if (runToken !== this.folderWaveRunToken) return;
          triggerNext();
        });
      });
    });
  },

  hasSeenFolderGuide() {
    try {
      return Boolean(wx.getStorageSync(FOLDER_GUIDE_SEEN_KEY));
    } catch (e) {
      return false;
    }
  },

  markFolderGuideSeen() {
    try {
      wx.setStorageSync(FOLDER_GUIDE_SEEN_KEY, "1");
    } catch (e) {
      // ignore
    }
  },

  startFolderGuideAutoDismiss() {
    this.clearFolderGuideTimer();
    this.folderGuideTimer = setTimeout(() => {
      this.dismissFolderGuide();
    }, 15000);
  },

  triggerFolderGuideForEntry() {
    const folderCount = Array.isArray(this.data.folders) ? this.data.folders.length : 0;
    this.clearFolderGuideTimer();
    if (folderCount <= 1) {
      if (this.data.showFolderGuide) {
        this.setData({ showFolderGuide: false });
      }
      return;
    }

    if (this.data.showFolderGuide) {
      this.setData({ showFolderGuide: false });
    }
  },

  dismissFolderGuide() {
    const isShowing = Boolean(this.data.showFolderGuide);
    this.clearFolderGuideTimer();
    if (!isShowing) return;
    this.markFolderGuideSeen();
    this.setData({ showFolderGuide: false });
  },

  showToast(message, type, duration) {
    const finalType = type === "error" ? "error" : "success";
    const ttl = Number(duration || 2600);

    this.clearToastTimer();
    this.setData({
      toast: {
        message: String(message || ""),
        type: finalType,
      },
    });

    this.toastTimer = setTimeout(() => {
      this.setData({ toast: null });
      this.toastTimer = null;
    }, ttl);
  },

  hideNotice() {
    this.setData({ showNotice: false });
  },

  closeWelcomeLetter() {
    const storageKey = String(this.data.welcomeStorageKey || "").trim();
    const storageToken = String(this.data.welcomeStorageToken || "").trim() || "1";
    if (storageKey) {
      try {
        wx.setStorageSync(storageKey, storageToken);
      } catch (e) {
        // ignore
      }
    }
    // 关闭后重置阶段，确保下次打开时从信封开始
    this.setData(
      {
        showWelcomeLetter: false,
        showWelcomeEasterEgg: false,
        welcomeOpenedFromEgg: false,
        letterStage: "envelope",
      },
      () => {
        if (!this.data.pendingFolderWaveAfterLetterClose) return;
        this.setData({ pendingFolderWaveAfterLetterClose: false }, () => {
          this.startFolderWaveAnimation();
        });
      }
    );
  },

  onLetterMaskTap() {
    // Web 端仅在信纸阶段点击遮罩时才关闭
    if (this.data.letterStage !== "letter") return;
    this.closeWelcomeLetterAnimated();
  },

  onOpenWelcomeEasterEgg() {
    if (!this.data.showWelcomeEasterEgg) return;
    const eggStorageKey = String(this.data.welcomeEggStorageKey || "").trim();
    const storageToken = String(this.data.welcomeStorageToken || "").trim() || "1";
    if (eggStorageKey) {
      try {
        wx.setStorageSync(eggStorageKey, storageToken);
      } catch (e) {
        // ignore
      }
    }
    this.setData({
      showWelcomeEasterEgg: false,
      showWelcomeLetter: true,
      welcomeOpenedFromEgg: true,
      letterStage: "letter",
    });
  },

  onOpenLetter() {
    if (!this.data.showWelcomeLetter) return;
    if (this.data.letterStage !== "envelope") return;

    this.setData({ letterStage: "opening-envelope" });
    setTimeout(() => {
      if (!this.data.showWelcomeLetter) return;
      if (this.data.letterStage !== "opening-envelope") return;
      this.setData({ letterStage: "opening" });
    }, 200);
    setTimeout(() => {
      if (!this.data.showWelcomeLetter) return;
      if (this.data.letterStage !== "opening" && this.data.letterStage !== "opening-envelope") return;
      this.setData({ letterStage: "letter" });
    }, 800);
  },

  closeWelcomeLetterAnimated() {
    if (this.data.letterStage !== "letter") return;
    this.setData({ letterStage: "closing" });
    setTimeout(() => {
      this.closeWelcomeLetter();
    }, 600);
  },

  openDonationModal() {
    this.setData({ showDonationModal: true });
  },

  closeDonationModal() {
    this.setData({
      showDonationModal: false,
      donationSaving: false,
    });
  },

  async handleSaveDonationQr() {
    if (this.data.donationSaving) return;

    const album = this.data.album || null;
    const qrCodeUrl = String((album && album.donation_qr_code_url) || "").trim();
    if (!qrCodeUrl) {
      this.showToast("赞赏码暂不可用", "error", 2200);
      return;
    }

    const granted = await this.ensureAlbumWritePermission();
    if (!granted) {
      wx.showModal({
        title: "需要相册权限",
        content: "请在小程序设置中开启“保存到相册”权限后重试。",
        showCancel: false,
      });
      return;
    }

    wx.showLoading({ title: "保存中..." });

    try {
      await this.savePhotoToAlbum(qrCodeUrl);
      wx.hideLoading();
      this.showToast("赞赏码已保存到相册", "success", 2400);
      this.closeDonationModal();
    } catch (error) {
      wx.hideLoading();
      this.setData({ donationSaving: false });
      this.showToast("保存赞赏码失败", "error", 2400);
    }
  },

  findPhotoById(id) {
    return (this.data.allPhotos || []).find((x) => String(x.id) === String(id)) || null;
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

    const allResult = patchList(this.data.allPhotos || []);
    const photosResult = patchList(this.data.photos || []);
    const leftResult = patchList(this.data.leftPhotos || []);
    const rightResult = patchList(this.data.rightPhotos || []);

    if (!allResult.changed && !photosResult.changed && !leftResult.changed && !rightResult.changed) {
      return;
    }

    const nextData = {};
    if (allResult.changed) nextData.allPhotos = allResult.nextList;
    if (photosResult.changed) nextData.photos = photosResult.nextList;
    if (leftResult.changed) nextData.leftPhotos = leftResult.nextList;
    if (rightResult.changed) nextData.rightPhotos = rightResult.nextList;
    this.setData(nextData, () => this.refreshSelectionMeta());
  },

  patchPhotoMetrics(id, patch) {
    const targetId = String(id || "");
    if (!targetId || !patch || typeof patch !== "object") return;

    const nextPatch = {};
    if (Object.prototype.hasOwnProperty.call(patch, "view_count")) {
      const parsedViewCount = toNonNegativeInteger(patch.view_count);
      if (parsedViewCount !== null) {
        nextPatch.view_count = parsedViewCount;
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, "download_count")) {
      const parsedDownloadCount = toNonNegativeInteger(patch.download_count);
      if (parsedDownloadCount !== null) {
        nextPatch.download_count = parsedDownloadCount;
      }
    }
    if (Object.keys(nextPatch).length === 0) {
      return;
    }

    const applyPatch = (photo) => {
      if (String((photo && photo.id) || "") !== targetId) {
        return photo;
      }

      let changed = false;
      const nextPhoto = Object.assign({}, photo);
      if (
        Object.prototype.hasOwnProperty.call(nextPatch, "view_count") &&
        Number((photo && photo.view_count) || 0) !== nextPatch.view_count
      ) {
        nextPhoto.view_count = nextPatch.view_count;
        changed = true;
      }
      if (
        Object.prototype.hasOwnProperty.call(nextPatch, "download_count") &&
        Number((photo && photo.download_count) || 0) !== nextPatch.download_count
      ) {
        nextPhoto.download_count = nextPatch.download_count;
        changed = true;
      }
      return changed ? nextPhoto : photo;
    };

    this.patchPhotoVisualState(targetId, applyPatch);

    const patchCacheMap = (cacheMap) => {
      if (!cacheMap || typeof cacheMap !== "object") return;
      Object.keys(cacheMap).forEach((folderId) => {
        const list = cacheMap[folderId];
        if (!Array.isArray(list) || list.length === 0) return;

        let changed = false;
        const nextList = list.map((photo) => {
          const patched = applyPatch(photo);
          if (patched !== photo) {
            changed = true;
          }
          return patched;
        });

        if (changed) {
          cacheMap[folderId] = nextList;
        }
      });
    };

    patchCacheMap(this.fullPhotosByFolder);
    patchCacheMap(this.legacyPhotosByFolder);
  },

  updatePhotoById(id, updater) {
    const nextAll = (this.data.allPhotos || []).map((photo) => {
      if (String(photo.id) !== String(id)) return photo;
      return updater(photo);
    });

    this.setData({ allPhotos: nextAll }, () => this.applyFilter());
  },

  isPinActionPending(id) {
    const normalizedId = String(id || "").trim();
    if (!normalizedId || !(this.pendingPinPhotoIds instanceof Set)) {
      return false;
    }
    return this.pendingPinPhotoIds.has(normalizedId);
  },

  setPinActionPending(id, pending) {
    const normalizedId = String(id || "").trim();
    if (!normalizedId) {
      return;
    }

    if (!(this.pendingPinPhotoIds instanceof Set)) {
      this.pendingPinPhotoIds = new Set();
    }

    if (pending) {
      this.pendingPinPhotoIds.add(normalizedId);
    } else {
      this.pendingPinPhotoIds.delete(normalizedId);
    }

    this.setData(
      {
        pinConfirmPending: this.isPinActionPending(this.data.confirmPhotoId),
      },
      () => this.applyFilter()
    );
  },

  getCachedFullPhotosForFolder(folderId) {
    const targetFolderId = String(folderId || ROOT_FOLDER_ID);
    const currentFolderId = String(this.data.selectedFolder || ROOT_FOLDER_ID);
    const currentRows = Array.isArray(this.data.allPhotos) ? this.data.allPhotos : [];
    const total = Math.max(0, Number(this.data.total || 0));
    if (
      targetFolderId === currentFolderId &&
      !this.data.hasMore &&
      currentRows.length > 0 &&
      (!total || currentRows.length >= total)
    ) {
      return currentRows.slice();
    }
    if (!this.fullPhotosByFolder) {
      return [];
    }
    const cachedRows = this.fullPhotosByFolder[targetFolderId];
    return Array.isArray(cachedRows) ? cachedRows.slice() : [];
  },

  cacheFullPhotosForFolder(folderId, rows) {
    const targetFolderId = String(folderId || ROOT_FOLDER_ID);
    if (!targetFolderId) return;
    if (!this.fullPhotosByFolder) {
      this.fullPhotosByFolder = Object.create(null);
    }
    this.fullPhotosByFolder[targetFolderId] = Array.isArray(rows) ? rows.slice() : [];
  },

  clearCachedFullPhotosForFolder(folderId) {
    const targetFolderId = String(folderId || ROOT_FOLDER_ID);
    if (!targetFolderId || !this.fullPhotosByFolder) return;
    delete this.fullPhotosByFolder[targetFolderId];
  },

  async loadAlbum() {
    this.loadingNextPhotoPage = false;
    this.albumAutoFillRemaining = ALBUM_INITIAL_AUTOFILL_MAX_BATCHES;
    this.albumLoadZoneArmed = true;
    this.clearAutoFillTimer();
    this.setData({
      loading: true,
      loadingMore: false,
      pagingSkeletonLeftPhotos: [],
      pagingSkeletonRightPhotos: [],
    });
    const loadTicket = this.photoLoadTicket + 1;
    this.photoLoadTicket = loadTicket;
    this.useLegacyPhotoPaging = false;
    this.legacyPhotosByFolder = Object.create(null);
    this.fullPhotosByFolder = Object.create(null);
    try {
      const app = typeof getApp === "function" ? getApp() : null;
      const r = await dbRpc("get_album_content", {
        input_key: this.data.key,
        include_photos: false,
      });
      const rawPayload = r ? r.data : null;
      const payload = resolveAlbumContentPayload(rawPayload);
      const rpcErrorMessage = String((r && r.error && r.error.message) || "").trim();
      const payloadErrorMessage =
        isExplicitRpcFailure(rawPayload) || isExplicitRpcFailure(payload)
          ? readRpcPayloadErrorMessage(rawPayload || payload)
          : "";
      if (rpcErrorMessage || payloadErrorMessage || !payload || !payload.album) {
        const message = resolveAlbumAccessErrorMessage(rpcErrorMessage || payloadErrorMessage);
        wx.showToast({ title: message, icon: "none" });
        wx.switchTab({ url: "/pages/album/index" });
        return;
      }

      const album = payload.album;
      const normalizedAlbum = Object.assign({}, album || {}, {
        cover_url: normalizeMaybeUrl(album && album.cover_url),
        donation_qr_code_url: normalizeMaybeUrl(album && album.donation_qr_code_url),
      });
      if (album && album.is_expired) {
        wx.showToast({ title: "该空间已过期", icon: "none" });
      }

      const expiryDays = getExpiryDays(normalizedAlbum);
      const fallbackRootFolderName =
        String(this.data.rootFolderName || this.data.initialRootFolderName || "").trim() || "根目录";
      const rootFolderName =
        readRootFolderNameFromPayload(payload) ||
        readRootFolderNameFromPayload(rawPayload) ||
        fallbackRootFolderName;
      if (rootFolderName) {
        setCachedAlbumRootName(this.data.key, rootFolderName);
      }
      const folders = [{ id: ROOT_FOLDER_ID, name: rootFolderName }].concat(
        Array.isArray(payload.folders) ? payload.folders : []
      );
      const showFolderGuide = false;
      const storageKey = String(this.data.welcomeStorageKey || "").trim();
      const welcomeStorageToken = buildWelcomeStorageToken(normalizedAlbum);
      let hasSeenWelcome = false;
      if (storageKey) {
        try {
          hasSeenWelcome = String(wx.getStorageSync(storageKey) || "") === welcomeStorageToken;
        } catch (e) {
          hasSeenWelcome = false;
        }
      }
      const eggStorageKey = String(this.data.welcomeEggStorageKey || "").trim();
      let hasSeenWelcomeEgg = false;
      if (eggStorageKey) {
        try {
          hasSeenWelcomeEgg = String(wx.getStorageSync(eggStorageKey) || "") === welcomeStorageToken;
        } catch (e) {
          hasSeenWelcomeEgg = false;
        }
      }
      // 兼容旧逻辑：历史版本可能在未点击印章时就写入了入口已见标记
      if (hasSeenWelcomeEgg && !hasSeenWelcome && eggStorageKey) {
        try {
          wx.removeStorageSync(eggStorageKey);
          hasSeenWelcomeEgg = false;
        } catch (e) {
          // ignore
        }
      }

      const welcomeLetterMode = normalizeWelcomeLetterMode(
        normalizedAlbum && normalizedAlbum.welcome_letter_mode,
        Boolean(normalizedAlbum && normalizedAlbum.enable_welcome_letter !== false)
      );
      const showWelcomeLetter = welcomeLetterMode === "envelope" && !hasSeenWelcome;
      const showWelcomeEasterEgg =
        welcomeLetterMode === "stamp" &&
        !hasSeenWelcome &&
        !hasSeenWelcomeEgg;
      await new Promise((resolve) => {
        this.clearRelayoutTimer();
        this.leftHeight = 0;
        this.rightHeight = 0;
        this.photoRatioMap = Object.create(null);
        this.photoColumnMap = Object.create(null);
        this.setData(
          {
            album: normalizedAlbum,
            freezeEnabled: normalizedAlbum && normalizedAlbum.enable_freeze !== false,
            headerTitle: resolveAlbumHeaderTitle({
              albumTitle: String((normalizedAlbum && normalizedAlbum.title) || "").trim(),
              rootFolderName,
              initialRootFolderName: this.data.initialRootFolderName,
              managedTitle: this.data.managedTitle,
            }),
            pageScaffoldReady: true,
            expiryDays,
            expiryNotice: buildExpiryNotice(normalizedAlbum),
            welcomeText:
              String((normalizedAlbum && normalizedAlbum.welcome_letter) || "").trim() ||
              "愿你在这里，收集每一刻闪闪发光的记忆。",
            rootFolderName,
            showNotice: true,
            folders,
            selectedFolder: ROOT_FOLDER_ID,
            showFolderGuide,
            folderWaveActiveIndex: -1,
            folderWaveTick: 0,
            allPhotos: [],
            photos: [],
            leftPhotos: [],
            rightPhotos: [],
            selectedPhotoMap: {},
            selectedCount: 0,
            isSelectAll: false,
            loading: true,
            loadingMore: false,
            hasMore: true,
            pendingFolderPhotoIds: [],
            pageNo: 0,
            total: 0,
            confirmPhotoId: "",
            showWelcomeLetter,
            showWelcomeEasterEgg,
            welcomeLetterMode,
            welcomeStorageToken,
            welcomeOpenedFromEgg: false,
            pendingFolderWaveAfterLetterClose: false,
            letterStage: "envelope",
            showDonationModal: false,
          },
          () => {
            this.refreshSelectionMeta();
            this.scheduleToolbarStickyTopSync();
            if (showFolderGuide) {
              this.startFolderGuideAutoDismiss();
            } else {
              this.clearFolderGuideTimer();
            }
            const bindNoticeKey = `album_bind_notice_${this.data.key}`;
            let shouldShowBindNotice = false;
            try {
              shouldShowBindNotice = Boolean(wx.getStorageSync(bindNoticeKey));
            } catch (e) {
              shouldShowBindNotice = false;
            }
            if (shouldShowBindNotice) {
              this.showToast("🎉 已自动绑定该空间到您的账号", "success", 3000);
              try {
                wx.removeStorageSync(bindNoticeKey);
              } catch (e) {
                // ignore storage cleanup failure
              }
            }
            resolve();
          }
        );
      });

      if (loadTicket !== this.photoLoadTicket) return;
      await this.loadPhotoPage(ROOT_FOLDER_ID, 1, { reset: true, silent: false });
    } catch (e) {
      wx.showToast({ title: "加载失败", icon: "none" });
      this.setData({ loading: false, loadingMore: false, switchingFolderLoading: false, pendingFolderPhotoIds: [] });
    }
  },

  async selectFolder(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || ROOT_FOLDER_ID)
        : ROOT_FOLDER_ID;
    const previousId = String(this.data.selectedFolder || ROOT_FOLDER_ID);
    if (id === previousId) return;
    if (this.data.showFolderGuide) {
      this.dismissFolderGuide();
    }

    const folder = (this.data.folders || []).find((item) => String(item.id || "") === id) || null;
    this.clearRelayoutTimer();
    this.leftHeight = 0;
    this.rightHeight = 0;
    this.photoRatioMap = Object.create(null);
    this.photoColumnMap = Object.create(null);
    this.albumAutoFillRemaining = ALBUM_INITIAL_AUTOFILL_MAX_BATCHES;
    this.albumLoadZoneArmed = true;
    this.clearAutoFillTimer();
    this.invalidateAlbumPrefetch();
    this.currentScrollTop = 0;
    await new Promise((resolve) => this.setData({
      selectedFolder: id,
      switchingFolderLoading: true,
      pendingFolderPhotoIds: [],
      loadingMore: false,
      hasMore: true,
      pageNo: 0,
      total: 0,
      selectedPhotoMap: {},
      selectedCount: 0,
      isSelectAll: false,
    }, () => {
      this.applyFilter();
      this.refreshSelectionMeta();
      const folderName = String((folder && folder.name) || "分组").trim() || "分组";
      this.showToast(`已切换到：${folderName}`, "success", 1800);
      resolve();
    }));

    try {
      wx.pageScrollTo({ scrollTop: 0, duration: 0 });
    } catch (error) {
      // ignore
    }

    const success = await this.loadPhotoPage(id, 1, { reset: true, silent: true });
    if (!success && String(this.data.selectedFolder || ROOT_FOLDER_ID) === id) {
      await new Promise((resolve) => this.setData({
        selectedFolder: previousId,
        switchingFolderLoading: false,
        pendingFolderPhotoIds: [],
      }, () => {
        this.applyFilter();
        resolve();
      }));
      this.showToast("切换失败，请稍后重试", "error", 1800);
    }
  },

  applyFilter() {
    const selectedPhotos = withPhotoUiState(
      this.data.allPhotos || [],
      this.data.selectedPhotoMap || {},
      this.pendingPinPhotoIds
    );
    this.applyWaterfallPhotos(selectedPhotos);
  },

  async loadPhotoPage(folderId, pageNo, opts) {
    if (this.data.serviceMissing) return false;

    const reset = Boolean(opts && opts.reset);
    const silent = Boolean(opts && opts.silent);
    const skipWave = Boolean(opts && opts.skipWave);
    const targetFolderId = String(folderId || ROOT_FOLDER_ID);
    const nextPageNo = toPageNumber(pageNo, 1);
    let nextPendingFolderPhotoIds = null;

    if (reset) {
      this.albumAutoFillRemaining = ALBUM_INITIAL_AUTOFILL_MAX_BATCHES;
      this.albumLoadZoneArmed = true;
      this.clearAutoFillTimer();
      this.clearCachedFullPhotosForFolder(targetFolderId);
      this.invalidateAlbumPrefetch();
    }

    if (!reset && this.loadingNextPhotoPage) return false;
    if (!reset && this.data.loadingMore) return false;
    if (!reset && !this.data.hasMore) return false;

    if (this.useLegacyPhotoPaging) {
      if (!reset) {
        this.loadingNextPhotoPage = true;
        this.showPagingSkeletons(ALBUM_PAGING_SKELETON_COUNT);
      }
      try {
        return await this.loadPhotoPageLegacy(targetFolderId, nextPageNo, { reset, silent });
      } finally {
        if (!reset) {
          this.loadingNextPhotoPage = false;
          this.clearPagingSkeletons();
        }
      }
    }

    if (reset) {
      if (!silent) {
        this.setData({
          loading: true,
          loadingMore: false,
          pagingSkeletonLeftPhotos: [],
          pagingSkeletonRightPhotos: [],
        });
      }
    } else {
      if (this.canUsePrefetchedAlbumPage(targetFolderId, nextPageNo)) {
        const prefetched = this.prefetchedAlbumPage;
        this.prefetchedAlbumPage = null;
        const committed = this.commitAlbumPhotoPageData(targetFolderId, nextPageNo, prefetched, {
          reset,
          silent,
        });
        nextPendingFolderPhotoIds = committed && committed.nextPendingFolderPhotoIds;
        this.loadingNextPhotoPage = false;
        this.scheduleAutoFillCheck(80);
        return Boolean(committed);
      }
      this.loadingNextPhotoPage = true;
      this.showPagingSkeletons(ALBUM_PAGING_SKELETON_COUNT);
      this.setData({ loadingMore: true });
    }

    const ticket = this.photoLoadTicket + 1;
    this.photoLoadTicket = ticket;

    try {
      const pageData = nextPageNo > 1
        ? await (this.prefetchAlbumPhotoPage(targetFolderId, nextPageNo) || this.fetchAlbumPhotoPageData(targetFolderId, nextPageNo))
        : await this.fetchAlbumPhotoPageData(targetFolderId, nextPageNo);

      if (pageData && pageData.fallbackLegacy) {
        this.useLegacyPhotoPaging = true;
        this.photoLoadTicket += 1;
        return this.loadPhotoPageLegacy(targetFolderId, nextPageNo, { reset, silent });
      }

      if (!pageData || pageData.errorMessage) {
        if (!(reset && silent)) {
          wx.showToast({ title: (pageData && pageData.errorMessage) || "加载失败", icon: "none" });
        }
        return false;
      }

      if (ticket !== this.photoLoadTicket) return false;
      if (String(this.data.selectedFolder || ROOT_FOLDER_ID) !== targetFolderId) return false;

      if (this.canUsePrefetchedAlbumPage(targetFolderId, nextPageNo)) {
        this.prefetchedAlbumPage = null;
      }
      const committed = this.commitAlbumPhotoPageData(targetFolderId, nextPageNo, pageData, {
        reset,
        silent,
      });
      nextPendingFolderPhotoIds = committed && committed.nextPendingFolderPhotoIds;
      return true;
    } catch (e) {
      if (reset && nextPendingFolderPhotoIds !== null) {
        nextPendingFolderPhotoIds = [];
        this.setData({ pendingFolderPhotoIds: [] });
      }
      if (!(reset && silent)) {
        wx.showToast({ title: "加载失败", icon: "none" });
      }
      return false;
    } finally {
      if (!reset) {
        this.loadingNextPhotoPage = false;
      }
      if (ticket === this.photoLoadTicket) {
        const shouldPlayWaveOnVisible =
          !skipWave && reset && nextPageNo === 1 && targetFolderId === ROOT_FOLDER_ID;
        const shouldKeepSwitchOverlay = reset && silent
          ? Boolean(Array.isArray(nextPendingFolderPhotoIds) && nextPendingFolderPhotoIds.length > 0)
          : false;
        this.setData({
          loading: false,
          loadingMore: false,
          switchingFolderLoading: shouldKeepSwitchOverlay,
          pagingSkeletonLeftPhotos: [],
          pagingSkeletonRightPhotos: [],
        }, () => {
          this.scheduleAutoFillCheck(80);
          if (!shouldPlayWaveOnVisible) return;
          if (String(this.data.selectedFolder || ROOT_FOLDER_ID) !== ROOT_FOLDER_ID) return;
          if (this.data.showWelcomeLetter) {
            if (!this.data.pendingFolderWaveAfterLetterClose) {
              this.setData({ pendingFolderWaveAfterLetterClose: true });
            }
            return;
          }
          this.startFolderWaveAnimation();
        });
      }
    }
  },

  async loadPhotoPageLegacy(folderId, pageNo, opts) {
    const reset = Boolean(opts && opts.reset);
    const silent = Boolean(opts && opts.silent);
    const skipWave = Boolean(opts && opts.skipWave);
    const targetFolderId = String(folderId || ROOT_FOLDER_ID);
    const nextPageNo = toPageNumber(pageNo, 1);
    let nextPendingFolderPhotoIds = null;

    if (reset) {
      this.albumAutoFillRemaining = ALBUM_INITIAL_AUTOFILL_MAX_BATCHES;
      this.albumLoadZoneArmed = true;
      this.clearAutoFillTimer();
      this.clearCachedFullPhotosForFolder(targetFolderId);
    }

    if (reset) {
      if (!silent) {
        this.setData({
          loading: true,
          loadingMore: false,
          pagingSkeletonLeftPhotos: [],
          pagingSkeletonRightPhotos: [],
        });
      }
    } else {
      this.loadingNextPhotoPage = true;
      this.showPagingSkeletons(ALBUM_PAGING_SKELETON_COUNT);
      this.setData({ loadingMore: true });
    }

    const ticket = this.photoLoadTicket + 1;
    this.photoLoadTicket = ticket;

    try {
      if (!this.legacyPhotosByFolder) {
        this.legacyPhotosByFolder = Object.create(null);
      }

      let fullRows = this.legacyPhotosByFolder[targetFolderId];
      if (!Array.isArray(fullRows) || reset) {
        const r = await dbRpc("get_album_content", {
          input_key: this.data.key,
          include_photos: true,
        });
        const rawPayload = r ? r.data : null;
        const payload = resolveAlbumContentPayload(rawPayload);
        const rpcErrorMessage = String((r && r.error && r.error.message) || "").trim();
        const payloadErrorMessage =
          isExplicitRpcFailure(rawPayload) || isExplicitRpcFailure(payload)
            ? readRpcPayloadErrorMessage(rawPayload || payload)
            : "";
        if (rpcErrorMessage || payloadErrorMessage || !payload) {
          if (!(reset && silent)) {
            wx.showToast({ title: (pageData && pageData.errorMessage) || "加载失败", icon: "none" });
          }
          return;
        }

        const normalizedAllRows = (Array.isArray(payload.photos) ? payload.photos : []).map(normalizePhoto);
        const allRows = normalizedAllRows.length > 0
          ? await hydratePhotoDimensions(normalizedAllRows)
          : normalizedAllRows;
        fullRows = filterPhotosByFolder(allRows, targetFolderId);
        this.legacyPhotosByFolder[targetFolderId] = fullRows;
        this.cacheFullPhotosForFolder(targetFolderId, fullRows);
      }

      if (ticket !== this.photoLoadTicket) return;
      if (String(this.data.selectedFolder || ROOT_FOLDER_ID) !== targetFolderId) return;

      const start = (nextPageNo - 1) * PHOTO_PAGE_SIZE;
      const end = start + PHOTO_PAGE_SIZE;
      const pageRows = (Array.isArray(fullRows) ? fullRows : []).slice(start, end);
      const mergedRows = reset ? pageRows : (this.data.allPhotos || []).concat(pageRows);
      const total = Array.isArray(fullRows) ? fullRows.length : 0;
      const hasMore = mergedRows.length < total;
      const selectedPhotos = withSelection(mergedRows, this.data.selectedPhotoMap || {});
      this.cacheFullPhotosForFolder(targetFolderId, fullRows);

      if (reset) {
        nextPendingFolderPhotoIds = silent
          ? Array.from(
            new Set(
              mergedRows
                .slice(0, ALBUM_SWITCH_OVERLAY_TRACK_COUNT)
                .filter((photo) => photo && !photo._imageLoaded && !photo._imageLoadFailed)
                .map((photo) => String((photo && photo.id) || "").trim())
                .filter(Boolean)
            )
          )
          : [];
      }

      const nextData = {
        allPhotos: mergedRows,
        pageNo: nextPageNo,
        total,
        hasMore,
      };
      if (reset) {
        nextData.pendingFolderPhotoIds = nextPendingFolderPhotoIds;
      }

      this.setData(
        nextData,
        () => this.applyWaterfallPhotos(selectedPhotos, { preferAppend: !reset })
      );
      return true;
    } catch (e) {
      if (!(reset && silent)) {
        wx.showToast({ title: "加载失败", icon: "none" });
      }
    } finally {
      if (!reset) {
        this.loadingNextPhotoPage = false;
      }
      if (ticket === this.photoLoadTicket) {
        const shouldPlayWaveOnVisible =
          !skipWave && reset && nextPageNo === 1 && targetFolderId === ROOT_FOLDER_ID;
        const shouldKeepSwitchOverlay = reset && silent
          ? Boolean(Array.isArray(nextPendingFolderPhotoIds) && nextPendingFolderPhotoIds.length > 0)
          : false;
        this.setData({
          loading: false,
          loadingMore: false,
          switchingFolderLoading: shouldKeepSwitchOverlay,
          pagingSkeletonLeftPhotos: [],
          pagingSkeletonRightPhotos: [],
        }, () => {
          this.scheduleAutoFillCheck(80);
          if (!shouldPlayWaveOnVisible) return;
          if (String(this.data.selectedFolder || ROOT_FOLDER_ID) !== ROOT_FOLDER_ID) return;
          if (this.data.showWelcomeLetter) {
            if (!this.data.pendingFolderWaveAfterLetterClose) {
              this.setData({ pendingFolderWaveAfterLetterClose: true });
            }
            return;
          }
          this.startFolderWaveAnimation();
        });
      }
    }
  },

  onReachBottom() {
    if (this.data.serviceMissing) return;
    if (this.data.loading || this.data.loadingMore) return;
    if (!this.data.hasMore) return;
    this._lastAlbumAutoLoadAt = Date.now();
    void this.loadPhotoPage(this.data.selectedFolder || ROOT_FOLDER_ID, Number(this.data.pageNo || 0) + 1, {
      reset: false,
      silent: false,
    });
  },

  onPageScroll(event) {
    const scrollTop = Number(event && event.scrollTop);
    if (Number.isFinite(scrollTop) && scrollTop >= 0) {
      this.currentScrollTop = scrollTop;
    }

    if (this.data.serviceMissing) return;
    if (this.data.loading || this.data.loadingMore) return;
    if (this.data.switchingFolderLoading) return;
    if (!this.data.hasMore) return;
    if (!Number.isFinite(scrollTop) || scrollTop < 0) return;

    const now = Date.now();
    const lastAutoLoadAt = Number(this._lastAlbumAutoLoadAt || 0);
    if (lastAutoLoadAt > 0 && now - lastAutoLoadAt < 280) return;

    const viewportHeight = this.ensureWindowHeight();
    if (!(viewportHeight > 0)) return;

    wx.createSelectorQuery()
      .selectViewport()
      .scrollOffset((offset) => {
        if (this.data.loading || this.data.loadingMore || this.data.switchingFolderLoading || !this.data.hasMore) return;
        const scrollHeight = Number((offset && offset.scrollHeight) || 0);
        if (!(scrollHeight > 0)) return;
        const distanceToBottom = scrollHeight - (scrollTop + viewportHeight);
        if (distanceToBottom > ALBUM_LOAD_AHEAD_PX) {
          this.albumLoadZoneArmed = true;
          return;
        }
        if (!this.albumLoadZoneArmed) return;

        this.albumLoadZoneArmed = false;
        this._lastAlbumAutoLoadAt = Date.now();
        Promise.resolve(this.loadPhotoPage(this.data.selectedFolder || ROOT_FOLDER_ID, Number(this.data.pageNo || 0) + 1, {
          reset: false,
          silent: false,
        })).then((success) => {
          if (!success) {
            this.albumLoadZoneArmed = true;
          }
        });
      })
      .exec();
  },

  refreshSelectionMeta() {
    const list = this.data.photos || [];
    const selectedCount = list.filter((p) => Boolean(p._selected)).length;
    const total = Math.max(0, Number(this.data.total || 0));
    const loadedAll =
      Boolean(!this.data.hasMore) && (total === 0 ? list.length > 0 : list.length >= total);
    const isSelectAll = list.length > 0 && selectedCount === list.length && loadedAll;
    this.setData({ selectedCount, isSelectAll });
  },

  togglePhotoSelection(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;

    const map = Object.assign({}, this.data.selectedPhotoMap || {});
    if (map[id]) {
      delete map[id];
    } else {
      map[id] = true;
    }

    this.setData({ selectedPhotoMap: map }, () => this.applyFilter());
  },

  toggleStory(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;

    const current = this.findPhotoById(id);
    if (!current || !current.has_story) return;

    this.clearStoryMotionTimersForPhoto(id);

    if (current.story_visible) {
      this.patchPhotoVisualState(id, (photo) => createStoryClosingState(photo));
      this.scheduleStoryMotionTimer(
        id,
        "close",
        () => {
          this.patchPhotoVisualState(id, (photo) => createStoryClosedState(photo));
          this.scheduleStoryMotionTimer(
            id,
            "image",
            () => {
              this.patchPhotoVisualState(id, (photo) => clearStoryImagePhase(photo));
            },
            STORY_IMAGE_ENTER_DURATION_MS
          );
        },
        STORY_CLOSING_DURATION_MS
      );
      return;
    }

    this.patchPhotoVisualState(id, (photo) => createStoryOpeningState(photo));
    this.scheduleStoryMotionTimer(
      id,
      "open",
      () => {
        this.patchPhotoVisualState(id, (photo) => createStoryOpenedState(photo));
      },
      STORY_OPENING_DURATION_MS
    );
  },

  async toggleSelectAll() {
    if (this.data.batchLoading) return;

    const list = this.data.photos || [];
    const map = Object.assign({}, this.data.selectedPhotoMap || {});
    const targetFolderId = String(this.data.selectedFolder || ROOT_FOLDER_ID);

    if (this.data.isSelectAll) {
      list.forEach((p) => {
        delete map[String(p.id)];
      });
      this.setData({ selectedPhotoMap: map }, () => this.applyFilter());
      return;
    }

    this.setData({ loadingMore: true });
    try {
      const fullRows = await this.loadAllPhotosForFolder(targetFolderId);
      fullRows.forEach((p) => {
        map[String(p.id)] = true;
      });

      const selectedPhotos = withSelection(fullRows, map);
      const total = fullRows.length;
      const pageNo = total > 0 ? Math.ceil(total / PHOTO_PAGE_SIZE) : 0;

      this.setData(
        {
          selectedPhotoMap: map,
          allPhotos: fullRows,
          total,
          pageNo,
          hasMore: false,
          loading: false,
          loadingMore: false,
        },
        () => this.applyWaterfallPhotos(selectedPhotos)
      );

      if (total > 0) {
        this.showToast(`已全选 ${total} 张`, "success", 1800);
      } else {
        this.showToast("当前分组暂无照片", "error", 2200);
      }
    } catch (error) {
      this.setData({ loading: false, loadingMore: false, switchingFolderLoading: false });
      const message = String((error && error.message) || "").trim() || "全选失败";
      this.showToast(message, "error", 2600);
    }
  },

  getSelectedPhotos() {
    const list = this.data.photos || [];
    const map = this.data.selectedPhotoMap || {};
    const selected = list.filter((p) => Boolean(map[String(p.id)]));
    return selected.length > 0 ? selected : list;
  },

  async loadAllPhotosForFolderLegacy(folderId) {
    const targetFolderId = String(folderId || ROOT_FOLDER_ID);
    const cachedRows = this.getCachedFullPhotosForFolder(targetFolderId);
    if (cachedRows.length > 0) {
      return cachedRows;
    }

    if (!this.legacyPhotosByFolder) {
      this.legacyPhotosByFolder = Object.create(null);
    }

    let fullRows = this.legacyPhotosByFolder[targetFolderId];
    if (!Array.isArray(fullRows)) {
      const r = await dbRpc("get_album_content", {
        input_key: this.data.key,
        include_photos: true,
      });
      const rawPayload = r ? r.data : null;
      const payload = resolveAlbumContentPayload(rawPayload);
      const rpcErrorMessage = String((r && r.error && r.error.message) || "").trim();
      const payloadErrorMessage =
        isExplicitRpcFailure(rawPayload) || isExplicitRpcFailure(payload)
          ? readRpcPayloadErrorMessage(rawPayload || payload)
          : "";

      if (rpcErrorMessage || payloadErrorMessage || !payload) {
        throw new Error(rpcErrorMessage || payloadErrorMessage || "加载失败");
      }

      const normalizedAllRows = (Array.isArray(payload.photos) ? payload.photos : []).map(normalizePhoto);
      const allRows = normalizedAllRows.length > 0
        ? await hydratePhotoDimensions(normalizedAllRows)
        : normalizedAllRows;
      fullRows = filterPhotosByFolder(allRows, targetFolderId);
      this.legacyPhotosByFolder[targetFolderId] = fullRows;
      this.cacheFullPhotosForFolder(targetFolderId, fullRows);
    }

    return Array.isArray(fullRows) ? fullRows.slice() : [];
  },

  async loadAllPhotosForFolder(folderId) {
    const targetFolderId = String(folderId || ROOT_FOLDER_ID);
    const cachedRows = this.getCachedFullPhotosForFolder(targetFolderId);
    if (cachedRows.length > 0) {
      return cachedRows;
    }
    if (this.useLegacyPhotoPaging) {
      return this.loadAllPhotosForFolderLegacy(targetFolderId);
    }

    const rows = [];
    const rowIds = new Set();
    let pageNo = 1;
    let hasMore = true;

    while (hasMore) {
      const r = await dbRpc("get_album_photo_page", {
        input_key: this.data.key,
        folder_id: targetFolderId,
        page_no: pageNo,
        page_size: PHOTO_BULK_PAGE_SIZE,
      });
      const rawPayload = r ? r.data : null;
      const payload = resolveAlbumPhotoPagePayload(rawPayload);
      const rpcErrorMessage = String((r && r.error && r.error.message) || "").trim();
      const payloadErrorMessage =
        isExplicitRpcFailure(rawPayload) || isExplicitRpcFailure(payload)
          ? readRpcPayloadErrorMessage(rawPayload || payload)
          : "";

      if (isRpcFunctionNotImplemented(rpcErrorMessage || payloadErrorMessage)) {
        this.useLegacyPhotoPaging = true;
        return this.loadAllPhotosForFolderLegacy(targetFolderId);
      }

      if (rpcErrorMessage || payloadErrorMessage || !payload) {
        throw new Error(rpcErrorMessage || payloadErrorMessage || "加载失败");
      }

      const normalizedPageRows = (Array.isArray(payload.photos) ? payload.photos : []).map(normalizePhoto);
      const pageRows = normalizedPageRows.length > 0
        ? await hydratePhotoDimensions(normalizedPageRows)
        : normalizedPageRows;
      pageRows.forEach((item) => {
        const id = String((item && item.id) || "").trim();
        if (id && rowIds.has(id)) return;
        if (id) rowIds.add(id);
        rows.push(item);
      });

      const hasMoreFromPayload = Object.prototype.hasOwnProperty.call(payload, "has_more")
        ? Boolean(payload.has_more)
        : null;
      if (hasMoreFromPayload !== null) {
        hasMore = hasMoreFromPayload;
      } else {
        const total = readPageTotal(payload, rows.length);
        const hasKnownTotal = total > 0;
        hasMore = hasKnownTotal ? rows.length < total : pageRows.length >= PHOTO_BULK_PAGE_SIZE;
      }

      if (!hasMore) break;
      pageNo += 1;

      // 闃叉寮傚父鏁版嵁瀵艰嚧鏃犻檺缈婚〉
      if (pageNo > 200) {
        throw new Error("分页异常：页数超出上限");
      }
    }

    this.cacheFullPhotosForFolder(targetFolderId, rows);
    return rows.slice();
  },

  async ensureAlbumWritePermission() {
    try {
      const setting = await wx.getSetting();
      const granted =
        setting && setting.authSetting ? setting.authSetting["scope.writePhotosAlbum"] : false;
      if (granted) return true;
      await wx.authorize({ scope: "scope.writePhotosAlbum" });
      return true;
    } catch (e) {
      return false;
    }
  },

  async resolveImageLocalPath(url) {
    const target = String(url || "").trim();
    if (!target) {
      throw new Error("缺少图片地址");
    }

    try {
      const info = await wx.getImageInfo({ src: target });
      const localPath = String((info && info.path) || "").trim();
      if (localPath) {
        return localPath;
      }
    } catch (error) {
      // ignore，进入 downloadFile 兜底
    }

    const tryDownload = async () => {
      const download = await wx.downloadFile({ url: target, timeout: 60000 });
      if (!download || download.statusCode !== 200 || !download.tempFilePath) {
        const status = Number((download && download.statusCode) || 0);
        throw new Error(status ? `下载失败(${status})` : "下载失败");
      }
      return download.tempFilePath;
    };

    try {
      return await tryDownload();
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 220));
      return tryDownload();
    }
  },

  async savePhotoToAlbum(url) {
    const localPath = await this.resolveImageLocalPath(url);
    await wx.saveImageToPhotosAlbum({ filePath: localPath });
  },

  async incrementPhotoViewCount(photoId) {
    const id = String(photoId || "").trim();
    if (!id) return;

    try {
      const fallbackPhoto = this.findPhotoById(id);
      const sessionId = getSessionId();
      const r = await dbRpc("increment_photo_view", {
        p_photo_id: id,
        p_session_id: sessionId,
      });
      if (r && r.error) {
        return;
      }
      const payload = r ? r.data : null;
      if (typeof payload !== "boolean" && isExplicitRpcFailure(payload)) {
        return;
      }

      const counted =
        typeof payload === "boolean"
          ? payload
          : Boolean(readFieldFromPayloadChain(payload, "counted"));
      const serverViewCount = toNonNegativeInteger(readFieldFromPayloadChain(payload, "view_count"));
      const fallbackViewCount = toNonNegativeInteger(fallbackPhoto && fallbackPhoto.view_count);
      const nextViewCount =
        serverViewCount !== null
          ? serverViewCount
          : counted
            ? Math.max(0, fallbackViewCount || 0) + 1
            : fallbackViewCount;

      if (nextViewCount !== null) {
        this.patchPhotoMetrics(id, { view_count: nextViewCount });
      }
    } catch (error) {
      // ignore count failure
    }
  },

  async incrementPhotoDownloadCount(photoId) {
    const id = String(photoId || "").trim();
    if (!id) return;

    try {
      const fallbackPhoto = this.findPhotoById(id);
      const r = await dbRpc(
        "increment_photo_download",
        {
          p_photo_id: id,
        },
        {
          disableBackendRecovery: true,
        }
      );
      if (r && r.error) {
        return;
      }
      const payload = r ? r.data : null;
      if (typeof payload !== "boolean" && isExplicitRpcFailure(payload)) {
        return;
      }

      const counted =
        typeof payload === "boolean"
          ? payload
          : Boolean(readFieldFromPayloadChain(payload, "counted"));
      const serverDownloadCount = toNonNegativeInteger(readFieldFromPayloadChain(payload, "download_count"));
      const fallbackDownloadCount = toNonNegativeInteger(fallbackPhoto && fallbackPhoto.download_count);
      const nextDownloadCount =
        serverDownloadCount !== null
          ? serverDownloadCount
          : counted
            ? Math.max(0, fallbackDownloadCount || 0) + 1
            : fallbackDownloadCount;

      if (nextDownloadCount !== null) {
        this.patchPhotoMetrics(id, { download_count: nextDownloadCount });
      }
    } catch (error) {
      // ignore count failure
    }
  },

  async handleBatchDownload() {
    if (this.data.batchLoading || this.data.downloadProgressRunning) return;

    const list = this.data.photos || [];
    const map = this.data.selectedPhotoMap || {};
    const selected = list.filter((p) => Boolean(map[String(p.id)]));
    const shouldDownloadAll = selected.length === 0;

    const granted = await this.ensureAlbumWritePermission();
    if (!granted) {
      wx.showModal({
        title: "需要相册权限",
        content: "请在小程序设置中开启“保存到相册”权限后重试。",
        showCancel: false,
      });
      return;
    }

    this.openDownloadProgress({
      title: shouldDownloadAll ? "正在准备下载" : "正在保存照片",
      message: shouldDownloadAll
        ? "正在整理当前相册的全部照片..."
        : `准备保存 0 / ${selected.length} 张照片`,
      total: shouldDownloadAll ? 0 : selected.length,
      current: 0,
      success: 0,
      fail: 0,
      running: true,
      done: false,
    });

    let targets = selected;
    if (shouldDownloadAll) {
      try {
        targets = await this.loadAllPhotosForFolder(this.data.selectedFolder || ROOT_FOLDER_ID);
      } catch (error) {
        this.hideDownloadProgress();
        const message = String((error && error.message) || "").trim() || "加载全部照片失败";
        this.showToast(message, "error", 2600);
        return;
      }
    }

    if (!targets.length) {
      this.hideDownloadProgress();
      this.showToast("暂无可下载照片", "error", 2200);
      return;
    }

    const total = targets.length;
    this.updateDownloadProgress({
      title: "正在保存照片",
      message: `准备保存 0 / ${total} 张照片`,
      total,
      current: 0,
      success: 0,
      fail: 0,
      running: true,
      done: false,
    });

    let success = 0;
    let fail = 0;

    for (let index = 0; index < total; index += 1) {
      const photo = targets[index];
      this.updateDownloadProgress({
        title: "正在保存照片",
        message: total > 1 ? `正在保存第 ${index + 1} / ${total} 张...` : "正在保存照片...",
      });

      const url = photo.original_url_resolved;
      if (!url) {
        fail += 1;
      } else {
        try {
          await this.savePhotoToAlbum(url);
          success += 1;
          void this.incrementPhotoDownloadCount(photo.id);
          if (index < total - 1) {
            await new Promise((resolve) => setTimeout(resolve, 120));
          }
        } catch (e) {
          try {
            console.warn("[album] save image failed", {
              photoId: String(photo.id || ""),
              url: String(url),
              message: String((e && e.message) || e || ""),
            });
          } catch (_) {
            // ignore log error
          }
          fail += 1;
        }
      }

      const current = index + 1;
      this.updateDownloadProgress({
        current,
        total,
        success,
        fail,
        message: current < total ? `已完成 ${current} / ${total} 张照片` : "正在整理保存结果...",
      });
    }

    this.finishDownloadProgress({ success, fail, total });

    if (fail > 0) {
      this.showToast(`保存完成：成功 ${success} 张，失败 ${fail} 张`, "error", 3200);
    } else {
      this.showToast(`成功保存 ${success} 张`, "success", 2600);
    }
  },

  handleBatchDelete() {
    if (this.data.batchLoading || this.data.downloadProgressRunning) return;

    const map = this.data.selectedPhotoMap || {};
    const selected = (this.data.photos || []).filter((p) => Boolean(map[String(p.id)]));
    if (selected.length === 0) {
      this.showToast("请先勾选要删除的照片", "error", 2200);
      return;
    }

    this.setData({ showDeleteConfirm: true });
  },

  closeDeleteConfirm() {
    this.setData({ showDeleteConfirm: false });
  },

  async confirmBatchDelete() {
    if (this.data.batchLoading || this.data.downloadProgressRunning) return;

    const map = this.data.selectedPhotoMap || {};
    const selected = (this.data.photos || []).filter((p) => Boolean(map[String(p.id)]));
    if (selected.length === 0) {
      this.setData({ showDeleteConfirm: false });
      return;
    }

    this.setData({ batchLoading: true });

    let success = 0;
    let fail = 0;
    let storageWarningCount = 0;
    const deletedIds = [];
    let hasPublicDeleted = false;

    for (const photo of selected) {
      try {
        const r = await dbRpc("delete_album_photo", {
          p_access_key: this.data.key,
          p_photo_id: photo.id,
        });
        const rawPayload = r ? r.data : null;
        if ((r && r.error) || isExplicitRpcFailure(rawPayload)) {
          fail += 1;
        } else {
          success += 1;
          if (hasStorageCleanupFailed(rawPayload)) {
            storageWarningCount += 1;
          }
          const id = String(photo && photo.id ? photo.id : "");
          if (id) {
            deletedIds.push(id);
          }
          if (photo && photo.is_public) {
            hasPublicDeleted = true;
          }
        }
      } catch (e) {
        fail += 1;
      }
    }

    if (success > 0) {
      const deletedIdSet = new Set(deletedIds);
      const nextAll = (this.data.allPhotos || []).filter((p) => !deletedIdSet.has(String(p.id)));
      const currentSelectedMap = this.data.selectedPhotoMap || {};
      const nextSelectedMap = {};
      Object.keys(currentSelectedMap).forEach((id) => {
        if (!deletedIdSet.has(String(id))) {
          nextSelectedMap[id] = currentSelectedMap[id];
        }
      });

      this.setData(
        {
          allPhotos: nextAll,
          selectedPhotoMap: nextSelectedMap,
        },
        () => this.applyFilter()
      );

      this.legacyPhotosByFolder = Object.create(null);
      this.fullPhotosByFolder = Object.create(null);

      if (hasPublicDeleted) {
        markGalleryCacheDirty();
      }
    }

    this.setData({ batchLoading: false, showDeleteConfirm: false });

    if (fail > 0 || storageWarningCount > 0) {
      const warnings = [];
      if (fail > 0) {
        warnings.push(`失败 ${fail} 张`);
      }
      if (storageWarningCount > 0) {
        warnings.push(`云存储清理失败 ${storageWarningCount} 张`);
      }
      this.showToast(`删除完成：成功 ${success} 张，${warnings.join("；")}`, "error", 3200);
    } else {
      this.showToast(`成功删除 ${success} 张`, "success", 2600);
    }
  },

  async openPhotoFullscreen(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;

    const visibleRows = Array.isArray(this.data.photos) ? this.data.photos : [];
    const target = visibleRows.find((item) => String(item.id) === id) || this.findPhotoById(id);
    if (!target) return;

    const targetFolderId = target.folder_id ? String(target.folder_id) : ROOT_FOLDER_ID;
    let previewRows = this.getCachedFullPhotosForFolder(targetFolderId);
    let loadingShown = false;

    if (previewRows.length === 0) {
      try {
          wx.showLoading({ title: "正在准备全部照片...", mask: true });
          loadingShown = true;
      } catch (error) {
        loadingShown = false;
      }

      try {
        previewRows = await this.loadAllPhotosForFolder(targetFolderId);
      } catch (error) {
        previewRows = Array.isArray(this.data.allPhotos) && this.data.allPhotos.length > 0
          ? this.data.allPhotos.slice()
          : visibleRows.slice();
      } finally {
        if (loadingShown) {
          try {
            wx.hideLoading();
          } catch (error) {
            // ignore hide loading error
          }
        }
      }
    }

    const previewableRows = (Array.isArray(previewRows) ? previewRows : []).filter((item) => Boolean(item && item.fullscreen_url_resolved));
    if (previewableRows.length === 0) {
      this.showToast("鍘熷浘鏆備笉鍙敤", "error", 2200);
      return;
    }

    const currentIndex = Math.max(0, previewableRows.findIndex((item) => String(item.id) === id));
    const currentRow = previewableRows[currentIndex] || previewableRows[0];
    if (!currentRow || !currentRow.fullscreen_url_resolved) {
      this.showToast("该照片原图暂不可用", "error", 2200);
      return;
    }

    void this.incrementPhotoViewCount(id);
    this.markTransientForegroundReturn();
    wx.previewImage({
      current: currentRow.fullscreen_url_resolved,
      urls: previewableRows.map((item) => item.fullscreen_url_resolved),
    });
  },

  closePinConfirm() {
    if (this.data.pinConfirmPending) {
      return;
    }
    this.setData({ confirmPhotoId: "" });
  },

  async confirmPin() {
    if (!this.data.freezeEnabled) return;
    const id = String(this.data.confirmPhotoId || "");
    if (!id || this.isPinActionPending(id)) return;

    await this.performTogglePin(id);
    this.setData({ confirmPhotoId: "" });
  },

  async togglePin(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;

    const photo = this.findPhotoById(id);
    if (!photo) return;
    if (this.isPinActionPending(id)) return;
    if (!this.data.freezeEnabled) {
      this.showToast("当前专属空间未开启定格功能", "error", 2600);
      return;
    }

    if (photo.is_public) {
      await this.performTogglePin(id);
      return;
    }

    this.setData({ confirmPhotoId: id });
  },

  async performTogglePin(id) {
    const photo = this.findPhotoById(id);
    if (!photo) return;
    if (this.isPinActionPending(id)) return;
    if (!this.data.freezeEnabled) {
      this.showToast("当前专属空间未开启定格功能", "error", 2600);
      return;
    }
    this.setPinActionPending(id, true);
    try {
      const r = await dbRpc("pin_photo_to_wall", {
        p_access_key: this.data.key,
        p_photo_id: id,
        p_client_source: "mini",
      }, {
        disableTransientRetry: true,
        disableBackendRecovery: true,
      });

      if (r && r.error) {
        const rpcErrorMessage = String((r.error && r.error.message) || "").trim();
        this.showToast(rpcErrorMessage || "操作失败", "error", 2600);
        return;
      }
      const rawPayload = r ? r.data : null;
      if (typeof rawPayload !== "boolean" && isExplicitRpcFailure(rawPayload)) {
        const payloadErrorMessage = readRpcPayloadErrorMessage(rawPayload);
        this.showToast(payloadErrorMessage || "操作失败", "error", 2600);
        return;
      }
      const nextPublicState = typeof rawPayload === "boolean" ? rawPayload : null;

      const nextAll = (this.data.allPhotos || []).map((p) => {
        if (String(p.id) !== String(id)) return p;
        return Object.assign({}, p, {
          is_public: nextPublicState === null ? !p.is_public : nextPublicState,
        });
      });

      const updated = nextAll.find((p) => String(p.id) === String(id));
      const becamePublic = Boolean(updated && updated.is_public);

      this.setData(
        {
          allPhotos: nextAll,
        },
        () => this.applyFilter()
      );

      markGalleryCacheDirty();

      if (becamePublic) {
        this.showToast(
          `✨ 照片已定格到照片墙，不再受当前相册剩余 ${this.data.expiryDays} 天有效期限制。`,
          "success",
          5000
        );
      } else {
        this.showToast("照片已从照片墙移除", "success", 2200);
      }
    } catch (e2) {
      this.showToast("操作失败", "error", 2600);
    } finally {
      this.setPinActionPending(id, false);
    }
  },

  onShareAppMessage() {
    const key = String(this.data.key || "").trim();
    const path = key
      ? `/pages/album/detail?key=${encodeURIComponent(key)}`
      : "/pages/album/index";
    return {
      title: SHARE_TITLE,
      path,
      imageUrl: SHARE_IMAGE_URL,
    };
  },

  onShareTimeline() {
    const key = String(this.data.key || "").trim();
    return {
      title: SHARE_TITLE,
      query: key ? `key=${encodeURIComponent(key)}` : "",
      imageUrl: SHARE_IMAGE_URL,
    };
  },
});


