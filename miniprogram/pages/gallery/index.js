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
  createPagingSkeletonItems,
  createPagingSkeletonItemsFromPhotos,
} = require("../../utils/paging-skeleton");
const {
  hydratePhotoDimensions,
  photoListHasMissingDimensions,
} = require("../../utils/photo-dimensions");
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
const GALLERY_FULLSCREEN_BULK_PAGE_SIZE = 50;
const GALLERY_FULLSCREEN_MAX_PAGES = 200;
const GALLERY_LOAD_AHEAD_PX = 720;
const GALLERY_VIEWPORT_FILL_BUFFER_PX = 48;
const GALLERY_INITIAL_AUTOFILL_MAX_BATCHES = 2;
const GALLERY_SWITCH_OVERLAY_TRACK_COUNT = 6;
const GALLERY_PAGING_SKELETON_COUNT = 8;
const GALLERY_PAGE_READY_DELAY_MS = 120;
const GALLERY_TAG_GUIDE_TRIGGER_DELAY_MS = 120;
const GALLERY_CACHE_KEY = GALLERY_PAGE_CACHE_KEY;
const GALLERY_CACHE_TTL = 30 * 60 * 1000;
const GALLERY_STALE_PAGE_LOADING_MS = 15000;
const ROOT_FOLDER_ID = "__ROOT__";
const SHARE_IMAGE_URL = "/images/share/shiguangyao-share.jpg";
const SHARE_TITLE = "拾光谣｜定格美好瞬间";

function createEmptyGalleryCache() {
  return {
    photos: [],
    total: 0,
    folders: [{ id: ROOT_FOLDER_ID, name: "根目录" }],
    rootFolderName: "根目录",
    hideRootFolder: false,
    folderSnapshotReady: false,
    targetFolderId: ROOT_FOLDER_ID,
    cachedAt: 0,
  };
}

let galleryMemoryCache = createEmptyGalleryCache();

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
    "照片墙";

  return {
    title: "拾光中...",
    pageDescription: "正在加载页面",
    switchDescription: "正在加载页面",
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

function normalizeGalleryBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return Boolean(fallback);
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  const numericValue = Number(value);
  if (Number.isFinite(numericValue)) {
    return numericValue !== 0;
  }
  return Boolean(fallback);
}

function resolveDefaultGalleryFolderId(folders, hideRootFolder) {
  if (!hideRootFolder) {
    return ROOT_FOLDER_ID;
  }
  const list = Array.isArray(folders) ? folders : [];
  const firstFolder = list.find((folder) => {
    const id = String(folder && folder.id ? folder.id : "").trim();
    return Boolean(id);
  });
  return firstFolder ? normalizeGalleryFolderId(firstFolder.id) : ROOT_FOLDER_ID;
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

function hasGalleryCacheContent(cache) {
  const safeCache = cache && typeof cache === "object" ? cache : {};
  const photos = Array.isArray(safeCache.photos) ? safeCache.photos : [];
  const folders = Array.isArray(safeCache.folders) ? safeCache.folders : [];
  const hideRootFolder = normalizeGalleryBoolean(safeCache.hideRootFolder || safeCache.hide_root_folder, false);
  return photos.length > 0 || folders.length > (hideRootFolder ? 0 : 1);
}

function buildCachedGalleryFolders(folders, rootFolderName, hideRootFolder) {
  const normalizedRootFolderName = String(rootFolderName || "").trim() || "根目录";
  const normalizedHideRootFolder = normalizeGalleryBoolean(hideRootFolder, false);
  const rpcFolders = Array.isArray(folders)
    ? folders
      .map((folder) => {
        const id = String(folder && folder.id ? folder.id : "").trim();
        const name = String(folder && folder.name ? folder.name : "").trim();
        if (!id || !name) return null;
        if (normalizeGalleryFolderId(id) === ROOT_FOLDER_ID) {
          return normalizedHideRootFolder ? null : { id: ROOT_FOLDER_ID, name: normalizedRootFolderName };
        }
        return { id, name };
      })
      .filter(Boolean)
    : [];
  return normalizedHideRootFolder
    ? rpcFolders
    : [{ id: ROOT_FOLDER_ID, name: normalizedRootFolderName }].concat(
      rpcFolders.filter((folder) => normalizeGalleryFolderId(folder && folder.id) !== ROOT_FOLDER_ID)
    );
}

function readGalleryMemoryCache() {
  if (!hasGalleryCacheContent(galleryMemoryCache)) {
    return null;
  }

  const expired = Date.now() - Number(galleryMemoryCache.cachedAt || 0) > GALLERY_CACHE_TTL;
  if (expired) {
    galleryMemoryCache = createEmptyGalleryCache();
    return null;
  }

  if (photoListHasMissingDimensions(galleryMemoryCache.photos)) {
    galleryMemoryCache = createEmptyGalleryCache();
    return null;
  }

  if (!normalizeGalleryBoolean(galleryMemoryCache.folderSnapshotReady, false)) {
    return null;
  }

  const hideRootFolder = normalizeGalleryBoolean(galleryMemoryCache.hideRootFolder, false);
  const rootFolderName = String(galleryMemoryCache.rootFolderName || "").trim() || "根目录";
  const folders = buildCachedGalleryFolders(galleryMemoryCache.folders, rootFolderName, hideRootFolder);

  return {
    photos: galleryMemoryCache.photos.map((x) => Object.assign({}, x)),
    total: Number(galleryMemoryCache.total || 0),
    folders,
    rootFolderName,
    hideRootFolder,
    folderSnapshotReady: true,
    targetFolderId: normalizeGalleryFolderId(
      galleryMemoryCache.targetFolderId || resolveDefaultGalleryFolderId(folders, hideRootFolder)
    ),
  };
}

function writeGalleryMemoryCache(photos, total, folders, rootFolderName, hideRootFolder, targetFolderId, folderSnapshotReady) {
  const rows = Array.isArray(photos) ? photos : [];
  const normalizedHideRootFolder = normalizeGalleryBoolean(hideRootFolder, false);
  const normalizedFolderSnapshotReady = normalizeGalleryBoolean(folderSnapshotReady, false);
  const normalizedRootFolderName = String(rootFolderName || "").trim() || "根目录";
  const normalizedFolders = buildCachedGalleryFolders(
    folders,
    normalizedRootFolderName,
    normalizedHideRootFolder
  );
  if (
    !normalizedFolderSnapshotReady ||
    (!rows.length && normalizedFolders.length <= (normalizedHideRootFolder ? 0 : 1))
  ) {
    galleryMemoryCache = createEmptyGalleryCache();
    return;
  }

  galleryMemoryCache = {
    photos: rows.map((x) => Object.assign({}, x)),
    total: Number(total || rows.length),
    folders: normalizedFolders.map((folder) => Object.assign({}, folder)),
    rootFolderName: normalizedRootFolderName,
    hideRootFolder: normalizedHideRootFolder,
    folderSnapshotReady: normalizedFolderSnapshotReady,
    targetFolderId: normalizeGalleryFolderId(
      targetFolderId || resolveDefaultGalleryFolderId(normalizedFolders, normalizedHideRootFolder)
    ),
    cachedAt: Date.now(),
  };
}

function clearGalleryMemoryCache() {
  galleryMemoryCache = createEmptyGalleryCache();
}

function readGalleryStorageCache() {
  try {
    const raw = wx.getStorageSync(GALLERY_CACHE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!hasGalleryCacheContent(parsed)) return null;
    if (
      !normalizeGalleryBoolean(
        parsed && (parsed.folder_snapshot_ready || parsed.folderSnapshotReady),
        false
      )
    ) {
      return null;
    }
    const photos = parsed && Array.isArray(parsed.photos) ? parsed.photos : [];
    const cachedAt = Number((parsed && parsed.cachedAt) || 0);
    if (!cachedAt) return null;

    const expired = Date.now() - cachedAt > GALLERY_CACHE_TTL;
    if (expired || photoListHasMissingDimensions(photos)) return null;

    const hideRootFolder = normalizeGalleryBoolean(parsed && parsed.hide_root_folder, false);
    const rootFolderName = String((parsed && parsed.root_folder_name) || "").trim() || "根目录";
    const folders = buildCachedGalleryFolders(parsed && parsed.folders, rootFolderName, hideRootFolder);

    return {
      photos,
      total: Number((parsed && parsed.total) || photos.length),
      folders,
      rootFolderName,
      hideRootFolder,
      folderSnapshotReady: true,
      targetFolderId: normalizeGalleryFolderId(
        (parsed && parsed.folder_id) || resolveDefaultGalleryFolderId(folders, hideRootFolder)
      ),
    };
  } catch (e) {
    return null;
  }
}

function writeGalleryStorageCache(photos, total, folders, rootFolderName, hideRootFolder, targetFolderId, folderSnapshotReady) {
  const rows = Array.isArray(photos) ? photos : [];
  const normalizedHideRootFolder = normalizeGalleryBoolean(hideRootFolder, false);
  const normalizedFolderSnapshotReady = normalizeGalleryBoolean(folderSnapshotReady, false);
  const normalizedRootFolderName = String(rootFolderName || "").trim() || "根目录";
  const normalizedFolders = buildCachedGalleryFolders(
    folders,
    normalizedRootFolderName,
    normalizedHideRootFolder
  );
  if (
    !normalizedFolderSnapshotReady ||
    (!rows.length && normalizedFolders.length <= (normalizedHideRootFolder ? 0 : 1))
  ) return;

  try {
    wx.setStorageSync(
      GALLERY_CACHE_KEY,
      JSON.stringify({
        photos: rows,
        total: Number(total || rows.length),
        folders: normalizedFolders,
        folder_id: normalizeGalleryFolderId(
          targetFolderId || resolveDefaultGalleryFolderId(normalizedFolders, normalizedHideRootFolder)
        ),
        folder_snapshot_ready: 1,
        hide_root_folder: normalizedHideRootFolder ? 1 : 0,
        root_folder_name: normalizedRootFolderName,
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
  const thumbnailUrlResolved = resolvePublicUrl(photo && photo.thumbnail_url);
  const previewUrlResolved = resolvePublicUrl(photo && photo.preview_url);
  const originalUrlResolved = resolvePublicUrl(photo && photo.original_url);
  const cardUrlCandidates = collectResolvedGalleryPhotoUrls([
    thumbnailUrlResolved,
    previewUrlResolved,
    originalUrlResolved,
  ]);
  const fullscreenUrlCandidates = collectResolvedGalleryPhotoUrls([
    originalUrlResolved,
    previewUrlResolved,
    thumbnailUrlResolved,
  ]);
  const cardUrlResolved = cardUrlCandidates[0] || "";
  const fullscreenUrlResolved = fullscreenUrlCandidates[0] || "";
  const assetKey = resolveGalleryPhotoAssetKey({
    thumbnail_url_resolved: thumbnailUrlResolved,
    preview_url_resolved: previewUrlResolved,
    original_url_resolved: originalUrlResolved,
  });

  return Object.assign({}, photo, {
    thumbnail_url_resolved: thumbnailUrlResolved,
    preview_url_resolved: previewUrlResolved,
    original_url_resolved: originalUrlResolved,
    __assetKey: assetKey,
    card_url_resolved: cardUrlResolved,
    fullscreen_url_resolved: fullscreenUrlResolved,
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
    _imageLoaded: Boolean(photo && photo._imageLoaded) && Boolean(cardUrlResolved),
    _imageLoadFailed: Boolean(photo && photo._imageLoadFailed) || !cardUrlResolved,
    __ratio: ratio,
    __media_padding_top: `${ratio * 100}%`,
  });
}

function collectResolvedGalleryPhotoUrls(values) {
  const seen = Object.create(null);
  return (Array.isArray(values) ? values : [])
    .map((value) => resolvePublicUrl(value))
    .map((value) => String(value || "").trim())
    .filter((value) => {
      if (!value || seen[value]) {
        return false;
      }
      seen[value] = true;
      return true;
    });
}

function buildGalleryCardUrlCandidates(photo) {
  return collectResolvedGalleryPhotoUrls([
    photo && photo.card_url_resolved,
    photo && photo.thumbnail_url_resolved,
    photo && photo.preview_url_resolved,
    photo && photo.original_url_resolved,
    photo && photo.thumbnail_url,
    photo && photo.preview_url,
    photo && photo.original_url,
  ]);
}

function buildGalleryFullscreenUrlCandidates(photo) {
  return collectResolvedGalleryPhotoUrls([
    photo && photo.fullscreen_url_resolved,
    photo && photo.original_url_resolved,
    photo && photo.preview_url_resolved,
    photo && photo.thumbnail_url_resolved,
    photo && photo.original_url,
    photo && photo.preview_url,
    photo && photo.thumbnail_url,
  ]);
}

function resolveGalleryPhotoAssetKey(photo) {
  const thumbnailUrl = String(
    (photo && (photo.thumbnail_url_resolved || photo.thumbnail_url)) || ""
  ).trim();
  const previewUrl = String(
    (photo && (photo.preview_url_resolved || photo.preview_url)) || ""
  ).trim();
  const originalUrl = String(
    (photo && (photo.original_url_resolved || photo.original_url)) || ""
  ).trim();
  return `${thumbnailUrl}|${previewUrl}|${originalUrl}`;
}

function readGalleryPhotoRuntimeAssetKey(photo) {
  const explicitAssetKey = String((photo && photo.__assetKey) || "").trim();
  return explicitAssetKey || resolveGalleryPhotoAssetKey(photo);
}

function createGalleryPhotoRuntimeState(photo) {
  if (!photo) return null;
  const id =
    photo && photo.id !== undefined && photo.id !== null
      ? String(photo.id)
      : "";
  const assetKey = readGalleryPhotoRuntimeAssetKey(photo);
  if (!id || !assetKey) {
    return null;
  }

  return {
    id,
    __assetKey: assetKey,
    _imageLoaded: Boolean(photo._imageLoaded),
    _imageLoadFailed: Boolean(photo._imageLoadFailed) && !Boolean(photo._imageLoaded),
    card_url_resolved: String((photo && photo.card_url_resolved) || "").trim(),
    fullscreen_url_resolved: String((photo && photo.fullscreen_url_resolved) || "").trim(),
    __ratio: Number((photo && photo.__ratio) || 0),
    __media_padding_top: String((photo && photo.__media_padding_top) || "").trim(),
  };
}

function inheritGalleryPhotoRuntimeState(photo, previousPhoto) {
  if (!photo || !previousPhoto) return photo;

  const nextId =
    photo && photo.id !== undefined && photo.id !== null
      ? String(photo.id)
      : "";
  const prevId =
    previousPhoto && previousPhoto.id !== undefined && previousPhoto.id !== null
      ? String(previousPhoto.id)
      : "";
  if (!nextId || !prevId || nextId !== prevId) {
    return photo;
  }

  const nextAssetKey = readGalleryPhotoRuntimeAssetKey(photo);
  const previousAssetKey = readGalleryPhotoRuntimeAssetKey(previousPhoto);
  if (!nextAssetKey || nextAssetKey !== previousAssetKey) {
    return photo;
  }

  const previousRatio = Number(previousPhoto.__ratio || 0);
  const nextRatio = previousRatio > 0 ? previousRatio : Number(photo.__ratio || 0);
  const nextPaddingTop =
    nextRatio > 0
      ? `${nextRatio * 100}%`
      : String(previousPhoto.__media_padding_top || photo.__media_padding_top || "").trim();
  const nextCardUrlCandidates = buildGalleryCardUrlCandidates(photo);
  const nextFullscreenUrlCandidates = buildGalleryFullscreenUrlCandidates(photo);
  const preservedCardUrl = nextCardUrlCandidates.includes(String(previousPhoto.card_url_resolved || "").trim())
    ? String(previousPhoto.card_url_resolved || "").trim()
    : (nextCardUrlCandidates[0] || "");
  const preservedFullscreenUrl = nextFullscreenUrlCandidates.includes(String(previousPhoto.fullscreen_url_resolved || "").trim())
    ? String(previousPhoto.fullscreen_url_resolved || "").trim()
    : (nextFullscreenUrlCandidates[0] || "");

  return Object.assign({}, photo, {
    _imageLoaded: Boolean(previousPhoto._imageLoaded),
    _imageLoadFailed: Boolean(previousPhoto._imageLoadFailed) && !Boolean(previousPhoto._imageLoaded),
    card_url_resolved: preservedCardUrl,
    fullscreen_url_resolved: preservedFullscreenUrl,
    __ratio: nextRatio > 0 ? nextRatio : photo.__ratio,
    __media_padding_top: nextPaddingTop || photo.__media_padding_top,
  });
}

function mergeGalleryPhotoRuntimeStateList(nextRows, previousRows, rememberedRuntimeStateMap) {
  const previousMap = Object.create(null);
  (Array.isArray(previousRows) ? previousRows : []).forEach((photo) => {
    const id =
      photo && photo.id !== undefined && photo.id !== null
        ? String(photo.id)
        : "";
    if (!id || previousMap[id]) return;
    previousMap[id] = photo;
  });

  const activeRuntimeStateMap =
    rememberedRuntimeStateMap && typeof rememberedRuntimeStateMap === "object"
      ? rememberedRuntimeStateMap
      : null;

  return (Array.isArray(nextRows) ? nextRows : []).map((photo) => {
    const id =
      photo && photo.id !== undefined && photo.id !== null
        ? String(photo.id)
        : "";
    const withPreviousState = inheritGalleryPhotoRuntimeState(photo, previousMap[id]);
    if (!activeRuntimeStateMap || !id) {
      return withPreviousState;
    }
    return inheritGalleryPhotoRuntimeState(withPreviousState, activeRuntimeStateMap[id]);
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
  return numericValue;
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

  const width = Number((photo && photo.width) || 0);
  const height = Number((photo && photo.height) || 0);
  if (width > 0 && height > 0) {
    return clampGalleryLayoutRatio(height / width, 1);
  }

  const photoRatio = Number(photo && photo.__ratio);
  if (photoRatio > 0) {
    return clampGalleryLayoutRatio(photoRatio, 1);
  }

  return 1;
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

function readGalleryFolderId(payload) {
  return normalizeGalleryFolderId(
    readFieldFromPayloadChain(payload, ["folder_id", "folderId"])
  );
}

function readRootFolderName(payload) {
  const direct = String(
    readFieldFromPayloadChain(payload, ["root_folder_name", "rootFolderName"]) || ""
  ).trim();
  return direct || "根目录";
}

function readHideRootFolder(payload) {
  return normalizeGalleryBoolean(
    readFieldFromPayloadChain(payload, ["hide_root_folder", "hideRootFolder"]),
    false
  );
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

function computeGallerySwitchOverlayTop(safeTop) {
  return computeTagbarStickyTop(safeTop) + convertRpxToPx(92);
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
    tagSwitchOverlayTopPx: 0,
    serviceMissing: false,
    backendReady: false,
    backendReconnecting: false,

    loading: true,
    initialContentReady: false,
    switchingFolderLoading: false,
    pendingSwitchPhotoIds: [],
    loadingMore: false,
    hasMore: true,
    pageLoadingTitle: "拾光中...",
    pageLoadingDescription: "正在加载页面",

    isLoggedIn: false,

    pageNo: 1,
    total: 0,
    selectedFolder: ROOT_FOLDER_ID,
    rootFolderName: "根目录",
    folders: [{ id: ROOT_FOLDER_ID, name: "根目录" }],
    hideRootFolder: false,
    showTagGuide: false,
    tagWaveActiveIndex: -1,
    tagWaveTick: 0,

    sourcePhotos: [],
    photos: [],
    left: [],
    right: [],
    pagingSkeletonLeft: [],
    pagingSkeletonRight: [],
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

    tagbarPinned: false,
    pageReady: false,
    pagePresentationMode: "tabbar",
    pageFallbackRoute: "",
    pageFallbackTab: "pages/index/index",
    hasBottomTabbar: true,

  },

  leftHeight: 0,
  rightHeight: 0,
  photoRatioMap: null,
  photoRuntimeStateMap: null,
  photoColumnMap: null,
  relayoutTimer: null,
  scrollMetricsTimer: null,
  viewportHeight: 0,
  pageHeight: 0,
  currentScrollTop: 0,
  loadingNextPage: false,
  galleryLoadZoneArmed: true,
  galleryAutoFillRemaining: GALLERY_INITIAL_AUTOFILL_MAX_BATCHES,
  galleryLoadTicket: 0,
  galleryPrefetchToken: 0,
  galleryPrefetchPromise: null,
  prefetchingGalleryPageNo: 0,
  prefetchingGalleryFolderId: "",
  prefetchedGalleryPage: null,
  fullPhotosByFolder: null,
  tagGuideTimer: null,
  tagGuideTriggerTimer: null,
  tagWaveTimer: null,
  tagWaveRunToken: 0,
  pageReadyTimer: null,
  storyMotionTimers: null,
  isPageAlive: false,
  pendingScrollMetricsRefresh: false,
  pageLoadingStartedAt: 0,

  applyRuntimeConfig(runtimeConfig) {
    const normalized = normalizeRuntimeConfig(runtimeConfig);
    const loadingCopy = resolveGalleryLoadingCopy(normalized, this.data.isLoggedIn);
    this.setData({
      pageLoadingTitle: loadingCopy.title,
      pageLoadingDescription: loadingCopy.pageDescription,
    });
    return normalized;
  },

  applyPagePresentation() {
    const app = typeof getApp === "function" ? getApp() : null;
    return applyPagePresentationToPage(this, app, "pages/gallery/index");
  },

  onLoad() {
    this.isPageAlive = true;
    this.pendingScrollMetricsRefresh = false;
    const app = getApp();
    const globalData = app && app.globalData ? app.globalData : {};
    const safeTop = Number(globalData.statusBarHeight || 0);
    const serviceMissing = !String(globalData.cloudRunService || "").trim();
    const backendReady = serviceMissing ? true : Boolean(globalData.backendReady);
    const backendReconnecting = !backendReady && Boolean(globalData.backendReconnecting);

    this.photoRatioMap = Object.create(null);
    this.photoRuntimeStateMap = Object.create(null);
    this.photoColumnMap = Object.create(null);
    this.relayoutTimer = null;
    this.scrollMetricsTimer = null;
    this.viewportHeight = 0;
    this.pageHeight = 0;
    this.loadingNextPage = false;
    this.galleryLoadZoneArmed = true;
    this.galleryAutoFillRemaining = GALLERY_INITIAL_AUTOFILL_MAX_BATCHES;
    this.galleryLoadTicket = 0;
    this.galleryPrefetchToken = 0;
    this.galleryPrefetchPromise = null;
    this.prefetchingGalleryPageNo = 0;
    this.prefetchingGalleryFolderId = "";
    this.prefetchedGalleryPage = null;
    this.fullPhotosByFolder = Object.create(null);
    this.galleryFolderSnapshotReady = false;
    this._galleryBootstrapped = false;
    this.pageLoadingStartedAt = Date.now();
    const currentAppEnterSeq = Math.max(0, Number(globalData.appEnterSeq || 0));
    // 首次进入页面时也需要展示一次引导：将“已见序号”回退一位，确保首帧可触发。
    this._lastSeenAppEnterSeq = Math.max(0, currentAppEnterSeq - 1);
    this._pendingTagGuideOnAppEntry = true;
    this.setData({
      safeTop,
      tagbarStickyTop: computeTagbarStickyTop(safeTop),
      tagSwitchOverlayTopPx: computeGallerySwitchOverlayTop(safeTop),
      serviceMissing,
      backendReady,
      backendReconnecting,
      initialContentReady: Boolean(serviceMissing),
      pageReady: false,
    });

    this.viewportHeight = readWindowHeight();
    this.applyRuntimeConfig(globalData.runtimeConfig || null);
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
        this.markPageLoadingStarted();
        this.setData({ loading: true });
        if (app && typeof app.ensureBackendReady === "function") {
          void app.ensureBackendReady();
        }
      }
    } else {
      this.clearPageLoadingStarted();
      this.setData({ loading: false, initialContentReady: true });
    }
  },

  onReady() {
    this.markPageReady();
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
        ? app.globalData.runtimeConfig || null
        : null
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
        this.setData(
          this._galleryBootstrapped
            ? {
                backendReconnecting: true,
              }
            : {
                loading: true,
                backendReconnecting: true,
              }
        );
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
      this.scheduleTagGuideTrigger();
    }
    if (this.consumeSuppressRefreshOnShow()) return;
    if (this.recoverFromStalePageLoading()) {
      void this.refreshLoginState();
      return;
    }
    if (this.data.loading || this.data.loadingMore) {
      void this.refreshLoginState();
      return;
    }

    const shouldForceRefresh = consumeGalleryCacheDirty();
    const hasLoadedPhotos = Array.isArray(this.data.photos) && this.data.photos.length > 0;
    if (hasLoadedPhotos && !shouldForceRefresh) {
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
    this.isPageAlive = false;
    this.clearPageReadyTimer();
    this.clearRelayoutTimer();
    this.clearScrollMetricsTimer();
    this.clearTagGuideTimer();
    this.clearTagGuideTriggerTimer();
    this.clearTagWaveTimer();
    this.clearAllStoryMotionTimers();
    this.loadingNextPage = false;
    this.galleryLoadTicket += 1;
    this._galleryBootstrapped = false;
    this.clearPageLoadingStarted();
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
    if (tab && typeof tab.syncForPage === "function") {
      tab.syncForPage(selectedPath);
      return;
    }
    if (tab && typeof tab.setData === "function") {
      tab.setData({
        selectedPath: String(selectedPath || "").trim().replace(/^\/+/, ""),
      });
    }
  },

  noop() {},

  clearPageReadyTimer() {
    if (!this.pageReadyTimer) return;
    clearTimeout(this.pageReadyTimer);
    this.pageReadyTimer = null;
  },

  markPageReady() {
    this.clearPageReadyTimer();
    this.pageReadyTimer = setTimeout(() => {
      this.pageReadyTimer = null;
      if (!this.isPageAlive) return;
      this.setData({ pageReady: true });
      if (this.pendingScrollMetricsRefresh) {
        this.pendingScrollMetricsRefresh = false;
        this.scheduleScrollMetricsRefresh(0);
      }
      if (this._pendingTagGuideOnAppEntry) {
        this.scheduleTagGuideTrigger(0);
      }
    }, GALLERY_PAGE_READY_DELAY_MS);
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

  clearTagGuideTimer() {
    if (!this.tagGuideTimer) return;
    clearTimeout(this.tagGuideTimer);
    this.tagGuideTimer = null;
  },

  clearTagGuideTriggerTimer() {
    if (!this.tagGuideTriggerTimer) return;
    clearTimeout(this.tagGuideTriggerTimer);
    this.tagGuideTriggerTimer = null;
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

    this.setData({ tagWaveActiveIndex: -1, tagWaveTick: 0 });
    schedule(120 + 16, () => {
      if (runToken !== this.tagWaveRunToken) return;
      if (!this.isPageAlive) return;
      triggerNext();
    });
  },

  startTagGuideAutoDismiss() {
    this.clearTagGuideTimer();
    this.tagGuideTimer = setTimeout(() => {
      this.dismissTagGuide();
    }, 15000);
  },

  triggerTagGuideForEntry() {
    if (!this.data.pageReady) {
      this._pendingTagGuideOnAppEntry = true;
      return;
    }
    const folderCount = Array.isArray(this.data.folders) ? this.data.folders.length : 0;
    if (folderCount <= 1) {
      this.clearTagGuideTriggerTimer();
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

    this.setData({ showTagGuide: true });
    this.startTagGuideAutoDismiss();
    this.startTagWaveAnimation();
  },

  scheduleTagGuideTrigger(delay = GALLERY_TAG_GUIDE_TRIGGER_DELAY_MS) {
    if (!this.isPageAlive) return;
    if (!this.data.pageReady) {
      this._pendingTagGuideOnAppEntry = true;
      return;
    }
    this.clearTagGuideTriggerTimer();
    this.tagGuideTriggerTimer = setTimeout(() => {
      this.tagGuideTriggerTimer = null;
      if (!this.isPageAlive) return;
      this.triggerTagGuideForEntry();
    }, Math.max(0, Number(delay || 0)));
  },

  dismissTagGuide() {
    this.clearTagGuideTriggerTimer();
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
    this.clearTagGuideTriggerTimer();
    if (this.data.showTagGuide) {
      this.dismissTagGuide();
    }
    this.clearTagWaveTimer();

    clearGalleryMemoryCache();
    clearGalleryStorageCache();
    this.invalidateGalleryPrefetch();
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
    this.fullPhotosByFolder = Object.create(null);

    this.setData({
      selectedFolder: nextId,
      loading: false,
      switchingFolderLoading: true,
      pendingSwitchPhotoIds: [],
      loadingMore: false,
      hasMore: true,
      pageNo: 0,
      total: 0,
      showFilterModal: false,
      tagWaveActiveIndex: -1,
      tagWaveTick: 0,
    }, () => {
      void this.loadPage(1, { keepCurrentContent: true, folderId: nextId });
    });

    try {
      wx.pageScrollTo({ scrollTop: 0, duration: 0 });
    } catch (error) {
      // ignore
    }

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

  markPageLoadingStarted() {
    this.pageLoadingStartedAt = Date.now();
  },

  clearPageLoadingStarted() {
    this.pageLoadingStartedAt = 0;
  },

  hasStalePageLoading() {
    const startedAt = Number(this.pageLoadingStartedAt || 0);
    if (!(startedAt > 0)) return false;
    return Date.now() - startedAt >= GALLERY_STALE_PAGE_LOADING_MS;
  },

  restoreVisibleGalleryFromSource() {
    const sourcePhotos = Array.isArray(this.data.sourcePhotos) ? this.data.sourcePhotos : [];
    if (sourcePhotos.length <= 0) {
      return false;
    }

    this.applyGalleryViewFromSource(sourcePhotos);
    this.clearPageLoadingStarted();
    this.setData({
      loading: false,
      loadingMore: false,
      initialContentReady: true,
    });
    this.scheduleScrollMetricsRefresh();
    return true;
  },

  recoverFromStalePageLoading() {
    if (this.data.initialContentReady && !this.data.loading && !this.data.loadingMore) {
      this.clearPageLoadingStarted();
      return false;
    }

    if (!this.data.initialContentReady && this.restoreVisibleGalleryFromSource()) {
      return true;
    }

    if (!this.data.loading) {
      return false;
    }

    if (!this.hasStalePageLoading()) {
      return false;
    }

    this.resetGalleryStateForRefresh();
    void this.loadPage(1, {
      silent: false,
      folderId: String(this.data.selectedFolder || ROOT_FOLDER_ID),
    });
    return true;
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
    this.fullPhotosByFolder = Object.create(null);
    this.markPageLoadingStarted();

    this.setData({
      loading: true,
      initialContentReady: false,
      pageNo: 1,
      total: 0,
      hasMore: true,
      pendingSwitchPhotoIds: [],
      sourcePhotos: [],
      photos: [],
      left: [],
      right: [],
      pagingSkeletonLeft: [],
      pagingSkeletonRight: [],
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
    const runtimeConfig = globalData.runtimeConfig || null;

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
    if (!cached || !Array.isArray(cached.photos)) return;

    const photos = this.applyRememberedPhotoRuntimeStates(
      cached.photos.map((row) => normalizePhoto(row))
    );
    const cachedFolders = Array.isArray(cached.folders) ? cached.folders : this.data.folders;
    const cachedHideRootFolder = normalizeGalleryBoolean(cached.hideRootFolder, false);
    this.galleryFolderSnapshotReady = normalizeGalleryBoolean(cached.folderSnapshotReady, true);
    const cachedTargetFolderId = normalizeGalleryFolderId(
      cached.targetFolderId || resolveDefaultGalleryFolderId(cachedFolders, cachedHideRootFolder)
    );
    this.rememberPhotoRuntimeStates(photos);
    this.clearPageLoadingStarted();
    this.setData({
      loading: false,
      initialContentReady: true,
      pageNo: 1,
      selectedFolder: cachedTargetFolderId,
      total: Number(cached.total || photos.length),
      hasMore: photos.length < Number(cached.total || photos.length),
      rootFolderName: String(cached.rootFolderName || this.data.rootFolderName || "根目录"),
      hideRootFolder: cachedHideRootFolder,
      folders: cachedFolders,
      tempFolderId: cachedTargetFolderId,
      sourcePhotos: photos,
    }, () => {
      this.applyGalleryViewFromSource(photos);
      this.persistGalleryCache(
        { writeStorage: Boolean(storage) },
        photos,
        Number(cached.total || photos.length),
        cachedFolders,
        String(cached.rootFolderName || this.data.rootFolderName || "根目录"),
        cachedHideRootFolder,
        cachedTargetFolderId,
        this.galleryFolderSnapshotReady
      );
    });
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
    const sourceBase = Array.isArray(sourceRows)
      ? sourceRows.slice()
      : (Array.isArray(this.data.sourcePhotos) ? this.data.sourcePhotos.slice() : []);
    const source = this.applyRememberedPhotoRuntimeStates(sourceBase);

    const sortMode = String(this.data.sortMode || "time_desc");
    const filterMode = String(this.data.filterMode || "all");
    const filterDateStart = normalizeDateOnlyText(this.data.filterDateStart);
    const filterDateEnd = normalizeDateOnlyText(this.data.filterDateEnd);
    const selectedFolderId = normalizeGalleryFolderId(
      opts && Object.prototype.hasOwnProperty.call(opts, "selectedFolderId")
        ? opts.selectedFolderId
        : (this.data.selectedFolder || ROOT_FOLDER_ID)
    );

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

  ensurePhotoRuntimeStateMap() {
    if (!this.photoRuntimeStateMap || typeof this.photoRuntimeStateMap !== "object") {
      this.photoRuntimeStateMap = Object.create(null);
    }
    return this.photoRuntimeStateMap;
  },

  rememberPhotoRuntimeState(photo) {
    const state = createGalleryPhotoRuntimeState(photo);
    if (!state) return;
    const runtimeStateMap = this.ensurePhotoRuntimeStateMap();
    runtimeStateMap[state.id] = state;
  },

  rememberPhotoRuntimeStates(list) {
    (Array.isArray(list) ? list : []).forEach((photo) => {
      this.rememberPhotoRuntimeState(photo);
    });
  },

  applyRememberedPhotoRuntimeStates(list) {
    if (!Array.isArray(list) || list.length === 0) {
      return [];
    }
    return mergeGalleryPhotoRuntimeStateList(
      list,
      [],
      this.ensurePhotoRuntimeStateMap()
    );
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
      tempFolderId: resolveDefaultGalleryFolderId(this.data.folders, this.data.hideRootFolder),
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

  clearPagingSkeletons() {
    if (
      (!Array.isArray(this.data.pagingSkeletonLeft) || this.data.pagingSkeletonLeft.length === 0) &&
      (!Array.isArray(this.data.pagingSkeletonRight) || this.data.pagingSkeletonRight.length === 0)
    ) {
      return;
    }

    this.setData({
      pagingSkeletonLeft: [],
      pagingSkeletonRight: [],
    });
  },

  buildPagingSkeletonColumns(skeletonItems) {
    const source = Array.isArray(skeletonItems) ? skeletonItems : [];
    if (!source.length) {
      return {
        left: [],
        right: [],
      };
    }

    const columns = buildStableWaterfallColumns(source, {
      left: [],
      right: [],
      leftHeight: Math.max(0, Number(this.leftHeight || 0)),
      rightHeight: Math.max(0, Number(this.rightHeight || 0)),
      columnMap: Object.assign(Object.create(null), this.photoColumnMap || Object.create(null)),
      estimateHeight: (photo) => estimateGalleryCardHeight(photo, this.photoRatioMap),
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
        prefix: "gallery",
        seed: Date.now(),
      })
      : createPagingSkeletonItems(safeCount, {
        prefix: "gallery",
        seed: Date.now(),
      });
    const columns = this.buildPagingSkeletonColumns(skeletonItems);
    this.setData({
      pagingSkeletonLeft: columns.left,
      pagingSkeletonRight: columns.right,
    });
  },

  invalidateGalleryPrefetch() {
    this.galleryPrefetchToken = Number(this.galleryPrefetchToken || 0) + 1;
    this.galleryPrefetchPromise = null;
    this.prefetchingGalleryPageNo = 0;
    this.prefetchingGalleryFolderId = "";
    this.prefetchedGalleryPage = null;
  },

  canUsePrefetchedGalleryPage(pageNo, targetFolderId) {
    const prefetched = this.prefetchedGalleryPage;
    if (!prefetched || typeof prefetched !== "object") {
      return false;
    }
    return (
      Number(prefetched.pageNo || 0) === Number(pageNo || 0) &&
      String(prefetched.targetFolderId || "") === String(targetFolderId || "")
    );
  },

  async fetchGalleryPageData(pageNo, targetFolderId) {
    const r = await dbRpc("get_public_gallery", {
      page_no: pageNo,
      page_size: PAGE_SIZE,
      folder_id: targetFolderId,
      client_source: "mini",
    });

    if (r && r.error) {
      return {
        errorMessage: String(r.error.message || "加载失败").trim() || "加载失败",
      };
    }

    const payload = (r && r.data) || {};
    if (hasExplicitRpcFailure(payload)) {
      return {
        errorMessage: readRpcFailureMessage(payload, "加载失败"),
      };
    }

    const rows = extractGalleryRows(payload);
    const rootFolderName = readRootFolderName(payload);
    const hideRootFolder = readHideRootFolder(payload);
    const rpcFolders = readGalleryFolders(payload);
    const folders = hideRootFolder
      ? rpcFolders.slice()
      : [{ id: ROOT_FOLDER_ID, name: rootFolderName }].concat(
        rpcFolders.filter((item) => String(item.id) !== ROOT_FOLDER_ID)
      );
    const normalizedRows = rows.map((row) => normalizePhoto(row));
    const hydratedRows = normalizedRows.length > 0
      ? await hydratePhotoDimensions(normalizedRows)
      : normalizedRows;

    return {
      errorMessage: "",
      pageNo,
      targetFolderId: readGalleryFolderId(payload) || normalizeGalleryFolderId(targetFolderId),
      rows: hydratedRows,
      total: readGalleryTotal(payload, hydratedRows.length),
      rootFolderName,
      folders,
      hideRootFolder,
    };
  },

  commitGalleryPageData(pageNo, targetFolderId, pageData, options) {
    const resolvedTargetFolderId = normalizeGalleryFolderId(
      (pageData && pageData.targetFolderId) || targetFolderId
    );
    const keepCurrentContent = Boolean(options && options.keepCurrentContent);
    const currentSource = Array.isArray(this.data.sourcePhotos) ? this.data.sourcePhotos : [];
    const currentVisible = Array.isArray(this.data.photos) ? this.data.photos : [];
    const photos = mergeGalleryPhotoRuntimeStateList(
      Array.isArray(pageData && pageData.rows) ? pageData.rows : [],
      currentSource.length > 0 ? currentSource : currentVisible,
      this.ensurePhotoRuntimeStateMap()
    );

    let mergedSource = currentSource;
    if (pageNo === 1) {
      mergedSource = photos;
    } else if (photos.length > 0) {
      const existingIds = new Set(currentSource.map((photo) => String(photo.id)));
      const incremental = photos.filter((photo) => !existingIds.has(String(photo.id)));
      mergedSource = incremental.length > 0 ? currentSource.concat(incremental) : currentSource;
    }

    this.rememberPhotoRuntimeStates(mergedSource);
    this.applyGalleryViewFromSource(mergedSource, {
      preferAppend: pageNo > 1,
      selectedFolderId: resolvedTargetFolderId,
    });

    const loadedCount = mergedSource.length;
    const total = Math.max(0, Number(pageData && pageData.total) || 0);
    const hasKnownTotal = total > 0;
    const hasMore = hasKnownTotal
      ? photos.length >= PAGE_SIZE && loadedCount < total
      : photos.length >= PAGE_SIZE;

    let nextPendingSwitchPhotoIds = null;
    if (pageNo === 1) {
      nextPendingSwitchPhotoIds = keepCurrentContent
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
      selectedFolder: resolvedTargetFolderId,
      rootFolderName: String((pageData && pageData.rootFolderName) || "根目录"),
      hideRootFolder: normalizeGalleryBoolean(pageData && pageData.hideRootFolder, false),
      folders: Array.isArray(pageData && pageData.folders)
        ? pageData.folders
        : [{ id: ROOT_FOLDER_ID, name: "根目录" }],
      tempFolderId: resolvedTargetFolderId,
      sourcePhotos: mergedSource,
    };
    if (pageNo === 1) {
      nextData.pendingSwitchPhotoIds = nextPendingSwitchPhotoIds;
    }

    this.galleryFolderSnapshotReady = true;
    this.setData(nextData);
    if (!hasMore && mergedSource.length > 0) {
      this.cacheFullPhotosForFolder(resolvedTargetFolderId, mergedSource);
    }
    if (this._pendingTagGuideOnAppEntry) {
      this.scheduleTagGuideTrigger();
    }
    this.persistGalleryCache(
      { writeStorage: pageNo === 1 },
      mergedSource,
      total,
      nextData.folders,
      nextData.rootFolderName,
      nextData.hideRootFolder,
      resolvedTargetFolderId,
      true
    );

    if (hasMore) {
      void this.prefetchGalleryPage(pageNo + 1, resolvedTargetFolderId);
    } else {
      this.invalidateGalleryPrefetch();
    }

    return {
      hasMore,
      nextPendingSwitchPhotoIds,
    };
  },

  async prefetchGalleryPage(pageNo, targetFolderId) {
    if (this.data.serviceMissing) return null;
    if (!(Number(pageNo || 0) > 1)) return null;
    if (String(this.data.selectedFolder || ROOT_FOLDER_ID) !== String(targetFolderId || ROOT_FOLDER_ID)) {
      return null;
    }
    if (this.canUsePrefetchedGalleryPage(pageNo, targetFolderId)) {
      return this.prefetchedGalleryPage;
    }
    if (
      Number(this.prefetchingGalleryPageNo || 0) === Number(pageNo || 0) &&
      String(this.prefetchingGalleryFolderId || "") === String(targetFolderId || "") &&
      this.galleryPrefetchPromise
    ) {
      return this.galleryPrefetchPromise;
    }

    const token = Number(this.galleryPrefetchToken || 0) + 1;
    this.galleryPrefetchToken = token;
    this.prefetchedGalleryPage = null;
    this.prefetchingGalleryPageNo = Number(pageNo || 0);
    this.prefetchingGalleryFolderId = String(targetFolderId || "");

    const task = Promise.resolve(this.fetchGalleryPageData(pageNo, targetFolderId))
      .then((pageData) => {
        if (token !== this.galleryPrefetchToken) {
          return null;
        }
        if (!pageData || pageData.errorMessage) {
          return null;
        }
        if (String(this.data.selectedFolder || ROOT_FOLDER_ID) !== String(targetFolderId || ROOT_FOLDER_ID)) {
          return null;
        }
        this.prefetchedGalleryPage = Object.assign({}, pageData);
        return this.prefetchedGalleryPage;
      })
      .catch(() => null)
      .finally(() => {
        if (token === this.galleryPrefetchToken) {
          this.galleryPrefetchPromise = null;
          this.prefetchingGalleryPageNo = 0;
          this.prefetchingGalleryFolderId = "";
        }
      });

    this.galleryPrefetchPromise = task;
    return task;
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

    const preservedScrollTop = Math.max(0, Number(this.currentScrollTop || 0));
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
    this.setData(
      {
        photos: resolvedNextList,
        left: columns.left,
        right: columns.right,
      },
      () => {
        if (this.isPageAlive && preservedScrollTop > 0) {
          try {
            wx.pageScrollTo({
              scrollTop: preservedScrollTop,
              duration: 0,
            });
          } catch (error) {
          }
        }
        this.scheduleScrollMetricsRefresh();
      }
    );
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
    if (!this.data.pageReady || !this.isPageAlive) {
      this.pendingScrollMetricsRefresh = true;
      return;
    }
    this.clearScrollMetricsTimer();
    this.scrollMetricsTimer = setTimeout(() => {
      this.scrollMetricsTimer = null;
      this.refreshScrollMetrics();
    }, Math.max(0, Number(delay || 0)));
  },

  refreshScrollMetrics() {
    if (!this.data.pageReady || !this.isPageAlive) {
      this.pendingScrollMetricsRefresh = true;
      return;
    }
    const query = typeof this.createSelectorQuery === "function"
      ? this.createSelectorQuery()
      : wx.createSelectorQuery();
    query
      .select(".page")
      .boundingClientRect();
    query.exec((result) => {
      if (!this.isPageAlive) return;
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
    const targetFolderId = String(this.data.selectedFolder || ROOT_FOLDER_ID);
    if (this.canUsePrefetchedGalleryPage(nextPage, targetFolderId)) {
      const prefetched = this.prefetchedGalleryPage;
      this.prefetchedGalleryPage = null;
      this.commitGalleryPageData(nextPage, targetFolderId, prefetched, {
        keepCurrentContent: false,
      });
      this.loadingNextPage = false;
      this.scheduleScrollMetricsRefresh(80);
      return true;
    }
    Promise.resolve(this.loadPage(nextPage, {
      folderId: targetFolderId,
    }))
      .finally(() => {
        this.loadingNextPage = false;
        this.scheduleScrollMetricsRefresh(120);
      });
    return true;
  },

  onPageScroll(e) {
    const scrollTop = Number(e && e.scrollTop);
    if (Number.isFinite(scrollTop) && scrollTop >= 0) {
      this.currentScrollTop = scrollTop;
    }
    this.syncTagbarPinnedByScrollTop(scrollTop);

    if (this.data.serviceMissing) return;
    if (this.data.loading) return;
    if (this.data.loadingMore) return;
    if (!this.data.hasMore) return;

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
        Number(stablePhoto.width || 0) > 0
        && Number(stablePhoto.height || 0) > 0
      )
    );
    if (hasStableStoredRatio) return;

    const shouldAllowLiveRelayout = Boolean(
      this.data.switchingFolderLoading ||
      (Array.isArray(this.data.pendingSwitchPhotoIds) && this.data.pendingSwitchPhotoIds.length > 0)
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
    if (!id) return;

    const current = this.findPhotoById(id);
    if (!current) return;

    const currentCardUrl = String((current && current.card_url_resolved) || "").trim();
    const nextCardUrl = buildGalleryCardUrlCandidates(current).find((url) => url && url !== currentCardUrl) || "";
    if (nextCardUrl) {
      this.patchPhotoVisualState(id, (photo) => Object.assign({}, photo, {
        card_url_resolved: nextCardUrl,
        _imageLoaded: false,
        _imageLoadFailed: false,
      }));
      return;
    }

    if (current._imageLoadFailed) return;

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

  persistGalleryCache(opts, sourceRows, totalOverride, foldersOverride, rootFolderNameOverride, hideRootFolderOverride, targetFolderIdOverride) {
    const folders = Array.isArray(foldersOverride) ? foldersOverride : this.data.folders;
    const hideRootFolder = normalizeGalleryBoolean(
      hideRootFolderOverride === undefined ? this.data.hideRootFolder : hideRootFolderOverride,
      false
    );
    const folderSnapshotReady = normalizeGalleryBoolean(
      arguments.length > 7 ? arguments[7] : this.galleryFolderSnapshotReady,
      false
    );
    const targetFolderId = normalizeGalleryFolderId(
      targetFolderIdOverride || this.data.selectedFolder || ROOT_FOLDER_ID
    );
    const defaultFolderId = resolveDefaultGalleryFolderId(folders, hideRootFolder);
    if (!folderSnapshotReady || targetFolderId !== defaultFolderId) return;
    const photos = Array.isArray(sourceRows)
      ? sourceRows
      : (
        Array.isArray(this.data.sourcePhotos) && this.data.sourcePhotos.length > 0
          ? this.data.sourcePhotos
          : (this.data.photos || [])
      );

    const total = Math.max(Number(totalOverride || this.data.total || 0), photos.length);
    const rootFolderName = String(
      rootFolderNameOverride || this.data.rootFolderName || "根目录"
    ).trim() || "根目录";
    writeGalleryMemoryCache(
      photos,
      total,
      folders,
      rootFolderName,
      hideRootFolder,
      targetFolderId,
      folderSnapshotReady
    );

    if (opts && opts.writeStorage) {
      writeGalleryStorageCache(
        photos,
        total,
        folders,
        rootFolderName,
        hideRootFolder,
        targetFolderId,
        folderSnapshotReady
      );
    }
  },

  getLoadedSourcePhotosForFolder(folderId) {
    const normalizedFolderId = normalizeGalleryFolderId(folderId);
    const sourcePhotos = Array.isArray(this.data.sourcePhotos) ? this.data.sourcePhotos : [];
    return sourcePhotos.filter((photo) => doesPhotoBelongToGalleryFolder(photo, normalizedFolderId));
  },

  getCachedFullPhotosForFolder(folderId) {
    const normalizedFolderId = normalizeGalleryFolderId(folderId);
    const rows =
      this.fullPhotosByFolder && Array.isArray(this.fullPhotosByFolder[normalizedFolderId])
        ? this.fullPhotosByFolder[normalizedFolderId]
        : [];
    return rows.length > 0 ? rows.map((row) => Object.assign({}, row)) : [];
  },

  cacheFullPhotosForFolder(folderId, rows) {
    const normalizedFolderId = normalizeGalleryFolderId(folderId);
    if (!this.fullPhotosByFolder) {
      this.fullPhotosByFolder = Object.create(null);
    }

    const normalizedRows = (Array.isArray(rows) ? rows : []).map((row) => Object.assign({}, row));
    this.fullPhotosByFolder[normalizedFolderId] = normalizedRows;
    return normalizedRows.map((row) => Object.assign({}, row));
  },

  resolveGalleryViewRowsFromSource(sourceRows) {
    const sourceBase = Array.isArray(sourceRows)
      ? sourceRows.slice()
      : (Array.isArray(this.data.sourcePhotos) ? this.data.sourcePhotos.slice() : []);
    const source = this.applyRememberedPhotoRuntimeStates(sourceBase);

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

    return resolveGalleryPhotoListRatios(viewRows, this.photoRatioMap);
  },

  async loadAllPhotosForFolder(folderId) {
    const targetFolderId = normalizeGalleryFolderId(folderId);
    const cachedRows = this.getCachedFullPhotosForFolder(targetFolderId);
    if (cachedRows.length > 0) {
      return cachedRows;
    }

    const loadedRows = this.getLoadedSourcePhotosForFolder(targetFolderId);
    const knownTotal = Math.max(0, Number(this.data.total || 0));
    if (loadedRows.length > 0 && (!this.data.hasMore || (knownTotal > 0 && loadedRows.length >= knownTotal))) {
      return this.cacheFullPhotosForFolder(targetFolderId, loadedRows);
    }

    const rows = [];
    const rowIds = new Set();
    let pageNo = 1;
    let hasMore = true;

    while (hasMore) {
      const r = await dbRpc("get_public_gallery", {
        page_no: pageNo,
        page_size: GALLERY_FULLSCREEN_BULK_PAGE_SIZE,
        folder_id: targetFolderId,
        client_source: "mini",
      });

      if (r && r.error) {
        throw new Error(String(r.error.message || "加载失败"));
      }

      const payload = (r && r.data) || {};
      if (hasExplicitRpcFailure(payload)) {
        throw new Error(readRpcFailureMessage(payload, "加载失败"));
      }

      const pageRows = extractGalleryRows(payload)
        .map((row) => normalizePhoto(row))
        .filter((photo) => doesPhotoBelongToGalleryFolder(photo, targetFolderId));

      pageRows.forEach((row) => {
        const id = String((row && row.id) || "").trim();
        if (id && rowIds.has(id)) return;
        if (id) rowIds.add(id);
        rows.push(row);
      });

      const total = readGalleryTotal(payload, rows.length);
      const hasKnownTotal = total > 0;
      hasMore = hasKnownTotal
        ? rows.length < total
        : pageRows.length >= GALLERY_FULLSCREEN_BULK_PAGE_SIZE;

      if (!hasMore) break;
      pageNo += 1;

      if (pageNo > GALLERY_FULLSCREEN_MAX_PAGES) {
        throw new Error("照片分页异常，请稍后重试");
      }
    }

    const previousRows = loadedRows.length > 0 ? loadedRows : (Array.isArray(this.data.photos) ? this.data.photos : []);
    const mergedRows = mergeGalleryPhotoRuntimeStateList(
      rows,
      previousRows,
      this.ensurePhotoRuntimeStateMap()
    );
    this.rememberPhotoRuntimeStates(mergedRows);
    return this.cacheFullPhotosForFolder(targetFolderId, mergedRows);
  },

  async loadPage(pageNo, opts) {
    if (this.data.serviceMissing) return;

    const silent = Boolean(opts && opts.silent);
    const keepCurrentContent = Boolean(opts && opts.keepCurrentContent);
    const targetFolderId = String(
      (opts && opts.folderId) || this.data.selectedFolder || ROOT_FOLDER_ID
    ).trim() || ROOT_FOLDER_ID;
    let activeFolderId = targetFolderId;
    if (pageNo === 1) {
      this.invalidateGalleryPrefetch();
    }
    const ticket = Number(this.galleryLoadTicket || 0) + 1;
    this.galleryLoadTicket = ticket;
    const shouldTrackSwitchOverlay = pageNo === 1 && keepCurrentContent;
    let nextPendingSwitchPhotoIds = null;
    if (pageNo === 1) {
      if (!silent && !keepCurrentContent) {
        this.markPageLoadingStarted();
        this.setData({ loading: true });
      }
    } else {
      if (this.canUsePrefetchedGalleryPage(pageNo, targetFolderId)) {
        const prefetched = this.prefetchedGalleryPage;
        this.prefetchedGalleryPage = null;
        activeFolderId = normalizeGalleryFolderId(
          prefetched && prefetched.targetFolderId ? prefetched.targetFolderId : targetFolderId
        );
        const committed = this.commitGalleryPageData(pageNo, targetFolderId, prefetched, {
          keepCurrentContent: false,
        });
        return Boolean(committed);
      }
      this.showPagingSkeletons(GALLERY_PAGING_SKELETON_COUNT);
      this.setData({ loadingMore: true });
    }

    try {
      const pageData =
        pageNo > 1
          ? await (this.prefetchGalleryPage(pageNo, targetFolderId) || this.fetchGalleryPageData(pageNo, targetFolderId))
          : await this.fetchGalleryPageData(pageNo, targetFolderId);

      if (ticket !== this.galleryLoadTicket) {
        return false;
      }
      if (String(this.data.selectedFolder || ROOT_FOLDER_ID) !== targetFolderId) {
        return false;
      }

      if (pageData && pageData.errorMessage) {
        if (!(pageNo === 1 && silent)) {
          wx.showToast({ title: pageData.errorMessage || "加载失败", icon: "none" });
        }
        return false;
      }
      if (this.canUsePrefetchedGalleryPage(pageNo, targetFolderId)) {
        this.prefetchedGalleryPage = null;
      }
      activeFolderId = normalizeGalleryFolderId(
        pageData && pageData.targetFolderId ? pageData.targetFolderId : targetFolderId
      );
      const committed = this.commitGalleryPageData(pageNo, targetFolderId, pageData, {
        keepCurrentContent: shouldTrackSwitchOverlay,
      });
      nextPendingSwitchPhotoIds = committed && committed.nextPendingSwitchPhotoIds;
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
      if (String(this.data.selectedFolder || ROOT_FOLDER_ID) !== activeFolderId) {
        return false;
      }
      const shouldKeepSwitchOverlay = shouldTrackSwitchOverlay
        ? Boolean(Array.isArray(nextPendingSwitchPhotoIds) && nextPendingSwitchPhotoIds.length > 0)
        : false;
      if (pageNo === 1) {
        this.clearPageLoadingStarted();
      }
      const nextState = {
        loading: false,
        switchingFolderLoading: shouldKeepSwitchOverlay,
        loadingMore: false,
        pagingSkeletonLeft: [],
        pagingSkeletonRight: [],
      };
      if (pageNo === 1) {
        nextState.initialContentReady = true;
      }
      this.setData(nextState);
      if (this._pendingTagGuideOnAppEntry) {
        this.scheduleTagGuideTrigger();
      }
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

    const nextData = {};
    let changed = false;
    let rememberedPhoto = null;
    const patchListByPath = (fieldName, list) => {
      if (!Array.isArray(list) || list.length === 0) {
        return;
      }

      list.forEach((photo, index) => {
        if (String((photo && photo.id) || "") !== targetId) {
          return;
        }
        const nextPhoto = updater(photo);
        if (nextPhoto === photo) {
          return;
        }
        nextData[`${fieldName}[${index}]`] = nextPhoto;
        changed = true;
        if (!rememberedPhoto) {
          rememberedPhoto = nextPhoto;
        }
      });
    };

    patchListByPath("sourcePhotos", this.data.sourcePhotos || []);
    patchListByPath("photos", this.data.photos || []);
    patchListByPath("left", this.data.left || []);
    patchListByPath("right", this.data.right || []);
    if (!changed) {
      return;
    }

    if (rememberedPhoto) {
      this.rememberPhotoRuntimeState(rememberedPhoto);
    }
    this.setData(nextData);
  },

  async openPhotoFullscreenById(id) {
    const visibleRows = Array.isArray(this.data.photos) ? this.data.photos : [];
    const target =
      visibleRows.find((photo) => String((photo && photo.id) || "") === String(id)) ||
      this.findPhotoById(id);
    if (!target) {
      wx.showToast({ title: "图片暂不可用", icon: "none" });
      return;
    }

    const targetFolderId = normalizeGalleryFolderId(target && target.folder_id);
    const loadedRows = this.getLoadedSourcePhotosForFolder(targetFolderId);
    let previewRows = this.getCachedFullPhotosForFolder(targetFolderId);
    let loadingShown = false;

    if (previewRows.length === 0) {
      const loadedCount = loadedRows.length;
      const total = Math.max(0, Number(this.data.total || 0));
      const shouldShowLoading = this.data.hasMore || (total > 0 && loadedCount < total);
      if (shouldShowLoading) {
        try {
          wx.showLoading({ title: "正在加载全部照片...", mask: true });
          loadingShown = true;
        } catch (error) {
          loadingShown = false;
        }
      }

      try {
        previewRows = await this.loadAllPhotosForFolder(targetFolderId);
      } catch (error) {
        previewRows = loadedRows.length > 0 ? loadedRows.slice() : visibleRows.slice();
      } finally {
        if (loadingShown) {
          try {
            wx.hideLoading();
          } catch (error) {
            // ignore
          }
        }
      }
    }

    const previewable = this.resolveGalleryViewRowsFromSource(previewRows).filter(
      (p) => Boolean(p && (p.fullscreen_url_resolved || p.card_url_resolved))
    );
    if (!previewable.length) {
      wx.showToast({ title: "图片暂不可用", icon: "none" });
      return;
    }

    const currentTarget = previewable.find((p) => String(p.id) === String(id)) || previewable[0];
    const currentUrl =
      currentTarget.fullscreen_url_resolved ||
      currentTarget.card_url_resolved;
    if (!currentUrl) {
      wx.showToast({ title: "图片暂不可用", icon: "none" });
      return;
    }

    const urls = previewable
      .map((p) => p.fullscreen_url_resolved || p.card_url_resolved)
      .filter(Boolean);
    if (!urls.length) {
      wx.showToast({ title: "图片暂不可用", icon: "none" });
      return;
    }

    this.markTransientForegroundReturn();
    wx.previewImage({
      current: currentUrl,
      urls,
      showmenu: false,
    });
  },

  updatePhoto(id, updater, options) {
    const updateOne = (p) => (String(p.id) === String(id) ? updater(p) : p);
    const shouldPersist = !Boolean(options && options.skipPersist);

    const sourceBaseRaw =
      Array.isArray(this.data.sourcePhotos) && this.data.sourcePhotos.length > 0
        ? this.data.sourcePhotos
        : (this.data.photos || []);
    const sourceBase = this.applyRememberedPhotoRuntimeStates(sourceBaseRaw);
    const sourcePhotos = sourceBase.map(updateOne);
    this.rememberPhotoRuntimeStates(sourcePhotos);

    this.setData(
      {
        sourcePhotos,
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

    void this.incrementPhotoViewCount(id, current);
    this.openPhotoFullscreenById(id);
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
