const { dbQuery, requestUpload, requestJson } = require("../../../services/photo-api");
const { resolvePublicUrl } = require("../../../utils/storage-url");
const { setCachedAlbumRootName } = require("../../../utils/album-root-name-cache");
const { markGalleryCacheDirty } = require("../../../utils/gallery-cache");

const ROOT_FOLDER_SENTINEL = '__ROOT__';
const DEFAULT_SORT_ORDER = 2147483647;
const TOP_PIN_SORT_ORDER = 1;
const TOP_PIN_CONFLICT_SORT_ORDER = 11;
const SYSTEM_GALLERY_ALBUM_ID = "00000000-0000-0000-0000-000000000000";
const ALBUM_FOLDER_SORT_MIGRATION_HINT = "数据库缺少 album_folders.sort_order 字段，请先执行 SQL 迁移：photo/sql/migrations/15_album_folder_sort_order.sql";
const ALBUM_FOLDER_SORT_READONLY_HINT = "当前后端暂不支持 album_folders.sort_order, 已回退为旧版顺序展示; 如需启用上移/下移, 请同步数据库迁移和后端字段白名单: photo/sql/migrations/15_album_folder_sort_order.sql";
const ALBUM_PHOTO_STORY_SORT_MIGRATION_HINT = "数据库缺少 story_text / is_highlight / sort_order 字段，请先执行 SQL 迁移：photo/sql/migrations/06_album_photo_story_sort.sql";
const ALBUM_PHOTO_SHOT_DATE_MIGRATION_HINT = "数据库缺少 shot_date 字段，请先执行 SQL 迁移：photo/sql/migrations/07_album_photo_shot_date.sql";
const ALBUM_PHOTO_SHOT_LOCATION_MIGRATION_HINT = "数据库缺少 shot_location 字段，请先执行 SQL 迁移：photo/sql/migrations/08_album_photo_shot_location.sql";

function shouldInvalidatePublicGalleryCache(pageData) {
  if (!pageData || typeof pageData !== "object") return false;
  if (Boolean(pageData.isSystemAlbum)) return true;
  return String(pageData.albumId || "").trim() === SYSTEM_GALLERY_ALBUM_ID;
}

function normalizeStoryText(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text) return "";
  const lowered = text.toLowerCase();
  if (lowered === "null" || lowered === "undefined" || lowered === "none" || lowered === "nil") {
    return "";
  }
  return text;
}

function getTodayDateUTC8() {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeShotDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const matched = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!matched) return "";
  return `${matched[1]}-${matched[2]}-${matched[3]}`;
}

function normalizeShotLocation(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return "";
  const lowered = raw.toLowerCase();
  if (lowered === "null" || lowered === "undefined" || lowered === "none" || lowered === "nil") {
    return "";
  }
  return raw;
}

function normalizeDbBoolean(value, fallback) {
  if (value === undefined || value === null) return Boolean(fallback);
  if (value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true") {
    return true;
  }
  return false;
}

function isColumnMissingError(message, column) {
  const normalized = String(message || "").toLowerCase();
  const target = String(column || "").trim().toLowerCase();
  if (!target) return false;
  return (
    (normalized.includes("unknown column") && normalized.includes(target)) ||
    (normalized.includes("column") && normalized.includes("not found") && normalized.includes(target)) ||
    (normalized.includes("does not exist") && normalized.includes(target))
  );
}

function isColumnAccessDeniedError(message, column, table) {
  const raw = String(message || "");
  const normalized = raw.toLowerCase();
  const target = String(column || "").trim().toLowerCase();
  const normalizedTable = String(table || "").trim().toLowerCase();
  if (!target) return false;
  const qualifiedTarget = normalizedTable ? normalizedTable + "." + target : "";
  return (
    (raw.includes("字段不允许访问") &&
      ((qualifiedTarget && normalized.includes(qualifiedTarget)) ||
        normalized.includes("." + target) ||
        normalized.includes(target))) ||
    (normalized.includes("field") &&
      normalized.includes("not allowed") &&
      ((qualifiedTarget && normalized.includes(qualifiedTarget)) || normalized.includes(target)))
  );
}

function isColumnUnavailableError(message, column, table) {
  return isColumnMissingError(message, column) || isColumnAccessDeniedError(message, column, table);
}

function isRootFolderTarget(value) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  if (!text) return true;
  return text.toUpperCase() === ROOT_FOLDER_SENTINEL;
}

function buildRootMoveTempFolderName() {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `__ROOT_MOVE_TMP__${Date.now()}_${suffix}`;
}

function buildFolderSortOrderValue(index) {
  return (Math.max(0, Number(index) || 0) + 1) * 10;
}

function normalizeFolderSortOrder(value) {
  const sortValue = Number(value);
  return Number.isFinite(sortValue) && sortValue > 0 ? Math.round(sortValue) : DEFAULT_SORT_ORDER;
}

function sortAlbumFolders(rows) {
  return (Array.isArray(rows) ? rows.slice() : []).sort((a, b) => {
    const normalizedA = normalizeFolderSortOrder(a && a.sort_order);
    const normalizedB = normalizeFolderSortOrder(b && b.sort_order);
    if (normalizedA !== normalizedB) return normalizedA - normalizedB;
    const createdCompare = String((a && a.created_at) || "").localeCompare(String((b && b.created_at) || ""), "zh-CN");
    if (createdCompare !== 0) return createdCompare;
    return String((a && a.id) || "").localeCompare(String((b && b.id) || ""), "zh-CN");
  });
}

function hasRpcError(result) {
  return Boolean(result && result.error);
}

function readRpcError(result, fallback) {
  if (result && result.error) {
    const error = result.error;
    if (typeof error === "string" && error.trim()) {
      return error;
    }
    if (error && typeof error === "object") {
      const message = String(error.message || "").trim();
      if (message) return message;
    }
  }
  return String(fallback || "请求失败");
}

function readErrorMessage(error, fallback) {
  if (error && typeof error === "object") {
    const message = String(error.message || "").trim();
    if (message) return message;
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return String(fallback || "操作失败");
}

function hasExplicitPayloadFailure(payload) {
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

function readPayloadErrorMessage(payload, fallback) {
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") break;
    const message = String(current.message || "").trim();
    if (message) return message;
    const error = current.error;
    if (typeof error === "string" && error.trim()) {
      return error.trim();
    }
    if (error && typeof error === "object") {
      const nested = String(error.message || "").trim();
      if (nested) return nested;
    }
    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }
  return String(fallback || "请求失败");
}

function readRpcData(result, fallback) {
  if (!result || result.data === undefined || result.data === null) {
    return fallback;
  }
  return result.data;
}

function readValueFromPayloadChain(payload, fields, matcher) {
  const keys = Array.isArray(fields) ? fields : [fields];
  const predicate = typeof matcher === "function" ? matcher : () => true;
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") break;
    for (let i = 0; i < keys.length; i += 1) {
      const key = String(keys[i] || "").trim();
      if (!key || !Object.prototype.hasOwnProperty.call(current, key)) continue;
      const value = current[key];
      if (predicate(value)) {
        return value;
      }
    }
    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }
  return undefined;
}

function readArrayFromPayloadChain(payload, fields) {
  const value = readValueFromPayloadChain(payload, fields, (item) => Array.isArray(item));
  return Array.isArray(value) ? value : [];
}

function readNumberFromPayloadChain(payload, fields) {
  const value = readValueFromPayloadChain(payload, fields, (item) => Number.isFinite(Number(item)));
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function readStringFromPayloadChain(payload, fields) {
  const value = readValueFromPayloadChain(
    payload,
    fields,
    (item) => typeof item === "string" && item.trim()
  );
  return typeof value === "string" ? value.trim() : "";
}

function markAdminPageTransientForeground(reason) {
  try {
    const pages = getCurrentPages();
    const currentPage = Array.isArray(pages) && pages.length ? pages[pages.length - 1] : null;
    if (currentPage && typeof currentPage.markTransientForegroundReturn === "function") {
      currentPage.markTransientForegroundReturn(reason);
    }
  } catch (error) {
    // ignore
  }
}

function readRpcRows(result) {
  const payload = readRpcData(result, []);
  if (Array.isArray(payload)) return payload;
  return readArrayFromPayloadChain(payload, ["rows", "list", "items", "data"]);
}

function isRowLikeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (
    Object.prototype.hasOwnProperty.call(value, "id") ||
    Object.prototype.hasOwnProperty.call(value, "url") ||
    Object.prototype.hasOwnProperty.call(value, "name") ||
    Object.prototype.hasOwnProperty.call(value, "album_id")
  );
}

function readRpcRecord(result) {
  const payload = readRpcData(result, null);
  if (!payload) return null;

  if (isRowLikeObject(payload)) {
    return payload;
  }

  if (Array.isArray(payload)) {
    const first = payload.find((item) => isRowLikeObject(item));
    return first || null;
  }

  if (payload && typeof payload === "object") {
    const rows = readArrayFromPayloadChain(payload, ["rows", "list", "items", "data"]);
    const first = rows.find((item) => isRowLikeObject(item));
    if (first) return first;
    const nestedObject = readValueFromPayloadChain(payload, "data", (item) => isRowLikeObject(item));
    if (nestedObject && isRowLikeObject(nestedObject)) {
      return nestedObject;
    }
  }

  return null;
}

function toUniqueNonEmptyStrings(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  values.forEach((item) => {
    const text = String(item || "").trim();
    if (!text) return;
    seen.add(text);
  });
  return Array.from(seen);
}

function normalizeUploadFileName(fileName, fallbackPrefix) {
  const text = String(fileName || "").trim();
  const safeBase = text
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^_+|_+$/g, "");
  if (safeBase) {
    return safeBase.slice(0, 120);
  }
  const fallback = String(fallbackPrefix || "upload").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${fallback}_${Date.now()}`;
}

function buildUploadKey(fileName, fallbackPrefix) {
  const normalizedName = normalizeUploadFileName(fileName, fallbackPrefix);
  const randomSuffix = Math.random().toString(36).slice(2, 10);
  return `${Date.now()}_${randomSuffix}_${normalizedName}`;
}

const ALBUM_THUMBNAIL_MAX_LONG_EDGE = 1280;
const ALBUM_PREVIEW_MAX_LONG_EDGE = 2560;

function pickAlbumThumbnailQuality(sizeBytes) {
  const bytes = Number(sizeBytes || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return 84;
  }
  if (bytes >= 12 * 1024 * 1024) return 76;
  if (bytes >= 8 * 1024 * 1024) return 78;
  if (bytes >= 5 * 1024 * 1024) return 80;
  if (bytes >= 2 * 1024 * 1024) return 82;
  return 84;
}

function pickAlbumPreviewQuality(sizeBytes) {
  const bytes = Number(sizeBytes || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return 95;
  }
  if (bytes >= 12 * 1024 * 1024) return 90;
  if (bytes >= 8 * 1024 * 1024) return 91;
  if (bytes >= 5 * 1024 * 1024) return 92;
  if (bytes >= 2 * 1024 * 1024) return 94;
  return 95;
}

function cleanupLocalTempFile(filePath) {
  const target = String(filePath || "").trim();
  if (!target) return;
  try {
    const fs = typeof wx.getFileSystemManager === "function" ? wx.getFileSystemManager() : null;
    if (!fs || typeof fs.unlink !== "function") return;
    fs.unlink({
      filePath: target,
      fail: () => {},
    });
  } catch (error) {
    // ignore
  }
}

async function buildAlbumThumbnailTempPath(filePath, fileSize) {
  return buildAlbumCompressedTempPath(filePath, {
    quality: pickAlbumThumbnailQuality(fileSize),
    maxLongEdge: ALBUM_THUMBNAIL_MAX_LONG_EDGE,
    label: "缩略图",
  });
}

async function buildAlbumPreviewTempPath(filePath, fileSize) {
  return buildAlbumCompressedTempPath(filePath, {
    quality: pickAlbumPreviewQuality(fileSize),
    maxLongEdge: ALBUM_PREVIEW_MAX_LONG_EDGE,
    label: "高清图",
  });
}

async function readImageInfo(filePath) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({
      src: filePath,
      success: resolve,
      fail: reject,
    });
  });
}

function buildCompressedSize(width, height, maxLongEdge) {
  const w = Number(width || 0);
  const h = Number(height || 0);
  const maxEdge = Number(maxLongEdge || 0);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0 || maxEdge <= 0) {
    return null;
  }
  const longEdge = Math.max(w, h);
  if (longEdge <= maxEdge) {
    return null;
  }
  const scale = maxEdge / longEdge;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

async function compressAlbumImage(filePath, quality, maxLongEdge) {
  const normalizedPath = String(filePath || "").trim();
  if (!normalizedPath) return "";
  const options = {
    src: normalizedPath,
    quality,
  };
  try {
    const info = await readImageInfo(normalizedPath);
    const compressedSize = buildCompressedSize(info && info.width, info && info.height, maxLongEdge);
    if (compressedSize) {
      options.compressedWidth = compressedSize.width;
      options.compressedHeight = compressedSize.height;
    }
  } catch (error) {
    // ignore，读不到尺寸时回退为仅按质量压缩
  }
  try {
    const result = await wx.compressImage(options);
    const compressedPath = String((result && result.tempFilePath) || "").trim();
    if (compressedPath) {
      return compressedPath;
    }
  } catch (error) {
    // 带尺寸参数压缩失败时，回退到仅质量压缩
  }
  const fallback = await wx.compressImage({
    src: normalizedPath,
    quality,
  });
  return String((fallback && fallback.tempFilePath) || "").trim();
}

async function buildAlbumCompressedTempPath(filePath, options) {
  const normalizedPath = String(filePath || "").trim();
  if (!normalizedPath) return "";
  const opts = options && typeof options === "object" ? options : {};
  const quality = Number(opts.quality || 0);
  const maxLongEdge = Number(opts.maxLongEdge || 0);
  const label = String(opts.label || "图片").trim() || "图片";
  const compressedPath = await compressAlbumImage(normalizedPath, quality, maxLongEdge);
  if (!compressedPath) {
    throw new Error(`压缩${label}失败`);
  }
  return compressedPath;
}

function isAlbumFolderForeignKeyError(message) {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("fk_album_photos_folder") ||
    (normalized.includes("foreign key") && normalized.includes("folder")) ||
    (normalized.includes("foreign key constraint fails") && normalized.includes("album_photos"))
  );
}

async function uploadAlbumAsset(filePath, fileName, options) {
  const normalizedPath = String(filePath || "").trim();
  if (!normalizedPath) {
    throw new Error("上传失败：文件路径不能为空");
  }
  const opts = options && typeof options === "object" ? options : {};
  const variant = String(opts.variant || "asset")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");
  const fallbackPrefix = `album_photo_${variant || "asset"}`;
  const finalFileName = normalizeUploadFileName(fileName, fallbackPrefix);
  const key = buildUploadKey(finalFileName, fallbackPrefix);
  const payload = await requestUpload("/api/upload", {
    method: "POST",
    filePath: normalizedPath,
    fileName: finalFileName,
    name: "file",
    formData: {
      folder: "albums",
      key,
    },
  });
  const body = payload && typeof payload === "object" ? payload : {};
  if (hasExplicitPayloadFailure(body)) {
    throw new Error(readPayloadErrorMessage(body, "上传失败"));
  }

  const url = readStringFromPayloadChain(body, "url");
  const cloudPath = readStringFromPayloadChain(body, "path");
  const fileId = readStringFromPayloadChain(body, "fileId");
  if (!url || !cloudPath) {
    throw new Error("上传失败：后端未返回有效文件地址");
  }

  return {
    url,
    path: cloudPath,
    fileId,
  };
}

async function uploadAlbumPhotoVariants(filePath, fileName, fileSize) {
  const normalizedPath = String(filePath || "").trim();
  if (!normalizedPath) {
    throw new Error("上传失败：文件路径不能为空");
  }

  const cleanupTargets = [];
  let thumbnailTempPath = "";
  let previewTempPath = "";
  try {
    thumbnailTempPath = await buildAlbumThumbnailTempPath(normalizedPath, fileSize);
    previewTempPath = await buildAlbumPreviewTempPath(normalizedPath, fileSize);
    const thumbnailUpload = await uploadAlbumAsset(thumbnailTempPath, fileName, {
      variant: "thumb",
    });
    cleanupTargets.push(thumbnailUpload.path, thumbnailUpload.url, thumbnailUpload.fileId);

    const previewUpload = await uploadAlbumAsset(previewTempPath, fileName, {
      variant: "preview",
    });
    cleanupTargets.push(previewUpload.path, previewUpload.url, previewUpload.fileId);

    return {
      url: previewUpload.url,
      thumbnail_url: thumbnailUpload.url,
      preview_url: previewUpload.url,
      original_url: previewUpload.url,
      cleanupTargets: toUniqueNonEmptyStrings(cleanupTargets),
    };
  } catch (error) {
    await cleanupStorageTargets(cleanupTargets);
    throw error;
  } finally {
    if (thumbnailTempPath && thumbnailTempPath !== normalizedPath) {
      cleanupLocalTempFile(thumbnailTempPath);
    }
    if (previewTempPath && previewTempPath !== normalizedPath) {
      cleanupLocalTempFile(previewTempPath);
    }
  }
}

async function cleanupStorageTargets(targets) {
  const keys = toUniqueNonEmptyStrings(targets);
  if (!keys.length) {
    return { ok: true, warning: "" };
  }
  try {
    const payload = await requestJson("/api/batch-delete", {
      method: "DELETE",
      data: { keys },
    });
    const body = payload && typeof payload === "object" ? payload : {};
    if (hasExplicitPayloadFailure(body)) {
      return {
        ok: false,
        warning: readPayloadErrorMessage(body, "清理云存储文件失败"),
      };
    }
    return { ok: true, warning: "" };
  } catch (error) {
    console.error("清理云存储文件失败:", error);
    return {
      ok: false,
      warning: readErrorMessage(error, "清理云存储文件失败"),
    };
  }
}

function normalizePhotoRecord(row) {
  const item = row && typeof row === "object" ? row : {};
  const rawUrl = String(item.url || "").trim();
  const rawThumb = String(item.thumbnail_url || "").trim();
  const rawPreview = String(item.preview_url || "").trim();
  const rawOriginal = String(item.original_url || "").trim();

  const thumbnailResolved = resolvePublicUrl(rawThumb || rawPreview || rawUrl || rawOriginal);
  const previewResolved = resolvePublicUrl(rawPreview || rawOriginal || rawUrl || rawThumb);
  const originalResolved = resolvePublicUrl(rawOriginal || rawPreview || rawUrl || rawThumb);
  const urlResolved = resolvePublicUrl(rawUrl || rawPreview || rawOriginal || rawThumb);
  const storyText = normalizeStoryText(item.story_text);
  const hasStory = Boolean(storyText);
  const isHighlight = Boolean(item.is_highlight);
  const shotDate = normalizeShotDate(item.shot_date);
  const shotLocation = normalizeShotLocation(item.shot_location);
  const isPublic = normalizeDbBoolean(item.is_public, true);
  const viewCount = Number(item.view_count || 0);
  const likeCount = Number(item.like_count || 0);
  const sortRaw = Number(item.sort_order);
  const sortOrder = Number.isFinite(sortRaw) && sortRaw > 0 ? Math.round(sortRaw) : DEFAULT_SORT_ORDER;

  return Object.assign({}, item, {
    url: urlResolved,
    thumbnail_url: thumbnailResolved,
    preview_url: previewResolved,
    original_url: originalResolved,
    story_text: storyText,
    has_story: hasStory,
    is_highlight: isHighlight,
    shot_date: shotDate,
    shot_location: shotLocation,
    story_highlight: hasStory || isHighlight,
    is_public: isPublic,
    view_count: Number.isFinite(viewCount) ? Math.max(0, Math.round(viewCount)) : 0,
    like_count: Number.isFinite(likeCount) ? Math.max(0, Math.round(likeCount)) : 0,
    sort_order: sortOrder,
  });
}

function formatFileSize(size) {
  const bytes = Number(size || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "未知大小";
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  }
  return `${bytes} B`;
}

function formatPhotoDateWithYear(value) {
  const raw = String(value || "").trim();
  if (!raw) return "----/--/--";

  const dateMatch = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (dateMatch) {
    return `${dateMatch[1]}/${dateMatch[2]}/${dateMatch[3]}`;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return "----/--/--";
  }

  const year = String(parsed.getFullYear()).padStart(4, "0");
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

const pageDefinition = {
  data: {
    safeTop: 0,
    contentTopPx: 12,
    albumId: "",
    album: null,
    isSystemAlbum: false,
    folders: [],
    photos: [],
    loading: true,
    selectedFolder: null,
    selectedFolderName: "根目录",
    selectedFolderCanMoveTop: false,
    selectedFolderCanMoveUp: false,
    selectedFolderCanMoveDown: false,
    folderSortOrderAvailable: true,
    rootFolderName: "根目录",
    rootPhotoCount: 0,

    // 分页
    currentPage: 1,
    photosPerPage: 10,
    totalCount: 0,
    totalPages: 1,
    loadingMore: false,
    hasMore: true,

    // 过滤后的照片
    filteredPhotos: [],

    // 新建文件夹
    showNewFolderModal: false,
    newFolderName: "",

    // 修改根目录名称
    showEditRootModal: false,
    newRootFolderName: "",
    showEditFolderModal: false,
    editingFolderId: "",
    editingFolderName: "",

    // 上传照片
    showUploadModal: false,
    uploadMode: "batch",
    singleImage: null,
    singleStoryText: "",
    singleHighlight: false,
    singleShotDate: getTodayDateUTC8(),
    singleShotLocation: "",
    batchShotDate: getTodayDateUTC8(),
    batchShotLocation: "",
    batchImages: [],
    uploading: false,
    uploadProgress: { current: 0, total: 0 },

    // 关于此刻编辑
    showStoryModal: false,
    editingStoryPhotoId: "",
    editingStoryText: "",
    editingStoryHighlight: false,
    showShotDateModal: false,
    editingShotDatePhotoId: "",
    editingShotDateValue: getTodayDateUTC8(),
    editingShotLocationValue: "",

    // 批量选择
    isSelectionMode: false,
    selectedPhotoIds: [],

    // 迁移照片
    showMoveModal: false,
    movingPhotoIds: [],
    moveTargetFolder: ROOT_FOLDER_SENTINEL,

    // 删除确认
    deletingFolder: null,
    deletingPhoto: null,
    showBatchDeleteConfirm: false,

    // 预览
    previewPhoto: null,

    // Toast
    showToast: false,
    toastMessage: "",
    toastType: "success",

    // 操作加载状态
    actionLoading: false
  },

  onLoad(options) {
    const app = getApp();
    const globalData = app && app.globalData ? app.globalData : {};
    const safeTop = Number(globalData.statusBarHeight || 0);
    let contentTopPx = safeTop + 12;
    try {
      const menuRect = wx.getMenuButtonBoundingClientRect();
      const menuBottom = Number(menuRect && menuRect.bottom ? menuRect.bottom : 0);
      if (menuBottom > 0) {
        contentTopPx = Math.max(contentTopPx, menuBottom + 10);
      }
    } catch (error) {
      // ignore capsule rect error
    }

    const albumId = String((options && options.id) || "").trim();
    const titleRaw = String((options && options.title) || "").trim();
    const accessKey = String((options && options.key) || "").trim();
    let fallbackTitle = titleRaw;
    try {
      fallbackTitle = titleRaw ? decodeURIComponent(titleRaw) : "";
    } catch (error) {
      fallbackTitle = titleRaw;
    }

    if (!albumId) {
      wx.showToast({ title: "缺少空间ID", icon: "none" });
      setTimeout(() => {
        wx.navigateBack();
      }, 300);
      return;
    }

    const isSystemAlbum =
      albumId === SYSTEM_GALLERY_ALBUM_ID || accessKey.toUpperCase() === "PUBLIC_GALLERY";
    const initialAlbum =
      fallbackTitle || accessKey || isSystemAlbum
        ? {
            title: isSystemAlbum ? "照片墙管理" : (fallbackTitle || "未命名空间"),
            access_key: isSystemAlbum ? "" : accessKey,
          }
        : null;

    this.setData({ albumId, safeTop, contentTopPx, album: initialAlbum, isSystemAlbum });
    this.loadAlbumData();
  },

  async loadAlbumData() {
    this.setData({ loading: true });

    try {
      // 加载相册信息
      const albumResult = await dbQuery({
        table: "albums",
        action: "select",
        columns: "id,title,access_key,root_folder_name",
        filters: [{ column: "id", operator: "eq", value: this.data.albumId }],
        maybeSingle: true,
      });
      if (!hasRpcError(albumResult)) {
        const albumPayload = readRpcData(albumResult, null);
        const albumFromChain = readValueFromPayloadChain(
          albumPayload,
          "album",
          (value) => value && typeof value === "object" && !Array.isArray(value)
        );
        const album = albumFromChain || albumPayload;
        if (album && typeof album === "object") {
          const isSystemAlbum =
            this.data.isSystemAlbum || String(album.id || "") === SYSTEM_GALLERY_ALBUM_ID;
          const normalizedAlbum = Object.assign({}, album, {
            title: isSystemAlbum ? "照片墙管理" : (String(album.title || "").trim() || "未命名空间"),
            access_key: isSystemAlbum ? "" : String(album.access_key || "").trim(),
          });
          setCachedAlbumRootName(
            album.access_key,
            String(album.root_folder_name || "").trim() || "根目录"
          );
          this.setData({
            album: normalizedAlbum,
            isSystemAlbum,
            rootFolderName: album.root_folder_name || "根目录"
          });
        }
      } else {
        console.error("加载空间信息失败:", readRpcError(albumResult, "获取空间信息失败"));
      }

      // 加载文件夹列表
      const foldersLoaded = await this.loadFolders({ silent: true });

      // 加载图片列表
      const photosLoaded = await this.loadPhotos({ silent: true });
      if (!foldersLoaded || !photosLoaded) {
        throw new Error("加载失败，请稍后重试");
      }

    } catch (error) {
      console.error("加载数据失败:", error);
      this.showToastMessage(readErrorMessage(error, "加载失败"), "error");
    } finally {
      this.setData({ loading: false });
    }
  },

  async loadFolders(options) {
    const silent = Boolean(options && options.silent);
    try {
      let result = await dbQuery({
        table: "album_folders",
        action: "select",
        columns: "id,album_id,name,sort_order,created_at",
        filters: [{ column: "album_id", operator: "eq", value: this.data.albumId }],
        orders: [
          { column: "sort_order", ascending: true },
          { column: "created_at", ascending: true },
        ],
      });
      let folderSortOrderAvailable = true;
      const folderSortReadError = readRpcError(result, "获取文件夹失败");

      if (hasRpcError(result) && isColumnUnavailableError(folderSortReadError, "sort_order", "album_folders")) {
        folderSortOrderAvailable = false;
        result = await dbQuery({
          table: "album_folders",
          action: "select",
          columns: "id,album_id,name,created_at",
          filters: [{ column: "album_id", operator: "eq", value: this.data.albumId }],
          orders: [{ column: "created_at", ascending: true }],
        });
      }

      if (!hasRpcError(result)) {
        const folderData = readRpcData(result, []);
        const folderRows = Array.isArray(folderData)
          ? folderData
          : readArrayFromPayloadChain(folderData, ["folders", "rows", "list", "items", "data"]);
        const previousFolders = Array.isArray(this.data.folders) ? this.data.folders : [];
        const previousCountMap = new Map(
          previousFolders.map((folder) => [String(folder.id), Number(folder.photoCount || 0)])
        );
        const folders = sortAlbumFolders(folderRows.map(folder => ({
          ...folder,
          sort_order: normalizeFolderSortOrder(folder && folder.sort_order),
          photoCount: previousCountMap.get(String(folder.id)) || 0
        })));
        const nextSelectedFolder =
          this.data.selectedFolder &&
          !folders.some((folder) => String(folder.id) === String(this.data.selectedFolder))
            ? null
            : this.data.selectedFolder;
        const nextSelectedFolderName =
          nextSelectedFolder === null
            ? this.data.rootFolderName || "根目录"
            : (
                folders.find((folder) => String(folder.id) === String(nextSelectedFolder)) || {}
              ).name || "";
        this.setData({
          folders,
          selectedFolder: nextSelectedFolder,
          selectedFolderName: String(nextSelectedFolderName || ""),
          folderSortOrderAvailable,
          ...this.resolveSelectedFolderMoveState(nextSelectedFolder, folders, { folderSortOrderAvailable }),
        }, () => {
          void this.updateFolderPhotoCounts();
        });
        return true;
      } else {
        const message = readRpcError(result, "获取文件夹失败");
        console.error("加载文件夹失败:", message);
        if (!silent) {
          this.showToastMessage(`文件夹刷新失败：${message}`, "warning");
        }
        return false;
      }
    } catch (error) {
      console.error("加载文件夹失败:", error);
      if (!silent) {
        this.showToastMessage(`文件夹刷新失败：${readErrorMessage(error, "请稍后重试")}`, "warning");
      }
      return false;
    }
  },

  async loadPhotos(options) {
    const silent = Boolean(options && options.silent);
    const append = Boolean(options && options.append);
    if (append) {
      if (this.data.loading || this.data.loadingMore || this.data.actionLoading || !this.data.hasMore) {
        return false;
      }
      this.setData({ loadingMore: true });
    }
    try {
      const photosPerPage = Math.max(1, Number(this.data.photosPerPage || 10));
      const buildPhotoFilters = () => {
        const filters = [{ column: "album_id", operator: "eq", value: this.data.albumId }];
        const selectedFolder = this.data.selectedFolder;
        if (selectedFolder === null || selectedFolder === undefined || String(selectedFolder).trim() === "") {
          filters.push({ column: "folder_id", operator: "eq", value: null });
        } else {
          filters.push({ column: "folder_id", operator: "eq", value: String(selectedFolder) });
        }
        return filters;
      };
      const useTimeDescOrders = Boolean(this.data.isSystemAlbum);
      const timeDescOrders = [{ column: "created_at", ascending: false }, { column: "shot_date", ascending: false }];
      const primaryOrders = useTimeDescOrders
        ? timeDescOrders
        : [
            { column: "sort_order", ascending: true },
            { column: "shot_date", ascending: false },
            { column: "created_at", ascending: false },
          ];
      const ordersWithoutSort = useTimeDescOrders
        ? timeDescOrders
        : [{ column: "shot_date", ascending: false }, { column: "created_at", ascending: false }];
      const ordersWithoutShotDate = [{ column: "created_at", ascending: false }];
      const fullColumns =
        "id,album_id,folder_id,url,thumbnail_url,preview_url,original_url,width,height,story_text,is_highlight,sort_order,shot_date,shot_location,is_public,view_count,like_count,created_at";
      const columnsWithoutSort =
        "id,album_id,folder_id,url,thumbnail_url,preview_url,original_url,width,height,story_text,is_highlight,shot_date,shot_location,is_public,view_count,like_count,created_at";
      const columnsWithoutStory =
        "id,album_id,folder_id,url,thumbnail_url,preview_url,original_url,width,height,sort_order,shot_date,shot_location,is_public,view_count,like_count,created_at";
      const columnsWithoutShotLocation =
        "id,album_id,folder_id,url,thumbnail_url,preview_url,original_url,width,height,story_text,is_highlight,sort_order,shot_date,is_public,view_count,like_count,created_at";
      const columnsWithoutShotDate =
        "id,album_id,folder_id,url,thumbnail_url,preview_url,original_url,width,height,story_text,is_highlight,sort_order,shot_location,is_public,view_count,like_count,created_at";
      const columnsWithoutShotMeta =
        "id,album_id,folder_id,url,thumbnail_url,preview_url,original_url,width,height,story_text,is_highlight,sort_order,is_public,view_count,like_count,created_at";
      const columnsWithoutSortOrLocation =
        "id,album_id,folder_id,url,thumbnail_url,preview_url,original_url,width,height,story_text,is_highlight,shot_date,is_public,view_count,like_count,created_at";
      const columnsWithoutSortShotDate =
        "id,album_id,folder_id,url,thumbnail_url,preview_url,original_url,width,height,story_text,is_highlight,shot_location,is_public,view_count,like_count,created_at";
      const columnsWithoutSortShotMeta =
        "id,album_id,folder_id,url,thumbnail_url,preview_url,original_url,width,height,story_text,is_highlight,is_public,view_count,like_count,created_at";
      const minimalColumns =
        "id,album_id,folder_id,url,thumbnail_url,preview_url,original_url,width,height,is_public,view_count,like_count,created_at";
      const fullColumnsWithoutLegacyUrl =
        "id,album_id,folder_id,thumbnail_url,preview_url,original_url,width,height,story_text,is_highlight,sort_order,shot_date,shot_location,is_public,view_count,like_count,created_at";
      const columnsWithoutSortWithoutLegacyUrl =
        "id,album_id,folder_id,thumbnail_url,preview_url,original_url,width,height,story_text,is_highlight,shot_date,shot_location,is_public,view_count,like_count,created_at";
      const columnsWithoutStoryWithoutLegacyUrl =
        "id,album_id,folder_id,thumbnail_url,preview_url,original_url,width,height,sort_order,shot_date,shot_location,is_public,view_count,like_count,created_at";
      const columnsWithoutShotLocationWithoutLegacyUrl =
        "id,album_id,folder_id,thumbnail_url,preview_url,original_url,width,height,story_text,is_highlight,sort_order,shot_date,is_public,view_count,like_count,created_at";
      const columnsWithoutShotDateWithoutLegacyUrl =
        "id,album_id,folder_id,thumbnail_url,preview_url,original_url,width,height,story_text,is_highlight,sort_order,shot_location,is_public,view_count,like_count,created_at";
      const columnsWithoutShotMetaWithoutLegacyUrl =
        "id,album_id,folder_id,thumbnail_url,preview_url,original_url,width,height,story_text,is_highlight,sort_order,is_public,view_count,like_count,created_at";
      const columnsWithoutSortOrLocationWithoutLegacyUrl =
        "id,album_id,folder_id,thumbnail_url,preview_url,original_url,width,height,story_text,is_highlight,shot_date,is_public,view_count,like_count,created_at";
      const columnsWithoutSortShotDateWithoutLegacyUrl =
        "id,album_id,folder_id,thumbnail_url,preview_url,original_url,width,height,story_text,is_highlight,shot_location,is_public,view_count,like_count,created_at";
      const columnsWithoutSortShotMetaWithoutLegacyUrl =
        "id,album_id,folder_id,thumbnail_url,preview_url,original_url,width,height,story_text,is_highlight,is_public,view_count,like_count,created_at";
      const minimalColumnsWithoutLegacyUrl =
        "id,album_id,folder_id,thumbnail_url,preview_url,original_url,width,height,is_public,view_count,like_count,created_at";

      const queryPhotoPage = async (pageNo) => {
        const safePageNo = Math.max(1, Number(pageNo || 1));
        const offset = (safePageNo - 1) * photosPerPage;
        const photoFilters = buildPhotoFilters();
        const legacyColumnSet = {
          full: fullColumns,
          withoutSort: columnsWithoutSort,
          withoutStory: columnsWithoutStory,
          withoutShotLocation: columnsWithoutShotLocation,
          withoutShotDate: columnsWithoutShotDate,
          withoutShotMeta: columnsWithoutShotMeta,
          withoutSortOrLocation: columnsWithoutSortOrLocation,
          withoutSortShotDate: columnsWithoutSortShotDate,
          withoutSortShotMeta: columnsWithoutSortShotMeta,
          minimal: minimalColumns,
        };
        const fallbackColumnSet = {
          full: fullColumnsWithoutLegacyUrl,
          withoutSort: columnsWithoutSortWithoutLegacyUrl,
          withoutStory: columnsWithoutStoryWithoutLegacyUrl,
          withoutShotLocation: columnsWithoutShotLocationWithoutLegacyUrl,
          withoutShotDate: columnsWithoutShotDateWithoutLegacyUrl,
          withoutShotMeta: columnsWithoutShotMetaWithoutLegacyUrl,
          withoutSortOrLocation: columnsWithoutSortOrLocationWithoutLegacyUrl,
          withoutSortShotDate: columnsWithoutSortShotDateWithoutLegacyUrl,
          withoutSortShotMeta: columnsWithoutSortShotMetaWithoutLegacyUrl,
          minimal: minimalColumnsWithoutLegacyUrl,
        };
        let activeColumnSet = legacyColumnSet;

        let result = await dbQuery({
          table: "album_photos",
          action: "select",
          columns: activeColumnSet.full,
          filters: photoFilters,
          orders: primaryOrders,
          range: {
            from: offset,
            to: offset + photosPerPage - 1,
          },
          count: "exact",
        });

        if (hasRpcError(result) && isColumnMissingError(readRpcError(result, "鑾峰彇鐓х墖澶辫触"), "url")) {
          activeColumnSet = fallbackColumnSet;
          result = await dbQuery({
            table: "album_photos",
            action: "select",
            columns: activeColumnSet.full,
            filters: photoFilters,
            orders: primaryOrders,
            range: {
              from: offset,
              to: offset + photosPerPage - 1,
            },
            count: "exact",
          });
        }

        if (hasRpcError(result) && isColumnUnavailableError(readRpcError(result, "获取照片失败"), "sort_order", "album_photos")) {
          result = await dbQuery({
            table: "album_photos",
            action: "select",
            columns: activeColumnSet.withoutSort,
            filters: photoFilters,
            orders: ordersWithoutSort,
            range: {
              from: offset,
              to: offset + photosPerPage - 1,
            },
            count: "exact",
          });
        }

        if (
          hasRpcError(result) &&
          (
            isColumnMissingError(readRpcError(result, "获取照片失败"), "story_text") ||
            isColumnMissingError(readRpcError(result, "获取照片失败"), "is_highlight")
          )
        ) {
          result = await dbQuery({
            table: "album_photos",
            action: "select",
            columns: activeColumnSet.withoutStory,
            filters: photoFilters,
            orders: ordersWithoutSort,
            range: {
              from: offset,
              to: offset + photosPerPage - 1,
            },
            count: "exact",
          });
        }

        if (hasRpcError(result) && isColumnMissingError(readRpcError(result, "获取照片失败"), "shot_location")) {
          result = await dbQuery({
            table: "album_photos",
            action: "select",
            columns: activeColumnSet.withoutShotLocation,
            filters: photoFilters,
            orders: useTimeDescOrders ? ordersWithoutSort : primaryOrders,
            range: {
              from: offset,
              to: offset + photosPerPage - 1,
            },
            count: "exact",
          });
          if (hasRpcError(result) && isColumnUnavailableError(readRpcError(result, "获取照片失败"), "sort_order", "album_photos")) {
            result = await dbQuery({
              table: "album_photos",
              action: "select",
              columns: activeColumnSet.withoutSortOrLocation,
              filters: photoFilters,
              orders: ordersWithoutSort,
              range: {
                from: offset,
                to: offset + photosPerPage - 1,
              },
              count: "exact",
            });
          }
        }

        if (hasRpcError(result) && isColumnMissingError(readRpcError(result, "获取照片失败"), "shot_date")) {
          result = await dbQuery({
            table: "album_photos",
            action: "select",
            columns: activeColumnSet.withoutShotDate,
            filters: photoFilters,
            orders: ordersWithoutShotDate,
            range: {
              from: offset,
              to: offset + photosPerPage - 1,
            },
            count: "exact",
          });
          if (hasRpcError(result) && isColumnUnavailableError(readRpcError(result, "获取照片失败"), "sort_order", "album_photos")) {
            result = await dbQuery({
              table: "album_photos",
              action: "select",
              columns: activeColumnSet.withoutSortShotDate,
              filters: photoFilters,
              orders: ordersWithoutShotDate,
              range: {
                from: offset,
                to: offset + photosPerPage - 1,
              },
              count: "exact",
            });
          }
        }

        if (
          hasRpcError(result) &&
          (
            isColumnMissingError(readRpcError(result, "获取照片失败"), "shot_date") ||
            isColumnMissingError(readRpcError(result, "获取照片失败"), "shot_location")
          )
        ) {
          result = await dbQuery({
            table: "album_photos",
            action: "select",
            columns: activeColumnSet.withoutShotMeta,
            filters: photoFilters,
            orders: ordersWithoutShotDate,
            range: {
              from: offset,
              to: offset + photosPerPage - 1,
            },
            count: "exact",
          });
          if (hasRpcError(result) && isColumnUnavailableError(readRpcError(result, "获取照片失败"), "sort_order", "album_photos")) {
            result = await dbQuery({
              table: "album_photos",
              action: "select",
              columns: activeColumnSet.withoutSortShotMeta,
              filters: photoFilters,
              orders: ordersWithoutShotDate,
              range: {
                from: offset,
                to: offset + photosPerPage - 1,
              },
              count: "exact",
            });
          }
          if (hasRpcError(result)) {
            result = await dbQuery({
              table: "album_photos",
              action: "select",
              columns: activeColumnSet.minimal,
              filters: photoFilters,
              orders: [{ column: "created_at", ascending: false }],
              range: {
                from: offset,
                to: offset + photosPerPage - 1,
              },
              count: "exact",
            });
          }
        }

        if (hasRpcError(result)) {
          throw new Error(readRpcError(result, "获取照片失败"));
        }

        const payload = readRpcData(result, []);
        let photos = [];
        let totalCount = 0;

        if (Array.isArray(payload)) {
          photos = payload;
          totalCount = Number(result && (result.total || result.count || 0)) || payload.length;
        } else if (payload && typeof payload === "object") {
          photos = readArrayFromPayloadChain(payload, ["photos", "rows", "list", "items", "data"]);
          totalCount =
            readNumberFromPayloadChain(payload, ["total", "count", "totalCount"]) ||
            Number(result && (result.total || result.count || 0)) ||
            photos.length;
        }

        const safeTotalCount = Math.max(Number(totalCount || result.count || 0), 0);
        const totalPages = Math.max(1, Math.ceil(safeTotalCount / photosPerPage));
        photos = (Array.isArray(photos) ? photos : []).map((row) => normalizePhotoRecord(row));

        return { photos, totalCount: safeTotalCount, totalPages };
      };

      const mergeLoadedPhotos = (baseRows, nextRows) => {
        const seen = new Set();
        return (Array.isArray(baseRows) ? baseRows : [])
          .concat(Array.isArray(nextRows) ? nextRows : [])
          .filter((item) => {
            const id = String(item && item.id ? item.id : "").trim();
            if (!id || seen.has(id)) return false;
            seen.add(id);
            return true;
          });
      };

      const currentPage = Math.max(1, Number(this.data.currentPage || 1));
      if (append) {
        const nextPage = currentPage + 1;
        const pageResult = await queryPhotoPage(nextPage);
        if (pageResult.totalPages < nextPage) {
          if (currentPage > pageResult.totalPages) {
            this.setData({ currentPage: pageResult.totalPages, loadingMore: false });
            return this.loadPhotos({ silent });
          }
          this.setData({
            totalCount: pageResult.totalCount,
            totalPages: pageResult.totalPages,
            hasMore: currentPage < pageResult.totalPages,
            loadingMore: false,
          });
          return false;
        }

        const photos = mergeLoadedPhotos(this.data.photos, pageResult.photos);
        this.setData({
          photos,
          currentPage: nextPage,
          totalCount: pageResult.totalCount,
          totalPages: pageResult.totalPages,
          hasMore: nextPage < pageResult.totalPages,
          loadingMore: false,
        }, () => {
          this.updateFilteredPhotos();
          void this.updateFolderPhotoCounts();
        });
        return true;
      }

      const firstPageResult = await queryPhotoPage(1);
      const loadedPage = Math.min(currentPage, firstPageResult.totalPages);
      let photos = firstPageResult.photos;
      let totalCount = firstPageResult.totalCount;
      let totalPages = firstPageResult.totalPages;

      for (let pageNo = 2; pageNo <= loadedPage; pageNo += 1) {
        const pageResult = await queryPhotoPage(pageNo);
        photos = photos.concat(pageResult.photos);
        totalCount = pageResult.totalCount;
        totalPages = pageResult.totalPages;
      }

      this.setData({
        photos,
        currentPage: loadedPage,
        totalCount,
        totalPages,
        hasMore: loadedPage < totalPages,
        loadingMore: false,
      }, () => {
        this.updateFilteredPhotos();
        void this.updateFolderPhotoCounts();
      });
      return true;
    } catch (error) {
      console.error("加载照片失败:", error);
      if (!silent) {
        const message = readErrorMessage(error, "加载失败");
        if (isColumnMissingError(message, "shot_location")) {
          this.showToastMessage(ALBUM_PHOTO_SHOT_LOCATION_MIGRATION_HINT, "warning");
        } else {
          this.showToastMessage(`照片加载失败：${message}`, "warning");
        }
      }
      return false;
    } finally {
      if (this.data.loadingMore) {
        this.setData({ loadingMore: false });
      }
    }
  },

  loadMorePhotos() {
    return this.loadPhotos({ append: true });
  },

  updateFilteredPhotos() {
    const { photos, selectedFolder, isSystemAlbum } = this.data;
    const selectedSet = new Set((Array.isArray(this.data.selectedPhotoIds) ? this.data.selectedPhotoIds : []).map(id => String(id)));

    let filteredPhotos = selectedFolder
      ? photos.filter(p => String(p.folder_id || "") === String(selectedFolder))
      : photos.filter(p => !p.folder_id);

    filteredPhotos = filteredPhotos.slice().sort((a, b) => {
      if (isSystemAlbum) {
        const createdCompare = String((b && b.created_at) || "").localeCompare(
          String((a && a.created_at) || ""),
          "zh-CN"
        );
        if (createdCompare !== 0) return createdCompare;
        const shotA = normalizeShotDate(a && a.shot_date) || "";
        const shotB = normalizeShotDate(b && b.shot_date) || "";
        if (shotA !== shotB) return shotB.localeCompare(shotA, "zh-CN");
        return 0;
      }
      const sortA = Number(a && a.sort_order);
      const sortB = Number(b && b.sort_order);
      const normalizedA = Number.isFinite(sortA) && sortA > 0 ? Math.round(sortA) : DEFAULT_SORT_ORDER;
      const normalizedB = Number.isFinite(sortB) && sortB > 0 ? Math.round(sortB) : DEFAULT_SORT_ORDER;
      if (normalizedA !== normalizedB) return normalizedA - normalizedB;
      const shotA = normalizeShotDate(a && a.shot_date) || "";
      const shotB = normalizeShotDate(b && b.shot_date) || "";
      if (shotA !== shotB) return shotB.localeCompare(shotA, "zh-CN");
      return String((b && b.created_at) || "").localeCompare(String((a && a.created_at) || ""), "zh-CN");
    });

    filteredPhotos = filteredPhotos.map(photo => {
      const dateText = formatPhotoDateWithYear(photo.shot_date || photo.created_at);
      const shotLocationText = normalizeShotLocation(photo.shot_location);
      const viewCount = Number((photo && photo.view_count) || 0);
      const likeCount = Number((photo && photo.like_count) || 0);
      const safeViewCount = Number.isFinite(viewCount) ? Math.max(0, Math.round(viewCount)) : 0;
      const safeLikeCount = Number.isFinite(likeCount) ? Math.max(0, Math.round(likeCount)) : 0;
      const isPublic = normalizeDbBoolean(photo && photo.is_public, true);

      return {
        ...photo,
        dateText,
        shotLocationText,
        viewCount: safeViewCount,
        likeCount: safeLikeCount,
        isPublic,
        visibilityText: isPublic ? "公开" : "已隐藏",
        visibilityClass: isPublic ? "photo-card__visibility--public" : "photo-card__visibility--hidden",
        selected: selectedSet.has(String(photo.id)),
        has_story: Boolean(photo.has_story),
        story_highlight: Boolean(photo.story_highlight),
      };
    });

    this.setData({
      filteredPhotos,
      ...this.resolveSelectedFolderMoveState(selectedFolder, this.data.folders),
    });
  },

  resolveSelectedFolderMoveState(folderId, folders, options) {
    const canMove =
      options && Object.prototype.hasOwnProperty.call(options, "folderSortOrderAvailable")
        ? Boolean(options.folderSortOrderAvailable)
        : this.data.folderSortOrderAvailable !== false;
    if (!canMove) {
      return {
        selectedFolderCanMoveTop: false,
        selectedFolderCanMoveUp: false,
        selectedFolderCanMoveDown: false,
      };
    }
    const normalizedFolderId = String(folderId == null ? "" : folderId).trim();
    if (!normalizedFolderId) {
      return {
        selectedFolderCanMoveTop: false,
        selectedFolderCanMoveUp: false,
        selectedFolderCanMoveDown: false,
      };
    }
    const list = sortAlbumFolders(Array.isArray(folders) ? folders : []);
    const currentIndex = list.findIndex((item) => String(item && item.id) === normalizedFolderId);
    if (currentIndex < 0) {
      return {
        selectedFolderCanMoveTop: false,
        selectedFolderCanMoveUp: false,
        selectedFolderCanMoveDown: false,
      };
    }
    return {
      selectedFolderCanMoveTop: currentIndex > 0,
      selectedFolderCanMoveUp: currentIndex > 0,
      selectedFolderCanMoveDown: currentIndex < list.length - 1,
    };
  },

  async updateFolderPhotoCounts() {
    try {
      const rows = [];
      const pageSize = 500;
      let offset = 0;
      while (true) {
        const result = await dbQuery({
          table: "album_photos",
          action: "select",
          columns: "id,folder_id",
          filters: [{ column: "album_id", operator: "eq", value: this.data.albumId }],
          orders: [{ column: "created_at", ascending: true }, { column: "id", ascending: true }],
          range: {
            from: offset,
            to: offset + pageSize - 1,
          },
        });
        if (hasRpcError(result)) {
          console.error("加载文件夹照片统计失败:", readRpcError(result, "获取照片统计失败"));
          return;
        }

        const payload = readRpcData(result, []);
        const batchRows = Array.isArray(payload)
          ? payload
          : readArrayFromPayloadChain(payload, ["rows", "list", "items", "data"]);
        if (!Array.isArray(batchRows) || batchRows.length <= 0) {
          break;
        }
        rows.push(...batchRows);
        if (batchRows.length < pageSize) {
          break;
        }
        offset += pageSize;
      }

      const folderCountMap = new Map();
      let rootPhotoCount = 0;
      rows.forEach((photo) => {
        const folderIdRaw = photo && Object.prototype.hasOwnProperty.call(photo, "folder_id") ? photo.folder_id : null;
        if (folderIdRaw === null || folderIdRaw === undefined || String(folderIdRaw).trim() === "") {
          rootPhotoCount += 1;
          return;
        }
        const folderId = String(folderIdRaw);
        folderCountMap.set(folderId, Number(folderCountMap.get(folderId) || 0) + 1);
      });

      const folders = Array.isArray(this.data.folders) ? this.data.folders : [];
      const updatedFolders = folders.map((folder) => ({
        ...folder,
        photoCount: Number(folderCountMap.get(String(folder.id)) || 0),
      }));

      this.setData({
        rootPhotoCount,
        folders: updatedFolders,
      });
    } catch (error) {
      console.error("加载文件夹照片统计失败:", error);
    }
  },

  // 返回
  onBack() {
    wx.navigateBack();
  },

  // 选择文件夹
  onSelectFolder(e) {
    const rawFolderId = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.folderId : "";
    const folderId =
      rawFolderId === ROOT_FOLDER_SENTINEL ||
      rawFolderId === null ||
      rawFolderId === undefined ||
      rawFolderId === "" ||
      rawFolderId === "null"
        ? null
        : String(rawFolderId);
    const selectedFolderName =
      folderId === null
        ? this.data.rootFolderName || "根目录"
        : (
            (Array.isArray(this.data.folders) ? this.data.folders : []).find(
              (folder) => String(folder.id) === String(folderId)
            ) || {}
          ).name || "";
    this.setData({
      selectedFolder: folderId,
      selectedFolderName: String(selectedFolderName || ""),
      ...this.resolveSelectedFolderMoveState(folderId, this.data.folders),
      currentPage: 1,
      isSelectionMode: false,
      selectedPhotoIds: []
    });
    this.loadPhotos();
  },

  // 新建文件夹
  onShowNewFolderModal() {
    this.setData({
      showNewFolderModal: true,
      newFolderName: ""
    });
  },

  onCloseNewFolderModal() {
    this.setData({ showNewFolderModal: false });
  },

  onNewFolderNameInput(e) {
    this.setData({ newFolderName: e.detail.value });
  },

  async onCreateFolder() {
    const { newFolderName, albumId } = this.data;

    if (!newFolderName.trim()) {
      this.showToastMessage("请输入文件夹名称", "warning");
      return;
    }

    this.setData({ actionLoading: true });

    try {
      const result = await dbQuery({
        table: "album_folders",
        action: "insert",
        values: {
          album_id: albumId,
          name: newFolderName.trim(),
        },
        selectAfterWrite: true,
        maybeSingle: true,
        columns: "id,album_id,name,created_at",
      });

      if (!hasRpcError(result) && readRpcData(result, null)) {
        this.showToastMessage("文件夹创建成功", "success");
        this.setData({ showNewFolderModal: false });
        await this.loadFolders();
        if (shouldInvalidatePublicGalleryCache(this.data)) {
          markGalleryCacheDirty();
        }
      } else {
        this.showToastMessage(readRpcError(result, "创建失败"), "error");
      }
    } catch (error) {
      console.error("创建文件夹失败:", error);
      this.showToastMessage("创建失败", "error");
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  // 修改根目录名称
  onShowEditRootModal() {
    const currentRootName = this.data.rootFolderName || "根目录";
    this.setData({
      showEditRootModal: true,
      newRootFolderName: currentRootName
    });
  },

  onCloseEditRootModal() {
    this.setData({ showEditRootModal: false });
  },

  onNewRootFolderNameInput(e) {
    this.setData({ newRootFolderName: e.detail.value });
  },

  async onUpdateRootFolderName() {
    const { newRootFolderName, albumId } = this.data;
    const targetName = newRootFolderName.trim();

    if (!targetName) {
      this.showToastMessage("请输入根目录名称", "warning");
      return;
    }

    if (targetName.length > 30) {
      this.showToastMessage("根目录名称最多 30 个字符", "warning");
      return;
    }

    this.setData({ actionLoading: true });

    try {
      const result = await dbQuery({
        table: "albums",
        action: "update",
        values: {
          root_folder_name: targetName,
        },
        filters: [{ column: "id", operator: "eq", value: albumId }],
        selectAfterWrite: true,
        maybeSingle: true,
        columns: "id,root_folder_name",
      });

      if (!hasRpcError(result) && readRpcData(result, null)) {
        setCachedAlbumRootName(
          this.data.album && this.data.album.access_key,
          targetName
        );
        const patch = {
          rootFolderName: targetName,
          album: { ...this.data.album, root_folder_name: targetName },
          showEditRootModal: false
        };
        if (this.data.selectedFolder === null) {
          patch.selectedFolderName = targetName;
        }
        this.setData({
          ...patch
        });
        this.updateFilteredPhotos();
        if (shouldInvalidatePublicGalleryCache(this.data)) {
          markGalleryCacheDirty();
        }
        this.showToastMessage("根目录名称已更新", "success");
      } else {
        this.showToastMessage(readRpcError(result, "修改失败"), "error");
      }
    } catch (error) {
      console.error("修改根目录名称失败:", error);
      this.showToastMessage("修改失败", "error");
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  onShowEditFolderModal(e) {
    if (this.data.actionLoading) return;
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const folderId = String(dataset.folderId || "").trim();
    const folderName = String(dataset.folderName || "").trim();
    if (!folderId) return;
    const matched = Array.isArray(this.data.folders)
      ? this.data.folders.find((folder) => String(folder.id) === folderId)
      : null;
    if (!matched) return;
    this.setData({
      showEditFolderModal: true,
      editingFolderId: folderId,
      editingFolderName: folderName || String(matched.name || "").trim(),
    });
  },

  onCloseEditFolderModal() {
    if (this.data.actionLoading) return;
    this.setData({
      showEditFolderModal: false,
      editingFolderId: "",
      editingFolderName: "",
    });
  },

  onEditFolderNameInput(e) {
    this.setData({ editingFolderName: e && e.detail ? e.detail.value : "" });
  },

  async onUpdateFolderName() {
    if (this.data.actionLoading) return;
    const folderId = String(this.data.editingFolderId || "").trim();
    const targetName = String(this.data.editingFolderName || "").trim();

    if (!folderId) {
      this.showToastMessage("目标文件夹不存在", "warning");
      return;
    }
    if (!targetName) {
      this.showToastMessage("请输入文件夹名称", "warning");
      return;
    }
    if (targetName.length > 50) {
      this.showToastMessage("文件夹名称最多 50 个字符", "warning");
      return;
    }

    const targetFolder = Array.isArray(this.data.folders)
      ? this.data.folders.find((folder) => String(folder.id) === folderId)
      : null;
    if (!targetFolder) {
      this.showToastMessage("文件夹不存在或已删除", "warning");
      return;
    }

    this.setData({ actionLoading: true });
    try {
      const result = await dbQuery({
        table: "album_folders",
        action: "update",
        values: { name: targetName },
        filters: [
          { column: "id", operator: "eq", value: folderId },
          { column: "album_id", operator: "eq", value: this.data.albumId },
        ],
        selectAfterWrite: true,
        maybeSingle: true,
        columns: "id,album_id,name,created_at",
      });
      if (!hasRpcError(result) && readRpcData(result, null)) {
        this.setData({
          showEditFolderModal: false,
          editingFolderId: "",
          editingFolderName: "",
        });
        await this.loadFolders();
        this.updateFilteredPhotos();
        this.showToastMessage("文件夹名称已更新", "success");
      } else {
        this.showToastMessage(readRpcError(result, "修改失败"), "error");
      }
    } catch (error) {
      console.error("修改文件夹名称失败:", error);
      this.showToastMessage("修改失败", "error");
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  async persistFolderOrder(reordered, successMessage) {
    const currentFolders = Array.isArray(this.data.folders) ? this.data.folders : [];
    const currentMap = new Map();
    currentFolders.forEach((item, index) => {
      currentMap.set(
        String(item.id),
        normalizeFolderSortOrder(item && item.sort_order != null ? item.sort_order : buildFolderSortOrderValue(index))
      );
    });

    const desiredMap = new Map();
    (Array.isArray(reordered) ? reordered : []).forEach((item, index) => {
      desiredMap.set(String(item.id), buildFolderSortOrderValue(index));
    });

    const changed = (Array.isArray(reordered) ? reordered : []).filter(
      (item) => currentMap.get(String(item.id)) !== desiredMap.get(String(item.id))
    );
    if (!changed.length) return;

    this.setData({ actionLoading: true });
    try {
      for (let i = 0; i < changed.length; i += 1) {
        const item = changed[i];
        const sortOrder = desiredMap.get(String(item.id));
        const result = await dbQuery({
          table: "album_folders",
          action: "update",
          values: { sort_order: sortOrder },
          filters: [
            { column: "id", operator: "eq", value: item.id },
            { column: "album_id", operator: "eq", value: this.data.albumId },
          ],
        });
        if (hasRpcError(result)) {
          const message = readRpcError(result, "文件夹排序失败");
          if (isColumnUnavailableError(message, "sort_order", "album_folders")) {
            this.setData({
              folderSortOrderAvailable: false,
              ...this.resolveSelectedFolderMoveState(this.data.selectedFolder, currentFolders, {
                folderSortOrderAvailable: false,
              }),
            });
            this.showToastMessage(
              isColumnMissingError(message, "sort_order")
                ? ALBUM_FOLDER_SORT_MIGRATION_HINT
                : ALBUM_FOLDER_SORT_READONLY_HINT,
              "warning"
            );
          } else {
            this.showToastMessage(message, "error");
          }
          return;
        }
      }

      const nextFolders = sortAlbumFolders(currentFolders.map((item, index) => {
        const nextSort = desiredMap.get(String(item.id));
        if (!Number.isFinite(Number(nextSort))) {
          return Object.assign({}, item, {
            sort_order: normalizeFolderSortOrder(item && item.sort_order != null ? item.sort_order : buildFolderSortOrderValue(index)),
          });
        }
        return Object.assign({}, item, { sort_order: Number(nextSort) });
      }));

      this.setData({
        folders: nextFolders,
        ...this.resolveSelectedFolderMoveState(this.data.selectedFolder, nextFolders),
      });
      if (shouldInvalidatePublicGalleryCache(this.data)) {
        markGalleryCacheDirty();
      }
      this.showToastMessage(successMessage, "success");
    } catch (error) {
      this.showToastMessage(`文件夹排序失败：${readErrorMessage(error, "请稍后重试")}`, "error");
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  async onMoveFolder(e) {
    if (this.data.actionLoading) return;
    if (this.data.folderSortOrderAvailable === false) {
      this.showToastMessage(ALBUM_FOLDER_SORT_READONLY_HINT, "warning");
      return;
    }
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const folderId = String(dataset.folderId || "").trim();
    const rawDirection = String(dataset.direction || "").trim();
    const direction = rawDirection === "down" ? "down" : rawDirection === "top" ? "top" : "up";
    if (!folderId || folderId === ROOT_FOLDER_SENTINEL) {
      return;
    }

    const list = sortAlbumFolders(Array.isArray(this.data.folders) ? this.data.folders : []);
    const currentIndex = list.findIndex((item) => String(item.id) === folderId);
    if (currentIndex < 0) return;

    const targetIndex = direction === "top" ? 0 : direction === "up" ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= list.length || targetIndex === currentIndex) {
      return;
    }

    const reordered = list.slice();
    const moved = reordered[currentIndex];
    reordered.splice(currentIndex, 1);
    reordered.splice(targetIndex, 0, moved);
    await this.persistFolderOrder(
      reordered,
      direction === "top" ? "文件夹已置顶" : direction === "up" ? "文件夹已上移" : "文件夹已下移"
    );
  },

  // 删除文件夹
  onDeleteFolder(e) {
    const folderId = String(e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.folderId : "").trim();
    if (!folderId || folderId === ROOT_FOLDER_SENTINEL) {
      return;
    }
    const folder = this.data.folders.find(f => String(f.id) === String(folderId));
    if (folder) {
      this.setData({ deletingFolder: folder });
    }
  },

  onCancelDeleteFolder() {
    this.setData({ deletingFolder: null });
  },

  async onConfirmDeleteFolder() {
    const { deletingFolder } = this.data;
    if (!deletingFolder) return;

    this.setData({ actionLoading: true });

    try {
      const result = await dbQuery({
        table: "album_folders",
        action: "delete",
        filters: [
          { column: "id", operator: "eq", value: deletingFolder.id },
          { column: "album_id", operator: "eq", value: this.data.albumId },
        ],
        selectAfterWrite: true,
        maybeSingle: true,
        columns: "id,name",
      });

      if (!hasRpcError(result) && readRpcData(result, null)) {
        this.showToastMessage(`文件夹已删除,照片已移至${this.data.rootFolderName}`, "success");
        this.setData({ deletingFolder: null });
        await this.loadFolders();
        await this.loadPhotos();
        if (shouldInvalidatePublicGalleryCache(this.data)) {
          markGalleryCacheDirty();
        }
      } else {
        this.showToastMessage(readRpcError(result, "删除失败"), "error");
      }
    } catch (error) {
      console.error("删除文件夹失败:", error);
      this.showToastMessage("删除失败", "error");
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  // 上传照片
  onShowUploadModal() {
    this.setData({
      showUploadModal: true,
      uploadMode: "batch",
      singleImage: null,
      singleStoryText: "",
      singleHighlight: false,
      singleShotDate: getTodayDateUTC8(),
      singleShotLocation: "",
      batchShotDate: getTodayDateUTC8(),
      batchShotLocation: "",
      batchImages: [],
      uploadProgress: { current: 0, total: 0 },
    });
  },

  onCloseUploadModal() {
    if (!this.data.uploading) {
      this.setData({
        showUploadModal: false,
        singleImage: null,
        singleStoryText: "",
        singleHighlight: false,
        singleShotDate: getTodayDateUTC8(),
        singleShotLocation: "",
        batchShotDate: getTodayDateUTC8(),
        batchShotLocation: "",
        batchImages: [],
      });
    }
  },

  onUploadModeChange(e) {
    if (this.data.uploading) return;
    const mode =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.mode || "batch").trim()
        : "batch";
    const nextMode = mode === "single" ? "single" : "batch";
    this.setData({
      uploadMode: nextMode,
      singleImage: null,
      singleStoryText: "",
      singleHighlight: false,
      singleShotDate: getTodayDateUTC8(),
      singleShotLocation: "",
      batchShotDate: getTodayDateUTC8(),
      batchShotLocation: "",
      batchImages: [],
      uploadProgress: { current: 0, total: 0 },
    });
  },

  async onChooseImages() {
    if (this.data.uploading) return;
    if (!this.data.showUploadModal) {
      this.setData({ showUploadModal: true });
    }

    try {
      const isSingle = String(this.data.uploadMode || "batch") === "single";
      markAdminPageTransientForeground("gallery-manager-upload-choose-media");
      const res = await wx.chooseMedia({
        count: isSingle ? 1 : 9,
        mediaType: ['image'],
        sourceType: ['album', 'camera']
      });

      if (res.tempFiles && res.tempFiles.length > 0) {
        const selected = res.tempFiles.map((file, index) => ({
          path: file.tempFilePath,
          name: String((file && file.fileName) || "").trim() || `图片${index + 1}.jpg`,
          size: Number((file && file.size) || 0),
          sizeText: formatFileSize(file && file.size),
          width: Number((file && file.width) || 0),
          height: Number((file && file.height) || 0),
        }));

        if (isSingle) {
          this.setData({ singleImage: selected[0] || null });
        } else {
          this.setData({ batchImages: selected });
        }
      }
    } catch (error) {
      console.error("选择图片失败:", error);
    }
  },

  onClearImages() {
    if (String(this.data.uploadMode || "batch") === "single") {
      this.setData({ singleImage: null });
      return;
    }
    this.setData({ batchImages: [] });
  },

  onRemoveUploadImage(e) {
    if (this.data.uploading) return;
    if (String(this.data.uploadMode || "batch") === "single") {
      this.setData({ singleImage: null });
      return;
    }
    const index = Number(e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.index : -1);
    if (!Number.isInteger(index) || index < 0) return;
    const list = Array.isArray(this.data.batchImages) ? this.data.batchImages : [];
    if (index >= list.length) return;
    const next = list.slice(0, index).concat(list.slice(index + 1));
    this.setData({ batchImages: next });
  },

  onSingleStoryInput(e) {
    this.setData({ singleStoryText: e && e.detail ? e.detail.value : "" });
  },

  onSingleHighlightChange(e) {
    this.setData({
      singleHighlight: Boolean(e && e.detail ? e.detail.value : false),
    });
  },

  onSingleShotDateChange(e) {
    const value = normalizeShotDate(e && e.detail ? e.detail.value : "");
    this.setData({
      singleShotDate: value || getTodayDateUTC8(),
    });
  },

  onSingleShotLocationInput(e) {
    this.setData({
      singleShotLocation: normalizeShotLocation(e && e.detail ? e.detail.value : ""),
    });
  },

  onBatchShotDateChange(e) {
    const value = normalizeShotDate(e && e.detail ? e.detail.value : "");
    this.setData({
      batchShotDate: value || getTodayDateUTC8(),
    });
  },

  onBatchShotLocationInput(e) {
    this.setData({
      batchShotLocation: normalizeShotLocation(e && e.detail ? e.detail.value : ""),
    });
  },

  async onUploadSinglePhoto() {
    const {
      singleImage,
      albumId,
      selectedFolder,
      folders,
      singleStoryText,
      singleHighlight,
      singleShotDate,
      singleShotLocation,
    } = this.data;
    if (!singleImage || !singleImage.path) {
      this.showToastMessage("请选择图片", "warning");
      return;
    }

    this.setData({
      uploading: true,
      uploadProgress: { current: 0, total: 1 },
    });

    const normalizedFolderId =
      selectedFolder && Array.isArray(folders) && folders.some((folder) => String(folder.id) === String(selectedFolder))
        ? String(selectedFolder)
        : null;

    let uploadVariants = null;
    let shouldCleanupUpload = false;
    try {
      uploadVariants = await uploadAlbumPhotoVariants(singleImage.path, singleImage.name, singleImage.size);
      shouldCleanupUpload = true;
      this.setData({ uploadProgress: { current: 1, total: 1 } });

      const baseValues = {
        album_id: albumId,
        thumbnail_url: uploadVariants.thumbnail_url,
        preview_url: uploadVariants.preview_url,
        original_url: uploadVariants.original_url,
        sort_order: TOP_PIN_SORT_ORDER,
        ...(this.data.isSystemAlbum ? { is_public: 1 } : {}),
      };
      const width = Number(singleImage && singleImage.width);
      const height = Number(singleImage && singleImage.height);
      if (Number.isFinite(width) && width > 0) {
        baseValues.width = Math.round(width);
      }
      if (Number.isFinite(height) && height > 0) {
        baseValues.height = Math.round(height);
      }

      const storyText = normalizeStoryText(singleStoryText);
      const shotDate = normalizeShotDate(singleShotDate) || getTodayDateUTC8();
      const shotLocation = normalizeShotLocation(singleShotLocation);
      const storyValues = storyText ? { story_text: storyText } : singleHighlight ? { story_text: "" } : {};
      const valuesWithStory = Object.assign(
        {},
        baseValues,
        normalizedFolderId ? { folder_id: normalizedFolderId } : {},
        storyValues,
        singleHighlight ? { is_highlight: 1 } : {},
        shotLocation ? { shot_location: shotLocation } : {},
        { shot_date: shotDate }
      );
      const valuesWithoutShotDate = Object.assign(
        {},
        baseValues,
        normalizedFolderId ? { folder_id: normalizedFolderId } : {},
        storyValues,
        singleHighlight ? { is_highlight: 1 } : {},
        shotLocation ? { shot_location: shotLocation } : {}
      );
      const photoColumnsWithShotMeta = "id,album_id,folder_id,thumbnail_url,preview_url,original_url,width,height,story_text,is_highlight,sort_order,shot_date,shot_location,is_public,view_count,like_count,created_at";
      const photoColumnsWithoutShotDate = "id,album_id,folder_id,thumbnail_url,preview_url,original_url,width,height,story_text,is_highlight,sort_order,shot_location,is_public,view_count,like_count,created_at";
      const photoColumnsWithoutShotMeta = "id,album_id,folder_id,thumbnail_url,preview_url,original_url,width,height,story_text,is_highlight,sort_order,is_public,view_count,like_count,created_at";

      let result = await dbQuery({
        table: "album_photos",
        action: "insert",
        values: valuesWithStory,
        selectAfterWrite: true,
        maybeSingle: true,
        columns: photoColumnsWithShotMeta,
      });

      if (
        hasRpcError(result) &&
        normalizedFolderId &&
        isAlbumFolderForeignKeyError(readRpcError(result, "写入照片失败"))
      ) {
        const fallbackValues = Object.assign(
          {},
          baseValues,
          storyValues,
          singleHighlight ? { is_highlight: 1 } : {},
          shotLocation ? { shot_location: shotLocation } : {},
          { shot_date: shotDate }
        );
        result = await dbQuery({
          table: "album_photos",
          action: "insert",
          values: fallbackValues,
          selectAfterWrite: true,
          maybeSingle: true,
          columns: photoColumnsWithShotMeta,
        });
      }

      if (hasRpcError(result) && isColumnMissingError(readRpcError(result, "写入照片失败"), "shot_location")) {
        const valuesWithoutShotLocation = Object.assign({}, valuesWithStory);
        delete valuesWithoutShotLocation.shot_location;
        result = await dbQuery({
          table: "album_photos",
          action: "insert",
          values: valuesWithoutShotLocation,
          selectAfterWrite: true,
          maybeSingle: true,
          columns: photoColumnsWithoutShotMeta,
        });
        if (
          hasRpcError(result) &&
          normalizedFolderId &&
          isAlbumFolderForeignKeyError(readRpcError(result, "写入照片失败"))
        ) {
          const fallbackWithoutShotLocation = Object.assign(
            {},
            baseValues,
            storyValues,
            singleHighlight ? { is_highlight: 1 } : {},
            { shot_date: shotDate }
          );
          result = await dbQuery({
            table: "album_photos",
            action: "insert",
            values: fallbackWithoutShotLocation,
            selectAfterWrite: true,
            maybeSingle: true,
            columns: photoColumnsWithoutShotMeta,
          });
        }
      }

      if (hasRpcError(result) && isColumnMissingError(readRpcError(result, "写入照片失败"), "shot_date")) {
        result = await dbQuery({
          table: "album_photos",
          action: "insert",
          values: valuesWithoutShotDate,
          selectAfterWrite: true,
          maybeSingle: true,
          columns: photoColumnsWithoutShotDate,
        });
        if (
          hasRpcError(result) &&
          normalizedFolderId &&
          isAlbumFolderForeignKeyError(readRpcError(result, "写入照片失败"))
        ) {
          const fallbackValues = Object.assign(
            {},
            baseValues,
            storyValues,
            singleHighlight ? { is_highlight: 1 } : {},
            shotLocation ? { shot_location: shotLocation } : {}
          );
          result = await dbQuery({
            table: "album_photos",
            action: "insert",
            values: fallbackValues,
            selectAfterWrite: true,
            maybeSingle: true,
            columns: isColumnMissingError(readRpcError(result, "写入照片失败"), "shot_location")
              ? photoColumnsWithoutShotMeta
              : photoColumnsWithoutShotDate,
          });
        }
      }

      if (hasRpcError(result)) {
        const message = readRpcError(result, "写入照片失败");
        if (isColumnMissingError(message, "story_text") || isColumnMissingError(message, "is_highlight")) {
          this.showToastMessage(ALBUM_PHOTO_STORY_SORT_MIGRATION_HINT, "warning");
        } else if (isColumnMissingError(message, "shot_date")) {
          this.showToastMessage(ALBUM_PHOTO_SHOT_DATE_MIGRATION_HINT, "warning");
        } else if (isColumnMissingError(message, "shot_location")) {
          this.showToastMessage(ALBUM_PHOTO_SHOT_LOCATION_MIGRATION_HINT, "warning");
        } else {
          this.showToastMessage(message, "error");
        }
        return;
      }

      shouldCleanupUpload = false;
      this.showToastMessage("单图上传成功", "success");
      this.setData({
        showUploadModal: false,
        singleImage: null,
        singleStoryText: "",
        singleHighlight: false,
        singleShotDate: getTodayDateUTC8(),
        singleShotLocation: "",
        batchShotDate: getTodayDateUTC8(),
        batchShotLocation: "",
      });
      await this.loadPhotos();
      if (shouldInvalidatePublicGalleryCache(this.data)) {
        markGalleryCacheDirty();
      }
    } catch (error) {
      console.error("单图上传失败:", error);
      this.showToastMessage(readErrorMessage(error, "上传失败"), "error");
    } finally {
      if (uploadVariants && shouldCleanupUpload) {
        await cleanupStorageTargets(uploadVariants.cleanupTargets);
      }
      this.setData({
        uploading: false,
        uploadProgress: { current: 0, total: 0 },
      });
    }
  },

  async onUploadPhotos() {
    if (String(this.data.uploadMode || "batch") === "single") {
      await this.onUploadSinglePhoto();
      return;
    }
    const { batchImages, albumId, selectedFolder, folders, batchShotDate, batchShotLocation } = this.data;

    if (batchImages.length === 0) {
      this.showToastMessage("请选择图片", "warning");
      return;
    }

    this.setData({
      uploading: true,
      uploadProgress: { current: 0, total: batchImages.length }
    });

    let successCount = 0;
    let failCount = 0;
    const normalizedBatchShotDate = normalizeShotDate(batchShotDate) || getTodayDateUTC8();
    const normalizedBatchShotLocation = normalizeShotLocation(batchShotLocation);
    const normalizedFolderId =
      selectedFolder && Array.isArray(folders) && folders.some((folder) => String(folder.id) === String(selectedFolder))
        ? String(selectedFolder)
        : null;

    if (selectedFolder && !normalizedFolderId) {
      this.setData({
        selectedFolder: null,
        selectedFolderName: this.data.rootFolderName || "根目录",
      });
    }

    try {
      for (let i = 0; i < batchImages.length; i++) {
        const image = batchImages[i];
        let uploadVariants = null;
        let shouldCleanupUpload = false;

        try {
          uploadVariants = await uploadAlbumPhotoVariants(image.path, image.name, image.size);
          shouldCleanupUpload = true;

          const insertValues = {
            album_id: albumId,
            thumbnail_url: uploadVariants.thumbnail_url,
            preview_url: uploadVariants.preview_url,
            original_url: uploadVariants.original_url,
            sort_order: TOP_PIN_SORT_ORDER,
            shot_date: normalizedBatchShotDate,
            ...(this.data.isSystemAlbum ? { is_public: 1 } : {}),
          };
          if (normalizedBatchShotLocation) {
            insertValues.shot_location = normalizedBatchShotLocation;
          }
          const photoColumnsWithShotMeta = "id,album_id,folder_id,thumbnail_url,preview_url,original_url,width,height,story_text,is_highlight,sort_order,shot_date,shot_location,is_public,view_count,like_count,created_at";
          const photoColumnsWithoutShotDate = "id,album_id,folder_id,thumbnail_url,preview_url,original_url,width,height,story_text,is_highlight,sort_order,shot_location,is_public,view_count,like_count,created_at";
          const photoColumnsWithoutShotMeta = "id,album_id,folder_id,thumbnail_url,preview_url,original_url,width,height,story_text,is_highlight,sort_order,is_public,view_count,like_count,created_at";
          const width = Number(image && image.width);
          const height = Number(image && image.height);
          if (Number.isFinite(width) && width > 0) {
            insertValues.width = Math.round(width);
          }
          if (Number.isFinite(height) && height > 0) {
            insertValues.height = Math.round(height);
          }

          const valuesWithFolder = Object.assign(
            {},
            insertValues,
            normalizedFolderId ? { folder_id: normalizedFolderId } : {}
          );
          let result = await dbQuery({
            table: "album_photos",
            action: "insert",
            values: valuesWithFolder,
            selectAfterWrite: true,
            maybeSingle: true,
            columns: photoColumnsWithShotMeta,
          });
          if (
            hasRpcError(result) &&
            normalizedFolderId &&
            isAlbumFolderForeignKeyError(readRpcError(result, "写入照片失败"))
          ) {
            result = await dbQuery({
              table: "album_photos",
              action: "insert",
              values: insertValues,
              selectAfterWrite: true,
              maybeSingle: true,
              columns: photoColumnsWithShotMeta,
            });
          }

          if (hasRpcError(result) && isColumnMissingError(readRpcError(result, "写入照片失败"), "shot_location")) {
            const valuesWithoutLocation = Object.assign({}, valuesWithFolder);
            delete valuesWithoutLocation.shot_location;
            result = await dbQuery({
              table: "album_photos",
              action: "insert",
              values: valuesWithoutLocation,
              selectAfterWrite: true,
              maybeSingle: true,
              columns: photoColumnsWithoutShotMeta,
            });
            if (
              hasRpcError(result) &&
              normalizedFolderId &&
              isAlbumFolderForeignKeyError(readRpcError(result, "写入照片失败"))
            ) {
              const fallbackWithoutLocation = Object.assign({}, insertValues);
              delete fallbackWithoutLocation.shot_location;
              result = await dbQuery({
                table: "album_photos",
                action: "insert",
                values: fallbackWithoutLocation,
                selectAfterWrite: true,
                maybeSingle: true,
                columns: photoColumnsWithoutShotMeta,
              });
            }
          }

          if (hasRpcError(result) && isColumnMissingError(readRpcError(result, "写入照片失败"), "shot_date")) {
            const insertValuesWithoutShotDate = Object.assign({}, insertValues);
            delete insertValuesWithoutShotDate.shot_date;
            const valuesWithoutShotDate = Object.assign(
              {},
              insertValuesWithoutShotDate,
              normalizedFolderId ? { folder_id: normalizedFolderId } : {}
            );
            result = await dbQuery({
              table: "album_photos",
              action: "insert",
              values: valuesWithoutShotDate,
              selectAfterWrite: true,
              maybeSingle: true,
              columns: photoColumnsWithoutShotDate,
            });
            if (
              hasRpcError(result) &&
              normalizedFolderId &&
              isAlbumFolderForeignKeyError(readRpcError(result, "写入照片失败"))
            ) {
              result = await dbQuery({
                table: "album_photos",
                action: "insert",
                values: insertValuesWithoutShotDate,
                selectAfterWrite: true,
                maybeSingle: true,
                columns: isColumnMissingError(readRpcError(result, "写入照片失败"), "shot_location")
                  ? photoColumnsWithoutShotMeta
                  : photoColumnsWithoutShotDate,
              });
            }
          }

          if (!hasRpcError(result) && readRpcData(result, null)) {
            successCount++;
            shouldCleanupUpload = false;
          } else {
            const insertError = readRpcError(result, "写入照片失败");
            if (isColumnMissingError(insertError, "shot_date")) {
              this.showToastMessage(ALBUM_PHOTO_SHOT_DATE_MIGRATION_HINT, "warning");
              return;
            }
            if (isColumnMissingError(insertError, "shot_location")) {
              this.showToastMessage(ALBUM_PHOTO_SHOT_LOCATION_MIGRATION_HINT, "warning");
              return;
            }
            console.error("写入照片记录失败:", insertError);
            failCount++;
          }
        } catch (error) {
          console.error("上传图片失败:", error);
          failCount++;
        } finally {
          if (uploadVariants && shouldCleanupUpload) {
            await cleanupStorageTargets(uploadVariants.cleanupTargets);
          }
        }

        this.setData({
          uploadProgress: { current: i + 1, total: batchImages.length }
        });
      }

      if (failCount > 0) {
        this.showToastMessage(`上传完成:成功 ${successCount} 张,失败 ${failCount} 张`, "warning");
      } else {
        this.showToastMessage(`成功上传 ${successCount} 张照片`, "success");
      }

      this.setData({
        showUploadModal: false,
        batchImages: [],
        singleShotDate: getTodayDateUTC8(),
        singleShotLocation: "",
        batchShotDate: getTodayDateUTC8(),
        batchShotLocation: "",
      });

      if (successCount > 0) {
        await this.loadPhotos();
        if (shouldInvalidatePublicGalleryCache(this.data)) {
          markGalleryCacheDirty();
        }
      }
    } catch (error) {
      console.error("上传失败:", error);
      this.showToastMessage("上传失败", "error");
    } finally {
      this.setData({
        uploading: false,
        uploadProgress: { current: 0, total: 0 }
      });
    }
  },

  // 批量选择
  onEnterSelectionMode() {
    this.setData({
      isSelectionMode: true,
      selectedPhotoIds: []
    });
    this.updateFilteredPhotos();
  },

  onExitSelectionMode() {
    this.setData({
      isSelectionMode: false,
      selectedPhotoIds: []
    });
    this.updateFilteredPhotos();
  },

  onToggleSelection(e) {
    const photoId = String(e.currentTarget.dataset.photoId || "");
    if (!photoId) return;
    const selectedPhotoIds = Array.isArray(this.data.selectedPhotoIds) ? this.data.selectedPhotoIds.map(id => String(id)) : [];

    const index = selectedPhotoIds.indexOf(photoId);
    let newSelectedIds;

    if (index > -1) {
      newSelectedIds = selectedPhotoIds.filter(id => id !== photoId);
    } else {
      newSelectedIds = [...selectedPhotoIds, photoId];
    }

    this.setData({ selectedPhotoIds: newSelectedIds });
    this.updateFilteredPhotos();
  },

  onSelectAll() {
    const { filteredPhotos, selectedPhotoIds } = this.data;
    const allIds = filteredPhotos.map(p => String(p.id));
    const selectedSet = new Set(
      (Array.isArray(selectedPhotoIds) ? selectedPhotoIds : []).map((id) => String(id))
    );
    const allSelected = allIds.length > 0 && allIds.every((id) => selectedSet.has(id));
    this.setData({ selectedPhotoIds: allSelected ? [] : allIds });
    this.updateFilteredPhotos();
  },

  onPhotoCardTap(e) {
    const photoId = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.photoId : "";
    if (!photoId) return;
    if (this.data.isSelectionMode) {
      this.onToggleSelection(e);
      return;
    }
    this.onPreviewPhoto(e);
  },

  onOpenStoryModal(e) {
    if (this.data.actionLoading) return;
    const photoId =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.photoId || "").trim()
        : "";
    if (!photoId) return;
    const target =
      (Array.isArray(this.data.photos) ? this.data.photos : []).find((item) => String(item.id) === photoId) || null;
    if (!target) {
      this.showToastMessage("照片不存在或已删除", "warning");
      return;
    }

    this.setData({
      showStoryModal: true,
      editingStoryPhotoId: photoId,
      editingStoryText: normalizeStoryText(target.story_text),
      editingStoryHighlight: Boolean(target.is_highlight),
    });
  },

  onCloseStoryModal() {
    if (this.data.actionLoading) return;
    this.setData({
      showStoryModal: false,
      editingStoryPhotoId: "",
      editingStoryText: "",
      editingStoryHighlight: false,
    });
  },

  onEditingStoryInput(e) {
    this.setData({ editingStoryText: e && e.detail ? e.detail.value : "" });
  },

  onEditingStoryHighlightChange(e) {
    this.setData({ editingStoryHighlight: Boolean(e && e.detail ? e.detail.value : false) });
  },

  async onSaveStory() {
    const photoId = String(this.data.editingStoryPhotoId || "").trim();
    if (!photoId) {
      this.showToastMessage("目标照片不存在", "warning");
      return;
    }

    this.setData({ actionLoading: true });
    try {
      const storyText = normalizeStoryText(this.data.editingStoryText);
      const result = await dbQuery({
        table: "album_photos",
        action: "update",
        values: {
          story_text: storyText,
          is_highlight: this.data.editingStoryHighlight ? 1 : 0,
        },
        filters: [
          { column: "id", operator: "eq", value: photoId },
          { column: "album_id", operator: "eq", value: this.data.albumId },
        ],
        selectAfterWrite: true,
        maybeSingle: true,
        columns: "id,story_text,is_highlight",
      });

      if (hasRpcError(result)) {
        const message = readRpcError(result, "保存失败");
        if (isColumnMissingError(message, "story_text") || isColumnMissingError(message, "is_highlight")) {
          this.showToastMessage(ALBUM_PHOTO_STORY_SORT_MIGRATION_HINT, "warning");
        } else {
          this.showToastMessage(message, "error");
        }
        return;
      }

      const rows = Array.isArray(this.data.photos) ? this.data.photos : [];
      const nextPhotos = rows.map((item) => {
        if (String(item.id) !== photoId) return item;
        const normalized = normalizeStoryText(storyText);
        return Object.assign({}, item, {
          story_text: normalized,
          has_story: Boolean(normalized),
          is_highlight: Boolean(this.data.editingStoryHighlight),
          story_highlight: Boolean(normalized) || Boolean(this.data.editingStoryHighlight),
        });
      });
      this.setData(
        {
          photos: nextPhotos,
          showStoryModal: false,
          editingStoryPhotoId: "",
          editingStoryText: "",
          editingStoryHighlight: false,
        },
        () => this.updateFilteredPhotos()
      );
      if (shouldInvalidatePublicGalleryCache(this.data)) {
        markGalleryCacheDirty();
      }
      this.showToastMessage("关于此刻已更新", "success");
    } catch (error) {
      console.error("保存关于此刻失败:", error);
      this.showToastMessage(readErrorMessage(error, "保存失败"), "error");
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  onOpenShotDateModal(e) {
    if (this.data.actionLoading) return;
    const photoId =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.photoId || "").trim()
        : "";
    if (!photoId) return;

    const target =
      (Array.isArray(this.data.photos) ? this.data.photos : []).find((item) => String(item.id) === photoId) || null;
    if (!target) {
      this.showToastMessage("照片不存在或已删除", "warning");
      return;
    }

    const fallbackDate = normalizeShotDate(target.created_at) || getTodayDateUTC8();
    this.setData({
      showShotDateModal: true,
      editingShotDatePhotoId: photoId,
      editingShotDateValue: normalizeShotDate(target.shot_date) || fallbackDate,
      editingShotLocationValue: normalizeShotLocation(target.shot_location),
    });
  },

  onCloseShotDateModal() {
    if (this.data.actionLoading) return;
    this.setData({
      showShotDateModal: false,
      editingShotDatePhotoId: "",
      editingShotDateValue: getTodayDateUTC8(),
      editingShotLocationValue: "",
    });
  },

  onEditingShotDateChange(e) {
    const value = normalizeShotDate(e && e.detail ? e.detail.value : "");
    this.setData({ editingShotDateValue: value || getTodayDateUTC8() });
  },

  onEditingShotLocationInput(e) {
    this.setData({
      editingShotLocationValue: normalizeShotLocation(e && e.detail ? e.detail.value : ""),
    });
  },

  async onSaveShotDate() {
    const photoId = String(this.data.editingShotDatePhotoId || "").trim();
    if (!photoId) {
      this.showToastMessage("目标照片不存在", "warning");
      return;
    }

    const shotDate = normalizeShotDate(this.data.editingShotDateValue);
    const shotLocation = normalizeShotLocation(this.data.editingShotLocationValue);
    if (!shotDate) {
      this.showToastMessage("请选择有效的拍摄日期", "warning");
      return;
    }

    this.setData({ actionLoading: true });
    try {
      let usedShotLocationColumn = true;
      let result = await dbQuery({
        table: "album_photos",
        action: "update",
        values: { shot_date: shotDate, shot_location: shotLocation || null },
        filters: [
          { column: "id", operator: "eq", value: photoId },
          { column: "album_id", operator: "eq", value: this.data.albumId },
        ],
        selectAfterWrite: true,
        maybeSingle: true,
        columns: "id,shot_date,shot_location",
      });

      if (hasRpcError(result) && isColumnMissingError(readRpcError(result, "保存失败"), "shot_location")) {
        usedShotLocationColumn = false;
        result = await dbQuery({
          table: "album_photos",
          action: "update",
          values: { shot_date: shotDate },
          filters: [
            { column: "id", operator: "eq", value: photoId },
            { column: "album_id", operator: "eq", value: this.data.albumId },
          ],
          selectAfterWrite: true,
          maybeSingle: true,
          columns: "id,shot_date",
        });
      }

      if (hasRpcError(result)) {
        const message = readRpcError(result, "保存失败");
        if (isColumnMissingError(message, "shot_date")) {
          this.showToastMessage(ALBUM_PHOTO_SHOT_DATE_MIGRATION_HINT, "warning");
        } else if (isColumnMissingError(message, "shot_location")) {
          this.showToastMessage(ALBUM_PHOTO_SHOT_LOCATION_MIGRATION_HINT, "warning");
        } else {
          this.showToastMessage(message, "error");
        }
        return;
      }

      const rows = Array.isArray(this.data.photos) ? this.data.photos : [];
      const nextPhotos = rows.map((item) => {
        if (String(item.id) !== photoId) return item;
        return Object.assign({}, item, {
          shot_date: shotDate,
          shot_location: usedShotLocationColumn ? shotLocation : normalizeShotLocation(item.shot_location),
        });
      });
      this.setData(
        {
          photos: nextPhotos,
          showShotDateModal: false,
          editingShotDatePhotoId: "",
          editingShotDateValue: getTodayDateUTC8(),
          editingShotLocationValue: "",
        },
        () => this.updateFilteredPhotos()
      );
      if (shouldInvalidatePublicGalleryCache(this.data)) {
        markGalleryCacheDirty();
      }
      this.showToastMessage("拍摄信息已更新", "success");
    } catch (error) {
      console.error("保存拍摄日期失败:", error);
      this.showToastMessage(readErrorMessage(error, "保存失败"), "error");
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  async onMovePhotoSort(e) {
    if (this.data.actionLoading) return;
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const photoId = String(dataset.photoId || "").trim();
    const direction = String(dataset.direction || "").trim().toLowerCase();
    if (!photoId) return;
    if (direction !== "up" && direction !== "down") return;

    const rows = Array.isArray(this.data.filteredPhotos) ? this.data.filteredPhotos.slice() : [];
    const currentIndex = rows.findIndex((item) => String(item.id) === photoId);
    if (currentIndex < 0) return;

    const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= rows.length) return;

    const reordered = rows.slice();
    const moved = reordered[currentIndex];
    reordered.splice(currentIndex, 1);
    reordered.splice(targetIndex, 0, moved);

    const desiredMap = new Map();
    reordered.forEach((item, index) => {
      desiredMap.set(String(item.id), (index + 1) * 10);
    });

    const changed = reordered.filter((item) => Number(item.sort_order || 0) !== Number(desiredMap.get(String(item.id)) || 0));
    if (!changed.length) return;

    this.setData({ actionLoading: true });
    try {
      for (let i = 0; i < changed.length; i += 1) {
        const row = changed[i];
        const sortOrder = Number(desiredMap.get(String(row.id)) || 0);
        const result = await dbQuery({
          table: "album_photos",
          action: "update",
          values: { sort_order: sortOrder },
          filters: [
            { column: "id", operator: "eq", value: row.id },
            { column: "album_id", operator: "eq", value: this.data.albumId },
          ],
        });
        if (hasRpcError(result)) {
          const message = readRpcError(result, "排序失败");
          if (isColumnUnavailableError(message, "sort_order", "album_photos")) {
            this.showToastMessage(ALBUM_PHOTO_STORY_SORT_MIGRATION_HINT, "warning");
          } else {
            this.showToastMessage(message, "error");
          }
          return;
        }
      }

      const allPhotos = (Array.isArray(this.data.photos) ? this.data.photos : []).map((item) => {
        const nextSort = desiredMap.get(String(item.id));
        if (!Number.isFinite(Number(nextSort))) return item;
        return Object.assign({}, item, { sort_order: Number(nextSort) });
      });

      this.setData({ photos: allPhotos }, () => this.updateFilteredPhotos());
      if (shouldInvalidatePublicGalleryCache(this.data)) {
        markGalleryCacheDirty();
      }
      this.showToastMessage(direction === "up" ? "已上移一位" : "已下移一位", "success");
    } catch (error) {
      console.error("排序失败:", error);
      this.showToastMessage(readErrorMessage(error, "排序失败"), "error");
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  async onMovePhotoTop(e) {
    if (this.data.actionLoading) return;
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const photoId = String(dataset.photoId || "").trim();
    if (!photoId) return;

    this.setData({ actionLoading: true });
    try {
      const folderFilters =
        this.data.selectedFolder === null || this.data.selectedFolder === undefined || String(this.data.selectedFolder).trim() === ""
          ? [{ column: "folder_id", operator: "eq", value: null }]
          : [{ column: "folder_id", operator: "eq", value: String(this.data.selectedFolder) }];

      const conflictResult = await dbQuery({
        table: "album_photos",
        action: "update",
        values: { sort_order: TOP_PIN_CONFLICT_SORT_ORDER },
        filters: [
          { column: "album_id", operator: "eq", value: this.data.albumId },
          { column: "sort_order", operator: "eq", value: TOP_PIN_SORT_ORDER },
          { column: "id", operator: "neq", value: photoId },
        ].concat(folderFilters),
      });
      if (hasRpcError(conflictResult)) {
        const conflictMessage = readRpcError(conflictResult, "置顶失败");
        if (isColumnUnavailableError(conflictMessage, "sort_order", "album_photos")) {
          this.showToastMessage(ALBUM_PHOTO_STORY_SORT_MIGRATION_HINT, "warning");
        } else {
          this.showToastMessage(conflictMessage, "error");
        }
        return;
      }

      const topResult = await dbQuery({
        table: "album_photos",
        action: "update",
        values: { sort_order: TOP_PIN_SORT_ORDER },
        filters: [
          { column: "id", operator: "eq", value: photoId },
          { column: "album_id", operator: "eq", value: this.data.albumId },
        ],
      });
      if (hasRpcError(topResult)) {
        const message = readRpcError(topResult, "置顶失败");
        if (isColumnUnavailableError(message, "sort_order", "album_photos")) {
          this.showToastMessage(ALBUM_PHOTO_STORY_SORT_MIGRATION_HINT, "warning");
        } else {
          this.showToastMessage(message, "error");
        }
        return;
      }

      const allPhotos = (Array.isArray(this.data.photos) ? this.data.photos : []).map((item) => {
        const inCurrentFolder =
          (this.data.selectedFolder === null || this.data.selectedFolder === undefined || String(this.data.selectedFolder).trim() === "")
            ? !item.folder_id
            : String(item.folder_id || "") === String(this.data.selectedFolder);
        if (!inCurrentFolder) return item;
        if (String(item.id) === photoId) {
          return Object.assign({}, item, { sort_order: TOP_PIN_SORT_ORDER });
        }
        if (Number(item.sort_order || 0) === TOP_PIN_SORT_ORDER) {
          return Object.assign({}, item, { sort_order: TOP_PIN_CONFLICT_SORT_ORDER });
        }
        return item;
      });

      this.setData({ photos: allPhotos }, () => this.updateFilteredPhotos());
      if (shouldInvalidatePublicGalleryCache(this.data)) {
        markGalleryCacheDirty();
      }
      this.showToastMessage("已置顶", "success");
    } catch (error) {
      console.error("置顶失败:", error);
      this.showToastMessage(readErrorMessage(error, "置顶失败"), "error");
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  // 迁移照片
  onMovePhoto(e) {
    const photoId = String(e.currentTarget.dataset.photoId || "");
    if (!photoId) return;
    this.openMoveModal([photoId]);
  },

  onShowMoveModal() {
    const { selectedPhotoIds } = this.data;
    if (selectedPhotoIds.length === 0) {
      this.showToastMessage("请先选择照片", "warning");
      return;
    }
    this.openMoveModal(selectedPhotoIds);
  },

  openMoveModal(photoIds) {
    const { photos } = this.data;
    const normalizedIds = Array.isArray(photoIds) ? photoIds.map(id => String(id)).filter(Boolean) : [];
    const firstPhoto = photos.find(p => String(p.id) === String(normalizedIds[0]));
    const initialTarget =
      firstPhoto && firstPhoto.folder_id !== null && firstPhoto.folder_id !== undefined && String(firstPhoto.folder_id) !== ""
        ? String(firstPhoto.folder_id)
        : ROOT_FOLDER_SENTINEL;

    this.setData({
      showMoveModal: true,
      movingPhotoIds: normalizedIds,
      moveTargetFolder: initialTarget
    });
  },

  onCloseMoveModal() {
    if (!this.data.actionLoading) {
      this.setData({ showMoveModal: false });
    }
  },

  onSelectMoveTarget(e) {
    const rawFolderId = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.folderId : ROOT_FOLDER_SENTINEL;
    const folderId = isRootFolderTarget(rawFolderId) ? ROOT_FOLDER_SENTINEL : String(rawFolderId).trim();
    this.setData({ moveTargetFolder: folderId });
  },

  async movePhotosToRootViaTempFolder(photoIdPayload) {
    const albumId = String(this.data.albumId || "").trim();
    if (!albumId) {
      throw new Error("迁移失败：空间ID缺失");
    }
    const ids = Array.isArray(photoIdPayload)
      ? photoIdPayload
          .map((id) => String(id || "").trim())
          .filter(Boolean)
      : [];
    if (!ids.length) {
      return 0;
    }

    const tempFolderName = buildRootMoveTempFolderName();
    let tempFolderId = "";
    let tempFolderDeleted = false;

    try {
      const createResult = await dbQuery({
        table: "album_folders",
        action: "insert",
        values: {
          album_id: albumId,
          name: tempFolderName,
        },
        selectAfterWrite: true,
        maybeSingle: true,
        columns: "id,album_id,name",
      });
      if (hasRpcError(createResult)) {
        throw new Error(readRpcError(createResult, "迁移失败：创建临时文件夹失败"));
      }
      const created = readRpcRecord(createResult);
      tempFolderId = String(created && created.id ? created.id : "").trim();
      if (!tempFolderId) {
        throw new Error("迁移失败：临时文件夹创建异常");
      }

      const moveResult = await dbQuery({
        table: "album_photos",
        action: "update",
        values: { folder_id: tempFolderId },
        filters: [
          { column: "album_id", operator: "eq", value: albumId },
          { column: "id", operator: "in", value: ids },
        ],
        selectAfterWrite: true,
        columns: "id",
      });
      if (hasRpcError(moveResult)) {
        throw new Error(readRpcError(moveResult, "迁移失败"));
      }
      const movedRows = readRpcRows(moveResult);
      const movedCount = movedRows.length;
      if (movedCount <= 0) {
        throw new Error("未迁移任何照片，请刷新后重试");
      }

      const deleteTempResult = await dbQuery({
        table: "album_folders",
        action: "delete",
        filters: [
          { column: "id", operator: "eq", value: tempFolderId },
          { column: "album_id", operator: "eq", value: albumId },
        ],
      });
      if (hasRpcError(deleteTempResult)) {
        throw new Error(readRpcError(deleteTempResult, "迁移失败：清理临时文件夹失败"));
      }
      tempFolderDeleted = true;
      return movedCount;
    } finally {
      if (tempFolderId && !tempFolderDeleted) {
        try {
          await dbQuery({
            table: "album_folders",
            action: "delete",
            filters: [
              { column: "id", operator: "eq", value: tempFolderId },
              { column: "album_id", operator: "eq", value: albumId },
            ],
          });
        } catch (error) {
          console.error("清理临时文件夹失败:", error);
        }
      }
    }
  },

  async onConfirmMove() {
    const { movingPhotoIds, moveTargetFolder, folders } = this.data;

    if (movingPhotoIds.length === 0) {
      this.onCloseMoveModal();
      return;
    }

    const normalizedTargetFolder = isRootFolderTarget(moveTargetFolder) ? null : String(moveTargetFolder || "").trim();

    if (normalizedTargetFolder) {
      const folderExists = folders.some(f => String(f.id) === String(normalizedTargetFolder));
      if (!folderExists) {
        this.showToastMessage("目标文件夹不存在,请刷新后重试", "warning");
        return;
      }
    }

    const photoIdPayload = movingPhotoIds
      .map(id => {
        const matched = this.data.photos.find(photo => String(photo.id) === String(id));
        return matched ? matched.id : id;
      })
      .filter(id => id !== null && id !== undefined && String(id).trim() !== "");
    if (!photoIdPayload.length) {
      this.showToastMessage("未找到可迁移的照片", "warning");
      return;
    }

    this.setData({ actionLoading: true });

    try {
      let movedCount = 0;
      if (normalizedTargetFolder) {
        const result = await dbQuery({
          table: "album_photos",
          action: "update",
          values: { folder_id: normalizedTargetFolder },
          filters: [
            { column: "album_id", operator: "eq", value: this.data.albumId },
            { column: "id", operator: "in", value: photoIdPayload },
          ],
          selectAfterWrite: true,
          columns: "id",
        });
        if (hasRpcError(result)) {
          this.showToastMessage(readRpcError(result, "迁移失败"), "error");
          return;
        }
        movedCount = readRpcRows(result).length;
      } else {
        movedCount = await this.movePhotosToRootViaTempFolder(photoIdPayload);
      }

      if (movedCount <= 0) {
        this.showToastMessage("未迁移任何照片，请刷新后重试", "warning");
        await this.loadPhotos();
        return;
      }

      const targetFolderName = normalizedTargetFolder
        ? folders.find(f => String(f.id) === String(normalizedTargetFolder))?.name || "目标文件夹"
        : this.data.rootFolderName;

      const skippedCount = Math.max(0, photoIdPayload.length - movedCount);
      if (skippedCount > 0) {
        this.showToastMessage(`成功迁移 ${movedCount} 张照片到${targetFolderName}，跳过 ${skippedCount} 张`, "warning");
      } else {
        this.showToastMessage(`成功迁移 ${movedCount} 张照片到${targetFolderName}`, "success");
      }
      this.setData({
        showMoveModal: false,
        selectedPhotoIds: []
      });
      await this.loadPhotos();
      if (shouldInvalidatePublicGalleryCache(this.data)) {
        markGalleryCacheDirty();
      }
    } catch (error) {
      console.error("迁移失败:", error);
      this.showToastMessage(String((error && error.message) || "迁移失败"), "error");
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  async onTogglePhotoVisibility(e) {
    if (this.data.actionLoading || this.data.isSelectionMode) return;
    if (!this.data.isSystemAlbum) return;

    const photoId =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.photoId || "").trim()
        : "";
    if (!photoId) return;

    const target =
      (Array.isArray(this.data.photos) ? this.data.photos : []).find((item) => String(item.id) === photoId) || null;
    if (!target) {
      this.showToastMessage("照片不存在或已删除", "warning");
      return;
    }

    const nextPublic = !normalizeDbBoolean(target.is_public, true);
    this.setData({ actionLoading: true });
    try {
      const result = await dbQuery({
        table: "album_photos",
        action: "update",
        values: { is_public: nextPublic ? 1 : 0 },
        filters: [
          { column: "id", operator: "eq", value: photoId },
          { column: "album_id", operator: "eq", value: this.data.albumId },
        ],
        selectAfterWrite: true,
        maybeSingle: true,
        columns: "id,is_public",
      });
      if (hasRpcError(result)) {
        this.showToastMessage(readRpcError(result, nextPublic ? "恢复公开失败" : "隐藏失败"), "error");
        return;
      }

      const nextPhotos = (Array.isArray(this.data.photos) ? this.data.photos : []).map((item) => {
        if (String(item.id) !== photoId) return item;
        return Object.assign({}, item, {
          is_public: nextPublic,
        });
      });
      this.setData({ photos: nextPhotos }, () => this.updateFilteredPhotos());
      if (shouldInvalidatePublicGalleryCache(this.data)) {
        markGalleryCacheDirty();
      }
      this.showToastMessage(nextPublic ? "照片已恢复公开" : "照片已隐藏", "success");
    } catch (error) {
      console.error("更新照片可见性失败:", error);
      this.showToastMessage(readErrorMessage(error, nextPublic ? "恢复公开失败" : "隐藏失败"), "error");
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  // 删除照片
  onDeletePhoto(e) {
    const photoId = e.currentTarget.dataset.photoId;
    const photo = this.data.photos.find(p => String(p.id) === String(photoId));
    if (photo) {
      this.setData({ deletingPhoto: photo });
    }
  },

  onCancelDeletePhoto() {
    this.setData({ deletingPhoto: null });
  },

  async onConfirmDeletePhoto() {
    const { deletingPhoto } = this.data;
    if (!deletingPhoto) return;

    this.setData({ actionLoading: true });

    try {
      let result = await dbQuery({
        table: "album_photos",
        action: "delete",
        filters: [
          { column: "id", operator: "eq", value: deletingPhoto.id },
          { column: "album_id", operator: "eq", value: this.data.albumId },
        ],
        selectAfterWrite: true,
        maybeSingle: true,
        columns: "id,url,thumbnail_url,preview_url,original_url",
      });
      if (hasRpcError(result) && isColumnMissingError(readRpcError(result, "鍒犻櫎澶辫触"), "url")) {
        result = await dbQuery({
          table: "album_photos",
          action: "delete",
          filters: [
            { column: "id", operator: "eq", value: deletingPhoto.id },
            { column: "album_id", operator: "eq", value: this.data.albumId },
          ],
          selectAfterWrite: true,
          maybeSingle: true,
          columns: "id,thumbnail_url,preview_url,original_url",
        });
      }

      if (!hasRpcError(result)) {
        const deleted = readRpcRecord(result);
        if (!deleted) {
          this.showToastMessage("未删除任何照片，请刷新后重试", "warning");
          await this.loadPhotos();
          return;
        }
        const cleanup = await cleanupStorageTargets([
          deleted.url,
          deleted.thumbnail_url,
          deleted.preview_url,
          deleted.original_url,
        ]);
        if (cleanup && cleanup.ok === false) {
          this.showToastMessage(`照片记录已删除，但文件清理失败：${cleanup.warning || "请稍后处理"}`, "warning");
        } else {
          this.showToastMessage("照片已删除", "success");
        }
        this.setData({ deletingPhoto: null });
        await this.loadPhotos();
        if (shouldInvalidatePublicGalleryCache(this.data)) {
          markGalleryCacheDirty();
        }
      } else {
        this.showToastMessage(readRpcError(result, "删除失败"), "error");
      }
    } catch (error) {
      console.error("删除照片失败:", error);
      this.showToastMessage("删除失败", "error");
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  // 批量删除
  onBatchDelete() {
    const { selectedPhotoIds } = this.data;
    if (selectedPhotoIds.length === 0) {
      this.showToastMessage("请先选择照片", "warning");
      return;
    }
    this.setData({ showBatchDeleteConfirm: true });
  },

  onCancelBatchDelete() {
    this.setData({ showBatchDeleteConfirm: false });
  },

  async onConfirmBatchDelete() {
    if (this.data.actionLoading) return;
    const { selectedPhotoIds } = this.data;
    this.setData({ showBatchDeleteConfirm: false });

    const photoIdPayload = selectedPhotoIds
      .map(id => {
        const matched = this.data.photos.find(photo => String(photo.id) === String(id));
        return matched ? matched.id : id;
      })
      .filter(id => id !== null && id !== undefined && String(id).trim() !== "");
    if (!photoIdPayload.length) {
      this.showToastMessage("未找到可删除的照片", "warning");
      return;
    }

    this.setData({ actionLoading: true });
    try {
      let result = await dbQuery({
        table: "album_photos",
        action: "delete",
        filters: [
          { column: "album_id", operator: "eq", value: this.data.albumId },
          { column: "id", operator: "in", value: photoIdPayload },
        ],
        selectAfterWrite: true,
        columns: "id,url,thumbnail_url,preview_url,original_url",
      });
      if (hasRpcError(result) && isColumnMissingError(readRpcError(result, "鍒犻櫎澶辫触"), "url")) {
        result = await dbQuery({
          table: "album_photos",
          action: "delete",
          filters: [
            { column: "album_id", operator: "eq", value: this.data.albumId },
            { column: "id", operator: "in", value: photoIdPayload },
          ],
          selectAfterWrite: true,
          columns: "id,thumbnail_url,preview_url,original_url",
        });
      }

      if (!hasRpcError(result)) {
        const deletedList = readRpcRows(result).filter((row) => row && typeof row === "object");
        if (deletedList.length <= 0) {
          this.showToastMessage("未删除任何照片，请刷新后重试", "warning");
          await this.loadPhotos();
          return;
        }
        const cleanupTargets = [];
        deletedList.forEach((photo) => {
          cleanupTargets.push(photo && photo.url);
          cleanupTargets.push(photo && photo.thumbnail_url);
          cleanupTargets.push(photo && photo.preview_url);
          cleanupTargets.push(photo && photo.original_url);
        });
        const cleanup = await cleanupStorageTargets(
          cleanupTargets
        );
        if (cleanup && cleanup.ok === false) {
          this.showToastMessage(
            `成功删除 ${deletedList.length} 张照片，但文件清理失败：${cleanup.warning || "请稍后处理"}`,
            "warning"
          );
        } else {
          this.showToastMessage(`成功删除 ${deletedList.length} 张照片`, "success");
        }
        this.setData({
          selectedPhotoIds: [],
          isSelectionMode: false
        });
        await this.loadPhotos();
        if (shouldInvalidatePublicGalleryCache(this.data)) {
          markGalleryCacheDirty();
        }
      } else {
        this.showToastMessage(readRpcError(result, "删除失败"), "error");
      }
    } catch (error) {
      console.error("批量删除失败:", error);
      this.showToastMessage("批量删除失败", "error");
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  // 图片预览（使用微信原生预览器）
  onPreviewPhoto(e) {
    const photoId =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.photoId || "")
        : "";
    if (!photoId) return;

    const sourceRows =
      Array.isArray(this.data.filteredPhotos) && this.data.filteredPhotos.length > 0
        ? this.data.filteredPhotos
        : Array.isArray(this.data.photos)
          ? this.data.photos
          : [];

    const normalizedRows = sourceRows
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const id = String(item.id || "").trim();
        const url = String(
          item.original_url || item.preview_url || item.thumbnail_url || item.url || ""
        ).trim();
        if (!id || !url) return null;
        return { id, url };
      })
      .filter(Boolean);

    const matched = normalizedRows.find((item) => item.id === photoId);
    if (!matched || !matched.url) {
      this.showToastMessage("预览失败：图片地址无效", "warning");
      return;
    }

    const urls = Array.from(new Set(normalizedRows.map((item) => item.url).filter(Boolean)));
    const finalUrls = urls.includes(matched.url) ? urls : [matched.url].concat(urls);

    wx.previewImage({
      current: matched.url,
      urls: finalUrls.length ? finalUrls : [matched.url],
      fail: () => {
        this.showToastMessage("打开微信预览失败，请稍后重试", "warning");
      },
    });
  },

  onClosePreview() {
    this.setData({ previewPhoto: null });
  },

  // Toast 提示
  showToastMessage(message, type = "success") {
    this.setData({
      showToast: true,
      toastMessage: message,
      toastType: type
    });

    setTimeout(() => {
      this.setData({ showToast: false });
    }, 3000);
  },

  // 阻止事件冒泡
  onStopPropagation() {
    // 阻止事件冒泡
  }
};

const { data, onLoad, onUnload, ...methods } = pageDefinition;

Component({
  data,
  lifetimes: {
    attached() {
      const options = {
        id: SYSTEM_GALLERY_ALBUM_ID,
        title: encodeURIComponent("照片墙管理"),
        key: "PUBLIC_GALLERY",
      };
      if (typeof onLoad === "function") {
        onLoad.call(this, options);
      }
    },
    detached() {
      if (typeof onUnload === "function") {
        onUnload.call(this);
      }
    },
  },
  methods,
});
