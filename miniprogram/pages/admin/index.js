const {
  requireAdminSession,
  getAdminDashboardStats,
  listAdminUsers,
  toggleAdminUserDisabled,
  deleteAdminUser,
  runAdminMaintenanceTasks,
  listAdminBlockedDates,
  createAdminBlockedDate,
  deleteAdminBlockedDate,
  listAdminBookingTypes,
  saveAdminBookingType,
  toggleAdminBookingType,
  deleteAdminBookingType,
  listAdminRecentBookings,
  updateAdminBookingStatus,
  deleteAdminBookings,
  createAdminPose,
  listAdminPoses,
  deleteAdminPose,
  listAdminPoseTags,
  moveAdminPoseTag,
  createAdminPoseTags,
  updateAdminPoseTag,
  deleteAdminPoseTag,
  deleteAdminPoseTags,
  updateAdminPoseTags,
  listAdminGalleryPhotos,
  createAdminGalleryPhoto,
  setAdminGalleryPhotoPublic,
  deleteAdminGalleryPhoto,
  listAdminAlbums,
  createAdminAlbum,
  updateAdminAlbumFields,
  updateAdminAlbumAccessKey,
  uploadAdminAlbumCover,
  uploadAdminAlbumDonationQr,
  deleteAdminAlbum,
  createAdminRelease,
  listAdminReleases,
  deleteAdminRelease,
  listAdminAllowedCities,
  saveAdminAllowedCity,
  toggleAdminAllowedCity,
  deleteAdminAllowedCity,
  getAdminAboutSettings,
  saveAdminAboutSettings,
  uploadAdminAboutDonationQr,
  clearAdminAboutDonationQr,
  listAdminBetaRoutes,
  saveAdminBetaRoute,
  deleteAdminBetaRoute,
  listAdminBetaVersions,
  saveAdminBetaVersion,
  deleteAdminBetaVersion,
  generateAdminBetaFeatureCode,
  clearAdminSessionCache,
} = require("../../services/photo-admin-api");
const { logout, requestJson } = require("../../services/photo-api");
const { clearStoredCookie } = require("../../utils/auth");
const { normalizeChinaMobile, isValidChinaMobile } = require("../../utils/phone");
const { resolvePublicUrl } = require("../../utils/storage-url");
const {
  saveTransientPageState,
  loadTransientPageState,
  clearTransientPageState,
} = require("../../utils/transient-page-state");
const runtimeConfig = require("../../config");

const BOOKING_STATUS_OPTIONS = [
  { value: "pending", label: "待确认" },
  { value: "confirmed", label: "已确认" },
  { value: "in_progress", label: "进行中" },
  { value: "finished", label: "已完成" },
  { value: "cancelled", label: "已取消" },
];
const RELEASE_PLATFORM_OPTIONS = ["Android", "iOS", "HarmonyOS", "Windows", "MacOS", "Linux"];
const RELEASE_ALLOWED_EXTENSIONS = [
  ".apk",
  ".ipa",
  ".exe",
  ".dmg",
  ".zip",
  ".deb",
  ".rpm",
  ".appimage",
  ".tar.gz",
];
const MAX_RELEASE_FILE_SIZE = 100 * 1024 * 1024;
const ALBUM_COVER_TARGET_SIZE = 900 * 1024;
const ALBUM_COVER_MAX_LONG_EDGE = 1920;
const ALBUM_COVER_COMPRESS_QUALITIES = [86, 78, 70, 62];
const ADMIN_GALLERY_UPLOAD_DRAFT_KEY = "admin_gallery_upload_draft_v1";
const ADMIN_GALLERY_UPLOAD_DRAFT_TTL_MS = 30 * 60 * 1000;
const FIXED_PUBLIC_ORIGIN = "https://guangyao666.xyz";
function resolveAppPublicUrl() {
  return FIXED_PUBLIC_ORIGIN;
}

const ADMIN_SECTION_META = {
  stats: {
    title: "数据统计 📊",
    desc: "实时查看平台运营数据",
  },
  poses: {
    title: "摆姿管理 📸",
    desc: "管理拍照姿势库和标签",
  },
  bookings: {
    title: "预约管理 📅",
    desc: "管理用户预约申请",
  },
  schedule: {
    title: "档期管理",
    desc: "管理不可预约日期，支持批量锁定",
  },
  gallery: {
    title: "照片墙管理",
    desc: "管理公开展示照片",
  },
  albums: {
    title: "专属空间管理 💝",
    desc: "管理专属返图空间",
  },
  about: {
    title: "关于设置 ℹ️",
    desc: "管理用户端关于页面展示信息",
  },
  releases: {
    title: "发布版本 📦",
    desc: "管理应用安装包发布",
  },
  webPages: {
    title: "Web 页面管理",
    desc: "管理 Web 端页面发布与入口",
  },
  miniprogramPages: {
    title: "小程序页面管理",
    desc: "管理小程序页面发布与入口",
  },
};

ADMIN_SECTION_META.users = {
  title: "用户管理 👥",
  desc: "查看全部用户并执行账号禁用、删除等操作",
};

const ADMIN_NAV_ITEMS = [
  { key: "stats", label: "数据统计", desc: "运营概览", icon: "📊" },
  { key: "poses", label: "摆姿管理", desc: "姿势与标签", icon: "📸" },
  { key: "bookings", label: "预约管理", desc: "预约与城市", icon: "📅" },
  { key: "schedule", label: "档期管理", desc: "锁档日期", icon: "🗓️" },
  { key: "gallery", label: "照片墙管理", desc: "公开图集", icon: "🖼️" },
  { key: "albums", label: "专属空间管理", desc: "返图空间", icon: "💝" },
  { key: "about", label: "关于设置", desc: "作者信息", icon: "ℹ️" },
  { key: "releases", label: "发布版本", desc: "安装包发布", icon: "📦" },
  { key: "webPages", label: "Web 页面管理", desc: "Web 端页面发布与入口", icon: "🌐" },
  { key: "miniprogramPages", label: "小程序页面管理", desc: "小程序页面发布与入口", icon: "📱" },
];

const BOOKING_PANEL_TABS = [
  { key: "bookings", label: "预约列表" },
  { key: "types", label: "约拍类型" },
  { key: "cities", label: "城市管理" },
];
const BOOKING_FILTER_OPTIONS = [
  { key: "all", label: "全部" },
  { key: "pending", label: "待确认" },
  { key: "confirmed", label: "已确认" },
  { key: "in_progress", label: "进行中" },
  { key: "finished", label: "已完成" },
  { key: "cancelled", label: "已取消" },
];
const ALBUM_FILTER_OPTIONS = [
  { key: "all", label: "全部" },
  { key: "expiring", label: "即将到期" },
  { key: "expired", label: "已过期" },
  { key: "no_cover", label: "无封面" },
  { key: "welcome_off", label: "无欢迎信" },
];
const WELCOME_LETTER_MODE_OPTIONS = [
  { value: "envelope", label: "拆信封欢迎信", description: "进入空间后自动展示拆信封欢迎信。" },
  { value: "stamp", label: "右下角印章欢迎信", description: "在页面右下角显示印章入口，点击后查看欢迎信。" },
  { value: "none", label: "无欢迎信", description: "进入空间后不展示欢迎信入口。" },
];
const BETA_PRESET_ROUTE_OPTIONS = [
  { route_path: "/pages/index/index", route_title: "摆姿推荐" },
  { route_path: "/pages/gallery/index", route_title: "照片墙" },
  { route_path: "/pages/album/index", route_title: "相册提取" },
  { route_path: "/pages/profile/index", route_title: "我的" },
  { route_path: "/pages/booking/index", route_title: "约拍" },
  { route_path: "/pages/admin/index", route_title: "后台管理" },
];

function readErrorMessage(error, fallback) {
  if (error && typeof error === "object") {
    const message = error.message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  return String(fallback || "请求失败");
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
    const directMessage = String(current.message || "").trim();
    if (directMessage) return directMessage;

    const directError = current.error;
    if (typeof directError === "string" && directError.trim()) {
      return directError.trim();
    }
    if (directError && typeof directError === "object") {
      const nestedErrorMessage = String(directError.message || "").trim();
      if (nestedErrorMessage) return nestedErrorMessage;
    }

    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }
  return String(fallback || "请求失败");
}

function readArrayFromPayloadChain(payload, fields) {
  const keys = Array.isArray(fields) ? fields : [fields];
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") break;
    for (let i = 0; i < keys.length; i += 1) {
      const key = String(keys[i] || "").trim();
      if (!key || !Object.prototype.hasOwnProperty.call(current, key)) continue;
      const value = current[key];
      if (Array.isArray(value)) {
        return value;
      }
    }
    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }
  return [];
}

function resolvePayloadObjectByKeys(payload, keys) {
  const fields = Array.isArray(keys) ? keys : [keys];
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) break;
    for (let i = 0; i < fields.length; i += 1) {
      const key = String(fields[i] || "").trim();
      if (key && Object.prototype.hasOwnProperty.call(current, key)) {
        return current;
      }
    }
    const next = current.data;
    if (!next || typeof next !== "object" || Array.isArray(next) || next === current) break;
    current = next;
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload;
  }
  return {};
}

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

function getUTC8DateParts(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    weekday: shifted.getUTCDay(),
  };
}

function formatDateTime(value) {
  const date = parseDateTimeUTC8(value);
  if (!date) return String(value || "");
  const parts = getUTC8DateParts(date);
  if (!parts) return String(value || "");
  return `${parts.year}/${pad2(parts.month)}/${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`;
}

function formatDateDisplay(value) {
  const date = parseDateTimeUTC8(value);
  if (!date) return "";
  const parts = getUTC8DateParts(date);
  if (!parts) return "";
  return `${parts.year}/${pad2(parts.month)}/${pad2(parts.day)}`;
}

function toStatusLabel(status) {
  const matched = BOOKING_STATUS_OPTIONS.find((item) => item.value === status);
  return matched ? matched.label : String(status || "");
}

function toStatusBadgeLabel(status) {
  switch (String(status || "").trim()) {
    case "pending":
      return "⏳ 待确认";
    case "confirmed":
      return "✓ 已确认";
    case "in_progress":
      return "📸 进行中";
    case "finished":
      return "✨ 已完成";
    case "cancelled":
      return "✕ 已取消";
    default:
      return toStatusLabel(status);
  }
}

function isBookingDeletable(status) {
  return String(status || "").trim() === "finished" || String(status || "").trim() === "cancelled";
}

function normalizeBookingKeyword(value) {
  return String(value || "").trim().toLowerCase();
}

function buildBookingSearchText(booking) {
  const row = booking && typeof booking === "object" ? booking : {};
  const raw = [
    row.id,
    row.userDisplay,
    row.user_name,
    row.userEmail,
    row.user_email,
    row.phoneDisplay,
    row.phone,
    row.user_phone,
    row.wechatDisplay,
    row.wechat,
    row.typeDisplay,
    row.type_name,
    row.cityDisplay,
    row.city_name,
    row.locationDisplay,
    row.location,
    row.bookingDateDisplay,
    row.booking_date,
    row.notesDisplay,
    row.notes,
    row.statusText,
    row.statusPlainText,
    row.createdAtText,
  ];

  return raw
    .map((item) => String(item || "").trim().toLowerCase())
    .filter(Boolean)
    .join(" ");
}

function inferCityMetaFromLocation(location) {
  const normalized = String(location || "").replace(/\s+/g, "");
  if (!normalized) {
    return { cityName: "", province: "" };
  }

  const provinceMatch = normalized.match(/([\u4e00-\u9fa5]{2,}?(?:省|自治区|特别行政区))/);
  const municipalityMatch = normalized.match(/(北京市|上海市|天津市|重庆市)/);
  const cityLikeMatch = normalized.match(/([\u4e00-\u9fa5]{2,}?(?:自治州|地区|盟|市))/);

  if (municipalityMatch) {
    const cityName = municipalityMatch[1];
    return {
      cityName,
      province: provinceMatch ? provinceMatch[1] : cityName,
    };
  }

  return {
    cityName: cityLikeMatch ? cityLikeMatch[1] : "",
    province: provinceMatch ? provinceMatch[1] : "",
  };
}

function normalizeRegionKeyword(value) {
  return String(value || "").replace(/\s+/g, "").trim();
}

function normalizeCityKeyword(value) {
  return normalizeRegionKeyword(value).replace(
    /(?:特别行政区|壮族自治区|回族自治区|维吾尔自治区|自治区|自治州|地区|盟|州|市)$/,
    ""
  );
}

function normalizeProvinceKeyword(value) {
  return normalizeRegionKeyword(value).replace(
    /(?:特别行政区|壮族自治区|回族自治区|维吾尔自治区|自治区|省|市)$/,
    ""
  );
}

function isAdministrativeNameMatched(inputValue, rowValue, type) {
  const source = normalizeRegionKeyword(inputValue);
  const target = normalizeRegionKeyword(rowValue);
  if (!source || !target) return false;
  if (source.includes(target) || target.includes(source)) return true;

  const normalize =
    String(type || "").trim() === "province"
      ? normalizeProvinceKeyword
      : normalizeCityKeyword;
  const normalizedSource = normalize(source);
  const normalizedTarget = normalize(target);
  if (!normalizedSource || !normalizedTarget) return false;
  return (
    normalizedSource.includes(normalizedTarget) ||
    normalizedTarget.includes(normalizedSource)
  );
}

function buildCitySearchKeywords(cityName, province) {
  const cityText = normalizeRegionKeyword(cityName);
  const provinceText = normalizeRegionKeyword(province);
  const cityCore = normalizeCityKeyword(cityText);
  const provinceCore = normalizeProvinceKeyword(provinceText);

  const keywords = [];
  const addKeyword = (value) => {
    const text = normalizeRegionKeyword(value);
    if (!text || keywords.includes(text)) return;
    keywords.push(text);
  };

  if (provinceText && cityText) {
    addKeyword(`${provinceText}${cityText}`);
  }
  addKeyword(cityText);
  addKeyword(cityCore);
  if (cityCore && !cityCore.endsWith("市")) {
    addKeyword(`${cityCore}市`);
  }

  addKeyword(provinceText);
  addKeyword(provinceCore);
  if (provinceText && cityCore) {
    addKeyword(`${provinceText}${cityCore}`);
  }
  if (provinceCore && cityText) {
    addKeyword(`${provinceCore}${cityText}`);
  }
  if (provinceCore && cityCore) {
    addKeyword(`${provinceCore}${cityCore}`);
  }

  return keywords;
}

function isValidCoordinatePair(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90) return false;
  if (lng < -180 || lng > 180) return false;
  if (Math.abs(lat) < 0.000001 && Math.abs(lng) < 0.000001) return false;
  return true;
}

function readAdcodeValue(input) {
  const data = input && typeof input === "object" ? input : {};
  const adInfo = data.ad_info && typeof data.ad_info === "object" ? data.ad_info : {};
  const addressComponent =
    data.address_component && typeof data.address_component === "object"
      ? data.address_component
      : data.addressComponent && typeof data.addressComponent === "object"
        ? data.addressComponent
        : {};

  return String(
    data.adcode ||
      data.city_code ||
      data.cityCode ||
      data.citycode ||
      adInfo.adcode ||
      adInfo.citycode ||
      addressComponent.adcode ||
      addressComponent.citycode ||
      ""
  ).trim();
}

function pickFileNameFromPath(path, fallbackName) {
  const matched = String(path || "").match(/[^\\/]+$/);
  if (matched && matched[0]) {
    return matched[0];
  }
  return String(fallbackName || `upload_${Date.now()}`);
}

function getLocalFileSize(path) {
  const filePath = String(path || "").trim();
  if (!filePath) return Promise.resolve(0);
  return new Promise((resolve) => {
    wx.getFileInfo({
      filePath,
      success: (res) => {
        const size = Number((res && res.size) || 0);
        resolve(Number.isFinite(size) && size > 0 ? size : 0);
      },
      fail: () => resolve(0),
    });
  });
}

function readImageInfo(path) {
  const src = String(path || "").trim();
  if (!src) return Promise.resolve(null);
  return new Promise((resolve) => {
    wx.getImageInfo({
      src,
      success: (res) => resolve(res || null),
      fail: () => resolve(null),
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
  const ratio = maxEdge / longEdge;
  return {
    width: Math.max(1, Math.round(w * ratio)),
    height: Math.max(1, Math.round(h * ratio)),
  };
}

function compressImageFile(path, quality, maxLongEdge) {
  const src = String(path || "").trim();
  const q = Math.max(1, Math.min(100, Number(quality || 0) || 80));
  if (!src) return Promise.resolve("");
  const maxEdge = Math.max(0, Number(maxLongEdge || 0));
  return readImageInfo(src)
    .then((info) => {
      const options = {
        src,
        quality: q,
      };
      const compressedSize = buildCompressedSize(info && info.width, info && info.height, maxEdge);
      if (compressedSize) {
        options.compressedWidth = compressedSize.width;
        options.compressedHeight = compressedSize.height;
      }
      return new Promise((resolve) => {
        wx.compressImage({
          ...options,
          success: (res) => {
            const nextPath = String((res && res.tempFilePath) || "").trim();
            resolve(nextPath || "");
          },
          fail: () => resolve(""),
        });
      });
    })
    .then((resultPath) => {
      if (resultPath) {
        return resultPath;
      }
      return new Promise((resolve) => {
        wx.compressImage({
          src,
          quality: q,
          success: (res) => {
            const nextPath = String((res && res.tempFilePath) || "").trim();
            resolve(nextPath || "");
          },
          fail: () => resolve(""),
        });
      });
    });
}

async function optimizeAlbumCoverPath(path) {
  const filePath = String(path || "").trim();
  if (!filePath) {
    return {
      path: "",
      compressed: false,
      notice: "",
    };
  }

  let bestPath = "";
  let bestSize = 0;

  for (let i = 0; i < ALBUM_COVER_COMPRESS_QUALITIES.length; i += 1) {
    // 从原图压缩，避免多次有损叠加导致画质劣化。
    // eslint-disable-next-line no-await-in-loop
    const compressedPath = await compressImageFile(
      filePath,
      ALBUM_COVER_COMPRESS_QUALITIES[i],
      ALBUM_COVER_MAX_LONG_EDGE
    );
    if (!compressedPath) continue;

    // eslint-disable-next-line no-await-in-loop
    const compressedSize = await getLocalFileSize(compressedPath);
    if (!bestPath) {
      bestPath = compressedPath;
      bestSize = compressedSize;
    } else if (compressedSize > 0 && (bestSize <= 0 || compressedSize < bestSize)) {
      bestPath = compressedPath;
      bestSize = compressedSize;
    }

    if (compressedSize > 0 && compressedSize <= ALBUM_COVER_TARGET_SIZE) {
      break;
    }
  }

  if (!bestPath) {
    return {
      path: filePath,
      compressed: false,
      notice: "封面压缩失败，已自动回退原图",
    };
  }

  return {
    path: bestPath,
    compressed: true,
    notice: "",
  };
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

function normalizePoseTagsInput(input) {
  const source = String(input || "").trim();
  if (!source) return [];
  const dedup = new Map();
  source
    .split(/[,，]/g)
    .map((item) => item.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .forEach((item) => {
      const key = item.toLowerCase();
      if (!dedup.has(key)) {
        dedup.set(key, item);
      }
    });
  return Array.from(dedup.values());
}

function normalizePoseTagsList(tagsInput) {
  if (!Array.isArray(tagsInput)) return [];
  return tagsInput
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function buildPoseTagStats(poseTags, poses) {
  const tagRows = Array.isArray(poseTags) ? poseTags : [];
  const normalizedRows = tagRows
    .map((row, index) => {
      const id = Number((row && row.id) || 0);
      const name = String((row && row.name) || "").trim();
      const usageCount = Number((row && row.usage_count) || 0);
      const sortOrderRaw = Number(row && row.sort_order);
      const sortOrder =
        Number.isFinite(sortOrderRaw) && sortOrderRaw > 0
          ? Math.round(sortOrderRaw)
          : (index + 1) * 10;
      return {
        id,
        name,
        usage_count: Number.isFinite(usageCount) ? usageCount : 0,
        sort_order: sortOrder,
      };
    })
    .filter((item) => item.id > 0 && item.name);

  if (normalizedRows.length > 0) {
    return normalizedRows.sort((a, b) => {
      if (a.sort_order !== b.sort_order) {
        return a.sort_order - b.sort_order;
      }
      if (b.usage_count !== a.usage_count) {
        return b.usage_count - a.usage_count;
      }
      return String(a.name).localeCompare(String(b.name), "zh-CN");
    });
  }

  const poseRows = Array.isArray(poses) ? poses : [];
  const counter = new Map();
  poseRows.forEach((pose) => {
    const tags = normalizePoseTagsList(pose && pose.tags);
    tags.forEach((tag) => {
      const key = tag.toLowerCase();
      const current = counter.get(key) || { name: tag, usage_count: 0 };
      current.usage_count += 1;
      if (!current.name) current.name = tag;
      counter.set(key, current);
    });
  });

  return Array.from(counter.values())
    .sort((a, b) => {
      if (b.usage_count !== a.usage_count) {
        return b.usage_count - a.usage_count;
      }
      return String(a.name).localeCompare(String(b.name), "zh-CN");
    })
    .map((item, index) => ({
      id: -1 - index,
      name: item.name,
      usage_count: Number(item.usage_count || 0),
      virtual: true,
    }));
}

function normalizePoseSelectedIds(selectedIds, poses) {
  const ids = Array.isArray(selectedIds) ? selectedIds : [];
  const poseRows = Array.isArray(poses) ? poses : [];
  const validSet = new Set(poseRows.map((item) => Number(item && item.id)).filter((id) => Number.isFinite(id) && id > 0));
  return ids
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0 && validSet.has(id));
}

function normalizePoseTagSelectedIds(selectedIds, poseTags) {
  const ids = Array.isArray(selectedIds) ? selectedIds : [];
  const tagRows = Array.isArray(poseTags) ? poseTags : [];
  const validSet = new Set(
    tagRows.map((item) => Number(item && item.id)).filter((id) => Number.isFinite(id) && id > 0)
  );
  return ids
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0 && validSet.has(id));
}

function isReleaseFileAllowed(fileName) {
  const lowerName = String(fileName || "").trim().toLowerCase();
  if (!lowerName) return false;
  return RELEASE_ALLOWED_EXTENSIONS.some((suffix) => lowerName.endsWith(suffix));
}

function toReleasePlatformClass(platform) {
  switch (String(platform || "").trim()) {
    case "Android":
      return "release-chip--android";
    case "iOS":
      return "release-chip--ios";
    case "HarmonyOS":
      return "release-chip--harmony";
    case "Windows":
      return "release-chip--windows";
    case "MacOS":
      return "release-chip--macos";
    case "Linux":
      return "release-chip--linux";
    default:
      return "release-chip--default";
  }
}

function normalizeDbBoolean(value, fallback) {
  if (value === undefined || value === null) return Boolean(fallback);
  if (value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true") {
    return true;
  }
  return false;
}

function normalizeBetaRoutePath(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const normalized = raw.startsWith("/") ? raw : `/${raw}`;
  return normalized.slice(0, 255);
}

function buildBetaRoutePresetRows(currentRoutePath) {
  const normalizedCurrent = normalizeBetaRoutePath(currentRoutePath);
  const rows = BETA_PRESET_ROUTE_OPTIONS.map((item) => ({
    route_path: normalizeBetaRoutePath(item && item.route_path),
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

function resolveBetaRoutePresetState(routePath, presetRows) {
  const rows = Array.isArray(presetRows) ? presetRows : [];
  if (!rows.length) {
    return {
      index: 0,
      previewTitle: "",
      previewPath: "",
      presetTitle: "",
    };
  }
  const normalizedPath = normalizeBetaRoutePath(routePath);
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

function buildDefaultBetaRouteForm() {
  const presetRows = buildBetaRoutePresetRows("");
  const firstRoute = presetRows[0] || null;
  return {
    id: 0,
    route_path: firstRoute ? firstRoute.route_path : "",
    route_title: firstRoute ? firstRoute.route_title : "",
    route_description: "",
    is_active: true,
  };
}

function buildDefaultBetaVersionForm(routes) {
  const rows = Array.isArray(routes) ? routes : [];
  const firstRoute = rows.length > 0 ? rows[0] : null;
  return {
    id: "",
    feature_name: "",
    feature_description: "",
    feature_code: generateAdminBetaFeatureCode(),
    route_id: firstRoute ? Number(firstRoute.id || 0) : 0,
    is_active: true,
    has_expiry: false,
    expires_date: "",
  };
}

function isBetaRouteDuplicateMessage(message) {
  const text = String(message || "").trim().toLowerCase();
  if (!text) return false;
  return (
    text.includes("duplicate") ||
    text.includes("already exists") ||
    text.includes("unique") ||
    text.includes("已存在")
  );
}

function toSafeNumber(value, fallback) {
  const num = Number(value);
  if (Number.isFinite(num)) return num;
  return Number(fallback || 0);
}

function toSafeText(value, fallback) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  if (text) return text;
  return String(fallback || "");
}

function formatMonthDay(value) {
  const date = parseDateTimeUTC8(value);
  if (!date) return String(value || "");
  const parts = getUTC8DateParts(date);
  if (!parts) return String(value || "");
  return `${parts.month}月${parts.day}日`;
}

function formatDateOnly(value) {
  const date = parseDateTimeUTC8(value);
  if (!date) return String(value || "");
  const parts = getUTC8DateParts(date);
  if (!parts) return String(value || "");
  return `${parts.year}/${pad2(parts.month)}/${pad2(parts.day)}`;
}

function normalizeAlbumAccessKey(input) {
  return String(input || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
}

function generateAlbumAccessKey() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let key = "";
  for (let i = 0; i < 8; i += 1) {
    const idx = Math.floor(Math.random() * chars.length);
    key += chars.charAt(idx);
  }
  return key;
}

function getDateAfterDaysText(days) {
  const safeDays = Math.max(1, Number(days || 1));
  const date = new Date(Date.now() + safeDays * 24 * 60 * 60 * 1000);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getDateTimeAfterDaysText(days) {
  const safeDays = Math.max(1, Number(days || 1));
  const date = new Date(Date.now() + safeDays * 24 * 60 * 60 * 1000);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d} 23:59:59`;
}

function getTodayDateText() {
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getDateDiffDays(startDateText, endDateText) {
  const start = parseIsoDateOnly(startDateText);
  const end = parseIsoDateOnly(endDateText);
  if (!start || !end) return 0;
  const diff = Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
  return Number.isFinite(diff) ? diff : 0;
}

function extractDateText(value) {
  const raw = String(value || "").trim();
  const matched = raw.match(/^\d{4}-\d{2}-\d{2}/);
  return matched ? matched[0] : "";
}

function buildAlbumAccessLink(accessKey) {
  const key = normalizeAlbumAccessKey(accessKey);
  if (!key) return "";
  return `${resolveAppPublicUrl()}/album/${encodeURIComponent(key)}`;
}

function buildAlbumQrUrl(accessKey) {
  const link = buildAlbumAccessLink(accessKey);
  if (!link) return "";
  return `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(link)}`;
}

function isValidEmailText(value) {
  const text = String(value || "").trim();
  if (!text) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
}

function sanitizeAboutSettings(input) {
  const source = input && typeof input === "object" ? input : {};
  const phoneRaw = String(source.phone || "").trim();
  const authorMessageRaw = String(source.author_message == null ? "" : source.author_message);
  const authorMessageText = authorMessageRaw.trim();
  const normalizedAuthorMessageText = authorMessageText.toLowerCase();
  return {
    id: Number(source.id || 0),
    author_name: String(source.author_name || "").trim(),
    phone: phoneRaw ? normalizeChinaMobile(phoneRaw) : "",
    wechat: String(source.wechat || "").trim(),
    email: String(source.email || "").trim(),
    donation_qr_code: String(source.donation_qr_code || "").trim(),
    author_message:
      authorMessageText &&
      normalizedAuthorMessageText !== "null" &&
      normalizedAuthorMessageText !== "undefined" &&
      normalizedAuthorMessageText !== "nil" &&
      normalizedAuthorMessageText !== "none"
        ? authorMessageRaw.replace(/\r\n/g, "\n")
        : "",
  };
}

function buildTextareaMirrorText(value) {
  const normalized = String(value == null ? "" : value).replace(/\r\n/g, "\n");
  return normalized ? `${normalized}\u200b` : " ";
}

function buildAboutSettingsPatch(input) {
  const aboutSettings = sanitizeAboutSettings(input);
  return {
    aboutSettings,
    aboutAuthorMessageMirrorText: buildTextareaMirrorText(aboutSettings.author_message),
  };
}

function normalizePositiveIdList(values) {
  const source = Array.isArray(values) ? values : [];
  const idSet = new Set();
  source.forEach((item) => {
    const id = Number(item || 0);
    if (id > 0) {
      idSet.add(id);
    }
  });
  return Array.from(idSet.values());
}

function buildSelectableListState(rows, selectedIds) {
  const list = Array.isArray(rows) ? rows : [];
  const listIdSet = new Set(
    list
      .map((item) => Number(item && item.id))
      .filter((id) => id > 0)
  );
  const nextSelectedIds = normalizePositiveIdList(selectedIds).filter((id) => listIdSet.has(id));
  const selectedSet = new Set(nextSelectedIds);
  return {
    rows: list.map((item) =>
      Object.assign({}, item, {
        selected: selectedSet.has(Number(item && item.id)),
      })
    ),
    selectedIds: nextSelectedIds,
    selectedCount: nextSelectedIds.length,
    totalCount: list.length,
    allSelected: list.length > 0 && nextSelectedIds.length === list.length,
  };
}

function matchAlbumFilter(item, filterKey) {
  const key = String(filterKey || "all").trim() || "all";
  if (key === "expiring") return Boolean(item && item.expirySoon && !item.expired);
  if (key === "expired") return Boolean(item && item.expired);
  if (key === "no_cover") return !Boolean(item && item.hasCover);
  if (key === "welcome_off") return String((item && item.welcome_letter_mode) || "") === "none";
  return true;
}

function normalizeWelcomeLetterMode(mode, enabledFallback) {
  const normalized = String(mode || "").trim().toLowerCase();
  if (normalized === "envelope" || normalized === "stamp" || normalized === "none") {
    return normalized;
  }
  return enabledFallback === false ? "none" : "envelope";
}

function getWelcomeLetterModeLabel(mode) {
  const match = WELCOME_LETTER_MODE_OPTIONS.find((item) => item.value === mode);
  return match ? match.label : "拆信封欢迎信";
}

function matchAlbumKeyword(item, keyword) {
  const normalizedKeyword = String(keyword || "").trim().toLowerCase();
  if (!normalizedKeyword) return true;
  const searchText = [
    item && item.title,
    item && item.access_key,
    item && item.recipient_name,
    item && item.welcome_letter,
    item && item.welcome_letter_mode_label,
  ]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return searchText.includes(normalizedKeyword);
}

function parseIsoDateOnly(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function toIsoDateOnly(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildIsoDateRange(startDateText, endDateText) {
  const start = parseIsoDateOnly(startDateText);
  const end = parseIsoDateOnly(endDateText || startDateText);
  if (!start || !end) return null;

  const startMs = start.getTime();
  const endMs = end.getTime();
  if (endMs < startMs) return [];

  const rows = [];
  for (let current = startMs; current <= endMs; current += 24 * 60 * 60 * 1000) {
    rows.push(toIsoDateOnly(new Date(current)));
  }
  return rows;
}

function formatScheduleDateLabel(value) {
  const date = parseIsoDateOnly(value);
  if (!date) return String(value || "");
  const parts = getUTC8DateParts(date);
  if (!parts) return String(value || "");
  return `${parts.year}年${parts.month}月${parts.day}日`;
}

function formatScheduleWeekdayLabel(value) {
  const date = parseIsoDateOnly(value);
  if (!date) return "";
  const parts = getUTC8DateParts(date);
  if (!parts) return "";
  const weeks = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  return weeks[parts.weekday] || "";
}

function formatScheduleShortLabel(value) {
  const date = parseIsoDateOnly(value);
  if (!date) return "暂无";
  const parts = getUTC8DateParts(date);
  if (!parts) return "暂无";
  return `${parts.month}/${parts.day}`;
}

function getTodayIsoDateOnly() {
  const parts = getUTC8DateParts(new Date());
  if (!parts) return "";
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function getIsoDateAfterDays(dayOffset) {
  const shifted = new Date(Date.now() + Number(dayOffset || 0) * 24 * 60 * 60 * 1000);
  const parts = getUTC8DateParts(shifted);
  if (!parts) return "";
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function isDuplicateDateError(error) {
  const message = readErrorMessage(error, "").toLowerCase();
  return (
    message.includes("duplicate") ||
    message.includes("already exists") ||
    message.includes("已存在") ||
    message.includes("重复")
  );
}

function createStatCard(key, title, value, icon, colorStart, colorEnd, subtitle) {
  return {
    key: String(key || ""),
    title: String(title || ""),
    value,
    icon: String(icon || ""),
    colorStart: String(colorStart || "#FFC857"),
    colorEnd: String(colorEnd || "#FFB347"),
    subtitle: String(subtitle || ""),
    action: String(key || "") === "users-total" ? "users" : "",
  };
}

function mapStatsSourceLabel(source) {
  const map = {
    analytics_daily: "趋势快照",
    app_releases: "版本发布",
    booking_blackouts: "档期屏蔽",
    booking_types: "预约类型",
    pose_tags: "摆姿标签",
    allowed_cities: "预约城市",
    photo_comments: "照片评论",
    user_active_logs: "活跃日志",
  };
  return map[String(source || "").trim()] || String(source || "").trim();
}

function createEmptyStatsMeta() {
  return {
    snapshotDateText: "",
    trendCoverageText: "0/7 天",
    statusText: "暂无统计快照",
    statusTone: "muted",
  };
}

function createEmptyStatsView() {
  return {
    userCards: [],
    albumCards: [],
    photoCardsPrimary: [],
    photoCardsSecondary: [],
    bookingCardsPrimary: [],
    bookingCardsSecondary: [],
    poseCards: [],
    systemCards: [],
    bookingTypeStats: [],
    poseTopTags: [],
    latestVersion: null,
    trendNewUsers: [],
    trendActiveUsers: [],
    trendNewBookings: [],
    meta: createEmptyStatsMeta(),
  };
}

function normalizeAdminUserRow(row, currentUserId) {
  const source = row && typeof row === "object" ? row : {};
  const id = String((source && source.id) || "").trim();
  if (!id) {
    return null;
  }

  const role = String((source && source.role) || "").trim() === "admin" ? "admin" : "user";
  const isDisabled = Number((source && (source.isDisabled || source.is_disabled)) || 0) > 0
    || Boolean(source && (source.isDisabled === true || source.is_disabled === true));
  const name = String((source && source.name) || "").trim();
  const phone = String((source && source.phone) || "").trim();
  const email = String((source && source.email) || "").trim();
  const wechat = String((source && source.wechat) || "").trim();
  const displayName = name || phone || email || wechat || `用户 ${id.slice(0, 8)}`;
  const isCurrentAdmin = String(currentUserId || "").trim() === id;

  return {
    id,
    name,
    phone,
    email,
    wechat,
    displayName,
    role,
    roleText: role === "admin" ? "管理员" : "普通用户",
    isDisabled,
    statusText: isDisabled ? "已禁用" : "正常",
    disabledAtText: formatDateTime(source && (source.disabledAt || source.disabled_at)),
    createdAtText: formatDateTime(source && (source.createdAt || source.created_at)),
    lastActiveAtText: formatDateTime(source && (source.lastActiveAt || source.last_active_at)),
    lastSessionAtText: formatDateTime(source && (source.lastSessionAt || source.last_session_at)),
    albumCount: toSafeNumber(source && (source.albumCount || source.album_count), 0),
    bookingCount: toSafeNumber(source && (source.bookingCount || source.booking_count), 0),
    canManage: role !== "admin" && !isCurrentAdmin,
    isCurrentAdmin,
  };
}

function buildStatsMeta(stats) {
  const data = stats && typeof stats === "object" ? stats : {};
  const meta = data.meta && typeof data.meta === "object" ? data.meta : {};
  const snapshotDateText = formatDateOnly(meta.snapshot_latest_date);
  const trendDaysExpected = Math.max(0, toSafeNumber(meta.trend_days_expected, 7));
  const trendDaysAvailable = Math.max(0, toSafeNumber(meta.trend_days_available, 0));
  const snapshotLagDays = meta.snapshot_lag_days === null || meta.snapshot_lag_days === undefined
    ? null
    : Math.max(0, toSafeNumber(meta.snapshot_lag_days, 0));
  const unavailableSources = Array.isArray(meta.unavailable_sources)
    ? meta.unavailable_sources.map((item) => toSafeText(item, "")).filter(Boolean)
    : [];
  const unavailableSourcesText = unavailableSources.map(mapStatsSourceLabel).join("、");
  const snapshotStatus = toSafeText(meta.snapshot_status, "");
  const trendCoverageText = `${trendDaysAvailable}/${trendDaysExpected || 7} 天`;

  if (unavailableSourcesText) {
    return {
      snapshotDateText,
      trendCoverageText,
      statusText: `部分统计源不可用：${unavailableSourcesText}`,
      statusTone: "warning",
    };
  }

  if (snapshotStatus === "unavailable") {
    return {
      snapshotDateText,
      trendCoverageText,
      statusText: "趋势快照表不可用",
      statusTone: "warning",
    };
  }

  if (snapshotStatus === "empty" || trendDaysAvailable <= 0) {
    return {
      snapshotDateText,
      trendCoverageText,
      statusText: "暂无趋势快照，建议执行维护任务",
      statusTone: "muted",
    };
  }

  if (snapshotLagDays !== null && snapshotLagDays > 0) {
    return {
      snapshotDateText,
      trendCoverageText,
      statusText: `趋势快照落后 ${snapshotLagDays} 天，建议执行维护任务`,
      statusTone: "warning",
    };
  }

  if (trendDaysExpected > 0 && trendDaysAvailable < trendDaysExpected) {
    return {
      snapshotDateText,
      trendCoverageText,
      statusText: `最近 ${trendDaysExpected} 天趋势仅覆盖 ${trendDaysAvailable} 天`,
      statusTone: "warning",
    };
  }

  return {
    snapshotDateText,
    trendCoverageText,
    statusText: "统计数据已同步",
    statusTone: "fresh",
  };
}

function buildStatsView(stats) {
  const data = stats && typeof stats === "object" ? stats : {};
  const users = data.users || {};
  const albums = data.albums || {};
  const photos = data.photos || {};
  const bookings = data.bookings || {};
  const poses = data.poses || {};
  const system = data.system || {};
  const trends = data.trends || {};
  const meta = buildStatsMeta(data);

  const bookingTypeStats = Array.isArray(bookings.types)
    ? bookings.types.map((item, index) => ({
        key: `booking-type-${index}`,
        name: toSafeText(item && item.type_name, "未命名类型"),
        count: toSafeNumber(item && item.count, 0),
      }))
    : [];

  const poseTopTags = Array.isArray(poses.top_tags)
    ? poses.top_tags.map((item, index) => ({
        key: `pose-tag-${index}`,
        rank: index + 1,
        tagName: toSafeText(item && item.tag_name, "未命名标签"),
        usageCount: toSafeNumber(item && item.usage_count, 0),
      }))
    : [];

  let latestVersion = null;
  if (system.latest_version) {
    if (typeof system.latest_version === "string") {
      latestVersion = {
        version: toSafeText(system.latest_version, "-"),
        platform: "",
        createdAtText: "",
      };
    } else {
      latestVersion = {
        version: toSafeText(system.latest_version.version, "-"),
        platform: toSafeText(system.latest_version.platform, ""),
        createdAtText: formatDateTime(system.latest_version.created_at),
      };
    }
  }

  const trendNewUsers = Array.isArray(trends.daily_new_users)
    ? trends.daily_new_users.map((item, index) => ({
        key: `trend-user-${index}`,
        dateLabel: formatMonthDay(item && item.date),
        count: toSafeNumber(item && item.count, 0),
      }))
    : [];

  const trendActiveUsers = Array.isArray(trends.daily_active_users)
    ? trends.daily_active_users.map((item, index) => ({
        key: `trend-active-${index}`,
        dateLabel: formatMonthDay(item && item.date),
        count: toSafeNumber(item && item.count, 0),
      }))
    : [];

  const trendNewBookings = Array.isArray(trends.daily_new_bookings)
    ? trends.daily_new_bookings.map((item, index) => ({
        key: `trend-booking-${index}`,
        dateLabel: formatMonthDay(item && item.date),
        count: toSafeNumber(item && item.count, 0),
      }))
    : [];

  return {
    userCards: [
      createStatCard("users-total", "总用户数", toSafeNumber(users.total, 0), "👥", "#FFC857", "#FFB347", ""),
      createStatCard("users-regular", "普通用户", toSafeNumber(users.regular_users, 0), "🙋", "#FF9A3C", "#FF8C42", ""),
      createStatCard("users-new", "今日新增", toSafeNumber(users.new_today, 0), "➕", "#FFB347", "#FFA500", ""),
      createStatCard("users-active", "今日活跃", toSafeNumber(users.active_today, 0), "⚡", "#FFA500", "#FF8C00", ""),
    ],
    albumCards: [
      createStatCard("albums-total", "总相册数", toSafeNumber(albums.total, 0), "📁", "#8B7355", "#6D5A4A", ""),
      createStatCard(
        "albums-active",
        "有效空间",
        Math.max(0, toSafeNumber(albums.total, 0) - toSafeNumber(albums.expired, 0)),
        "🧩",
        "#9C8063",
        "#8B7355",
        ""
      ),
      createStatCard("albums-new", "今日新增", toSafeNumber(albums.new_today, 0), "🆕", "#A0826D", "#8B7355", ""),
      createStatCard("albums-expired", "已过期", toSafeNumber(albums.expired, 0), "⏰", "#B8956A", "#A0826D", ""),
    ],
    photoCardsPrimary: [
      createStatCard("photos-total", "总照片数", toSafeNumber(photos.total, 0), "🖼️", "#7B68EE", "#6A5ACD", ""),
      createStatCard("photos-new", "今日新增", toSafeNumber(photos.new_today, 0), "📸", "#9370DB", "#8A2BE2", ""),
      createStatCard("photos-public", "公开照片", toSafeNumber(photos.public, 0), "👁️", "#BA55D3", "#9370DB", "照片墙展示"),
      createStatCard("photos-private", "私密照片", toSafeNumber(photos.private, 0), "🔒", "#DA70D6", "#BA55D3", "专属空间"),
    ],
    photoCardsSecondary: [
      createStatCard("photos-views", "总浏览量", toSafeNumber(photos.total_views, 0), "👁️", "#4169E1", "#1E90FF", ""),
      createStatCard("photos-likes", "总点赞数", toSafeNumber(photos.total_likes, 0), "❤️", "#FF69B4", "#FF1493", ""),
      createStatCard("photos-downloads", "总下载数", toSafeNumber(photos.total_downloads, 0), "⬇️", "#4DB6AC", "#26A69A", ""),
      createStatCard(
        "photos-stories",
        "故事照片",
        toSafeNumber(photos.with_story, 0),
        "↻",
        "#8D6E63",
        "#6D4C41",
        `高亮 ${toSafeNumber(photos.highlighted, 0)}`
      ),
    ],
    bookingCardsPrimary: [
      createStatCard("bookings-total", "总预约数", toSafeNumber(bookings.total, 0), "📅", "#20B2AA", "#008B8B", ""),
      createStatCard("bookings-new", "今日新增", toSafeNumber(bookings.new_today, 0), "🆕", "#48D1CC", "#20B2AA", ""),
      createStatCard("bookings-pending", "待处理", toSafeNumber(bookings.pending, 0), "⏳", "#FFA500", "#FF8C00", ""),
      createStatCard("bookings-confirmed", "已确认", toSafeNumber(bookings.confirmed, 0), "✅", "#32CD32", "#228B22", ""),
    ],
    bookingCardsSecondary: [
      createStatCard("bookings-in-progress", "进行中", toSafeNumber(bookings.in_progress, 0), "⚡", "#1E90FF", "#4169E1", ""),
      createStatCard("bookings-finished", "已完成", toSafeNumber(bookings.finished, 0), "✔️", "#00FA9A", "#00FF7F", ""),
      createStatCard("bookings-cancelled", "已取消", toSafeNumber(bookings.cancelled, 0), "❌", "#DC143C", "#B22222", ""),
    ],
    poseCards: [
      createStatCard("poses-total", "总摆姿数", toSafeNumber(poses.total, 0), "📸", "#FF6347", "#FF4500", ""),
      createStatCard("poses-new", "今日新增", toSafeNumber(poses.new_today, 0), "🆕", "#FF7F50", "#FF6347", ""),
      createStatCard("poses-views", "总浏览量", toSafeNumber(poses.total_views, 0), "👁️", "#FFA07A", "#FF7F50", ""),
      createStatCard("poses-tags", "总标签数", toSafeNumber(poses.total_tags, 0), "🏷️", "#FFB6C1", "#FFA07A", ""),
    ],
    systemCards: [
      createStatCard("system-cities", "允许预约城市", toSafeNumber(system.total_cities, 0), "🏙️", "#4682B4", "#4169E1", ""),
      createStatCard("system-blackout", "档期锁定", toSafeNumber(system.total_blackout_dates, 0), "📅", "#5F9EA0", "#4682B4", ""),
      createStatCard("system-releases", "版本发布", toSafeNumber(system.total_releases, 0), "📦", "#6495ED", "#5F9EA0", ""),
    ],
    bookingTypeStats,
    poseTopTags,
    latestVersion,
    trendNewUsers,
    trendActiveUsers,
    trendNewBookings,
    meta,
  };
}

Page({
  data: {
    safeTop: 0,
    headerOffsetPx: 56,
    contentTopPx: 72,
    serviceMissing: false,
    mobileMenuOpen: false,
    activeSection: "stats",
    activeSectionTitle: ADMIN_SECTION_META.stats.title,
    activeSectionDesc: ADMIN_SECTION_META.stats.desc,
    adminNavItems: ADMIN_NAV_ITEMS,
    bookingPanelTabs: BOOKING_PANEL_TABS,
    bookingPanelTab: "bookings",

    loading: true,
    authDenied: false,
    adminName: "",
    maintenanceRunning: false,

    statsLoading: true,
    statsRefreshing: false,
    statsError: "",
    statsReady: false,
    statsView: createEmptyStatsView(),
    usersLoading: false,
    usersRefreshing: false,
    usersError: "",
    usersReady: false,
    currentAdminUserId: "",
    usersList: [],
    userActionLoading: false,
    userActionTargetId: "",
    userDeleteConfirmOpen: false,
    userDeletingTargetId: "",
    userDeletingTargetName: "",

    blockedDatesLoading: false,
    blockedDatesRefreshing: false,
    blockedDatesError: "",
    blockedDatesReady: false,
    blockedDates: [],
    scheduleRows: [],
    scheduleAddModalOpen: false,
    scheduleStartDate: "",
    scheduleEndDate: "",
    scheduleReason: "",
    scheduleSubmitting: false,
    scheduleSelectionMode: false,
    scheduleSelectedIds: [],
    scheduleSelectedCount: 0,
    scheduleTotalCount: 0,
    scheduleAllSelected: false,
    scheduleUpcomingCount: 0,
    scheduleReasonCount: 0,
    scheduleNearestDateLabel: "暂无",
    scheduleNearestDateDesc: "当前没有未来锁定日期",
    scheduleActionLoading: false,
    scheduleDeleteConfirmOpen: false,
    scheduleDeletingTargetId: "",
    scheduleDeletingTargetDate: "",
    scheduleBatchDeleteConfirmOpen: false,
    scheduleBatchDeleting: false,

    bookingFilterOptions: BOOKING_FILTER_OPTIONS,
    bookingFilter: "all",
    bookingKeyword: "",
    bookingsLoading: true,
    bookingsRefreshing: false,
    bookingsError: "",
    bookingsReady: false,
    bookings: [],
    bookingFilteredList: [],
    bookingRows: [],
    bookingCurrentPage: 1,
    bookingPageSize: 10,
    bookingVisibleCount: 10,
    bookingTotalPages: 1,
    bookingHasMoreVisible: false,
    bookingUpdatingId: "",
    bookingActionLoading: false,
    bookingSelectionMode: false,
    bookingSelectedIds: [],
    bookingSelectedCount: 0,
    bookingDeletableCount: 0,
    bookingPageDeletableCount: 0,
    bookingAllSelected: false,
    bookingPendingCount: 0,
    bookingActiveCount: 0,
    bookingBatchDeleteConfirmOpen: false,
    bookingBatchDeleting: false,
    bookingDeleteConfirmOpen: false,
    bookingDeletingTargetId: "",
    bookingDeletingTargetSummary: "",
    bookingCancelConfirmOpen: false,
    bookingCancelingTargetId: "",
    bookingLocationPreviewOpen: false,
    bookingLocationPreviewName: "",
    bookingLocationPreviewAddress: "",
    bookingLocationPreviewCoordinateText: "",
    bookingLocationPreviewLatitude: 0,
    bookingLocationPreviewLongitude: 0,
    bookingLocationPreviewMarkers: [],

    bookingTypeForm: {
      id: 0,
      name: "",
      description: "",
    },
    bookingTypeSaving: false,
    bookingTypeTogglingId: 0,
    bookingTypeDeletingId: 0,
    bookingTypesLoading: false,
    bookingTypesRefreshing: false,
    bookingTypesError: "",
    bookingTypesReady: false,
    bookingTypes: [],
    bookingTypeActiveCount: 0,
    bookingTypeInactiveCount: 0,
    bookingTypeModalOpen: false,
    bookingTypeDeleteConfirmOpen: false,
    bookingTypeDeletingTargetId: 0,
    bookingTypeDeletingTargetName: "",
    bookingTypeSelectionMode: false,
    bookingTypeSelectedIds: [],
    bookingTypeSelectedCount: 0,
    bookingTypeAllSelected: false,
    bookingTypeBatchDeleting: false,

    cityForm: {
      id: 0,
      city_name: "",
      province: "",
      city_code: "",
      latitude: "",
      longitude: "",
      is_active: true,
    },
    citySaving: false,
    cityTogglingId: 0,
    cityDeletingId: 0,
    citiesLoading: false,
    citiesRefreshing: false,
    citiesError: "",
    citiesReady: false,
    allowedCities: [],
    cityActiveCount: 0,
    cityInactiveCount: 0,
    cityLocatedCount: 0,
    cityModalOpen: false,
    cityMapPickerOpen: false,
    cityDeleteConfirmOpen: false,
    cityDeletingTargetId: 0,
    cityDeletingTargetName: "",
    citySelectionMode: false,
    citySelectedIds: [],
    citySelectedCount: 0,
    cityAllSelected: false,
    cityBatchDeleting: false,

    aboutLoading: false,
    aboutSaving: false,
    aboutDonationUploading: false,
    aboutDonationModalOpen: false,
    aboutSettings: {
      id: 0,
      author_name: "",
      phone: "",
      wechat: "",
      email: "",
      donation_qr_code: "",
      author_message: "",
    },
    aboutAuthorMessageMirrorText: " ",

    poseCreating: false,
    posesLoading: true,
    posesRefreshing: false,
    posesError: "",
    posesReady: false,
    poseFilePath: "",
    poseFileName: "",
    poseFileSize: 0,
    poseFileSizeText: "",
    poseTagsInput: "",
    poseFormSelectedTags: [],
    poseFormMode: "create",
    poseEditingId: 0,
    posePanelTab: "poses",
    poseCreateModalOpen: false,
    poseSelectionMode: false,
    poseSelectedIds: [],
    poseSelectedCount: 0,
    poseAllSelected: false,
    poseDeleteConfirmOpen: false,
    poseBatchDeleteConfirmOpen: false,
    poseDeletingTargetId: 0,
    poseBatchDeleting: false,
    poseTagsLoading: false,
    poseTagsRefreshing: false,
    poseTagsError: "",
    poseTagsReady: false,
    poseTags: [],
    poseSelectedTags: [],
    poseTagStats: [],
    poseTagUsedCount: 0,
    poseTagUnusedCount: 0,
    poseFormTagOptions: [],
    poseTagSelectionMode: false,
    poseTagSelectedIds: [],
    poseTagSelectedCount: 0,
    poseTagAllSelected: false,
    poseTagModalOpen: false,
    poseTagCreateInput: "",
    poseTagCreating: false,
    poseTagEditModalOpen: false,
    poseTagEditId: 0,
    poseTagEditName: "",
    poseTagUpdating: false,
    poseTagDeleteConfirmOpen: false,
    poseTagDeletingTargetId: 0,
    poseTagDeletingTargetName: "",
    poseTagDeletingId: 0,
    poseTagSortingId: 0,
    poseTagBatchDeleting: false,
    poseTagBatchDeleteConfirmOpen: false,
    poseTagBatchDeleteNamesText: "",
    poseFilteredList: [],
    posePagedList: [],
    poseCurrentPage: 1,
    posePageSize: 10,
    poseVisibleCount: 10,
    poseTotalCount: 0,
    poseTotalPages: 1,
    poseHasMoreVisible: false,
    poseDeletingId: 0,
    poses: [],

    galleryLoading: false,
    galleryPhotos: [],
    galleryFilteredRows: [],
    galleryRows: [],
    galleryAlbumFilterId: "",
    galleryAlbumFilterTitle: "",
    galleryCurrentPage: 1,
    galleryPageSize: 10,
    galleryTotalPages: 1,
    gallerySelectionMode: false,
    gallerySelectedIds: [],
    gallerySelectedCount: 0,
    galleryTotalCount: 0,
    galleryAllSelected: false,
    galleryActionLoading: false,
    galleryDeleteConfirmOpen: false,
    galleryDeletingTargetId: "",
    galleryDeletingTargetAssets: [],
    galleryBatchDeleteConfirmOpen: false,
    galleryBatchDeleting: false,
    galleryUploadModalOpen: false,
    galleryUploadFiles: [],
    galleryUploadSubmitting: false,
    galleryUploadProgressCurrent: 0,
    galleryUploadProgressTotal: 0,

    albumsLoading: false,
    albums: [],
    albumRows: [],
    albumFilterOptions: ALBUM_FILTER_OPTIONS,
    albumFilter: "all",
    albumKeyword: "",
    albumSelectionMode: false,
    albumSelectedIds: [],
    albumSelectedCount: 0,
    albumTotalCount: 0,
    albumAllSelected: false,
    albumSummaryTotalCount: 0,
    albumExpiringCount: 0,
    albumExpiredCount: 0,
    albumNoCoverCount: 0,
    albumBatchDeleteConfirmOpen: false,
    albumBatchDeleting: false,
    albumActionLoading: false,
    albumDeleteConfirmOpen: false,
    albumDeletingTargetId: "",
    albumDeletingTargetTitle: "",
    albumCreateModalOpen: false,
    albumCreating: false,
    albumCreateTitle: "",
    albumCreateRecipientName: "",
    albumCreateWelcomeLetter: "",
    albumCreateAutoKey: true,
    albumCreateAccessKey: "",
    albumCreateEnableTipping: true,
    albumCreateWelcomeLetterMode: "envelope",
    albumCreateEnableFreeze: true,
    albumCreateExpiryMode: "days",
    albumCreateExpiryDays: 7,
    albumCreateExpiryDate: getDateAfterDaysText(7),
    albumCreateCoverPath: "",
    albumCreateCoverPreview: "",
    albumCreateCoverCompressed: false,
    albumCreateDonationQrPath: "",
    albumCreateDonationQrPreview: "",
    albumTitleModalOpen: false,
    albumEditingTitleId: "",
    albumEditingTitleValue: "",
    albumTitleSaving: false,
    albumKeyModalOpen: false,
    albumEditingKeyId: "",
    albumEditingKeyTitle: "",
    albumEditingKeyValue: "",
    albumKeySaving: false,
    albumRecipientModalOpen: false,
    albumEditingRecipientId: "",
    albumEditingRecipientTitle: "",
    albumEditingRecipientName: "",
    albumEditingWelcomeLetter: "",
    albumEditingWelcomeLetterMode: "envelope",
    albumRecipientSaving: false,
    albumExpiryModalOpen: false,
    albumEditingExpiryId: "",
    albumEditingExpiryTitle: "",
    albumExpiryMode: "days",
    albumExpiryDays: 7,
    albumExpiryDate: getDateAfterDaysText(7),
    albumExpirySaving: false,
    albumCoverUpdatingId: "",
    albumCoverModalOpen: false,
    albumCoverTargetId: "",
    albumCoverTargetTitle: "",
    albumCoverCurrentUrl: "",
    albumDonationUpdatingId: "",
    albumDonationModalOpen: false,
    albumDonationTargetId: "",
    albumDonationTargetTitle: "",
    albumDonationCurrentUrl: "",
    albumQrModalOpen: false,
    albumQrAccessKey: "",
    albumQrImageUrl: "",

    releaseMode: "list",
    releasesLoading: false,
    releaseCreating: false,
    releaseVersion: "",
    releasePlatformOptions: RELEASE_PLATFORM_OPTIONS,
    releasePlatformIndex: 0,
    releaseUpdateLog: "",
    releaseForceUpdate: false,
    releaseFilePath: "",
    releaseFileName: "",
    releaseFileSize: 0,
    releaseFileSizeText: "",
    releaseDeleteModalOpen: false,
    releaseDeleteTargetId: 0,
    releaseDeleteTargetVersion: "",
    releaseDeleteTargetPlatform: "",
    releaseDeletingId: 0,
    releases: [],

    betaPanelTab: "versions",
    betaRoutesLoading: false,
    betaVersionsLoading: false,
    betaRouteRows: [],
    betaVersionRows: [],
    betaRouteModalOpen: false,
    betaRouteModalMode: "create",
    betaRouteSaving: false,
    betaRouteForm: buildDefaultBetaRouteForm(),
    betaRoutePresetRows: buildBetaRoutePresetRows(""),
    betaRoutePresetIndex: 0,
    betaRoutePresetPreviewTitle: "",
    betaRoutePresetPreviewPath: "",
    betaRoutePresetLastTitle: "",
    betaRoutePresetOpen: false,
    betaRouteDeleteConfirmOpen: false,
    betaRouteDeletingId: 0,
    betaRouteDeletingTitle: "",
    betaRouteDeleting: false,
    betaVersionModalOpen: false,
    betaVersionModalMode: "create",
    betaVersionSaving: false,
    betaVersionForm: buildDefaultBetaVersionForm([]),
    betaVersionRoutePickerIndex: 0,
    betaVersionRoutePreviewTitle: "",
    betaVersionRoutePreviewPath: "",
    betaVersionRouteOpen: false,
    betaVersionDeleteConfirmOpen: false,
    betaVersionDeletingId: "",
    betaVersionDeletingName: "",
    betaVersionDeleting: false,

    noticeType: "",
    noticeText: "",
    todayDateText: getTodayDateText(),
  },

  onLoad() {
    const app = getApp();
    const globalData = app && app.globalData ? app.globalData : {};
    const safeTop = Number(globalData.statusBarHeight || 0);
    const headerOffsetPx = safeTop + 56;
    const contentTopPx = headerOffsetPx + 16;
    const serviceMissing = !String(globalData.cloudRunService || "").trim();
    this._lastSeenAppEnterSeq = Math.max(0, Number(globalData.appEnterSeq || 0));
    const restoredDraft = loadTransientPageState(ADMIN_GALLERY_UPLOAD_DRAFT_KEY);
    const hasRestoredDraft = Boolean(restoredDraft && typeof restoredDraft === "object");
    this._restoredGalleryUploadDraft = hasRestoredDraft;
    this._statsLoadedOnce = false;
    this._blockedDatesLoadedOnce = false;
    this._bookingsLoadedOnce = false;
    this._bookingTypesLoadedOnce = false;
    this._citiesLoadedOnce = false;
    this._posesLoadedOnce = false;
    this._poseTagsLoadedOnce = false;
    this.setData(Object.assign(
      { safeTop, headerOffsetPx, contentTopPx, serviceMissing },
      hasRestoredDraft ? {
        activeSection: "gallery",
        galleryUploadModalOpen: Boolean(restoredDraft.galleryUploadModalOpen),
        galleryUploadFiles: Array.isArray(restoredDraft.galleryUploadFiles) ? restoredDraft.galleryUploadFiles : [],
        galleryUploadSubmitting: false,
        galleryUploadProgressCurrent: 0,
        galleryUploadProgressTotal: 0,
      } : {}
    ));
  },

  onShow() {
    const app = getApp();
    const appEnterSeq = Math.max(0, Number(app && app.globalData ? app.globalData.appEnterSeq : 0));
    const isForegroundReturn = appEnterSeq > Math.max(0, Number(this._lastSeenAppEnterSeq || 0));
    this._lastSeenAppEnterSeq = appEnterSeq;
    this.syncSectionMeta(this.data.activeSection);
    if (!this.data.serviceMissing) {
      if (this.consumeSuppressBootstrapOnShow()) {
        return;
      }
      if (isForegroundReturn && this.shouldPreserveRuntimeStateOnForegroundReturn()) {
        if (this._restoredGalleryUploadDraft) {
          this._restoredGalleryUploadDraft = false;
          this.showNotice("info", "摆姿数据已部分刷新，其余内容请稍后重试");
        }
        return;
      }
      this.bootstrap();
    } else {
      this.setData({ loading: false });
    }
  },

  onHide() {
    this.persistGalleryUploadDraft();
  },

  onPullDownRefresh() {
    if (this.data.serviceMissing) {
      wx.stopPullDownRefresh();
      return;
    }
    if (!this.data.loading && this.data.activeSection === "stats") {
      void this.refreshStatsSection({ silent: true, stopPullDown: true });
      return;
    }
    if (!this.data.loading && this.data.activeSection === "users") {
      void this.refreshAdminUsersSection({ silent: true, stopPullDown: true });
      return;
    }
    if (!this.data.loading && this.data.activeSection === "poses") {
      void this.refreshPoseSection({ silent: true, stopPullDown: true });
      return;
    }
    if (!this.data.loading && this.data.activeSection === "schedule") {
      void this.refreshScheduleSection({ silent: true, stopPullDown: true });
      return;
    }
    if (!this.data.loading && this.data.activeSection === "bookings") {
      void this.refreshBookingSection({ silent: true, stopPullDown: true });
      return;
    }
    void this.bootstrap();
  },

  onContentScrollToLower() {
    if (this.data.serviceMissing || this.data.loading || this.data.authDenied) return;
    if (this.data.activeSection === "poses") {
      this.loadMorePoseRows();
      return;
    }
    if (this.data.activeSection === "bookings") {
      this.loadMoreBookingRows();
      return;
    }
    if (this.data.activeSection === "gallery") {
      const galleryManager = this.selectComponent("#galleryManager");
      if (galleryManager && typeof galleryManager.loadMorePhotos === "function") {
        galleryManager.loadMorePhotos();
      }
    }
  },

  onUnload() {
    this.persistGalleryUploadDraft();
    this.clearNoticeTimer();
    this.clearBookingSearchTimer();
    this.clearReleaseModeTimer();
  },

  syncSectionMeta(sectionKey) {
    const key = String(sectionKey || "").trim();
    const meta = ADMIN_SECTION_META[key] || ADMIN_SECTION_META.stats;
    this.setData({
      activeSection: ADMIN_SECTION_META[key] ? key : "stats",
      activeSectionTitle: meta.title,
      activeSectionDesc: meta.desc,
    });
  },

  toggleMobileMenu() {
    this.setData({ mobileMenuOpen: !Boolean(this.data.mobileMenuOpen) });
  },

  closeMobileMenu() {
    if (this.data.mobileMenuOpen) {
      this.setData({ mobileMenuOpen: false });
    }
  },

  onSelectSection(e) {
    const key =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.key || "")
        : "";
    if (!ADMIN_SECTION_META[key]) {
      return;
    }

    const patch = {};
    patch.releaseMode = "list";
    patch.releaseDeleteModalOpen = false;
    patch.releaseDeleteTargetId = 0;
    patch.releaseDeleteTargetVersion = "";
    patch.releaseDeleteTargetPlatform = "";
    if (key !== "gallery") {
      patch.galleryAlbumFilterId = "";
      patch.galleryAlbumFilterTitle = "";
      patch.gallerySelectionMode = false;
      patch.gallerySelectedIds = [];
      patch.galleryDeleteConfirmOpen = false;
      patch.galleryDeletingTargetId = "";
      patch.galleryDeletingTargetAssets = [];
      patch.galleryBatchDeleteConfirmOpen = false;
      patch.galleryUploadModalOpen = false;
      patch.galleryUploadFiles = [];
      patch.galleryUploadProgressCurrent = 0;
      patch.galleryUploadProgressTotal = 0;
    }
    if (key !== "bookings") {
      patch.bookingSelectionMode = false;
      patch.bookingSelectedIds = [];
      patch.bookingBatchDeleteConfirmOpen = false;
      patch.bookingDeleteConfirmOpen = false;
      patch.bookingDeletingTargetId = "";
      patch.bookingDeletingTargetSummary = "";
      patch.bookingCancelConfirmOpen = false;
      patch.bookingCancelingTargetId = "";
      patch.bookingLocationPreviewOpen = false;
      patch.bookingLocationPreviewName = "";
      patch.bookingLocationPreviewAddress = "";
      patch.bookingLocationPreviewCoordinateText = "";
      patch.bookingLocationPreviewLatitude = 0;
      patch.bookingLocationPreviewLongitude = 0;
      patch.bookingLocationPreviewMarkers = [];
      patch.bookingTypeModalOpen = false;
      patch.bookingTypeDeleteConfirmOpen = false;
      patch.bookingTypeDeletingTargetId = 0;
      patch.bookingTypeDeletingTargetName = "";
      patch.cityModalOpen = false;
      patch.cityMapPickerOpen = false;
      patch.cityDeleteConfirmOpen = false;
      patch.cityDeletingTargetId = 0;
      patch.cityDeletingTargetName = "";
    }
    if (key !== "schedule") {
      patch.scheduleAddModalOpen = false;
      patch.scheduleStartDate = "";
      patch.scheduleEndDate = "";
      patch.scheduleReason = "";
      patch.scheduleSelectionMode = false;
      patch.scheduleSelectedIds = [];
      patch.scheduleDeleteConfirmOpen = false;
      patch.scheduleDeletingTargetId = "";
      patch.scheduleDeletingTargetDate = "";
      patch.scheduleBatchDeleteConfirmOpen = false;
    }
    if (key !== "poses") {
      patch.poseCreateModalOpen = false;
      patch.poseSelectionMode = false;
      patch.poseSelectedIds = [];
      patch.poseDeleteConfirmOpen = false;
      patch.poseDeletingTargetId = 0;
      patch.poseBatchDeleteConfirmOpen = false;
      patch.poseTagSelectionMode = false;
      patch.poseTagSelectedIds = [];
      patch.poseTagModalOpen = false;
      patch.poseTagEditModalOpen = false;
      patch.poseTagDeleteConfirmOpen = false;
      patch.poseTagDeletingTargetId = 0;
      patch.poseTagDeletingTargetName = "";
      patch.poseTagBatchDeleteConfirmOpen = false;
    }
    if (key !== "albums") {
      patch.albumCreateModalOpen = false;
      patch.albumSelectionMode = false;
      patch.albumSelectedIds = [];
      patch.albumBatchDeleteConfirmOpen = false;
      patch.albumDeleteConfirmOpen = false;
      patch.albumDeletingTargetId = "";
      patch.albumDeletingTargetTitle = "";
      patch.albumTitleModalOpen = false;
      patch.albumEditingTitleId = "";
      patch.albumEditingTitleValue = "";
      patch.albumKeyModalOpen = false;
      patch.albumEditingKeyId = "";
      patch.albumEditingKeyTitle = "";
      patch.albumEditingKeyValue = "";
      patch.albumRecipientModalOpen = false;
      patch.albumEditingRecipientId = "";
      patch.albumEditingRecipientTitle = "";
      patch.albumEditingRecipientName = "";
      patch.albumEditingWelcomeLetter = "";
      patch.albumEditingWelcomeLetterMode = "envelope";
      patch.albumExpiryModalOpen = false;
      patch.albumEditingExpiryId = "";
      patch.albumEditingExpiryTitle = "";
      patch.albumCoverModalOpen = false;
      patch.albumCoverTargetId = "";
      patch.albumCoverTargetTitle = "";
      patch.albumCoverCurrentUrl = "";
      patch.albumDonationModalOpen = false;
      patch.albumDonationTargetId = "";
      patch.albumDonationTargetTitle = "";
      patch.albumDonationCurrentUrl = "";
      patch.albumQrModalOpen = false;
      patch.albumQrAccessKey = "";
      patch.albumQrImageUrl = "";
    }
    if (key !== "about") {
      patch.aboutDonationModalOpen = false;
    }
    if (key !== "users") {
      patch.userDeleteConfirmOpen = false;
      patch.userDeletingTargetId = "";
      patch.userDeletingTargetName = "";
    }
    patch.betaRouteModalOpen = false;
    patch.betaRouteDeleteConfirmOpen = false;
    patch.betaRouteDeletingId = 0;
    patch.betaRouteDeletingTitle = "";
    patch.betaRoutePresetOpen = false;
    patch.betaVersionModalOpen = false;
    patch.betaVersionRouteOpen = false;
    patch.betaVersionDeleteConfirmOpen = false;
    patch.betaVersionDeletingId = "";
    patch.betaVersionDeletingName = "";
    this.syncSectionMeta(key);
    this.closeMobileMenu();
    if (Object.keys(patch).length) {
      this.setData(patch, () => {
        if (key === "about") {
          void this.loadAboutSettings().catch((error) => {
            this.showNotice("error", readErrorMessage(error, "加载关于信息失败"));
          });
        }
      });
    } else if (key === "about") {
      void this.loadAboutSettings().catch((error) => {
        this.showNotice("error", readErrorMessage(error, "加载关于信息失败"));
      });
    }
  },

  onSelectBookingPanelTab(e) {
    const key =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.key || "")
        : "";
    const allowed = BOOKING_PANEL_TABS.some((item) => item.key === key);
    if (!allowed) return;
    const nextState = {
      bookingPanelTab: key,
    };

    if (key !== "bookings") {
      nextState.bookingSelectionMode = false;
      nextState.bookingSelectedIds = [];
      nextState.bookingBatchDeleteConfirmOpen = false;
      nextState.bookingDeleteConfirmOpen = false;
      nextState.bookingDeletingTargetId = "";
      nextState.bookingDeletingTargetSummary = "";
      nextState.bookingCancelConfirmOpen = false;
      nextState.bookingCancelingTargetId = "";
      nextState.bookingLocationPreviewOpen = false;
      nextState.bookingLocationPreviewName = "";
      nextState.bookingLocationPreviewAddress = "";
      nextState.bookingLocationPreviewCoordinateText = "";
      nextState.bookingLocationPreviewLatitude = 0;
      nextState.bookingLocationPreviewLongitude = 0;
      nextState.bookingLocationPreviewMarkers = [];
    }
    if (key !== "types") {
      nextState.bookingTypeModalOpen = false;
      nextState.bookingTypeDeleteConfirmOpen = false;
      nextState.bookingTypeDeletingTargetId = 0;
      nextState.bookingTypeDeletingTargetName = "";
    }
    if (key !== "cities") {
      nextState.cityModalOpen = false;
      nextState.cityMapPickerOpen = false;
      nextState.cityDeleteConfirmOpen = false;
      nextState.cityDeletingTargetId = 0;
      nextState.cityDeletingTargetName = "";
    }

    this.setData(nextState, () => {
      if (key === "bookings") {
        this.refreshBookingModuleView();
      }
    });
  },

  goBack() {
    this.closeMobileMenu();
    wx.navigateBack({
      delta: 1,
      fail: () => {
        wx.switchTab({ url: "/pages/profile/index" });
      },
    });
  },

  async logoutFromAdmin() {
    if (this.data.loading) return;

    wx.showModal({
      title: "确认退出管理后台？",
      content: "退出后将清理当前登录会话，需重新登录才能继续管理内容。",
      success: async (res) => {
        if (!res || !res.confirm) return;
        try {
          await logout();
        } catch (_) {
          // ignore
        } finally {
          clearAdminSessionCache();
          clearStoredCookie();
          this.closeMobileMenu();
          wx.showToast({ title: "已退出登录", icon: "none" });
          setTimeout(() => {
            wx.reLaunch({ url: "/pages/login/index" });
          }, 80);
        }
      },
    });
  },

  clearNoticeTimer() {
    if (this._noticeTimer) {
      clearTimeout(this._noticeTimer);
      this._noticeTimer = null;
    }
  },

  clearBookingSearchTimer() {
    if (this._bookingSearchTimer) {
      clearTimeout(this._bookingSearchTimer);
      this._bookingSearchTimer = null;
    }
  },

  clearReleaseModeTimer() {
    if (this._releaseModeTimer) {
      clearTimeout(this._releaseModeTimer);
      this._releaseModeTimer = null;
    }
  },

  markTransientForegroundReturn(reason) {
    this._suppressBootstrapOnNextShow = true;
    this._suppressBootstrapAt = Date.now();
    this._suppressBootstrapReason = String(reason || "").trim();
  },

  shouldPreserveRuntimeStateOnForegroundReturn() {
    const files = Array.isArray(this.data.galleryUploadFiles) ? this.data.galleryUploadFiles : [];
    const hasHydratedRuntimeState = !this.data.loading && !this.data.serviceMissing;
    return Boolean(this.data.galleryUploadSubmitting)
      || Boolean(this.data.galleryUploadModalOpen)
      || files.length > 0
      || hasHydratedRuntimeState;
  },

  buildGalleryUploadDraftPayload() {
    const files = Array.isArray(this.data.galleryUploadFiles) ? this.data.galleryUploadFiles : [];
    return {
      galleryUploadModalOpen: Boolean(this.data.galleryUploadModalOpen || files.length > 0),
      galleryUploadFiles: files.map((file, index) => {
        const tempFilePath = String((file && file.tempFilePath) || "").trim();
        if (!tempFilePath) return null;
        const size = Math.max(0, Number((file && file.size) || 0));
        return {
          key: String((file && file.key) || `${Date.now()}_${index}`).trim(),
          tempFilePath,
          fileName: String((file && file.fileName) || "").trim(),
          size,
          sizeText: String((file && file.sizeText) || formatFileSize(size) || "").trim(),
          width: Math.max(0, Number((file && file.width) || 0)),
          height: Math.max(0, Number((file && file.height) || 0)),
        };
      }).filter(Boolean),
      wasSubmitting: Boolean(this.data.galleryUploadSubmitting),
    };
  },

  persistGalleryUploadDraft() {
    const files = Array.isArray(this.data.galleryUploadFiles) ? this.data.galleryUploadFiles : [];
    const hasDraft = Boolean(this.data.galleryUploadSubmitting) || files.length > 0;
    if (!hasDraft) {
      clearTransientPageState(ADMIN_GALLERY_UPLOAD_DRAFT_KEY);
      return;
    }
    saveTransientPageState(
      ADMIN_GALLERY_UPLOAD_DRAFT_KEY,
      this.buildGalleryUploadDraftPayload(),
      ADMIN_GALLERY_UPLOAD_DRAFT_TTL_MS
    );
  },

  clearGalleryUploadDraft() {
    clearTransientPageState(ADMIN_GALLERY_UPLOAD_DRAFT_KEY);
    this._restoredGalleryUploadDraft = false;
  },

  consumeSuppressBootstrapOnShow() {
    if (!this._suppressBootstrapOnNextShow) {
      return false;
    }
    const markedAt = Number(this._suppressBootstrapAt || 0);
    const expired = markedAt > 0 && Date.now() - markedAt > 2 * 60 * 1000;
    this._suppressBootstrapOnNextShow = false;
    this._suppressBootstrapAt = 0;
    this._suppressBootstrapReason = "";
    return !expired;
  },

  showNotice(type, text) {
    this.clearNoticeTimer();
    this.setData({
      noticeType: String(type || "info"),
      noticeText: String(text || ""),
    });

    this._noticeTimer = setTimeout(() => {
      this.setData({ noticeType: "", noticeText: "" });
      this._noticeTimer = null;
    }, 3200);
  },

  async safeRefresh(taskList, completedText) {
    const tasks = Array.isArray(taskList) ? taskList : [];
    if (!tasks.length) return "";
    try {
      await Promise.all(tasks);
      return "";
    } catch (error) {
      const message = readErrorMessage(error, "请稍后手动刷新");
      const prefix = String(completedText || "操作已完成");
      this.showNotice("info", `${prefix}，但列表刷新失败：${message}`);
      return message;
    }
  },

  async bootstrap() {
    this.setData({
      loading: true,
      authDenied: false,
      mobileMenuOpen: false,
      noticeType: "",
      noticeText: "",
    });

    try {
      const user = await requireAdminSession();
      const adminName = String(user.name || user.phone || user.email || "管理员");
      this.setData({ adminName });

      await Promise.all([
        this.loadStats({ throwOnError: false }),
        this.loadBlockedDates({ throwOnError: false }),
        this.loadBookingTypes({ throwOnError: false }),
        this.loadAllowedCities({ throwOnError: false }),
        this.loadPoses({ throwOnError: false }),
        this.loadPoseTags({ throwOnError: false }),
        this.loadGalleryPhotos(),
        this.loadAlbums(),
        this.loadReleases(),
        this.loadAboutSettings(),
        this.loadRecentBookings({ throwOnError: false }),
      ]);
    } catch (error) {
      const message = readErrorMessage(error, "管理后台加载失败");
      const authDenied =
        message.includes("无权访问") ||
        message.includes("未登录") ||
        message.includes("仅管理员");
      if (authDenied) {
        clearAdminSessionCache();
      }
      this.setData({
        authDenied,
      });
      this.showNotice("error", message);
    } finally {
      this.setData({ loading: false });
      wx.stopPullDownRefresh();
    }
  },

  async loadStats(options) {
    const config = options && typeof options === "object" ? options : {};
    const shouldThrow = config.throwOnError !== false;
    const shouldShowNotice = Boolean(config.showNotice);
    const hasReadyStats = Boolean(this.data.statsReady);
    const isFirstLoad = !this._statsLoadedOnce && !hasReadyStats;

    this.setData({
      statsLoading: isFirstLoad,
      statsRefreshing: !isFirstLoad && hasReadyStats,
      statsError: "",
    });

    try {
      const stats = await getAdminDashboardStats();
      this._statsLoadedOnce = true;
      this.setData({
        statsLoading: false,
        statsRefreshing: false,
        statsError: "",
        statsReady: true,
        statsView: buildStatsView(stats),
      });
      return stats;
    } catch (error) {
      const message = readErrorMessage(error, "获取数据统计失败");
      const patch = {
        statsLoading: false,
        statsRefreshing: false,
        statsError: message,
        statsReady: hasReadyStats,
      };
      if (!hasReadyStats) {
        patch.statsView = createEmptyStatsView();
      }
      this.setData(patch);
      if (shouldShowNotice) {
        this.showNotice("error", message);
      }
      if (shouldThrow) {
        throw error;
      }
      return null;
    }
  },

  async refreshStatsSection(options) {
    const config = options && typeof options === "object" ? options : {};
    try {
      const stats = await this.loadStats({ throwOnError: false, showNotice: !config.silent });
      if (stats && !config.silent) {
        this.showNotice("success", "摆姿管理已刷新");
      }
    } finally {
      if (config.stopPullDown) {
        wx.stopPullDownRefresh();
      }
    }
  },

  onRefreshStats() {
    if (
      this.data.loading ||
      this.data.statsLoading ||
      this.data.statsRefreshing ||
      this.data.maintenanceRunning
    ) return;
    void this.refreshStatsSection({ silent: false, stopPullDown: false });
  },

  onStatsCardTap(e) {
    const action = e && e.currentTarget && e.currentTarget.dataset
      ? String(e.currentTarget.dataset.action || "").trim()
      : "";
    if (action === "users") {
      this.onOpenAdminUsersSection();
    }
  },

  onOpenAdminUsersSection() {
    if (this.data.loading || this.data.authDenied || this.data.serviceMissing) return;
    this.setData({
      userDeleteConfirmOpen: false,
      userDeletingTargetId: "",
      userDeletingTargetName: "",
    });
    this.syncSectionMeta("users");
    this.closeMobileMenu();
    if (!this.data.usersLoading && !this.data.userActionLoading) {
      void this.loadAdminUsers({ throwOnError: false, showNotice: false });
    }
  },

  onBackToStatsSection() {
    if (this.data.loading || this.data.authDenied || this.data.serviceMissing) return;
    this.setData({
      userDeleteConfirmOpen: false,
      userDeletingTargetId: "",
      userDeletingTargetName: "",
    });
    this.syncSectionMeta("stats");
    this.closeMobileMenu();
  },

  async loadAdminUsers(options) {
    const config = options && typeof options === "object" ? options : {};
    const shouldThrow = config.throwOnError !== false;
    const shouldShowNotice = Boolean(config.showNotice);
    const hasReadyUsers = Boolean(this.data.usersReady);
    const isFirstLoad = !this._usersLoadedOnce && !hasReadyUsers;

    this.setData({
      usersLoading: isFirstLoad,
      usersRefreshing: !isFirstLoad && hasReadyUsers,
      usersError: "",
    });

    try {
      const payload = await listAdminUsers();
      const currentUserId = String((payload && payload.currentUserId) || "").trim();
      const rows = Array.isArray(payload && payload.users) ? payload.users : [];
      const list = rows
        .map((row) => normalizeAdminUserRow(row, currentUserId))
        .filter(Boolean);

      this._usersLoadedOnce = true;
      this.setData({
        usersLoading: false,
        usersRefreshing: false,
        usersError: "",
        usersReady: true,
        currentAdminUserId: currentUserId,
        usersList: list,
      });
      return list;
    } catch (error) {
      const message = readErrorMessage(error, "加载用户列表失败");
      const patch = {
        usersLoading: false,
        usersRefreshing: false,
        usersError: message,
        usersReady: hasReadyUsers,
      };
      if (!hasReadyUsers) {
        patch.usersList = [];
      }
      this.setData(patch);
      if (shouldShowNotice) {
        this.showNotice("error", message);
      }
      if (shouldThrow) {
        throw error;
      }
      return [];
    }
  },

  async refreshAdminUsersSection(options) {
    const config = options && typeof options === "object" ? options : {};
    try {
      const list = await this.loadAdminUsers({ throwOnError: false, showNotice: !config.silent });
      if (Array.isArray(list) && !config.silent) {
        this.showNotice("success", "用户列表已刷新");
      }
    } finally {
      if (config.stopPullDown) {
        wx.stopPullDownRefresh();
      }
    }
  },

  onRefreshAdminUsers() {
    if (
      this.data.loading ||
      this.data.usersLoading ||
      this.data.usersRefreshing ||
      this.data.userActionLoading
    ) return;
    void this.refreshAdminUsersSection({ silent: false, stopPullDown: false });
  },

  async onToggleAdminUserDisabled(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const userId = String((dataset && dataset.id) || "").trim();
    if (!userId) return;
    const currentItem = (Array.isArray(this.data.usersList) ? this.data.usersList : []).find((item) => item.id === userId);
    if (!currentItem || !currentItem.canManage) return;

    const nextDisabled = !Boolean(currentItem.isDisabled);
    this.setData({
      userActionLoading: true,
      userActionTargetId: userId,
    });

    try {
      await toggleAdminUserDisabled(userId, nextDisabled);
      await Promise.all([
        this.loadAdminUsers({ throwOnError: false, showNotice: false }),
        this.loadStats({ throwOnError: false, showNotice: false }),
      ]);
      this.showNotice("success", nextDisabled ? "账号已禁用，并已强制下线该用户" : "账号已恢复启用");
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "更新用户状态失败"));
    } finally {
      this.setData({
        userActionLoading: false,
        userActionTargetId: "",
      });
    }
  },

  onPromptDeleteAdminUser(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const userId = String((dataset && dataset.id) || "").trim();
    if (!userId) return;
    const currentItem = (Array.isArray(this.data.usersList) ? this.data.usersList : []).find((item) => item.id === userId);
    if (!currentItem || !currentItem.canManage) return;

    this.setData({
      userDeleteConfirmOpen: true,
      userDeletingTargetId: userId,
      userDeletingTargetName: currentItem.displayName,
    });
  },

  onCloseAdminUserDeleteConfirm() {
    if (this.data.userActionLoading) return;
    this.setData({
      userDeleteConfirmOpen: false,
      userDeletingTargetId: "",
      userDeletingTargetName: "",
    });
  },

  onUserModalTap() {},

  async confirmDeleteAdminUser() {
    const userId = String(this.data.userDeletingTargetId || "").trim();
    if (!userId) return;

    this.setData({
      userActionLoading: true,
      userActionTargetId: userId,
    });

    try {
      const result = await deleteAdminUser(userId);
      await Promise.all([
        this.loadAdminUsers({ throwOnError: false, showNotice: false }),
        this.loadStats({ throwOnError: false, showNotice: false }),
      ]);
      this.setData({
        userDeleteConfirmOpen: false,
        userDeletingTargetId: "",
        userDeletingTargetName: "",
      });
      const warning = result && typeof result === "object" ? String(result.warning || "").trim() : "";
      this.showNotice(warning ? "info" : "success", warning || "用户账号已删除");
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "删除用户失败"));
    } finally {
      this.setData({
        userActionLoading: false,
        userActionTargetId: "",
      });
    }
  },

  async loadBlockedDates(options) {
    const config = options && typeof options === "object" ? options : {};
    const shouldThrow = config.throwOnError !== false;
    const shouldShowNotice = Boolean(config.showNotice);
    const hasReadyDates = Boolean(this.data.blockedDatesReady);
    const isFirstLoad = !this._blockedDatesLoadedOnce && !hasReadyDates;

    this.setData({
      blockedDatesLoading: isFirstLoad,
      blockedDatesRefreshing: !isFirstLoad && hasReadyDates,
      blockedDatesError: "",
    });

    try {
      const rows = await listAdminBlockedDates();
      const list = (Array.isArray(rows) ? rows : [])
        .map((row) => {
          const date = String((row && (row.date || row.blocked_date || row.day)) || "").trim();
          return {
            id: String((row && row.id) || ""),
            date,
            dateLabel: formatScheduleDateLabel(date),
            weekdayLabel: formatScheduleWeekdayLabel(date),
            reason: String((row && row.reason) || "").trim(),
            createdAtText: formatDateTime(row && row.created_at),
          };
        })
        .filter((item) => item.id && item.date)
        .sort((a, b) => String(a.date).localeCompare(String(b.date), "zh-CN"));

      this._blockedDatesLoadedOnce = true;
      this.setData(
        {
          blockedDatesLoading: false,
          blockedDatesRefreshing: false,
          blockedDatesError: "",
          blockedDatesReady: true,
          blockedDates: list,
        },
        () => {
          this.refreshScheduleModuleView();
        }
      );
      return { ok: true, message: "", list };
    } catch (error) {
      const message = readErrorMessage(error, "加载档期失败");
      const patch = {
        blockedDatesLoading: false,
        blockedDatesRefreshing: false,
        blockedDatesError: message,
        blockedDatesReady: hasReadyDates,
      };
      if (!hasReadyDates) {
        patch.blockedDates = [];
      }
      this.setData(patch, () => {
        this.refreshScheduleModuleView();
      });
      if (shouldShowNotice) {
        this.showNotice(hasReadyDates ? "warning" : "error", message);
      }
      if (shouldThrow) {
        throw error;
      }
      return { ok: false, message };
    }
  },

  async refreshScheduleMutationDependencies() {
    const scheduleResult = await this.loadBlockedDates({ throwOnError: false, showNotice: false });
    const stats = await this.loadStats({ throwOnError: false, showNotice: false });
    const warnings = [];
    if (!scheduleResult || scheduleResult.ok !== true) {
      warnings.push(`列表刷新失败：${scheduleResult && scheduleResult.message ? scheduleResult.message : "请稍后手动刷新"}`);
    }
    if (!stats) {
      warnings.push("数据统计刷新失败，请稍后手动刷新");
    }
    return { scheduleResult, warnings };
  },

  async refreshScheduleSection(options) {
    const config = options && typeof options === "object" ? options : {};
    try {
      const result = await this.loadBlockedDates({ throwOnError: false, showNotice: false });
      if (result && result.ok) {
        if (!config.silent) {
          this.showNotice("success", "档期列表已刷新");
        }
        return result;
      }
      if (!config.silent) {
        this.showNotice(this.data.blockedDatesReady ? "warning" : "error", result && result.message ? result.message : "加载档期失败");
      }
      return result;
    } finally {
      if (config.stopPullDown) {
        wx.stopPullDownRefresh();
      }
    }
  },

  onRefreshScheduleSection() {
    if (
      this.data.loading ||
      this.data.blockedDatesLoading ||
      this.data.blockedDatesRefreshing ||
      this.data.scheduleSubmitting ||
      this.data.scheduleBatchDeleting ||
      this.data.scheduleActionLoading ||
      this.data.maintenanceRunning
    ) return;
    void this.refreshScheduleSection({ silent: false, stopPullDown: false });
  },

  refreshScheduleModuleView() {

    const rows = Array.isArray(this.data.blockedDates) ? this.data.blockedDates : [];
    const today = getTodayIsoDateOnly();
    const upcomingDeadline = getIsoDateAfterDays(6);
    const validIds = rows.map((item) => String((item && item.id) || "")).filter(Boolean);
    const validSet = new Set(validIds);

    const selectedRaw = Array.isArray(this.data.scheduleSelectedIds)
      ? this.data.scheduleSelectedIds
      : [];
    const selectedMap = new Map();
    selectedRaw.forEach((item) => {
      const id = String(item || "").trim();
      if (!id || !validSet.has(id) || selectedMap.has(id)) return;
      selectedMap.set(id, id);
    });

    const selectedIds = Array.from(selectedMap.values());
    const selectedSet = new Set(selectedIds);
    const scheduleRows = rows.map((item) =>
      Object.assign({}, item, {
        selected: selectedSet.has(String((item && item.id) || "")),
      })
    );

    const totalCount = rows.length;
    const selectedCount = selectedIds.length;
    const allSelected = totalCount > 0 && selectedCount === totalCount;
    const upcomingCount = rows.filter((item) => {
      const date = String((item && item.date) || "").trim();
      return Boolean(date) && (!today || date >= today) && (!upcomingDeadline || date <= upcomingDeadline);
    }).length;
    const reasonCount = rows.filter((item) => String((item && item.reason) || "").trim().length > 0).length;
    const nearestItem = rows[0] || null;

    const patch = {
      scheduleRows,
      scheduleSelectedIds: selectedIds,
      scheduleSelectedCount: selectedCount,
      scheduleTotalCount: totalCount,
      scheduleAllSelected: allSelected,
      scheduleUpcomingCount: upcomingCount,
      scheduleReasonCount: reasonCount,
      scheduleNearestDateLabel: nearestItem ? formatScheduleShortLabel(nearestItem.date) : "暂无",
      scheduleNearestDateDesc: nearestItem
        ? `${nearestItem.dateLabel} · ${nearestItem.weekdayLabel}`
        : "当前没有未来锁定日期",
    };

    if (this.data.scheduleSelectionMode && totalCount <= 0) {
      patch.scheduleSelectionMode = false;
      patch.scheduleBatchDeleteConfirmOpen = false;
      patch.scheduleDeleteConfirmOpen = false;
      patch.scheduleDeletingTargetId = "";
      patch.scheduleDeletingTargetDate = "";
    }

    this.setData(patch);
  },

  async loadBookingTypes(options) {
    const config = options && typeof options === "object" ? options : {};
    const shouldThrow = config.throwOnError !== false;
    const shouldShowNotice = Boolean(config.showNotice);
    const hasReadyTypes = Boolean(this.data.bookingTypesReady);
    const isFirstLoad = !this._bookingTypesLoadedOnce && !hasReadyTypes;

    this.setData({
      bookingTypesLoading: isFirstLoad,
      bookingTypesRefreshing: !isFirstLoad && hasReadyTypes,
      bookingTypesError: "",
    });
    try {
      const rows = await listAdminBookingTypes();
      const list = (Array.isArray(rows) ? rows : [])
        .map((row) => {
          const id = Number((row && row.id) || 0);
          const name = String((row && row.name) || "").trim();
          const description = String((row && row.description) || "").trim();
          const isActive = normalizeDbBoolean(row && row.is_active, true);
          return {
            id,
            name,
            description,
            is_active: isActive,
            activeText: isActive ? "启用" : "禁用",
            createdAtText: formatDateTime(row && row.created_at),
          };
        })
        .filter((item) => item.id > 0);

      const bookingTypeActiveCount = list.filter((item) => Boolean(item.is_active)).length;
      const selectionState = buildSelectableListState(list, this.data.bookingTypeSelectedIds);
      this._bookingTypesLoadedOnce = true;
      this.setData({
        bookingTypesLoading: false,
        bookingTypesRefreshing: false,
        bookingTypesError: "",
        bookingTypesReady: true,
        bookingTypes: selectionState.rows,
        bookingTypeActiveCount,
        bookingTypeInactiveCount: Math.max(0, list.length - bookingTypeActiveCount),
        bookingTypeSelectedIds: selectionState.selectedIds,
        bookingTypeSelectedCount: selectionState.selectedCount,
        bookingTypeAllSelected: selectionState.allSelected,
        bookingTypeSelectionMode: selectionState.totalCount > 0 ? Boolean(this.data.bookingTypeSelectionMode) : false,
      });
      return list;
    } catch (error) {
      const message = readErrorMessage(error, "加载预约类型失败");
      const patch = {
        bookingTypesLoading: false,
        bookingTypesRefreshing: false,
        bookingTypesError: message,
        bookingTypesReady: hasReadyTypes,
      };
      if (!hasReadyTypes) {
        patch.bookingTypes = [];
        patch.bookingTypeActiveCount = 0;
        patch.bookingTypeInactiveCount = 0;
        patch.bookingTypeSelectionMode = false;
        patch.bookingTypeSelectedIds = [];
        patch.bookingTypeSelectedCount = 0;
        patch.bookingTypeAllSelected = false;
      }
      this.setData(patch);
      if (shouldShowNotice) {
        this.showNotice("error", message);
      }
      if (shouldThrow) {
        throw error;
      }
      return null;
    }
  },

  async loadAllowedCities(options) {
    const config = options && typeof options === "object" ? options : {};
    const shouldThrow = config.throwOnError !== false;
    const shouldShowNotice = Boolean(config.showNotice);
    const hasReadyCities = Boolean(this.data.citiesReady);
    const isFirstLoad = !this._citiesLoadedOnce && !hasReadyCities;

    this.setData({
      citiesLoading: isFirstLoad,
      citiesRefreshing: !isFirstLoad && hasReadyCities,
      citiesError: "",
    });
    try {
      const rows = await listAdminAllowedCities(200);
      const list = (Array.isArray(rows) ? rows : [])
        .map((row) => {
          const id = Number((row && row.id) || 0);
          const cityName = String((row && row.city_name) || "").trim();
          const province = String((row && row.province) || "").trim();
          const cityCode = String((row && row.city_code) || "").trim();
          const latitudeRaw = row ? row.latitude : "";
          const longitudeRaw = row ? row.longitude : "";
          const latitude = Number(latitudeRaw);
          const longitude = Number(longitudeRaw);
          const hasLocation =
            latitudeRaw !== "" &&
            latitudeRaw !== null &&
            latitudeRaw !== undefined &&
            longitudeRaw !== "" &&
            longitudeRaw !== null &&
            longitudeRaw !== undefined &&
            Number.isFinite(latitude) &&
            Number.isFinite(longitude);
          const isActive = normalizeDbBoolean(row && row.is_active, true);

          return {
            id,
            city_name: cityName,
            province,
            city_code: cityCode,
            latitude: hasLocation ? latitude : "",
            longitude: hasLocation ? longitude : "",
            is_active: isActive,
            activeText: isActive ? "启用" : "禁用",
            locationText: hasLocation ? `${latitude}, ${longitude}` : "未设置坐标",
            createdAtText: formatDateTime(row && row.created_at),
          };
        })
        .filter((item) => item.id > 0);

      const cityActiveCount = list.filter((item) => Boolean(item.is_active)).length;
      const cityLocatedCount = list.filter((item) => {
        const latitude = Number(item && item.latitude);
        const longitude = Number(item && item.longitude);
        return Number.isFinite(latitude) && Number.isFinite(longitude);
      }).length;
      const selectionState = buildSelectableListState(list, this.data.citySelectedIds);
      this._citiesLoadedOnce = true;
      this.setData({
        citiesLoading: false,
        citiesRefreshing: false,
        citiesError: "",
        citiesReady: true,
        allowedCities: selectionState.rows,
        cityActiveCount,
        cityInactiveCount: Math.max(0, list.length - cityActiveCount),
        cityLocatedCount,
        citySelectedIds: selectionState.selectedIds,
        citySelectedCount: selectionState.selectedCount,
        cityAllSelected: selectionState.allSelected,
        citySelectionMode: selectionState.totalCount > 0 ? Boolean(this.data.citySelectionMode) : false,
      });
      return list;
    } catch (error) {
      const message = readErrorMessage(error, "加载城市配置失败");
      const patch = {
        citiesLoading: false,
        citiesRefreshing: false,
        citiesError: message,
        citiesReady: hasReadyCities,
      };
      if (!hasReadyCities) {
        patch.allowedCities = [];
        patch.cityActiveCount = 0;
        patch.cityInactiveCount = 0;
        patch.cityLocatedCount = 0;
        patch.citySelectionMode = false;
        patch.citySelectedIds = [];
        patch.citySelectedCount = 0;
        patch.cityAllSelected = false;
      }
      this.setData(patch);
      if (shouldShowNotice) {
        this.showNotice("error", message);
      }
      if (shouldThrow) {
        throw error;
      }
      return null;
    }
  },

  async loadAboutSettings() {
    this.setData({ aboutLoading: true });
    try {
      const row = await getAdminAboutSettings();
      const donationQrRaw = String((row && row.donation_qr_code) || "").trim();
      const patch = buildAboutSettingsPatch({
        id: Number((row && row.id) || 0),
        author_name: String((row && row.author_name) || "").trim(),
        phone: String((row && row.phone) || "").trim(),
        wechat: String((row && row.wechat) || "").trim(),
        email: String((row && row.email) || "").trim(),
        donation_qr_code: donationQrRaw ? resolvePublicUrl(donationQrRaw) : "",
        author_message: String(row && row.author_message != null ? row.author_message : "").replace(/\r\n/g, "\n"),
      });
      this.setData({
        aboutLoading: false,
        ...patch,
      });
    } catch (error) {
      this.setData({ aboutLoading: false });
      throw error;
    }
  },

  onAboutInput(e) {
    const field =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.field || "").trim()
        : "";
    if (!field) return;
    const value = e && e.detail ? e.detail.value : "";
    const nextSettings = Object.assign({}, this.data.aboutSettings || {}, { [field]: value });
    this.setData(buildAboutSettingsPatch(nextSettings));
  },

  onOpenAboutDonationModal() {
    if (this.data.aboutDonationUploading || this.data.aboutSaving || this.data.aboutLoading) return;
    this.setData({ aboutDonationModalOpen: true });
  },

  onCloseAboutDonationModal() {
    if (this.data.aboutDonationUploading) return;
    this.setData({ aboutDonationModalOpen: false });
  },

  onUploadAboutDonationQr() {
    if (this.data.aboutDonationUploading || this.data.aboutSaving || this.data.aboutLoading) return;

    this.markTransientForegroundReturn("about-donation-choose-media");
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: async (res) => {
        const file = res && Array.isArray(res.tempFiles) ? res.tempFiles[0] : null;
        const filePath = String((file && file.tempFilePath) || "").trim();
        if (!filePath) {
          this.showNotice("error", "读取赞赏码图片失败，请稍后重试");
          return;
        }
        const fileName = pickFileNameFromPath(filePath, `about_donation_${Date.now()}.jpg`);
        this.setData({ aboutDonationUploading: true });
        try {
          const result = await uploadAdminAboutDonationQr(filePath, fileName);
          const uploadedUrlRaw = String((result && result.about && result.about.donation_qr_code) || "").trim();
          const uploadedUrl = uploadedUrlRaw ? resolvePublicUrl(uploadedUrlRaw) : "";
          const nextSettings = Object.assign({}, this.data.aboutSettings || {}, {
            donation_qr_code: uploadedUrl,
          });
          this.setData({
            aboutDonationModalOpen: false,
            ...buildAboutSettingsPatch(nextSettings),
          });
          if (result && result.storageCleanupFailed) {
            this.showNotice("info", `赞赏码已上传，但旧文件清理失败：${result.warning || "请稍后处理"}`);
          } else {
            this.showNotice("success", "赞赏码已上传");
          }
        } catch (error) {
          this.showNotice("error", readErrorMessage(error, "上传赞赏码失败"));
        } finally {
          this.setData({ aboutDonationUploading: false });
        }
      },
      fail: (error) => {
        const message = String((error && error.errMsg) || "").toLowerCase();
        if (message.includes("cancel")) return;
        this.showNotice("error", "选择赞赏码失败，请重试");
      },
    });
  },

  async onClearAboutDonationQr() {
    if (this.data.aboutDonationUploading || this.data.aboutSaving || this.data.aboutLoading) return;
    const currentQr = String(((this.data.aboutSettings || {}).donation_qr_code) || "").trim();
    if (!currentQr) return;

    this.setData({ aboutSaving: true });
    try {
      const result = await clearAdminAboutDonationQr();
      const savedQrRaw = String((result && result.about && result.about.donation_qr_code) || "").trim();
      const savedQr = savedQrRaw ? resolvePublicUrl(savedQrRaw) : "";
      const nextSettings = Object.assign({}, this.data.aboutSettings || {}, {
        donation_qr_code: savedQr,
      });
      this.setData({
        aboutDonationModalOpen: false,
        ...buildAboutSettingsPatch(nextSettings),
      });
      if (result && result.storageCleanupFailed) {
        this.showNotice("info", `赞赏码已清空，但旧文件清理失败：${result.warning || "请稍后处理"}`);
      } else {
        this.showNotice("success", "赞赏码已清空");
      }
      await this.safeRefresh([this.loadAboutSettings()], "赞赏码已清空");
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "清空赞赏码失败"));
    } finally {
      this.setData({ aboutSaving: false });
    }
  },

  async onSaveAboutSettings() {
    if (this.data.aboutSaving || this.data.aboutLoading || this.data.aboutDonationUploading) return;

    const nextSettings = sanitizeAboutSettings(this.data.aboutSettings || {});
    if (nextSettings.phone && !isValidChinaMobile(nextSettings.phone)) {
      this.showNotice("error", "请输入正确的手机号");
      return;
    }
    if (nextSettings.email && !isValidEmailText(nextSettings.email)) {
      this.showNotice("error", "请输入正确的邮箱地址");
      return;
    }

    this.setData({
      aboutSaving: true,
      ...buildAboutSettingsPatch(nextSettings),
    });
    try {
      await saveAdminAboutSettings(nextSettings);
      this.showNotice("success", "关于信息已保存");
      await this.safeRefresh([this.loadAboutSettings()], "关于信息已保存");
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "保存关于信息失败"));
    } finally {
      this.setData({ aboutSaving: false });
    }
  },

  async loadBetaRoutes() {
    this.setData({ betaRoutesLoading: true });
    try {
      const rows = await listAdminBetaRoutes(500);
      const list = (Array.isArray(rows) ? rows : [])
        .map((row) => {
          const routeId = Number(row && row.id);
          const isActive = normalizeDbBoolean(row && row.is_active, true);
          return {
            id: Number.isInteger(routeId) ? routeId : 0,
            route_path: normalizeBetaRoutePath(row && row.route_path),
            route_title: String((row && row.route_title) || "").trim(),
            route_description: String((row && row.route_description) || "").trim(),
            is_active: isActive,
            stateText: isActive ? "启用中" : "已停用",
            stateClass: isActive ? "beta-state--active" : "beta-state--inactive",
          };
        })
        .filter((item) => item.id > 0);

      const currentRouteId = Number(this.data.betaVersionForm && this.data.betaVersionForm.route_id);
      const matchedIndex = list.findIndex((item) => item.id === currentRouteId);
      const safeIndex = list.length > 0 ? (matchedIndex >= 0 ? matchedIndex : 0) : 0;
      const selectedRoute = list[safeIndex] || null;

      const patch = {
        betaRoutesLoading: false,
        betaRouteRows: list,
        betaVersionRoutePickerIndex: safeIndex,
        betaVersionRoutePreviewTitle: selectedRoute ? selectedRoute.route_title : "",
        betaVersionRoutePreviewPath: selectedRoute ? selectedRoute.route_path : "",
        betaVersionRouteOpen: false,
      };
      if (selectedRoute && matchedIndex < 0) {
        patch["betaVersionForm.route_id"] = Number(selectedRoute.id || 0);
      }
      if (!selectedRoute) {
        patch["betaVersionForm.route_id"] = 0;
      }
      this.setData(patch);
    } catch (error) {
      this.setData({ betaRoutesLoading: false });
      throw error;
    }
  },

  async loadBetaVersions() {
    this.setData({ betaVersionsLoading: true });
    try {
      const rows = await listAdminBetaVersions(500);
      const now = Date.now();
      const list = (Array.isArray(rows) ? rows : [])
        .map((row) => {
          const versionId = String((row && row.id) || "").trim();
          if (!versionId) return null;
          const routeId = Number(row && row.route_id);
          const isActive = normalizeDbBoolean(row && row.is_active, true);
          const expiresAt = String((row && row.expires_at) || "").trim();
          const expiresAtDate = parseDateTimeUTC8(expiresAt);
          const isExpired = Boolean(expiresAtDate && expiresAtDate.getTime() < now);

          let stateText = "生效中";
          let stateClass = "beta-state--active";
          if (!isActive) {
            stateText = "已停用";
            stateClass = "beta-state--inactive";
          } else if (isExpired) {
            stateText = "已过期";
            stateClass = "beta-state--expired";
          }

          return {
            id: versionId,
            feature_name: String((row && row.feature_name) || "").trim(),
            feature_description: String((row && row.feature_description) || "").trim(),
            feature_code: String((row && row.feature_code) || "").trim(),
            route_id: Number.isInteger(routeId) ? routeId : 0,
            route_path: normalizeBetaRoutePath(row && row.route_path),
            route_title: String((row && row.route_title) || "").trim(),
            is_active: isActive,
            expires_at: expiresAt,
            expires_date: extractDateText(expiresAt),
            expires_text: expiresAt ? formatDateTime(expiresAt) : "",
            is_expired: isExpired,
            stateText,
            stateClass,
          };
        })
        .filter(Boolean);

      this.setData({
        betaVersionsLoading: false,
        betaVersionRows: list,
      });
    } catch (error) {
      this.setData({ betaVersionsLoading: false });
      throw error;
    }
  },

  async ensureBetaPresetRoutes() {
    const routeRows = Array.isArray(this.data.betaRouteRows) ? this.data.betaRouteRows : [];
    const routePathSet = new Set(
      routeRows.map((item) => normalizeBetaRoutePath(item && item.route_path)).filter(Boolean)
    );
    const presetRows = buildBetaRoutePresetRows("");
    const missingRows = presetRows.filter((item) => {
      const routePath = normalizeBetaRoutePath(item && item.route_path);
      return routePath && !routePathSet.has(routePath);
    });
    if (!missingRows.length) return routeRows;

    for (let i = 0; i < missingRows.length; i += 1) {
      const routeItem = missingRows[i];
      try {
        await saveAdminBetaRoute({
          route_path: normalizeBetaRoutePath(routeItem.route_path),
          route_title: String(routeItem.route_title || "").trim() || "未命名页面",
          route_description: "",
          is_active: true,
        });
      } catch (error) {
        const message = readErrorMessage(error, "新增内测路由失败");
        if (!isBetaRouteDuplicateMessage(message)) {
          throw error;
        }
      }
    }

    await this.loadBetaRoutes();
    return Array.isArray(this.data.betaRouteRows) ? this.data.betaRouteRows : [];
  },

  onBetaPanelTabChange(e) {
    const key =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.key || "")
        : "";
    if (key !== "routes" && key !== "versions") return;
    this.setData({ betaPanelTab: key });
  },

  onOpenCreateBetaRoute() {
    const routePresetRows = buildBetaRoutePresetRows("");
    const presetState = resolveBetaRoutePresetState("", routePresetRows);
    this.setData({
      betaRouteModalOpen: true,
      betaRouteModalMode: "create",
      betaRouteForm: buildDefaultBetaRouteForm(),
      betaRoutePresetRows: routePresetRows,
      betaRoutePresetIndex: presetState.index,
      betaRoutePresetPreviewTitle: presetState.previewTitle,
      betaRoutePresetPreviewPath: presetState.previewPath,
      betaRoutePresetLastTitle: presetState.presetTitle,
      betaRoutePresetOpen: false,
    });
  },

  onOpenEditBetaRoute(e) {
    const routeId =
      e && e.currentTarget && e.currentTarget.dataset
        ? Number(e.currentTarget.dataset.id || 0)
        : 0;
    if (!routeId) return;
    const target = (this.data.betaRouteRows || []).find((item) => item.id === routeId);
    if (!target) return;

    const routePresetRows = buildBetaRoutePresetRows(target.route_path);
    const presetState = resolveBetaRoutePresetState(target.route_path, routePresetRows);
    this.setData({
      betaRouteModalOpen: true,
      betaRouteModalMode: "edit",
      betaRouteForm: {
        id: target.id,
        route_path: target.route_path,
        route_title: target.route_title,
        route_description: target.route_description,
        is_active: target.is_active,
      },
      betaRoutePresetRows: routePresetRows,
      betaRoutePresetIndex: presetState.index,
      betaRoutePresetPreviewTitle: presetState.previewTitle,
      betaRoutePresetPreviewPath: presetState.previewPath,
      betaRoutePresetLastTitle: presetState.presetTitle,
      betaRoutePresetOpen: false,
    });
  },

  onCloseBetaRouteModal(forceClose = false) {
    if (this.data.betaRouteSaving && !forceClose) return;
    this.setData({
      betaRouteModalOpen: false,
      betaRouteModalMode: "create",
      betaRouteForm: buildDefaultBetaRouteForm(),
      betaRoutePresetRows: buildBetaRoutePresetRows(""),
      betaRoutePresetIndex: 0,
      betaRoutePresetPreviewTitle: "",
      betaRoutePresetPreviewPath: "",
      betaRoutePresetLastTitle: "",
      betaRoutePresetOpen: false,
    });
  },

  onBetaRouteInput(e) {
    const field =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.field || "")
        : "";
    if (!field) return;
    const value = e && e.detail ? String(e.detail.value || "") : "";
    this.setData({
      [`betaRouteForm.${field}`]: value,
    });
  },

  onBetaRoutePresetChange(e) {
    const index = e && e.detail ? Number(e.detail.value || 0) : 0;
    this.applyBetaRoutePresetIndex(index);
  },

  applyBetaRoutePresetIndex(index) {
    const rows = Array.isArray(this.data.betaRoutePresetRows) ? this.data.betaRoutePresetRows : [];
    if (!rows.length) return;
    const safeIndex = index >= 0 && index < rows.length ? index : 0;
    const selected = rows[safeIndex] || rows[0];
    const selectedPath = normalizeBetaRoutePath(selected && selected.route_path);
    const selectedTitle = String((selected && selected.route_title) || "").trim();

    const currentTitle = String((this.data.betaRouteForm && this.data.betaRouteForm.route_title) || "").trim();
    const lastPresetTitle = String(this.data.betaRoutePresetLastTitle || "").trim();
    const shouldAutoFillTitle = !currentTitle || currentTitle === lastPresetTitle;

    const patch = {
      betaRoutePresetIndex: safeIndex,
      betaRoutePresetPreviewTitle: selectedTitle,
      betaRoutePresetPreviewPath: selectedPath,
      betaRoutePresetLastTitle: selectedTitle,
      betaRoutePresetOpen: false,
      "betaRouteForm.route_path": selectedPath,
    };
    if (shouldAutoFillTitle) {
      patch["betaRouteForm.route_title"] = selectedTitle;
    }
    this.setData(patch);
  },

  onToggleBetaRoutePresetOpen() {
    if (this.data.betaRouteSaving) return;
    const rows = Array.isArray(this.data.betaRoutePresetRows) ? this.data.betaRoutePresetRows : [];
    if (!rows.length) return;
    this.setData({
      betaRoutePresetOpen: !Boolean(this.data.betaRoutePresetOpen),
    });
  },

  onSelectBetaRoutePreset(e) {
    const index =
      e && e.currentTarget && e.currentTarget.dataset
        ? Number(e.currentTarget.dataset.index || 0)
        : 0;
    this.applyBetaRoutePresetIndex(index);
  },

  onBetaRouteActiveChange(e) {
    this.setData({
      "betaRouteForm.is_active": Boolean(e && e.detail && e.detail.value),
    });
  },

  async onSubmitBetaRoute() {
    if (this.data.betaRouteSaving) return;
    const form = this.data.betaRouteForm || buildDefaultBetaRouteForm();
    const routePath = normalizeBetaRoutePath(form.route_path);
    const routeTitle = String(form.route_title || "").trim();
    if (!routePath) {
      wx.showToast({ title: "请选择功能路由", icon: "none" });
      return;
    }
    if (!routeTitle) {
      wx.showToast({ title: "请输入功能名称", icon: "none" });
      return;
    }

    this.setData({ betaRouteSaving: true });
    try {
      await saveAdminBetaRoute({
        id: Number(form.id || 0),
        route_path: routePath,
        route_title: routeTitle,
        route_description: String(form.route_description || "").trim(),
        is_active: Boolean(form.is_active),
      });
      this.showNotice("success", this.data.betaRouteModalMode === "edit" ? "内测路由已更新" : "内测路由已创建");
      this.onCloseBetaRouteModal(true);
      await Promise.all([this.loadBetaRoutes(), this.loadBetaVersions()]);
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "保存内测路由失败"));
    } finally {
      this.setData({ betaRouteSaving: false });
    }
  },

  onOpenBetaRouteDeleteConfirm(e) {
    const routeId =
      e && e.currentTarget && e.currentTarget.dataset
        ? Number(e.currentTarget.dataset.id || 0)
        : 0;
    if (!routeId) return;
    const target = (this.data.betaRouteRows || []).find((item) => item.id === routeId);
    if (!target) return;
    this.setData({
      betaRouteDeleteConfirmOpen: true,
      betaRouteDeletingId: routeId,
      betaRouteDeletingTitle: target.route_title,
    });
  },

  onCloseBetaRouteDeleteConfirm(forceClose = false) {
    if (this.data.betaRouteDeleting && !forceClose) return;
    this.setData({
      betaRouteDeleteConfirmOpen: false,
      betaRouteDeletingId: 0,
      betaRouteDeletingTitle: "",
    });
  },

  async onConfirmBetaRouteDelete() {
    const routeId = Number(this.data.betaRouteDeletingId || 0);
    if (!routeId || this.data.betaRouteDeleting) return;
    this.setData({ betaRouteDeleting: true });
    try {
      await deleteAdminBetaRoute(routeId);
      this.showNotice("success", "内测路由已删除");
      this.onCloseBetaRouteDeleteConfirm(true);
      await Promise.all([this.loadBetaRoutes(), this.loadBetaVersions()]);
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "删除内测路由失败"));
    } finally {
      this.setData({ betaRouteDeleting: false });
    }
  },

  async onOpenCreateBetaVersion() {
    let routes = [];
    try {
      routes = await this.ensureBetaPresetRoutes();
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "初始化内测路由失败"));
      return;
    }
    if (!routes.length) {
      this.showNotice("error", "内测路由初始化失败，请稍后重试");
      return;
    }
    this.setData({
      betaVersionModalOpen: true,
      betaVersionModalMode: "create",
      betaVersionForm: buildDefaultBetaVersionForm(routes),
      betaVersionRoutePickerIndex: 0,
      betaVersionRoutePreviewTitle: routes[0] ? routes[0].route_title : "",
      betaVersionRoutePreviewPath: routes[0] ? routes[0].route_path : "",
      betaVersionRouteOpen: false,
    });
  },

  async onOpenEditBetaVersion(e) {
    const versionId =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!versionId) return;
    const target = (this.data.betaVersionRows || []).find((item) => item.id === versionId);
    if (!target) return;

    let routes = [];
    try {
      routes = await this.ensureBetaPresetRoutes();
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "加载功能路由失败"));
      return;
    }
    if (!routes.length) {
      this.showNotice("error", "暂无可用功能路由");
      return;
    }
    const routeIndex = Math.max(
      0,
      routes.findIndex((item) => item.id === Number(target.route_id || 0))
    );
    this.setData({
      betaVersionModalOpen: true,
      betaVersionModalMode: "edit",
      betaVersionForm: {
        id: target.id,
        feature_name: target.feature_name,
        feature_description: target.feature_description,
        feature_code: target.feature_code,
        route_id: target.route_id,
        is_active: target.is_active,
        has_expiry: Boolean(target.expires_date),
        expires_date: target.expires_date,
      },
      betaVersionRoutePickerIndex: routeIndex,
      betaVersionRoutePreviewTitle: target.route_title || "",
      betaVersionRoutePreviewPath: target.route_path || "",
      betaVersionRouteOpen: false,
    });
  },

  onCloseBetaVersionModal(forceClose = false) {
    if (this.data.betaVersionSaving && !forceClose) return;
    this.setData({
      betaVersionModalOpen: false,
      betaVersionModalMode: "create",
      betaVersionForm: buildDefaultBetaVersionForm(this.data.betaRouteRows || []),
      betaVersionRoutePickerIndex: 0,
      betaVersionRoutePreviewTitle: "",
      betaVersionRoutePreviewPath: "",
      betaVersionRouteOpen: false,
    });
  },

  onBetaVersionInput(e) {
    const field =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.field || "")
        : "";
    if (!field) return;
    let value = e && e.detail ? String(e.detail.value || "") : "";
    if (field === "feature_code") {
      value = normalizeAlbumAccessKey(value);
    }
    this.setData({
      [`betaVersionForm.${field}`]: value,
    });
  },

  onBetaVersionRouteChange(e) {
    const index = e && e.detail ? Number(e.detail.value || 0) : 0;
    this.applyBetaVersionRouteIndex(index);
  },

  applyBetaVersionRouteIndex(index) {
    const routes = this.data.betaRouteRows || [];
    if (!routes.length) return;
    const safeIndex = index >= 0 && index < routes.length ? index : 0;
    const target = routes[safeIndex] || routes[0];
    this.setData({
      "betaVersionForm.route_id": Number(target.id || 0),
      betaVersionRoutePickerIndex: safeIndex,
      betaVersionRoutePreviewTitle: String(target.route_title || ""),
      betaVersionRoutePreviewPath: String(target.route_path || ""),
      betaVersionRouteOpen: false,
    });
  },

  onToggleBetaVersionRouteOpen() {
    if (this.data.betaVersionSaving) return;
    const routes = this.data.betaRouteRows || [];
    if (!routes.length) return;
    this.setData({
      betaVersionRouteOpen: !Boolean(this.data.betaVersionRouteOpen),
    });
  },

  onSelectBetaVersionRoute(e) {
    const index =
      e && e.currentTarget && e.currentTarget.dataset
        ? Number(e.currentTarget.dataset.index || 0)
        : 0;
    this.applyBetaVersionRouteIndex(index);
  },

  onBetaVersionActiveChange(e) {
    this.setData({
      "betaVersionForm.is_active": Boolean(e && e.detail && e.detail.value),
    });
  },

  onBetaVersionExpirySwitch(e) {
    const checked = Boolean(e && e.detail && e.detail.value);
    const patch = {
      "betaVersionForm.has_expiry": checked,
    };
    if (!checked) {
      patch["betaVersionForm.expires_date"] = "";
    }
    this.setData(patch);
  },

  onBetaVersionExpiryDateChange(e) {
    const value = e && e.detail ? String(e.detail.value || "") : "";
    this.setData({
      "betaVersionForm.expires_date": value,
    });
  },

  onGenerateBetaVersionCode() {
    this.setData({
      "betaVersionForm.feature_code": generateAdminBetaFeatureCode(),
    });
  },

  async onSubmitBetaVersion() {
    if (this.data.betaVersionSaving) return;
    const form = this.data.betaVersionForm || buildDefaultBetaVersionForm(this.data.betaRouteRows || []);
    const featureName = String(form.feature_name || "").trim();
    const featureCode = normalizeAlbumAccessKey(form.feature_code);
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
    if (featureCode.length !== 8) {
      wx.showToast({ title: "内测码必须是 8 位大写字母或数字", icon: "none" });
      return;
    }
    if (Boolean(form.has_expiry) && !String(form.expires_date || "").trim()) {
      wx.showToast({ title: "请选择有效期日期", icon: "none" });
      return;
    }

    const expiresAt = Boolean(form.has_expiry) ? `${String(form.expires_date || "").trim()} 23:59:59` : null;

    this.setData({ betaVersionSaving: true });
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
      this.showNotice("success", this.data.betaVersionModalMode === "edit" ? "内测版本已更新" : "内测版本已创建");
      this.onCloseBetaVersionModal(true);
      await this.loadBetaVersions();
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "保存内测版本失败"));
    } finally {
      this.setData({ betaVersionSaving: false });
    }
  },

  onOpenBetaVersionDeleteConfirm(e) {
    const versionId =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!versionId) return;
    const target = (this.data.betaVersionRows || []).find((item) => item.id === versionId);
    if (!target) return;
    this.setData({
      betaVersionDeleteConfirmOpen: true,
      betaVersionDeletingId: versionId,
      betaVersionDeletingName: target.feature_name,
    });
  },

  onCloseBetaVersionDeleteConfirm(forceClose = false) {
    if (this.data.betaVersionDeleting && !forceClose) return;
    this.setData({
      betaVersionDeleteConfirmOpen: false,
      betaVersionDeletingId: "",
      betaVersionDeletingName: "",
    });
  },

  async onConfirmBetaVersionDelete() {
    const versionId = String(this.data.betaVersionDeletingId || "").trim();
    if (!versionId || this.data.betaVersionDeleting) return;
    this.setData({ betaVersionDeleting: true });
    try {
      await deleteAdminBetaVersion(versionId);
      this.showNotice("success", "内测版本已删除");
      this.onCloseBetaVersionDeleteConfirm(true);
      await this.loadBetaVersions();
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "删除内测版本失败"));
    } finally {
      this.setData({ betaVersionDeleting: false });
    }
  },

  onCopyBetaVersionCode(e) {
    const code =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.code || "").trim()
        : "";
    if (!code) return;
    wx.setClipboardData({
      data: code,
      success: () => {
        this.showNotice("success", "内测码已复制");
      },
      fail: () => {
        this.showNotice("error", "复制失败，请重试");
      },
    });
  },

  async loadPoses(options) {
    const config = options && typeof options === "object" ? options : {};
    const shouldThrow = config.throwOnError !== false;
    const shouldShowNotice = Boolean(config.showNotice);
    const hasReadyPoses = Boolean(this.data.posesReady);
    const isFirstLoad = !this._posesLoadedOnce && !hasReadyPoses;

    this.setData({
      posesLoading: isFirstLoad,
      posesRefreshing: !isFirstLoad && hasReadyPoses,
      posesError: "",
    });

    try {
      const rows = await listAdminPoses(500);
      const list = (Array.isArray(rows) ? rows : []).map((row) => {
        const id = Number((row && row.id) || 0);
        const imageUrl = String((row && row.image_url) || "").trim();
        const storagePath = String((row && row.storage_path) || "").trim();
        const tags = normalizePoseTagsList(row && row.tags);
        const viewCount = Number((row && row.view_count) || 0);
        return {
          id,
          image_url: imageUrl,
          storage_path: storagePath,
          imageResolved: resolvePublicUrl(imageUrl),
          tags,
          tagsText: tags.join(" / "),
          viewCount,
          createdAtText: formatDateTime(row && row.created_at),
        };
      });

      this._posesLoadedOnce = true;
      this.setData(
        {
          poses: list,
          posesLoading: false,
          posesRefreshing: false,
          posesError: "",
          posesReady: true,
        },
        () => {
          this.refreshPoseModuleView();
        }
      );
      return list;
    } catch (error) {
      const message = readErrorMessage(error, "获取摆姿列表失败");
      const patch = {
        posesLoading: false,
        posesRefreshing: false,
        posesError: message,
        posesReady: hasReadyPoses,
      };
      if (!hasReadyPoses) {
        patch.poses = [];
      }
      this.setData(patch, () => {
        if (!hasReadyPoses) {
          this.refreshPoseModuleView();
        }
      });
      if (shouldShowNotice) {
        this.showNotice("error", message);
      }
      if (shouldThrow) {
        throw error;
      }
      return null;
    }
  },

  async loadPoseTags(showErrorNoticeOrOptions, maybeOptions) {
    const legacyShowErrorNotice = typeof showErrorNoticeOrOptions === "boolean" ? showErrorNoticeOrOptions : false;
    const config =
      showErrorNoticeOrOptions && typeof showErrorNoticeOrOptions === "object"
        ? showErrorNoticeOrOptions
        : maybeOptions && typeof maybeOptions === "object"
          ? maybeOptions
          : {};
    const shouldThrow = config.throwOnError !== false;
    const shouldShowNotice = legacyShowErrorNotice || Boolean(config.showNotice);
    const hasReadyTags = Boolean(this.data.poseTagsReady);
    const isFirstLoad = !this._poseTagsLoadedOnce && !hasReadyTags;

    this.setData({
      poseTagsLoading: isFirstLoad,
      poseTagsRefreshing: !isFirstLoad && hasReadyTags,
      poseTagsError: "",
    });

    try {
      const rows = await listAdminPoseTags(200);
      const list = (Array.isArray(rows) ? rows : [])
        .map((row) => {
          const id = Number((row && row.id) || 0);
          const name = String((row && row.name) || "").trim();
          const usageCount = Number((row && row.usage_count) || 0);
          const sortOrderRaw = Number(row && row.sort_order);
          return {
            id,
            name,
            usage_count: Number.isFinite(usageCount) ? usageCount : 0,
            sort_order:
              Number.isFinite(sortOrderRaw) && sortOrderRaw > 0
                ? Math.round(sortOrderRaw)
                : Number.MAX_SAFE_INTEGER,
          };
        })
        .filter((item) => item.id > 0 && item.name);

      this._poseTagsLoadedOnce = true;
      this.setData(
        {
          poseTagsLoading: false,
          poseTagsRefreshing: false,
          poseTagsError: "",
          poseTagsReady: true,
          poseTags: list,
        },
        () => {
          this.refreshPoseModuleView();
        }
      );
      return list;
    } catch (error) {
      const message = readErrorMessage(error, "获取标签失败");
      const patch = {
        poseTagsLoading: false,
        poseTagsRefreshing: false,
        poseTagsError: message,
        poseTagsReady: hasReadyTags,
      };
      if (!hasReadyTags) {
        patch.poseTags = [];
      }
      this.setData(patch, () => {
        if (!hasReadyTags) {
          this.refreshPoseModuleView();
        }
      });
      if (shouldShowNotice) {
        this.showNotice("error", message);
      }
      if (shouldThrow) {
        throw error;
      }
      return null;
    }
  },

  async refreshPoseSection(options) {
    const config = options && typeof options === "object" ? options : {};
    try {
      const results = await Promise.all([
        this.loadPoses({ throwOnError: false }),
        this.loadPoseTags({ throwOnError: false }),
      ]);
      if (!config.silent) {
        const successCount = results.filter(Boolean).length;
        if (successCount === results.length) {
          this.showNotice("success", "摆姿管理已刷新");
        } else if (successCount > 0) {
          this.showNotice("info", "摆姿数据已部分刷新，其余内容请稍后重试");
        } else {
          this.showNotice("error", "摆姿数据刷新失败，请稍后重试");
        }
      }
    } finally {
      if (config.stopPullDown) {
        wx.stopPullDownRefresh();
      }
    }
  },

  onRefreshPoseSection() {
    if (
      this.data.loading ||
      this.data.posesLoading ||
      this.data.posesRefreshing ||
      this.data.poseTagsLoading ||
      this.data.poseTagsRefreshing ||
      this.data.poseCreating ||
      this.data.poseBatchDeleting ||
      this.data.poseTagCreating ||
      this.data.poseTagUpdating ||
      this.data.poseTagBatchDeleting ||
      this.data.poseTagSortingId ||
      this.data.maintenanceRunning
    ) return;
    void this.refreshPoseSection({ silent: false, stopPullDown: false });
  },

  refreshPoseModuleView() {
    const poses = Array.isArray(this.data.poses) ? this.data.poses : [];
    const poseTags = Array.isArray(this.data.poseTags) ? this.data.poseTags : [];
    const selectedTags = Array.isArray(this.data.poseSelectedTags) ? this.data.poseSelectedTags : [];
    const poseFormSelectedTags = Array.isArray(this.data.poseFormSelectedTags) ? this.data.poseFormSelectedTags : [];
    const normalizedSelectedIds = normalizePoseSelectedIds(this.data.poseSelectedIds, poses);
    const selectedTagSet = new Set(
      selectedTags
        .map((item) => String(item || "").trim().toLowerCase())
        .filter(Boolean)
    );

    const rawTagStats = buildPoseTagStats(poseTags, poses).map((item) => {
      const name = String(item && item.name ? item.name : "");
      const lowerName = name.toLowerCase();
      const sortOrderRaw = Number(item && item.sort_order);
      return {
        id: Number((item && item.id) || 0),
        name,
        usage_count: Number((item && item.usage_count) || 0),
        sort_order:
          Number.isFinite(sortOrderRaw) && sortOrderRaw > 0
            ? Math.round(sortOrderRaw)
            : Number.MAX_SAFE_INTEGER,
        virtual: Boolean(item && item.virtual),
        lowerName,
        filterActive: selectedTagSet.has(lowerName),
      };
    });

    const selectedIdSet = new Set(normalizedSelectedIds);
    const filteredRows = poses
      .filter((pose) => {
        if (selectedTagSet.size === 0) return true;
        const tags = normalizePoseTagsList(pose && pose.tags);
        return tags.some((tag) => selectedTagSet.has(String(tag || "").toLowerCase()));
      })
      .map((pose) =>
        Object.assign({}, pose, {
          selected: selectedIdSet.has(Number(pose && pose.id)),
        })
      );

    const pageSize = Math.max(1, Number(this.data.posePageSize || 10));
    const totalCount = filteredRows.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    const rawVisibleCount = Math.max(pageSize, Number(this.data.poseVisibleCount || pageSize));
    const visibleCount = totalCount > 0 ? Math.min(rawVisibleCount, totalCount) : pageSize;
    const pagedRows = filteredRows.slice(0, visibleCount);
    const currentPage = totalCount > 0 ? Math.max(1, Math.ceil(pagedRows.length / pageSize)) : 1;
    const poseHasMoreVisible = pagedRows.length < totalCount;

    const poseAllSelected =
      totalCount > 0 &&
      filteredRows.every((item) => selectedIdSet.has(Number(item && item.id)));

    const normalizedPoseTagSelectedIds = normalizePoseTagSelectedIds(this.data.poseTagSelectedIds, rawTagStats);
    const selectedPoseTagIdSet = new Set(normalizedPoseTagSelectedIds);
    const poseTagStats = rawTagStats.map((item, index) => {
      const virtual = Boolean(item && item.virtual);
      return Object.assign({}, item, {
        selectedTag: selectedPoseTagIdSet.has(Number(item && item.id)),
        sortIndex: index + 1,
        canMoveTop: !virtual && index > 0,
        canMoveUp: !virtual && index > 0,
        canMoveDown: !virtual && index < rawTagStats.length - 1,
      });
    });
    const poseTagUsedCount = poseTagStats.filter((item) => Number(item && item.usage_count) > 0).length;
    const poseTagUnusedCount = Math.max(0, poseTagStats.length - poseTagUsedCount);

    const poseTagAllSelected =
      poseTagStats.length > 0 &&
      poseTagStats.every((item) => selectedPoseTagIdSet.has(Number(item && item.id)));

    const poseTagBatchDeleteNamesText = poseTagStats
      .filter((item) => item.selectedTag)
      .map((item) => item.name)
      .join("、");

    const formSelectedSet = new Set(
      poseFormSelectedTags.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean)
    );
    const poseFormTagOptions = poseTagStats.map((item) => ({
      id: Number(item.id || 0),
      name: item.name,
      usage_count: Number(item.usage_count || 0),
      active: formSelectedSet.has(String(item.lowerName || "").toLowerCase()),
    }));

    this.setData({
      poseTagStats,
      poseTagUsedCount,
      poseTagUnusedCount,
      poseFilteredList: filteredRows,
      posePagedList: pagedRows,
      poseCurrentPage: currentPage,
      poseVisibleCount: visibleCount,
      poseTotalCount: totalCount,
      poseTotalPages: totalPages,
      poseHasMoreVisible,
      poseSelectedIds: normalizedSelectedIds,
      poseSelectedCount: normalizedSelectedIds.length,
      poseAllSelected,
      poseFormTagOptions,
      poseTagSelectedIds: normalizedPoseTagSelectedIds,
      poseTagSelectedCount: normalizedPoseTagSelectedIds.length,
      poseTagAllSelected,
      poseTagBatchDeleteNamesText,
    });
  },

  onPosePanelTabChange(e) {
    const key =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.key || "")
        : "";
    if (key !== "poses" && key !== "tags") return;
    if (key === "poses") {
      this.setData({
        posePanelTab: key,
        poseTagModalOpen: false,
        poseTagEditModalOpen: false,
        poseTagDeleteConfirmOpen: false,
        poseTagBatchDeleteConfirmOpen: false,
      });
      return;
    }
    this.setData({ posePanelTab: key });
  },

  onOpenPoseCreateModal() {
    if (this.data.poseCreating || this.data.poseBatchDeleting) return;
    this.setData(
      {
        poseCreateModalOpen: true,
        poseFormMode: "create",
        poseEditingId: 0,
        poseFilePath: "",
        poseFileName: "",
        poseFileSize: 0,
        poseFileSizeText: "",
        poseTagsInput: "",
        poseFormSelectedTags: [],
      },
      () => {
        this.refreshPoseModuleView();
      }
    );
  },

  onClosePoseCreateModal() {
    if (this.data.poseCreating) return;
    this.setData(
      {
        poseCreateModalOpen: false,
        poseFormMode: "create",
        poseEditingId: 0,
        poseFilePath: "",
        poseFileName: "",
        poseFileSize: 0,
        poseFileSizeText: "",
        poseTagsInput: "",
        poseFormSelectedTags: [],
      },
      () => {
        this.refreshPoseModuleView();
      }
    );
  },

  onPoseModalTap() {},

  onOpenPoseEditModal(e) {
    if (this.data.poseCreating || this.data.poseBatchDeleting || this.data.poseDeletingId) return;
    this.closeMobileMenu();
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? Number(e.currentTarget.dataset.id || 0)
        : 0;
    if (!Number.isFinite(id) || id <= 0) return;

    const target = (this.data.poses || []).find((item) => Number(item && item.id) === id) || null;
    if (!target) {
      this.showNotice("error", "摆姿不存在或已删除");
      return;
    }

    const tags = normalizePoseTagsList(target.tags);
    this.setData(
      {
        poseCreateModalOpen: true,
        poseFormMode: "edit",
        poseEditingId: id,
        poseFilePath: "",
        poseFileName: "",
        poseFileSize: 0,
        poseFileSizeText: "",
        poseTagsInput: tags.join("，"),
        poseFormSelectedTags: tags,
      },
      () => {
        this.refreshPoseModuleView();
      }
    );
  },

  onTogglePoseTagFilter(e) {
    const name =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.tag || "").trim()
        : "";
    if (!name) return;

    const selected = Array.isArray(this.data.poseSelectedTags) ? this.data.poseSelectedTags : [];
    const exists = selected.includes(name);
    const next = exists ? selected.filter((item) => item !== name) : selected.concat(name);
    this.setData(
      {
        poseSelectedTags: next,
        poseCurrentPage: 1,
        poseVisibleCount: Math.max(1, Number(this.data.posePageSize || 10)),
      },
      () => {
        this.refreshPoseModuleView();
      }
    );
  },

  onEnterPoseSelectionMode() {
    if (this.data.poseBatchDeleting || this.data.poseCreating) return;
    this.setData(
      {
        poseSelectionMode: true,
        poseSelectedIds: [],
        poseSelectedCount: 0,
        poseAllSelected: false,
      },
      () => {
        this.refreshPoseModuleView();
      }
    );
  },

  onCancelPoseSelectionMode() {
    if (this.data.poseBatchDeleting) return;
    this.setData(
      {
        poseSelectionMode: false,
        poseSelectedIds: [],
        poseSelectedCount: 0,
        poseAllSelected: false,
      },
      () => {
        this.refreshPoseModuleView();
      }
    );
  },

  onTogglePoseSelection(e) {
    if (!this.data.poseSelectionMode || this.data.poseBatchDeleting) return;
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? Number(e.currentTarget.dataset.id || 0)
        : 0;
    if (!Number.isFinite(id) || id <= 0) return;

    const selected = Array.isArray(this.data.poseSelectedIds) ? this.data.poseSelectedIds : [];
    const exists = selected.includes(id);
    const next = exists ? selected.filter((item) => item !== id) : selected.concat(id);
    this.setData({ poseSelectedIds: next }, () => {
      this.refreshPoseModuleView();
    });
  },

  onSelectAllFilteredPoses() {
    if (!this.data.poseSelectionMode || this.data.poseBatchDeleting) return;
    const filteredRows = Array.isArray(this.data.poseFilteredList) ? this.data.poseFilteredList : [];
    if (!filteredRows.length) return;
    const totalCount = Math.max(0, Number(this.data.poseTotalCount || filteredRows.length));
    const allIds = filteredRows.map((item) => Number(item && item.id)).filter((id) => Number.isFinite(id) && id > 0);
    const allSelected = Boolean(this.data.poseAllSelected);
    this.setData({
      poseSelectedIds: allSelected ? [] : allIds,
      poseVisibleCount: allSelected ? this.data.poseVisibleCount : Math.max(totalCount, Number(this.data.posePageSize || 10)),
    }, () => {
      this.refreshPoseModuleView();
    });
  },

  loadMorePoseRows() {
    if (this.data.poseBatchDeleting || this.data.poseDeletingId) return;
    if (String(this.data.posePanelTab || "poses") !== "poses") return;
    if (!this.data.poseHasMoreVisible) return;
    const pageSize = Math.max(1, Number(this.data.posePageSize || 10));
    const visibleCount = Math.max(pageSize, Number(this.data.poseVisibleCount || pageSize));
    this.setData({ poseVisibleCount: visibleCount + pageSize }, () => {
      this.refreshPoseModuleView();
    });
  },

  onBatchDeletePoses() {
    if (this.data.poseBatchDeleting || this.data.poseDeletingId) return;
    const selectedIds = Array.isArray(this.data.poseSelectedIds) ? this.data.poseSelectedIds : [];
    if (!selectedIds.length) {
      this.showNotice("error", "请先选择要删除的摆姿");
      return;
    }
    this.setData({ poseBatchDeleteConfirmOpen: true });
  },

  onCancelPoseBatchDeleteConfirm() {
    if (this.data.poseBatchDeleting) return;
    this.setData({ poseBatchDeleteConfirmOpen: false });
  },

  async onConfirmPoseBatchDelete() {
    if (this.data.poseBatchDeleting || this.data.poseDeletingId) return;
    const selectedIds = Array.isArray(this.data.poseSelectedIds) ? this.data.poseSelectedIds : [];
    if (!selectedIds.length) {
      this.setData({ poseBatchDeleteConfirmOpen: false });
      this.showNotice("error", "请先选择要删除的摆姿");
      return;
    }

    this.setData({
      poseBatchDeleteConfirmOpen: false,
      poseBatchDeleting: true,
    });
    let successCount = 0;
    let failedCount = 0;
    const rows = Array.isArray(this.data.poses) ? this.data.poses : [];

    try {
      for (let i = 0; i < selectedIds.length; i += 1) {
        const id = Number(selectedIds[i]);
        if (!Number.isFinite(id) || id <= 0) continue;
        const target = rows.find((item) => Number(item && item.id) === id) || null;
        try {
          await deleteAdminPose(id, target ? [target.image_url, target.storage_path] : []);
          successCount += 1;
        } catch (_) {
          failedCount += 1;
        }
      }

      this.setData(
        {
          poseBatchDeleting: false,
          poseSelectionMode: false,
          poseSelectedIds: [],
          poseSelectedCount: 0,
          poseAllSelected: false,
        },
        () => {
          this.refreshPoseModuleView();
        }
      );

      if (successCount > 0 && failedCount === 0) {
        this.showNotice("success", `已删除 ${successCount} 个摆姿`);
      } else if (successCount > 0) {
        this.showNotice("info", `已删除 ${successCount} 个，失败 ${failedCount} 个`);
      } else {
        this.showNotice("error", "批量删除失败，请稍后重试");
      }

      if (successCount > 0) {
        await this.safeRefresh([this.loadPoses(), this.loadPoseTags(), this.loadStats()], "摆姿批量删除已完成");
      }
    } catch (error) {
      this.setData({ poseBatchDeleting: false });
      this.showNotice("error", readErrorMessage(error, "批量删除摆姿失败"));
    }
  },

  onDeletePose(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? Number(e.currentTarget.dataset.id || 0)
        : 0;
    if (!id) return;
    if (this.data.poseDeletingId || this.data.poseBatchDeleting) return;
    this.setData({
      poseDeleteConfirmOpen: true,
      poseDeletingTargetId: id,
    });
  },

  onCancelPoseDeleteConfirm() {
    if (this.data.poseDeletingId) return;
    this.setData({
      poseDeleteConfirmOpen: false,
      poseDeletingTargetId: 0,
    });
  },

  async onConfirmPoseDelete() {
    if (this.data.poseDeletingId || this.data.poseBatchDeleting) return;
    const id = Number(this.data.poseDeletingTargetId || 0);
    if (!id) {
      this.setData({
        poseDeleteConfirmOpen: false,
        poseDeletingTargetId: 0,
      });
      return;
    }

    const target = (this.data.poses || []).find((item) => item.id === id) || null;
    this.setData({
      poseDeleteConfirmOpen: false,
      poseDeletingId: id,
    });
    try {
      const result = await deleteAdminPose(
        id,
        target ? [target.image_url, target.storage_path] : []
      );
      if (result && result.storageCleanupFailed) {
        this.showNotice("error", `摆姿记录已删除，但文件清理失败：${result.warning || "请稍后处理"}`);
      } else {
        this.showNotice("success", "摆姿已删除");
      }
      await this.safeRefresh([this.loadPoses(), this.loadPoseTags(), this.loadStats()], "摆姿已删除");
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "删除摆姿失败"));
    } finally {
      this.setData({
        poseDeletingId: 0,
        poseDeletingTargetId: 0,
      });
    }
  },

  onPreviewPoseImage(e) {
    if (this.data.poseSelectionMode) return;
    const url =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.url || "").trim()
        : "";
    if (!url) return;
    this.markTransientForegroundReturn("pose-preview-image");
    wx.previewImage({
      current: url,
      urls: [url],
    });
  },

  onTogglePoseTagInForm(e) {
    const tag =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.tag || "").trim()
        : "";
    if (!tag) return;

    const selected = Array.isArray(this.data.poseFormSelectedTags) ? this.data.poseFormSelectedTags : [];
    const exists = selected.includes(tag);
    const next = exists ? selected.filter((item) => item !== tag) : selected.concat(tag);
    if (!exists && next.length > 3) {
      this.showNotice("error", "摆姿标签最多 3 个");
      return;
    }

    this.setData(
      {
        poseFormSelectedTags: next,
        poseTagsInput: next.join("，"),
      },
      () => {
        this.refreshPoseModuleView();
      }
    );
  },

  onEnterPoseTagSelectionMode() {
    if (
      this.data.poseTagBatchDeleting ||
      this.data.poseTagDeletingId ||
      this.data.poseTagCreating ||
      this.data.poseTagSortingId
    ) return;
    this.setData(
      {
        poseTagSelectionMode: true,
        poseTagSelectedIds: [],
        poseTagSelectedCount: 0,
        poseTagAllSelected: false,
      },
      () => {
        this.refreshPoseModuleView();
      }
    );
  },

  onCancelPoseTagSelectionMode() {
    if (this.data.poseTagBatchDeleting) return;
    this.setData(
      {
        poseTagSelectionMode: false,
        poseTagSelectedIds: [],
        poseTagSelectedCount: 0,
        poseTagAllSelected: false,
      },
      () => {
        this.refreshPoseModuleView();
      }
    );
  },

  onTogglePoseTagSelection(e) {
    if (!this.data.poseTagSelectionMode || this.data.poseTagBatchDeleting) return;
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? Number(e.currentTarget.dataset.id || 0)
        : 0;
    if (!Number.isFinite(id) || id <= 0) return;

    const selected = Array.isArray(this.data.poseTagSelectedIds) ? this.data.poseTagSelectedIds : [];
    const exists = selected.includes(id);
    const next = exists ? selected.filter((item) => item !== id) : selected.concat(id);
    this.setData({ poseTagSelectedIds: next }, () => {
      this.refreshPoseModuleView();
    });
  },

  onSelectAllPoseTags() {
    if (!this.data.poseTagSelectionMode || this.data.poseTagBatchDeleting) return;
    const rows = Array.isArray(this.data.poseTagStats) ? this.data.poseTagStats : [];
    const allIds = rows
      .map((item) => Number(item && item.id))
      .filter((id) => Number.isFinite(id) && id > 0);
    if (allIds.length === 0) return;
    const next = this.data.poseTagAllSelected ? [] : allIds;
    this.setData({ poseTagSelectedIds: next }, () => {
      this.refreshPoseModuleView();
    });
  },

  onOpenPoseTagModal() {
    if (this.data.poseTagCreating || this.data.poseTagBatchDeleting || this.data.poseTagSortingId) return;
    this.setData({
      poseTagModalOpen: true,
      poseTagCreateInput: "",
    });
  },

  onMovePoseTagUp(e) {
    void this.movePoseTagByDirection(e, "up");
  },

  onMovePoseTagDown(e) {
    void this.movePoseTagByDirection(e, "down");
  },

  onMovePoseTagTop(e) {
    void this.movePoseTagByDirection(e, "top");
  },

  async movePoseTagByDirection(e, direction) {
    if (
      this.data.poseTagSelectionMode ||
      this.data.poseTagBatchDeleting ||
      this.data.poseTagDeletingId ||
      this.data.poseTagUpdating ||
      this.data.poseTagCreating ||
      this.data.poseTagSortingId
    ) {
      return;
    }

    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? Number(e.currentTarget.dataset.id || 0)
        : 0;
    if (!Number.isInteger(id) || id <= 0) return;

    const rows = Array.isArray(this.data.poseTagStats) ? this.data.poseTagStats : [];
    const currentIndex = rows.findIndex((item) => Number(item && item.id) === id && !(item && item.virtual));
    if (currentIndex < 0) return;

    if (direction === "top" && currentIndex <= 0) return;
    if (direction === "up" && currentIndex <= 0) return;
    if (direction === "down" && currentIndex >= rows.length - 1) return;

    this.setData({ poseTagSortingId: id });
    try {
      const result = await moveAdminPoseTag(id, direction);
      if (result && result.boundary) {
        this.showNotice(
          "info",
          direction === "down" ? "已经是最后一个标签" : "已经是第一个标签"
        );
        return;
      }

      const successText =
        direction === "top" ? "标签已置顶" : direction === "up" ? "标签已上移" : "标签已下移";
      this.showNotice("success", successText);
      await this.safeRefresh([this.loadPoseTags()], successText);
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "更新标签顺序失败"));
    } finally {
      this.setData({ poseTagSortingId: 0 });
    }
  },

  onClosePoseTagModal() {
    if (this.data.poseTagCreating) return;
    this.setData({
      poseTagModalOpen: false,
      poseTagCreateInput: "",
    });
  },

  onPoseTagCreateInput(e) {
    const value = e && e.detail ? e.detail.value : "";
    this.setData({ poseTagCreateInput: String(value || "") });
  },

  async onCreatePoseTags() {
    if (this.data.poseTagCreating || this.data.poseTagSortingId) return;
    const names = normalizePoseTagsInput(this.data.poseTagCreateInput);
    if (!names.length) {
      this.showNotice("error", "请输入标签名称");
      return;
    }

    this.setData({ poseTagCreating: true });
    try {
      const result = await createAdminPoseTags(names);
      const insertedCount = Number((result && result.insertedCount) || 0);
      const skippedCount = Number((result && result.skippedCount) || 0);
      this.setData({
        poseTagModalOpen: false,
        poseTagCreateInput: "",
      });

      if (insertedCount > 0 && skippedCount === 0) {
        this.showNotice("success", `成功添加 ${insertedCount} 个标签`);
      } else if (insertedCount > 0) {
        this.showNotice("info", `成功添加 ${insertedCount} 个标签，跳过 ${skippedCount} 个已存在标签`);
      } else {
        this.showNotice("info", "标签已存在，未新增");
      }
      await this.safeRefresh([this.loadPoseTags(), this.loadPoses(), this.loadStats()], "标签创建已完成");
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "新增标签失败"));
    } finally {
      this.setData({ poseTagCreating: false });
    }
  },

  onOpenPoseTagEditModal(e) {
    if (
      this.data.poseTagUpdating ||
      this.data.poseTagDeletingId ||
      this.data.poseTagBatchDeleting ||
      this.data.poseTagSortingId
    ) return;
    const virtualFlag =
      e && e.currentTarget && e.currentTarget.dataset
        ? e.currentTarget.dataset.virtual
        : false;
    const isVirtual = virtualFlag === true || String(virtualFlag || "") === "true";
    if (isVirtual) return;
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? Number(e.currentTarget.dataset.id || 0)
        : 0;
    const name =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.name || "").trim()
        : "";
    if (!id || !name) return;
    this.setData({
      poseTagEditModalOpen: true,
      poseTagEditId: id,
      poseTagEditName: name,
    });
  },

  onClosePoseTagEditModal() {
    if (this.data.poseTagUpdating) return;
    this.setData({
      poseTagEditModalOpen: false,
      poseTagEditId: 0,
      poseTagEditName: "",
    });
  },

  onPoseTagEditInput(e) {
    const value = e && e.detail ? e.detail.value : "";
    this.setData({ poseTagEditName: String(value || "") });
  },

  async onUpdatePoseTag() {
    if (this.data.poseTagUpdating || this.data.poseTagSortingId) return;
    const id = Number(this.data.poseTagEditId || 0);
    const name = String(this.data.poseTagEditName || "").trim();
    if (!id) {
      this.showNotice("error", "目标标签不存在");
      return;
    }
    if (!name) {
      this.showNotice("error", "请输入标签名称");
      return;
    }

    this.setData({ poseTagUpdating: true });
    try {
      await updateAdminPoseTag(id, name);
      this.setData({
        poseTagEditModalOpen: false,
        poseTagEditId: 0,
        poseTagEditName: "",
      });
      this.showNotice("success", "标签已更新");
      await this.safeRefresh([this.loadPoseTags(), this.loadPoses(), this.loadStats()], "标签已更新");
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "更新标签失败"));
    } finally {
      this.setData({ poseTagUpdating: false });
    }
  },

  onAskDeletePoseTag(e) {
    if (this.data.poseTagDeletingId || this.data.poseTagBatchDeleting || this.data.poseTagSortingId) return;
    const virtualFlag =
      e && e.currentTarget && e.currentTarget.dataset
        ? e.currentTarget.dataset.virtual
        : false;
    const isVirtual = virtualFlag === true || String(virtualFlag || "") === "true";
    if (isVirtual) return;
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? Number(e.currentTarget.dataset.id || 0)
        : 0;
    const name =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.name || "").trim()
        : "";
    if (!id) return;
    this.setData({
      poseTagDeleteConfirmOpen: true,
      poseTagDeletingTargetId: id,
      poseTagDeletingTargetName: name,
    });
  },

  onCancelPoseTagDeleteConfirm() {
    if (this.data.poseTagDeletingId) return;
    this.setData({
      poseTagDeleteConfirmOpen: false,
      poseTagDeletingTargetId: 0,
      poseTagDeletingTargetName: "",
    });
  },

  async onConfirmDeletePoseTag() {
    if (this.data.poseTagDeletingId || this.data.poseTagBatchDeleting) return;
    const id = Number(this.data.poseTagDeletingTargetId || 0);
    if (!id) {
      this.setData({
        poseTagDeleteConfirmOpen: false,
        poseTagDeletingTargetId: 0,
        poseTagDeletingTargetName: "",
      });
      return;
    }

    this.setData({
      poseTagDeleteConfirmOpen: false,
      poseTagDeletingId: id,
    });
    try {
      await deleteAdminPoseTag(id);
      this.showNotice("success", "标签已删除");
      await this.safeRefresh([this.loadPoseTags(), this.loadPoses(), this.loadStats()], "标签已删除");
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "删除标签失败"));
    } finally {
      this.setData({
        poseTagDeletingId: 0,
        poseTagDeletingTargetId: 0,
        poseTagDeletingTargetName: "",
      });
    }
  },

  onBatchDeletePoseTags() {
    if (this.data.poseTagBatchDeleting || this.data.poseTagDeletingId || this.data.poseTagSortingId) return;
    const selected = Array.isArray(this.data.poseTagSelectedIds) ? this.data.poseTagSelectedIds : [];
    if (!selected.length) {
      this.showNotice("error", "请先选择要删除的标签");
      return;
    }
    this.setData({ poseTagBatchDeleteConfirmOpen: true });
  },

  onCancelPoseTagBatchDeleteConfirm() {
    if (this.data.poseTagBatchDeleting) return;
    this.setData({ poseTagBatchDeleteConfirmOpen: false });
  },

  async onConfirmBatchDeletePoseTags() {
    if (this.data.poseTagBatchDeleting || this.data.poseTagDeletingId) return;
    const selected = Array.isArray(this.data.poseTagSelectedIds) ? this.data.poseTagSelectedIds : [];
    if (!selected.length) {
      this.setData({ poseTagBatchDeleteConfirmOpen: false });
      this.showNotice("error", "请先选择要删除的标签");
      return;
    }

    this.setData({
      poseTagBatchDeleteConfirmOpen: false,
      poseTagBatchDeleting: true,
    });
    try {
      const result = await deleteAdminPoseTags(selected);
      const deletedCount = Number((result && result.deletedCount) || 0);
      const failedCount = Number((result && result.failedCount) || 0);
      const missingCount = Number((result && result.missingCount) || 0);

      this.setData(
        {
          poseTagBatchDeleting: false,
          poseTagSelectionMode: false,
          poseTagSelectedIds: [],
          poseTagSelectedCount: 0,
          poseTagAllSelected: false,
        },
        () => {
          this.refreshPoseModuleView();
        }
      );

      if (deletedCount > 0 && failedCount === 0 && missingCount === 0) {
        this.showNotice("success", `已删除 ${deletedCount} 个标签`);
      } else if (deletedCount > 0) {
        this.showNotice(
          "info",
          `已删除 ${deletedCount} 个，失败 ${failedCount} 个，${missingCount} 个已不存在`
        );
      } else if (missingCount > 0) {
        this.showNotice("info", "选中的标签已不存在");
      } else {
        this.showNotice("error", "批量删除标签失败，请稍后重试");
      }

      if (deletedCount > 0 || missingCount > 0) {
        const refreshContext = deletedCount > 0 ? "标签批量删除已完成" : "标签列表状态已更新";
        await this.safeRefresh([this.loadPoseTags(), this.loadPoses(), this.loadStats()], refreshContext);
      }
    } catch (error) {
      this.setData({ poseTagBatchDeleting: false });
      this.showNotice("error", readErrorMessage(error, "批量删除标签失败"));
    }
  },

  async loadGalleryPhotos() {
    this.setData({ galleryLoading: true });
    try {
      const rows = await listAdminGalleryPhotos(500);
      const list = (Array.isArray(rows) ? rows : [])
        .map((row) => {
          const id = String((row && row.id) || "");
          const albumId = String((row && row.album_id) || "").trim();
          const url = String((row && row.url) || "").trim();
          const thumbnailUrl = String((row && row.thumbnail_url) || "").trim();
          const previewUrl = String((row && row.preview_url) || "").trim();
          const originalUrl = String((row && row.original_url) || "").trim();
          const isPublic = normalizeDbBoolean(row && row.is_public, true);
          const imageResolved = resolvePublicUrl(thumbnailUrl || previewUrl || url || originalUrl);
          const previewResolved = resolvePublicUrl(previewUrl || originalUrl || url || thumbnailUrl);
          const originalResolved = resolvePublicUrl(originalUrl || previewUrl || url || thumbnailUrl);
          const assets = [url, thumbnailUrl, previewUrl, originalUrl];
          return {
            id,
            album_id: albumId,
            url,
            thumbnail_url: thumbnailUrl,
            preview_url: previewUrl,
            original_url: originalUrl,
            imageResolved,
            previewResolved: previewResolved || imageResolved,
            originalResolved: originalResolved || previewResolved || imageResolved,
            isPublic,
            visibilityText: isPublic ? "公开" : "已隐藏",
            visibilityClass: isPublic ? "gallery-visibility--public" : "gallery-visibility--hidden",
            width: Number((row && row.width) || 0),
            height: Number((row && row.height) || 0),
            viewCount: Number((row && row.view_count) || 0),
            likeCount: Number((row && row.like_count) || 0),
            createdAtText: formatDateTime(row && row.created_at),
            createdDateText: formatDateOnly((row && row.shot_date) || (row && row.created_at)),
            assets: assets.filter(Boolean),
          };
        })
        .filter((item) => item.id && item.imageResolved);

      this.setData(
        {
          galleryLoading: false,
          galleryPhotos: list,
        },
        () => {
          this.refreshGalleryModuleView();
        }
      );
    } catch (error) {
      this.setData({ galleryLoading: false });
      throw error;
    }
  },

  refreshGalleryModuleView() {
    const sourceRows = Array.isArray(this.data.galleryPhotos) ? this.data.galleryPhotos : [];
    const filterAlbumId = String(this.data.galleryAlbumFilterId || "").trim();
    const rows = filterAlbumId
      ? sourceRows.filter((item) => String((item && item.album_id) || "").trim() === filterAlbumId)
      : sourceRows;
    const pageSize = Math.max(1, Number(this.data.galleryPageSize || 10));
    const totalCount = rows.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    let currentPage = Number(this.data.galleryCurrentPage || 1);
    if (!Number.isFinite(currentPage) || currentPage < 1) {
      currentPage = 1;
    }
    if (currentPage > totalPages) {
      currentPage = totalPages;
    }
    const startIndex = (currentPage - 1) * pageSize;
    const pageRows = rows.slice(startIndex, startIndex + pageSize);
    const validIds = rows.map((item) => String((item && item.id) || "")).filter(Boolean);
    const validSet = new Set(validIds);

    const selectedRaw = Array.isArray(this.data.gallerySelectedIds) ? this.data.gallerySelectedIds : [];
    const selectedMap = new Map();
    selectedRaw.forEach((item) => {
      const id = String(item || "").trim();
      if (!id || !validSet.has(id) || selectedMap.has(id)) return;
      selectedMap.set(id, id);
    });

    const selectedIds = Array.from(selectedMap.values());
    const selectedSet = new Set(selectedIds);
    const galleryRows = pageRows.map((item) =>
      Object.assign({}, item, {
        selected: selectedSet.has(String((item && item.id) || "")),
      })
    );
    const selectedCount = selectedIds.length;
    const allSelected = totalCount > 0 && selectedCount === totalCount;

    const patch = {
      galleryFilteredRows: rows,
      galleryRows,
      gallerySelectedIds: selectedIds,
      gallerySelectedCount: selectedCount,
      galleryTotalCount: totalCount,
      galleryAllSelected: allSelected,
      galleryCurrentPage: currentPage,
      galleryTotalPages: totalPages,
    };

    if (this.data.gallerySelectionMode && totalCount <= 0) {
      patch.gallerySelectionMode = false;
      patch.galleryDeleteConfirmOpen = false;
      patch.galleryDeletingTargetId = "";
      patch.galleryDeletingTargetAssets = [];
      patch.galleryBatchDeleteConfirmOpen = false;
    }

    this.setData(patch);
  },

  onGalleryPrevPage() {
    const currentPage = Number(this.data.galleryCurrentPage || 1);
    if (!Number.isFinite(currentPage) || currentPage <= 1) return;
    this.setData({ galleryCurrentPage: currentPage - 1 }, () => {
      this.refreshGalleryModuleView();
    });
  },

  onGalleryNextPage() {
    const currentPage = Number(this.data.galleryCurrentPage || 1);
    const totalPages = Number(this.data.galleryTotalPages || 1);
    if (!Number.isFinite(currentPage) || !Number.isFinite(totalPages) || currentPage >= totalPages) return;
    this.setData({ galleryCurrentPage: currentPage + 1 }, () => {
      this.refreshGalleryModuleView();
    });
  },

  async loadAlbums() {
    this.setData({ albumsLoading: true });
    try {
      const rows = await listAdminAlbums(500);
      const nowTs = Date.now();
      const list = (Array.isArray(rows) ? rows : [])
        .map((row) => {
          const id = String((row && row.id) || "").trim();
          if (!id || id === "00000000-0000-0000-0000-000000000000") return null;

          const title = String((row && row.title) || "").trim() || "未命名空间";
          const accessKey = normalizeAlbumAccessKey(row && row.access_key);
          const coverUrl = String((row && row.cover_url) || "").trim();
          const donationQrUrl = String((row && row.donation_qr_code_url) || "").trim();
          const recipientName = String((row && row.recipient_name) || "").trim() || "拾光者";
          const welcomeLetter = String((row && row.welcome_letter) || "").trim();
          const enableTipping = Boolean(row && row.enable_tipping);
          const welcomeLetterMode = normalizeWelcomeLetterMode(
            row && row.welcome_letter_mode,
            row ? row.enable_welcome_letter !== false : true
          );
          const enableWelcomeLetter = welcomeLetterMode !== "none";
          const enableFreeze = row ? row.enable_freeze !== false : true;
          const createdAt = String((row && row.created_at) || "").trim();
          const expiresAt = String((row && row.expires_at) || "").trim();
          const expiresDate = parseDateTimeUTC8(expiresAt);
          const daysRemaining = expiresDate
            ? Math.ceil((expiresDate.getTime() - nowTs) / (24 * 60 * 60 * 1000))
            : null;
          const expired = daysRemaining !== null && daysRemaining < 0;
          const expirySoon = daysRemaining !== null && daysRemaining >= 0 && daysRemaining <= 3;

          return {
            id,
            title,
            access_key: accessKey,
            cover_url: coverUrl,
            coverResolved: resolvePublicUrl(coverUrl),
            donation_qr_code_url: donationQrUrl,
            donationQrResolved: resolvePublicUrl(donationQrUrl),
            recipient_name: recipientName,
            welcome_letter: welcomeLetter,
            enable_tipping: enableTipping,
            enable_welcome_letter: enableWelcomeLetter,
            welcome_letter_mode: welcomeLetterMode,
            welcome_letter_mode_label: getWelcomeLetterModeLabel(welcomeLetterMode),
            enable_freeze: enableFreeze,
            accessLink: buildAlbumAccessLink(accessKey),
            qrUrl: buildAlbumQrUrl(accessKey),
            created_at: createdAt,
            createdAtText: formatDateTime(createdAt),
            createdDateText: formatDateOnly(createdAt),
            expires_at: expiresAt,
            expiresAtText: expiresAt ? formatDateTime(expiresAt) : "",
            expiresDateText: expiresAt ? formatDateOnly(expiresAt) : "",
            daysRemaining,
            expired,
            expirySoon,
            hasCover: Boolean(resolvePublicUrl(coverUrl)),
            hasDonationQr: Boolean(resolvePublicUrl(donationQrUrl)),
          };
        })
        .filter(Boolean);

      this.setData(
        {
          albumsLoading: false,
          albums: list,
        },
        () => {
          this.refreshAlbumModuleView();
        }
      );
    } catch (error) {
      this.setData({ albumsLoading: false });
      throw error;
    }
  },

  refreshAlbumModuleView() {
    const sourceRows = Array.isArray(this.data.albums) ? this.data.albums : [];
    const rows = sourceRows.filter(
      (item) => matchAlbumFilter(item, this.data.albumFilter) && matchAlbumKeyword(item, this.data.albumKeyword)
    );
    const validIds = rows.map((item) => String((item && item.id) || "")).filter(Boolean);
    const validSet = new Set(validIds);
    const allValidIds = sourceRows.map((item) => String((item && item.id) || "")).filter(Boolean);
    const allValidSet = new Set(allValidIds);
    const selectedRaw = Array.isArray(this.data.albumSelectedIds) ? this.data.albumSelectedIds : [];
    const selectedMap = new Map();
    selectedRaw.forEach((item) => {
      const id = String(item || "").trim();
      if (!id || !validSet.has(id) || selectedMap.has(id)) return;
      selectedMap.set(id, id);
    });
    const selectedIds = Array.from(selectedMap.values());
    const selectedSet = new Set(selectedIds);

    const totalCount = rows.length;
    const selectedCount = selectedIds.length;
    const allSelected = totalCount > 0 && selectedCount === totalCount;
    const summaryTotalCount = sourceRows.length;
    const expiringCount = sourceRows.filter((item) => Boolean(item && item.expirySoon && !item.expired)).length;
    const expiredCount = sourceRows.filter((item) => Boolean(item && item.expired)).length;
    const noCoverCount = sourceRows.filter((item) => !Boolean(item && item.hasCover)).length;

    const patch = {
      albumRows: rows.map((item) =>
        Object.assign({}, item, {
          selected: selectedSet.has(String((item && item.id) || "")),
        })
      ),
      albumSelectedIds: selectedIds,
      albumSelectedCount: selectedCount,
      albumTotalCount: totalCount,
      albumAllSelected: allSelected,
      albumSummaryTotalCount: summaryTotalCount,
      albumExpiringCount: expiringCount,
      albumExpiredCount: expiredCount,
      albumNoCoverCount: noCoverCount,
    };
    if (this.data.albumBatchDeleteConfirmOpen && selectedCount <= 0) {
      patch.albumBatchDeleteConfirmOpen = false;
    }

    const deletingId = String(this.data.albumDeletingTargetId || "").trim();
    if (this.data.albumDeleteConfirmOpen && deletingId && !allValidSet.has(deletingId) && !this.data.albumActionLoading) {
      patch.albumDeleteConfirmOpen = false;
      patch.albumDeletingTargetId = "";
      patch.albumDeletingTargetTitle = "";
    }

    const editingTitleId = String(this.data.albumEditingTitleId || "").trim();
    if (this.data.albumTitleModalOpen && editingTitleId && !allValidSet.has(editingTitleId) && !this.data.albumTitleSaving) {
      patch.albumTitleModalOpen = false;
      patch.albumEditingTitleId = "";
      patch.albumEditingTitleValue = "";
    }

    const editingKeyId = String(this.data.albumEditingKeyId || "").trim();
    if (this.data.albumKeyModalOpen && editingKeyId && !allValidSet.has(editingKeyId) && !this.data.albumKeySaving) {
      patch.albumKeyModalOpen = false;
      patch.albumEditingKeyId = "";
      patch.albumEditingKeyTitle = "";
      patch.albumEditingKeyValue = "";
    }

    const editingRecipientId = String(this.data.albumEditingRecipientId || "").trim();
    if (
      this.data.albumRecipientModalOpen &&
      editingRecipientId &&
      !allValidSet.has(editingRecipientId) &&
      !this.data.albumRecipientSaving
    ) {
      patch.albumRecipientModalOpen = false;
      patch.albumEditingRecipientId = "";
      patch.albumEditingRecipientTitle = "";
      patch.albumEditingRecipientName = "";
      patch.albumEditingWelcomeLetter = "";
      patch.albumEditingWelcomeLetterMode = "envelope";
    }

    const editingExpiryId = String(this.data.albumEditingExpiryId || "").trim();
    if (
      this.data.albumExpiryModalOpen &&
      editingExpiryId &&
      !allValidSet.has(editingExpiryId) &&
      !this.data.albumExpirySaving
    ) {
      patch.albumExpiryModalOpen = false;
      patch.albumEditingExpiryId = "";
      patch.albumEditingExpiryTitle = "";
      patch.albumExpiryMode = "days";
      patch.albumExpiryDays = 7;
      patch.albumExpiryDate = getDateAfterDaysText(7);
    }

    const coverUpdatingId = String(this.data.albumCoverUpdatingId || "").trim();
    if (coverUpdatingId && !allValidSet.has(coverUpdatingId)) {
      patch.albumCoverUpdatingId = "";
    }

    const donationUpdatingId = String(this.data.albumDonationUpdatingId || "").trim();
    if (donationUpdatingId && !allValidSet.has(donationUpdatingId)) {
      patch.albumDonationUpdatingId = "";
    }

    const coverTargetId = String(this.data.albumCoverTargetId || "").trim();
    if (this.data.albumCoverModalOpen && coverTargetId) {
      const coverTarget = sourceRows.find((item) => String((item && item.id) || "") === coverTargetId) || null;
      if (!coverTarget) {
        patch.albumCoverModalOpen = false;
        patch.albumCoverTargetId = "";
        patch.albumCoverTargetTitle = "";
        patch.albumCoverCurrentUrl = "";
      } else {
        patch.albumCoverTargetTitle = String(coverTarget.title || "未命名空间");
        patch.albumCoverCurrentUrl = String(coverTarget.coverResolved || "");
      }
    }

    const donationTargetId = String(this.data.albumDonationTargetId || "").trim();
    if (this.data.albumDonationModalOpen && donationTargetId) {
      const donationTarget = sourceRows.find((item) => String((item && item.id) || "") === donationTargetId) || null;
      if (!donationTarget) {
        patch.albumDonationModalOpen = false;
        patch.albumDonationTargetId = "";
        patch.albumDonationTargetTitle = "";
        patch.albumDonationCurrentUrl = "";
      } else {
        patch.albumDonationTargetTitle = String(donationTarget.title || "未命名空间");
        patch.albumDonationCurrentUrl = String(donationTarget.donationQrResolved || "");
      }
    }

    const qrAccessKey = normalizeAlbumAccessKey(this.data.albumQrAccessKey);
    if (this.data.albumQrModalOpen) {
      if (!qrAccessKey) {
        patch.albumQrModalOpen = false;
        patch.albumQrAccessKey = "";
        patch.albumQrImageUrl = "";
      } else {
        const stillExists = sourceRows.some((item) => normalizeAlbumAccessKey(item && item.access_key) === qrAccessKey);
        if (!stillExists) {
          patch.albumQrModalOpen = false;
          patch.albumQrAccessKey = "";
          patch.albumQrImageUrl = "";
        }
      }
    }

    if (this.data.albumSelectionMode) {
      patch.albumDeleteConfirmOpen = false;
      patch.albumDeletingTargetId = "";
      patch.albumDeletingTargetTitle = "";
      if (totalCount <= 0) {
        patch.albumSelectionMode = false;
        patch.albumBatchDeleteConfirmOpen = false;
      }
    }

    this.setData(patch);
  },

  onAlbumFilterChange(e) {
    const nextFilter =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.key || "all")
        : "all";
    this.setData({ albumFilter: nextFilter || "all" }, () => {
      this.refreshAlbumModuleView();
    });
  },

  onAlbumKeywordInput(e) {
    const value = e && e.detail ? String(e.detail.value || "") : "";
    this.setData({ albumKeyword: value }, () => {
      this.refreshAlbumModuleView();
    });
  },

  onClearAlbumKeyword() {
    if (!this.data.albumKeyword) return;
    this.setData({ albumKeyword: "" }, () => {
      this.refreshAlbumModuleView();
    });
  },

  async loadReleases() {
    this.setData({ releasesLoading: true });
    try {
      const rows = await listAdminReleases(200);
      const list = (Array.isArray(rows) ? rows : [])
        .map((row) => {
          const id = Number((row && row.id) || 0);
          const version = String((row && row.version) || "").trim();
          const platform = String((row && row.platform) || "").trim();
          const downloadUrl = resolvePublicUrl(row && row.download_url);
          const updateLog = String((row && row.update_log) || "").trim();
          const forceUpdate = Boolean(row && row.force_update);
          return {
            id,
            version,
            platform,
            platformClass: toReleasePlatformClass(platform),
            downloadUrl,
            updateLog,
            forceUpdate,
            createdAtDisplay: formatDateDisplay(row && row.created_at),
          };
        })
        .filter((item) => Number.isInteger(item.id) && item.id > 0);

      this.setData({ releases: list, releasesLoading: false });
    } catch (error) {
      this.setData({ releasesLoading: false });
      throw error;
    }
  },

  async loadRecentBookings(options) {
    const config = options && typeof options === "object" ? options : {};
    const shouldThrow = config.throwOnError !== false;
    const shouldShowNotice = Boolean(config.showNotice);
    const hasReadyBookings = Boolean(this.data.bookingsReady);
    const isFirstLoad = !this._bookingsLoadedOnce && !hasReadyBookings;

    this.setData({
      bookingsLoading: isFirstLoad,
      bookingsRefreshing: !isFirstLoad && hasReadyBookings,
      bookingsError: "",
    });
    try {
      const rows = await listAdminRecentBookings(200);
      const list = (Array.isArray(rows) ? rows : []).map((row) => {
        const status = String((row && row.status) || "pending");
        const userDisplay = String((row && row.user_name) || (row && row.user_id) || "未知用户").trim();
        const userEmail = String((row && row.user_email) || "").trim();
        const phone = String((row && row.phone) || (row && row.user_phone) || "").trim();
        const wechat = String((row && row.wechat) || "").trim();
        const location = String((row && row.location) || "").trim();
        const cityName = String((row && row.city_name) || "").trim();
        const notes = String((row && row.notes) || "").trim();
        const latitude = Number(row && row.latitude);
        const longitude = Number(row && row.longitude);
        const hasCoordinate = isValidCoordinatePair(latitude, longitude);
        const isDeletable = isBookingDeletable(status);
        return Object.assign({}, row, {
          id: String((row && row.id) || ""),
          userDisplay,
          userEmail,
          typeDisplay: String((row && row.type_name) || "未命名类型"),
          bookingDateDisplay: String((row && row.booking_date) || ""),
          locationDisplay: location || "未填写地点",
          cityDisplay: cityName,
          phoneDisplay: phone || "未填写手机号",
          wechatDisplay: wechat || "未填写微信号",
          notesDisplay: notes,
          status,
          statusText: toStatusBadgeLabel(status),
          statusPlainText: toStatusLabel(status),
          statusClass: `booking-status-chip--${status}`,
          isDeletable,
          canConfirm: status === "pending",
          canStart: status === "confirmed",
          canFinish: status === "in_progress",
          canCancel: status === "pending" || status === "confirmed" || status === "in_progress",
          latitude: hasCoordinate ? latitude : 0,
          longitude: hasCoordinate ? longitude : 0,
          hasCoordinate,
          coordinateText: hasCoordinate ? `${latitude.toFixed(6)}, ${longitude.toFixed(6)}` : "",
          createdAtText: formatDateTime(row && row.created_at),
          searchText: "",
        });
      });

      list.forEach((item) => {
        item.searchText = buildBookingSearchText(item);
      });

      this._bookingsLoadedOnce = true;
      this.setData(
        {
          bookingsLoading: false,
          bookingsRefreshing: false,
          bookingsError: "",
          bookingsReady: true,
          bookings: list,
        },
        () => {
          this.refreshBookingModuleView();
        }
      );
      return list;
    } catch (error) {
      const message = readErrorMessage(error, "加载预约列表失败");
      const patch = {
        bookingsLoading: false,
        bookingsRefreshing: false,
        bookingsError: message,
        bookingsReady: hasReadyBookings,
      };
      if (!hasReadyBookings) {
        patch.bookings = [];
      }
      this.setData(patch, () => {
        if (!hasReadyBookings) {
          this.refreshBookingModuleView();
        }
      });
      if (shouldShowNotice) {
        this.showNotice("error", message);
      }
      if (shouldThrow) {
        throw error;
      }
      return null;
    }
  },

  async refreshBookingSection(options) {
    const config = options && typeof options === "object" ? options : {};
    const silent = Boolean(config.silent);
    const stopPullDown = config.stopPullDown !== false;
    const panelTab = String(this.data.bookingPanelTab || "bookings");
    const hasReadyData =
      panelTab === "types"
        ? Boolean(this.data.bookingTypesReady)
        : panelTab === "cities"
          ? Boolean(this.data.citiesReady)
          : Boolean(this.data.bookingsReady);

    try {
      let result = null;
      let successText = "预约模块已刷新";
      let emptyFailText = "预约模块加载失败，请稍后重试";
      let staleFailText = "预约模块刷新失败，已保留当前内容，请稍后重试";
      if (panelTab === "types") {
        result = await this.loadBookingTypes({ throwOnError: false });
        successText = "预约类型已刷新";
        emptyFailText = "预约类型加载失败，请稍后重试";
        staleFailText = "预约类型刷新失败，已保留当前内容，请稍后重试";
      } else if (panelTab === "cities") {
        result = await this.loadAllowedCities({ throwOnError: false });
        successText = "可预约城市已刷新";
        emptyFailText = "城市配置加载失败，请稍后重试";
        staleFailText = "城市配置刷新失败，已保留当前内容，请稍后重试";
      } else {
        result = await this.loadRecentBookings({ throwOnError: false });
        successText = "预约列表已刷新";
        emptyFailText = "预约列表加载失败，请稍后重试";
        staleFailText = "预约列表刷新失败，已保留当前内容，请稍后重试";
      }

      const success = result !== null;
      if (!silent) {
        if (success) {
          this.showNotice("success", successText);
        } else if (hasReadyData) {
          this.showNotice("warning", staleFailText);
        } else {
          this.showNotice("error", emptyFailText);
        }
      }
      return success;
    } finally {
      if (stopPullDown) {
        wx.stopPullDownRefresh();
      }
    }
  },

  onRefreshBookingSection() {
    const panelTab = String(this.data.bookingPanelTab || "bookings");
    if (panelTab === "types") {
      if (
        this.data.bookingTypesLoading ||
        this.data.bookingTypesRefreshing ||
        this.data.bookingTypeSaving ||
        this.data.bookingTypeTogglingId !== 0 ||
        this.data.bookingTypeDeletingId !== 0 ||
        this.data.bookingTypeBatchDeleting
      ) {
        return;
      }
    } else if (panelTab === "cities") {
      if (
        this.data.citiesLoading ||
        this.data.citiesRefreshing ||
        this.data.citySaving ||
        this.data.cityTogglingId !== 0 ||
        this.data.cityDeletingId !== 0 ||
        this.data.cityBatchDeleting
      ) {
        return;
      }
    } else if (
      this.data.bookingsLoading ||
      this.data.bookingsRefreshing ||
      this.data.bookingActionLoading ||
      this.data.bookingBatchDeleting ||
      this.data.bookingSelectionMode ||
      this.data.bookingUpdatingId
    ) {
      return;
    }

    void this.refreshBookingSection({ silent: false, stopPullDown: false });
  },

  refreshBookingModuleView() {
    const rows = Array.isArray(this.data.bookings) ? this.data.bookings : [];
    const filter = String(this.data.bookingFilter || "all");
    const keyword = normalizeBookingKeyword(this.data.bookingKeyword);
    const filtered = rows.filter((item) => {
      const statusMatched = filter === "all" ? true : String(item && item.status) === filter;
      if (!statusMatched) return false;
      if (!keyword) return true;
      const searchText = String((item && item.searchText) || "").trim() || buildBookingSearchText(item);
      return searchText.includes(keyword);
    });
    const pendingCount = filtered.filter((item) => String((item && item.status) || "") === "pending").length;
    const activeCount = filtered.filter((item) => {
      const status = String((item && item.status) || "");
      return status === "pending" || status === "confirmed" || status === "in_progress";
    }).length;

    const deletableIds = filtered
      .filter((item) => isBookingDeletable(item && item.status))
      .map((item) => String((item && item.id) || ""))
      .filter(Boolean);
    const deletableSet = new Set(deletableIds);

    const selectedRaw = Array.isArray(this.data.bookingSelectedIds) ? this.data.bookingSelectedIds : [];
    const selectedMap = new Map();
    selectedRaw.forEach((item) => {
      const id = String(item || "").trim();
      if (!id) return;
      if (!deletableSet.has(id)) return;
      if (selectedMap.has(id)) return;
      selectedMap.set(id, id);
    });

    const selectedIds = Array.from(selectedMap.values());
    const selectedSet = new Set(selectedIds);
    const normalized = filtered.map((item) =>
      Object.assign({}, item, {
        selected: selectedSet.has(String((item && item.id) || "")),
      })
    );

    const selectedCount = selectedIds.length;
    const deletableCount = deletableIds.length;
    const pageSize = Math.max(1, Number(this.data.bookingPageSize || 10));
    const totalCount = normalized.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    const rawVisibleCount = Math.max(pageSize, Number(this.data.bookingVisibleCount || pageSize));
    const visibleCount = totalCount > 0 ? Math.min(rawVisibleCount, totalCount) : pageSize;
    const bookingRows = normalized.slice(0, visibleCount);
    const currentPage = totalCount > 0 ? Math.max(1, Math.ceil(bookingRows.length / pageSize)) : 1;
    const bookingHasMoreVisible = bookingRows.length < totalCount;
    const pageDeletableIds = bookingRows
      .filter((item) => isBookingDeletable(item && item.status))
      .map((item) => String((item && item.id) || ""))
      .filter(Boolean);
    const pageDeletableCount = pageDeletableIds.length;
    const allSelected =
      deletableCount > 0 && deletableIds.every((id) => selectedSet.has(String(id)));

    const patch = {
      bookingFilteredList: normalized,
      bookingRows,
      bookingCurrentPage: currentPage,
      bookingVisibleCount: visibleCount,
      bookingTotalPages: totalPages,
      bookingHasMoreVisible,
      bookingSelectedIds: selectedIds,
      bookingSelectedCount: selectedCount,
      bookingPendingCount: pendingCount,
      bookingActiveCount: activeCount,
      bookingDeletableCount: deletableCount,
      bookingPageDeletableCount: pageDeletableCount,
      bookingAllSelected: allSelected,
    };

    if (this.data.bookingSelectionMode && deletableCount <= 0) {
      patch.bookingSelectionMode = false;
    }

    this.setData(patch);
  },

  onBookingKeywordInput(e) {
    const value = e && e.detail ? String(e.detail.value || "") : "";
    this.setData({
      bookingKeyword: value,
      bookingCurrentPage: 1,
      bookingVisibleCount: Math.max(1, Number(this.data.bookingPageSize || 10)),
    });
    this.clearBookingSearchTimer();
    this._bookingSearchTimer = setTimeout(() => {
      this._bookingSearchTimer = null;
      this.refreshBookingModuleView();
    }, 300);
  },

  onClearBookingKeyword() {
    if (!this.data.bookingKeyword) return;
    this.clearBookingSearchTimer();
    this.setData({
      bookingKeyword: "",
      bookingCurrentPage: 1,
      bookingVisibleCount: Math.max(1, Number(this.data.bookingPageSize || 10)),
    }, () => {
      this.refreshBookingModuleView();
    });
  },

  loadMoreBookingRows() {
    if (this.data.bookingBatchDeleting || this.data.bookingActionLoading) return;
    if (String(this.data.bookingPanelTab || "bookings") !== "bookings") return;
    if (!this.data.bookingHasMoreVisible) return;
    const pageSize = Math.max(1, Number(this.data.bookingPageSize || 10));
    const visibleCount = Math.max(pageSize, Number(this.data.bookingVisibleCount || pageSize));
    this.setData({ bookingVisibleCount: visibleCount + pageSize }, () => {
      this.refreshBookingModuleView();
    });
  },

  async runMaintenance() {
    if (this._maintenanceRunningLock || this.data.maintenanceRunning) return;
    this._maintenanceRunningLock = true;
    this.setData({ maintenanceRunning: true });

    try {
      const result = await runAdminMaintenanceTasks();
      const cleanup = result && result.cleanup_result ? result.cleanup_result : {};
      const deletedPhotos = Number(cleanup.deleted_photos || 0);
      const deletedFolders = Number(cleanup.deleted_folders || 0);
      const deletedAlbums = Number(cleanup.deleted_albums || 0);
      const deletedStorageFiles = Number(cleanup.deleted_storage_files || 0);
      const cleanedSessions = Number(result && result.sessions_cleaned ? result.sessions_cleaned : 0);
      const cleanedIpAttempts = Number(result && result.ip_attempts_cleaned ? result.ip_attempts_cleaned : 0);
      const cleanedBetaBindings = Number(
        result && result.beta_feature_bindings_cleaned ? result.beta_feature_bindings_cleaned : 0
      );
      const cleanedPhotoViews = Number(result && result.photo_views_cleaned ? result.photo_views_cleaned : 0);
      const cleanedResetTokens = Number(
        result && result.password_reset_tokens_cleaned ? result.password_reset_tokens_cleaned : 0
      );
      const cleanedActiveLogs = Number(result && result.user_active_logs_cleaned ? result.user_active_logs_cleaned : 0);
      const cleanedCaptchaChallenges = Number(
        result && result.slider_captcha_challenges_cleaned ? result.slider_captcha_challenges_cleaned : 0
      );
      const cleanedBlackouts = Number(result && result.booking_blackouts_cleaned ? result.booking_blackouts_cleaned : 0);
      const cleanedAnalyticsDaily = Number(result && result.analytics_daily_cleaned ? result.analytics_daily_cleaned : 0);
      const analyticsSnapshotsBackfilled = Number(
        result && result.analytics_snapshots_backfilled ? result.analytics_snapshots_backfilled : 0
      );
      const warningList = Array.isArray(cleanup.storage_cleanup_warnings)
        ? cleanup.storage_cleanup_warnings
            .map((item) =>
              String(item || "")
                .replace(/https?:\/\/\S+/gi, "")
                .replace(/\s+/g, " ")
                .trim()
            )
            .map((item) => {
              if (!item) return "";
              if (item.includes("Cannot operate more than 50 files one time")) {
                return "单次存储删除数量超过上限，系统已自动切换为分批删除。";
              }
              return item.length > 100 ? `${item.slice(0, 100)}...` : item;
            })
            .filter((item) => item !== "")
        : [];
      const skippedTasks = Array.isArray(result && result.skipped_tasks)
        ? result.skipped_tasks.filter((item) => String(item || "").trim() !== "")
        : [];
      const taskLabelMap = {
        beta_feature_bindings_cleanup: "内测功能绑定清理",
        slider_captcha_challenges_cleanup: "滑块验证记录清理",
        booking_blackouts_cleanup: "预约屏蔽日期清理",
        analytics_daily_cleanup: "每日统计清理",
        analytics_snapshot_update: "统计快照更新",
      };
      const skippedTaskLabels = skippedTasks.map((task) => taskLabelMap[task] || task);
      const summaryParts = [
        `清理照片${deletedPhotos}张`,
        `清理文件夹${deletedFolders}个`,
        `清理相册${deletedAlbums}个`,
        `清理存储文件${deletedStorageFiles}个`,
        `清理会话${cleanedSessions}条`,
        `清理 IP 尝试${cleanedIpAttempts}条`,
        `清理浏览记录${cleanedPhotoViews}条`,
        `清理内测绑定${cleanedBetaBindings}条`,
        `清理重置令牌${cleanedResetTokens}条`,
        `清理活跃日志${cleanedActiveLogs}条`,
        `清理滑块验证${cleanedCaptchaChallenges}条`,
        `清理预约屏蔽日期${cleanedBlackouts}条`,
        `清理每日统计${cleanedAnalyticsDaily}条`,
      ];
      const extraParts = [];
      if (analyticsSnapshotsBackfilled > 0) {
        extraParts.push(`趋势快照已回填 ${analyticsSnapshotsBackfilled} 天`);
      }
      if (warningList.length > 0) {
        extraParts.push(`存储清理告警：${warningList.join("；")}`);
      }
      if (skippedTaskLabels.length > 0) {
        extraParts.push(`跳过任务：${skippedTaskLabels.join("、")}`);
      }
      const maintenanceSummary = summaryParts.join("，");
      const maintenanceMessage = extraParts.length > 0
        ? `${maintenanceSummary}；${extraParts.join("；")}`
        : maintenanceSummary;
      const refreshResults = await Promise.all(
        [
          this.loadStats(),
          this.loadBlockedDates(),
          this.loadBookingTypes(),
          this.loadAllowedCities(),
          this.loadPoses(),
          this.loadPoseTags(),
          this.loadGalleryPhotos(),
          this.loadAlbums(),
          this.loadReleases(),
          this.loadAboutSettings(),
          this.loadRecentBookings(),
        ].map((task) =>
          Promise.resolve(task)
            .then(() => ({ ok: true, error: null }))
            .catch((error) => ({ ok: false, error }))
        )
      );

      const failedRefresh = refreshResults.filter((item) => item && item.ok === false);
      if (failedRefresh.length > 0) {
        const firstReason = failedRefresh[0] ? failedRefresh[0].error : null;
        const firstMessage = readErrorMessage(firstReason, "数据刷新失败");
        this.showNotice(
          "warning",
          `维护已完成：${maintenanceMessage}；但有 ${failedRefresh.length} 项数据刷新失败（${firstMessage}）`
        );
      } else {
        this.showNotice("success", `维护完成：${maintenanceMessage}`);
      }
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "维护任务执行失败"));
    } finally {
      this._maintenanceRunningLock = false;
      this.setData({ maintenanceRunning: false });
    }
  },

  onOpenScheduleAddModal() {
    if (this.data.scheduleSubmitting || this.data.scheduleBatchDeleting || this.data.scheduleActionLoading) {
      return;
    }
    this.setData({
      scheduleAddModalOpen: true,
      scheduleStartDate: "",
      scheduleEndDate: "",
      scheduleReason: "",
    });
  },

  onCloseScheduleAddModal() {
    if (this.data.scheduleSubmitting) return;
    this.setData({
      scheduleAddModalOpen: false,
      scheduleStartDate: "",
      scheduleEndDate: "",
      scheduleReason: "",
    });
  },

  onScheduleStartDateChange(e) {
    const value = e && e.detail ? String(e.detail.value || "") : "";
    this.setData({ scheduleStartDate: value });
  },

  onScheduleEndDateChange(e) {
    const value = e && e.detail ? String(e.detail.value || "") : "";
    this.setData({ scheduleEndDate: value });
  },

  onScheduleReasonInput(e) {
    const value = e && e.detail ? e.detail.value : "";
    this.setData({ scheduleReason: String(value || "") });
  },

  async onSubmitScheduleAdd() {
    if (this.data.scheduleSubmitting) return;

    const startDate = String(this.data.scheduleStartDate || "").trim();
    const endDate = String(this.data.scheduleEndDate || "").trim();
    const today = getTodayIsoDateOnly();
    if (!startDate) {
      this.showNotice("error", "请选择开始日期");
      return;
    }
    if (today && startDate < today) {
      this.showNotice("error", "不能锁定今天之前的日期");
      return;
    }

    const dates = buildIsoDateRange(startDate, endDate || startDate);
    if (dates === null) {
      this.showNotice("error", "日期格式错误，请重新选择");
      return;
    }
    if (!dates.length) {
      this.showNotice("error", "结束日期不能早于开始日期");
      return;
    }

    this.setData({ scheduleSubmitting: true });
    let createdCount = 0;
    let duplicatedCount = 0;
    try {
      const reason = String(this.data.scheduleReason || "").trim();

      for (let i = 0; i < dates.length; i += 1) {
        const date = dates[i];
        try {
          await createAdminBlockedDate(date, reason);
          createdCount += 1;
        } catch (error) {
          if (isDuplicateDateError(error)) {
            duplicatedCount += 1;
            continue;
          }
          throw error;
        }
      }

      if (createdCount > 0) {
        this.setData({
          scheduleAddModalOpen: false,
          scheduleStartDate: "",
          scheduleEndDate: "",
          scheduleReason: "",
        });
      }

      if (createdCount > 0 || duplicatedCount > 0) {
        const refreshOutcome = await this.refreshScheduleMutationDependencies();
        const warnings = Array.isArray(refreshOutcome.warnings) ? refreshOutcome.warnings : [];
        const suffix = warnings.length > 0 ? `；${warnings.join("；")}` : "";

        if (createdCount > 0 && duplicatedCount > 0) {
          this.showNotice(warnings.length > 0 ? "warning" : "success", `已锁定 ${createdCount} 天，跳过 ${duplicatedCount} 个已存在日期${suffix}`);
        } else if (createdCount > 0) {
          this.showNotice(warnings.length > 0 ? "warning" : "success", `档期已锁定${suffix}`);
        } else {
          this.showNotice(warnings.length > 0 ? "warning" : "info", `所选日期均已锁定，无需重复添加${suffix}`);
        }
      } else {
        this.showNotice("error", "添加档期失败，请稍后重试");
      }
    } catch (error) {
      const errorMessage = readErrorMessage(error, "新增锁定档期失败");
      if (createdCount > 0) {
        this.setData({
          scheduleAddModalOpen: false,
          scheduleStartDate: "",
          scheduleEndDate: "",
          scheduleReason: "",
        });
      }
      if (createdCount > 0 || duplicatedCount > 0) {
        const refreshOutcome = await this.refreshScheduleMutationDependencies();
        const warnings = Array.isArray(refreshOutcome.warnings) ? refreshOutcome.warnings : [];
        const parts = [];
        if (createdCount > 0) {
          parts.push(`已锁定 ${createdCount} 天`);
        }
        if (duplicatedCount > 0) {
          parts.push(`跳过 ${duplicatedCount} 个已存在日期`);
        }
        parts.push(`其余添加失败：${errorMessage}`);
        if (warnings.length > 0) {
          parts.push(...warnings);
        }
        this.showNotice("warning", parts.join("；"));
      } else {
        this.showNotice("error", errorMessage);
      }
    } finally {
      this.setData({ scheduleSubmitting: false });
    }
  },

  onEnterScheduleSelectionMode() {

    if (this.data.scheduleBatchDeleting || this.data.scheduleActionLoading) return;
    if (!this.data.scheduleTotalCount) return;
    this.setData(
      {
        scheduleSelectionMode: true,
        scheduleSelectedIds: [],
        scheduleDeleteConfirmOpen: false,
        scheduleDeletingTargetId: "",
        scheduleDeletingTargetDate: "",
        scheduleBatchDeleteConfirmOpen: false,
      },
      () => {
        this.refreshScheduleModuleView();
      }
    );
  },

  onCancelScheduleSelectionMode() {
    if (this.data.scheduleBatchDeleting || this.data.scheduleActionLoading) return;
    this.setData(
      {
        scheduleSelectionMode: false,
        scheduleSelectedIds: [],
        scheduleBatchDeleteConfirmOpen: false,
      },
      () => {
        this.refreshScheduleModuleView();
      }
    );
  },

  onToggleScheduleSelection(e) {
    if (!this.data.scheduleSelectionMode || this.data.scheduleBatchDeleting) return;
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;

    const selected = Array.isArray(this.data.scheduleSelectedIds)
      ? this.data.scheduleSelectedIds.slice()
      : [];
    const index = selected.indexOf(id);
    if (index >= 0) {
      selected.splice(index, 1);
    } else {
      selected.push(id);
    }

    this.setData({ scheduleSelectedIds: selected }, () => {
      this.refreshScheduleModuleView();
    });
  },

  onToggleScheduleSelectAll() {
    if (!this.data.scheduleSelectionMode || this.data.scheduleBatchDeleting) return;
    const allIds = (Array.isArray(this.data.blockedDates) ? this.data.blockedDates : [])
      .map((item) => String((item && item.id) || ""))
      .filter(Boolean);
    const nextSelected = this.data.scheduleAllSelected ? [] : allIds;
    this.setData({ scheduleSelectedIds: nextSelected }, () => {
      this.refreshScheduleModuleView();
    });
  },

  onOpenScheduleDeleteConfirm(e) {
    if (this.data.scheduleSelectionMode || this.data.scheduleBatchDeleting || this.data.scheduleActionLoading) {
      return;
    }
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;
    const target = (this.data.blockedDates || []).find((item) => String((item && item.id) || "") === id) || null;
    if (!target) return;

    this.setData({
      scheduleDeleteConfirmOpen: true,
      scheduleDeletingTargetId: id,
      scheduleDeletingTargetDate: String(target.dateLabel || target.date || ""),
    });
  },

  onCloseScheduleDeleteConfirm() {
    if (this.data.scheduleActionLoading) return;
    this.setData({
      scheduleDeleteConfirmOpen: false,
      scheduleDeletingTargetId: "",
      scheduleDeletingTargetDate: "",
    });
  },

  async onConfirmScheduleDelete() {
    const id = String(this.data.scheduleDeletingTargetId || "").trim();
    if (!id) {
      this.onCloseScheduleDeleteConfirm();
      return;
    }
    if (this.data.scheduleActionLoading || this.data.scheduleBatchDeleting) return;

    this.setData({ scheduleActionLoading: true });
    try {
      await deleteAdminBlockedDate(id);
      this.setData({
        scheduleDeleteConfirmOpen: false,
        scheduleDeletingTargetId: "",
        scheduleDeletingTargetDate: "",
      });
      const refreshOutcome = await this.refreshScheduleMutationDependencies();
      const warnings = Array.isArray(refreshOutcome.warnings) ? refreshOutcome.warnings : [];
      const suffix = warnings.length > 0 ? `；${warnings.join("；")}` : "";
      this.showNotice(warnings.length > 0 ? "warning" : "success", `档期锁定已删除${suffix}`);
    } catch (error) {
      this.setData({
        scheduleDeleteConfirmOpen: false,
        scheduleDeletingTargetId: "",
        scheduleDeletingTargetDate: "",
      });
      this.showNotice("error", readErrorMessage(error, "删除档期锁定失败"));
    } finally {
      this.setData({ scheduleActionLoading: false });
    }
  },

  onOpenScheduleBatchDeleteConfirm() {

    if (!this.data.scheduleSelectionMode || this.data.scheduleBatchDeleting) return;
    if (!this.data.scheduleSelectedCount) {
      this.showNotice("error", "请先选择要删除的档期");
      return;
    }
    this.setData({ scheduleBatchDeleteConfirmOpen: true });
  },

  onCloseScheduleBatchDeleteConfirm() {
    if (this.data.scheduleBatchDeleting) return;
    this.setData({ scheduleBatchDeleteConfirmOpen: false });
  },

  async onConfirmScheduleBatchDelete() {
    if (this.data.scheduleBatchDeleting) return;
    const selectedIds = Array.isArray(this.data.scheduleSelectedIds)
      ? this.data.scheduleSelectedIds.map((item) => String(item || "")).filter(Boolean)
      : [];
    if (!selectedIds.length) {
      this.setData({ scheduleBatchDeleteConfirmOpen: false });
      this.showNotice("error", "请先选择要删除的档期");
      return;
    }

    this.setData({
      scheduleBatchDeleting: true,
      scheduleBatchDeleteConfirmOpen: false,
    });

    let deletedCount = 0;
    let failedCount = 0;
    for (let i = 0; i < selectedIds.length; i += 1) {
      const id = selectedIds[i];
      try {
        await deleteAdminBlockedDate(id);
        deletedCount += 1;
      } catch (error) {
        failedCount += 1;
      }
    }

    this.setData(
      {
        scheduleBatchDeleting: false,
        scheduleSelectionMode: false,
        scheduleSelectedIds: [],
      },
      () => {
        this.refreshScheduleModuleView();
      }
    );

    if (deletedCount > 0) {
      const refreshOutcome = await this.refreshScheduleMutationDependencies();
      const warnings = Array.isArray(refreshOutcome.warnings) ? refreshOutcome.warnings : [];
      const suffix = warnings.length > 0 ? `；${warnings.join("；")}` : "";
      const noticeType = warnings.length > 0 || failedCount > 0 ? "warning" : "success";
      if (failedCount > 0) {
        this.showNotice(noticeType, `成功删除 ${deletedCount} 个档期锁定，失败 ${failedCount} 个${suffix}`);
      } else {
        this.showNotice(noticeType, `成功删除 ${deletedCount} 个档期锁定${suffix}`);
      }
    } else {
      this.showNotice("error", "批量删除档期锁定失败，请稍后重试");
    }
  },

  onOpenGalleryUploadModal() {

    if (this.data.galleryUploadSubmitting || this.data.galleryBatchDeleting || this.data.galleryActionLoading) {
      return;
    }
    this.setData({
      galleryUploadModalOpen: true,
      galleryUploadFiles: [],
      galleryUploadProgressCurrent: 0,
      galleryUploadProgressTotal: 0,
    });
  },

  onCloseGalleryUploadModal() {
    if (this.data.galleryUploadSubmitting) return;
    this.setData({
      galleryUploadModalOpen: false,
      galleryUploadFiles: [],
      galleryUploadProgressCurrent: 0,
      galleryUploadProgressTotal: 0,
    });
    this.clearGalleryUploadDraft();
  },

  onChooseGalleryUploadImages() {
    if (this.data.galleryUploadSubmitting) return;
    this.syncSectionMeta("gallery");
    if (this.data.mobileMenuOpen) {
      this.setData({ mobileMenuOpen: false });
    }
    this.markTransientForegroundReturn("gallery-upload-choose-media");
    wx.chooseMedia({
      count: 9,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: (res) => {
        const tempFiles = res && Array.isArray(res.tempFiles) ? res.tempFiles : [];
        const files = tempFiles
          .map((file, index) => {
            const tempFilePath = String((file && file.tempFilePath) || "").trim();
            const size = Number((file && file.size) || 0);
            const width = Number((file && file.width) || 0);
            const height = Number((file && file.height) || 0);
            if (!tempFilePath) return null;
            const fileName = pickFileNameFromPath(tempFilePath, `gallery_${Date.now()}_${index + 1}.jpg`);
            return {
              key: `${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`,
              tempFilePath,
              fileName,
              size,
              sizeText: formatFileSize(size),
              width: Number.isFinite(width) ? width : 0,
              height: Number.isFinite(height) ? height : 0,
            };
          })
          .filter(Boolean);

        if (!files.length) {
          this.showNotice("error", "选择图片失败，请重试");
          return;
        }

        this.setData({ galleryUploadFiles: files });
        this.persistGalleryUploadDraft();
      },
      fail: (error) => {
        const message = String((error && error.errMsg) || "");
        if (message.toLowerCase().includes("cancel")) return;
        this.showNotice("error", "选择图片失败，请重试");
      },
    });
  },

  onClearGalleryUploadFiles() {
    if (this.data.galleryUploadSubmitting) return;
    this.setData({ galleryUploadFiles: [] });
    this.clearGalleryUploadDraft();
  },

  onRemoveGalleryUploadFile(e) {
    if (this.data.galleryUploadSubmitting) return;
    const index =
      e && e.currentTarget && e.currentTarget.dataset
        ? Number(e.currentTarget.dataset.index)
        : -1;
    if (!Number.isInteger(index) || index < 0) return;
    const files = Array.isArray(this.data.galleryUploadFiles) ? this.data.galleryUploadFiles.slice() : [];
    if (index >= files.length) return;
    files.splice(index, 1);
    this.setData({ galleryUploadFiles: files });
    if (files.length > 0) {
      this.persistGalleryUploadDraft();
    } else {
      this.clearGalleryUploadDraft();
    }
  },

  async onSubmitGalleryUpload() {
    if (this.data.galleryUploadSubmitting) return;
    const files = Array.isArray(this.data.galleryUploadFiles) ? this.data.galleryUploadFiles : [];
    if (!files.length) {
      this.showNotice("error", "请先选择图片");
      return;
    }

    this.setData({
      galleryUploadSubmitting: true,
      galleryUploadProgressCurrent: 0,
      galleryUploadProgressTotal: files.length,
    });
    this.persistGalleryUploadDraft();

    let successCount = 0;
    let failedCount = 0;
    let lastErrorMessage = "";

    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      this.setData({ galleryUploadProgressCurrent: i + 1 });
      try {
        await createAdminGalleryPhoto({
          filePath: file.tempFilePath,
          fileName: file.fileName,
          width: file.width,
          height: file.height,
        });
        successCount += 1;
      } catch (error) {
        failedCount += 1;
        lastErrorMessage = readErrorMessage(error, "上传失败");
      }
    }

    this.setData({
      galleryUploadSubmitting: false,
      galleryUploadModalOpen: false,
      galleryUploadFiles: [],
      galleryUploadProgressCurrent: 0,
      galleryUploadProgressTotal: 0,
    });
    this.clearGalleryUploadDraft();

    if (successCount > 0) {
      let refreshWarning = "";
      try {
        await Promise.all([this.loadGalleryPhotos(), this.loadStats()]);
      } catch (refreshError) {
        refreshWarning = readErrorMessage(refreshError, "请稍后手动刷新");
      }
      if (failedCount > 0) {
        const suffix = refreshWarning ? `；列表刷新失败：${refreshWarning}` : "";
        this.showNotice("info", `上传完成：成功 ${successCount} 张，失败 ${failedCount} 张${suffix}`);
      } else {
        const suffix = refreshWarning ? `；列表刷新失败：${refreshWarning}` : "";
        this.showNotice("success", `成功上传 ${successCount} 张照片${suffix}`);
      }
    } else {
      this.showNotice("error", lastErrorMessage || "上传失败，请稍后重试");
    }
  },

  onEnterGallerySelectionMode() {
    if (this.data.galleryBatchDeleting || this.data.galleryActionLoading) return;
    if (!this.data.galleryTotalCount) return;
    this.setData(
      {
        gallerySelectionMode: true,
        gallerySelectedIds: [],
        galleryDeleteConfirmOpen: false,
        galleryDeletingTargetId: "",
        galleryDeletingTargetAssets: [],
        galleryBatchDeleteConfirmOpen: false,
      },
      () => {
        this.refreshGalleryModuleView();
      }
    );
  },

  onCancelGallerySelectionMode() {
    if (this.data.galleryBatchDeleting || this.data.galleryActionLoading) return;
    this.setData(
      {
        gallerySelectionMode: false,
        gallerySelectedIds: [],
        galleryBatchDeleteConfirmOpen: false,
      },
      () => {
        this.refreshGalleryModuleView();
      }
    );
  },

  onClearGalleryAlbumFilter() {
    if (this.data.galleryBatchDeleting || this.data.galleryActionLoading) return;
    this.setData(
      {
        galleryAlbumFilterId: "",
        galleryAlbumFilterTitle: "",
        galleryCurrentPage: 1,
        gallerySelectionMode: false,
        gallerySelectedIds: [],
        galleryBatchDeleteConfirmOpen: false,
      },
      () => {
        this.refreshGalleryModuleView();
      }
    );
  },

  onToggleGallerySelection(e) {
    if (!this.data.gallerySelectionMode || this.data.galleryBatchDeleting) return;
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;

    const selected = Array.isArray(this.data.gallerySelectedIds) ? this.data.gallerySelectedIds.slice() : [];
    const index = selected.indexOf(id);
    if (index >= 0) {
      selected.splice(index, 1);
    } else {
      selected.push(id);
    }
    this.setData({ gallerySelectedIds: selected }, () => {
      this.refreshGalleryModuleView();
    });
  },

  onToggleGallerySelectAll() {
    if (!this.data.gallerySelectionMode || this.data.galleryBatchDeleting) return;
    const allIds = (Array.isArray(this.data.galleryFilteredRows) ? this.data.galleryFilteredRows : [])
      .map((item) => String((item && item.id) || ""))
      .filter(Boolean);
    const nextSelected = this.data.galleryAllSelected ? [] : allIds;
    this.setData({ gallerySelectedIds: nextSelected }, () => {
      this.refreshGalleryModuleView();
    });
  },

  onPreviewGalleryImage(e) {
    if (this.data.gallerySelectionMode) return;
    const current =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.url || "")
        : "";
    if (!current) return;

    const urls = (Array.isArray(this.data.galleryFilteredRows) ? this.data.galleryFilteredRows : [])
      .map((item) => String((item && item.previewResolved) || ""))
      .filter(Boolean);
    const uniqueUrls = Array.from(new Set(urls.length ? urls : [current]));
    this.markTransientForegroundReturn("gallery-preview-image");
    wx.previewImage({
      current,
      urls: uniqueUrls,
    });
  },

  async onHideGalleryPhoto(e) {
    if (this.data.gallerySelectionMode || this.data.galleryBatchDeleting || this.data.galleryActionLoading) return;
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;

    const target = (Array.isArray(this.data.galleryPhotos) ? this.data.galleryPhotos : []).find(
      (item) => String((item && item.id) || "") === id
    );
    if (!target) return;
    const nextPublic = !Boolean(target.isPublic);

    this.setData({ galleryActionLoading: true });
    try {
      await setAdminGalleryPhotoPublic(id, nextPublic);
      this.showNotice("success", nextPublic ? "照片已恢复公开展示" : "照片已隐藏");
      await this.safeRefresh(
        [this.loadGalleryPhotos(), this.loadStats()],
        nextPublic ? "照片已恢复公开展示" : "照片已隐藏"
      );
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, nextPublic ? "恢复照片失败" : "隐藏照片失败"));
    } finally {
      this.setData({ galleryActionLoading: false });
    }
  },

  onOpenGalleryDeleteConfirm(e) {
    if (this.data.gallerySelectionMode || this.data.galleryBatchDeleting || this.data.galleryActionLoading) return;
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;
    const target = (this.data.galleryPhotos || []).find((item) => String((item && item.id) || "") === id) || null;
    if (!target) return;

    this.setData({
      galleryDeleteConfirmOpen: true,
      galleryDeletingTargetId: id,
      galleryDeletingTargetAssets: Array.isArray(target.assets) ? target.assets : [],
    });
  },

  onCloseGalleryDeleteConfirm() {
    if (this.data.galleryActionLoading) return;
    this.setData({
      galleryDeleteConfirmOpen: false,
      galleryDeletingTargetId: "",
      galleryDeletingTargetAssets: [],
    });
  },

  async onConfirmGalleryDelete() {
    const id = String(this.data.galleryDeletingTargetId || "").trim();
    if (!id) {
      this.onCloseGalleryDeleteConfirm();
      return;
    }
    if (this.data.galleryActionLoading || this.data.galleryBatchDeleting) return;

    const assets = Array.isArray(this.data.galleryDeletingTargetAssets)
      ? this.data.galleryDeletingTargetAssets
      : [];

    this.setData({ galleryActionLoading: true });
    try {
      const result = await deleteAdminGalleryPhoto(id, assets);
      const successMessage =
        result && result.removedFromWall
          ? "照片已从照片墙移除"
          : "照片已删除";
      this.setData({
        galleryDeleteConfirmOpen: false,
        galleryDeletingTargetId: "",
        galleryDeletingTargetAssets: [],
      });
      if (result && result.storageCleanupFailed) {
        this.showNotice("info", `${successMessage}，但文件清理失败：${result.warning || "请稍后处理"}`);
      } else {
        this.showNotice("success", successMessage);
      }
      await this.safeRefresh([this.loadGalleryPhotos(), this.loadStats()], successMessage);
    } catch (error) {
      this.setData({
        galleryDeleteConfirmOpen: false,
        galleryDeletingTargetId: "",
        galleryDeletingTargetAssets: [],
      });
      this.showNotice("error", readErrorMessage(error, "删除照片失败"));
    } finally {
      this.setData({ galleryActionLoading: false });
    }
  },

  onOpenGalleryBatchDeleteConfirm() {
    if (!this.data.gallerySelectionMode || this.data.galleryBatchDeleting) return;
    if (!this.data.gallerySelectedCount) {
      this.showNotice("error", "请先选择要删除的照片");
      return;
    }
    this.setData({ galleryBatchDeleteConfirmOpen: true });
  },

  onCloseGalleryBatchDeleteConfirm() {
    if (this.data.galleryBatchDeleting) return;
    this.setData({ galleryBatchDeleteConfirmOpen: false });
  },

  async onConfirmGalleryBatchDelete() {
    if (this.data.galleryBatchDeleting) return;
    const selectedIds = Array.isArray(this.data.gallerySelectedIds)
      ? this.data.gallerySelectedIds.map((item) => String(item || "")).filter(Boolean)
      : [];
    if (!selectedIds.length) {
      this.setData({ galleryBatchDeleteConfirmOpen: false });
      this.showNotice("error", "请先选择要删除的照片");
      return;
    }

    this.setData({
      galleryBatchDeleting: true,
      galleryBatchDeleteConfirmOpen: false,
    });

    const photoMap = new Map();
    (Array.isArray(this.data.galleryPhotos) ? this.data.galleryPhotos : []).forEach((item) => {
      const id = String((item && item.id) || "");
      if (!id) return;
      photoMap.set(id, item);
    });

    let deletedCount = 0;
    let failedCount = 0;
    let storageWarningCount = 0;
    let removedFromWallCount = 0;
    let deletedRecordCount = 0;
    for (let i = 0; i < selectedIds.length; i += 1) {
      const id = selectedIds[i];
      const target = photoMap.get(id);
      const assets = target && Array.isArray(target.assets) ? target.assets : [];
      try {
        const result = await deleteAdminGalleryPhoto(id, assets);
        deletedCount += 1;
        if (result && result.removedFromWall) {
          removedFromWallCount += 1;
        } else {
          deletedRecordCount += 1;
        }
        if (result && result.storageCleanupFailed) {
          storageWarningCount += 1;
        }
      } catch (error) {
        failedCount += 1;
      }
    }

    this.setData(
      {
        galleryBatchDeleting: false,
        gallerySelectionMode: false,
        gallerySelectedIds: [],
      },
      () => {
        this.refreshGalleryModuleView();
      }
    );

    if (deletedCount > 0) {
      let refreshWarning = "";
      try {
        await Promise.all([this.loadGalleryPhotos(), this.loadStats()]);
      } catch (refreshError) {
        refreshWarning = readErrorMessage(refreshError, "请稍后手动刷新");
      }
      const successParts = [];
      if (removedFromWallCount > 0) successParts.push(`移出照片墙 ${removedFromWallCount} 张`);
      if (deletedRecordCount > 0) successParts.push(`删除照片 ${deletedRecordCount} 张`);
      const successSummary = successParts.length > 0 ? successParts.join("，") : `处理成功 ${deletedCount} 张`;
      if (failedCount > 0 || storageWarningCount > 0) {
        const warningParts = [];
        if (failedCount > 0) warningParts.push(`失败 ${failedCount} 张`);
        if (storageWarningCount > 0) warningParts.push(`文件清理异常 ${storageWarningCount} 张`);
        if (refreshWarning) warningParts.push(`列表刷新失败：${refreshWarning}`);
        this.showNotice("info", `成功处理 ${deletedCount} 张照片（${successSummary}），${warningParts.join("，")}`);
      } else {
        const suffix = refreshWarning ? `；列表刷新失败：${refreshWarning}` : "";
        this.showNotice("success", `成功处理 ${deletedCount} 张照片（${successSummary}）${suffix}`);
      }
    } else {
      this.showNotice("error", "批量移除照片失败，请稍后重试");
    }
  },

  onSelectBookingFilter(e) {
    const key =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.key || "")
        : "";
    const allowed = BOOKING_FILTER_OPTIONS.some((item) => item.key === key);
    if (!allowed) return;

    this.setData(
      {
        bookingFilter: key,
        bookingCurrentPage: 1,
        bookingVisibleCount: Math.max(1, Number(this.data.bookingPageSize || 10)),
        bookingSelectionMode: false,
        bookingSelectedIds: [],
        bookingBatchDeleteConfirmOpen: false,
        bookingDeleteConfirmOpen: false,
        bookingDeletingTargetId: "",
        bookingDeletingTargetSummary: "",
      },
      () => {
        this.refreshBookingModuleView();
      }
    );
  },

  onStartBookingSelection() {
    if (this.data.bookingBatchDeleting || this.data.bookingActionLoading) return;
    if (Number(this.data.bookingDeletableCount || 0) <= 0) {
      this.showNotice("error", "当前筛选结果中没有可删除预约（仅支持删除已完成/已取消）");
      return;
    }

    this.setData(
      {
        bookingSelectionMode: true,
        bookingSelectedIds: [],
        bookingSelectedCount: 0,
        bookingAllSelected: false,
      },
      () => {
        this.refreshBookingModuleView();
      }
    );
  },

  onCancelBookingSelection() {
    if (this.data.bookingBatchDeleting) return;
    this.setData(
      {
        bookingSelectionMode: false,
        bookingSelectedIds: [],
        bookingSelectedCount: 0,
        bookingAllSelected: false,
        bookingBatchDeleteConfirmOpen: false,
        bookingDeleteConfirmOpen: false,
        bookingDeletingTargetId: "",
        bookingDeletingTargetSummary: "",
      },
      () => {
        this.refreshBookingModuleView();
      }
    );
  },

  onToggleBookingSelection(e) {
    if (!this.data.bookingSelectionMode || this.data.bookingBatchDeleting) return;
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;

    const target = (this.data.bookingFilteredList || []).find((item) => String(item.id) === id) || null;
    if (!target || !isBookingDeletable(target.status)) return;

    const selected = Array.isArray(this.data.bookingSelectedIds) ? this.data.bookingSelectedIds.slice() : [];
    const index = selected.indexOf(id);
    if (index >= 0) {
      selected.splice(index, 1);
    } else {
      selected.push(id);
    }

    this.setData({ bookingSelectedIds: selected }, () => {
      this.refreshBookingModuleView();
    });
  },

  onToggleSelectAllBookings() {
    if (!this.data.bookingSelectionMode || this.data.bookingBatchDeleting) return;
    const filteredRows = Array.isArray(this.data.bookingFilteredList) ? this.data.bookingFilteredList : [];
    const deletableIds = filteredRows
      .filter((item) => isBookingDeletable(item && item.status))
      .map((item) => String((item && item.id) || ""))
      .filter(Boolean);
    if (!deletableIds.length) return;
    const nextSelected = this.data.bookingAllSelected ? [] : deletableIds;
    this.setData({
      bookingSelectedIds: nextSelected,
      bookingVisibleCount: this.data.bookingAllSelected
        ? this.data.bookingVisibleCount
        : Math.max(filteredRows.length, Number(this.data.bookingPageSize || 10)),
    }, () => {
      this.refreshBookingModuleView();
    });
  },

  onOpenBookingLocation(e) {
    if (this.data.bookingSelectionMode || this.data.bookingBatchDeleting || this.data.bookingActionLoading) return;
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;

    const target = (Array.isArray(this.data.bookings) ? this.data.bookings : []).find(
      (item) => String((item && item.id) || "") === id
    );
    if (!target) {
      this.showNotice("error", "预约记录不存在或已更新");
      return;
    }

    const latitude = Number(target.latitude);
    const longitude = Number(target.longitude);
    if (!isValidCoordinatePair(latitude, longitude)) {
      this.showNotice("error", "该预约未记录有效定位");
      return;
    }

    const name = String(target.cityDisplay || target.userDisplay || "约拍定位").trim();
    const locationDisplay = String(target.locationDisplay || "").trim();
    const address = locationDisplay && locationDisplay !== "未填写地点" ? locationDisplay : name;
    const marker = {
      id: 1,
      latitude,
      longitude,
      width: 26,
      height: 36,
    };
    this.setData({
      bookingLocationPreviewOpen: true,
      bookingLocationPreviewName: name,
      bookingLocationPreviewAddress: address,
      bookingLocationPreviewCoordinateText: `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`,
      bookingLocationPreviewLatitude: latitude,
      bookingLocationPreviewLongitude: longitude,
      bookingLocationPreviewMarkers: [marker],
    });
  },

  onCloseBookingLocationPreview() {
    this.setData({
      bookingLocationPreviewOpen: false,
      bookingLocationPreviewName: "",
      bookingLocationPreviewAddress: "",
      bookingLocationPreviewCoordinateText: "",
      bookingLocationPreviewLatitude: 0,
      bookingLocationPreviewLongitude: 0,
      bookingLocationPreviewMarkers: [],
    });
  },

  async onDeleteSingleBooking(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;
    if (this.data.bookingBatchDeleting || this.data.bookingActionLoading || this.data.bookingUpdatingId) return;

    const target = (Array.isArray(this.data.bookings) ? this.data.bookings : []).find(
      (item) => String((item && item.id) || "") === id
    );
    if (!target || !isBookingDeletable(target.status)) {
      this.showNotice("error", "仅已完成或已取消预约可删除");
      return;
    }

    this.setData({
      bookingDeleteConfirmOpen: false,
      bookingDeletingTargetId: "",
      bookingDeletingTargetSummary: "",
      bookingActionLoading: true,
      bookingUpdatingId: id,
    });
    try {
      const result = await deleteAdminBookings([id]);
      const deletedCount = Number((result && result.deletedCount) || 0);
      const failedCount = Number((result && result.failedCount) || 0);
      const missingCount = Number((result && result.missingCount) || 0);

      if (deletedCount > 0 && failedCount === 0 && missingCount === 0) {
        this.showNotice("success", "预约已删除");
      } else if (deletedCount > 0) {
        this.showNotice("info", `删除结果：成功 ${deletedCount}，失败 ${failedCount}，已不存在 ${missingCount}`);
      } else if (missingCount > 0) {
        this.showNotice("info", "预约已不存在");
      } else {
        this.showNotice("error", "删除预约失败，请稍后重试");
      }

      if (deletedCount > 0 || missingCount > 0) {
        const refreshContext = deletedCount > 0 ? "预约删除已完成" : "预约列表状态已更新";
        await this.safeRefresh([this.loadRecentBookings(), this.loadStats()], refreshContext);
      }
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "删除预约失败"));
    } finally {
      this.setData({
        bookingDeleteConfirmOpen: false,
        bookingDeletingTargetId: "",
        bookingDeletingTargetSummary: "",
        bookingActionLoading: false,
        bookingUpdatingId: "",
      });
    }
  },

  onOpenBookingDeleteConfirm(e) {
    if (this.data.bookingBatchDeleting || this.data.bookingActionLoading || this.data.bookingUpdatingId) return;
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;

    const target = (Array.isArray(this.data.bookings) ? this.data.bookings : []).find(
      (item) => String((item && item.id) || "") === id
    );
    if (!target || !isBookingDeletable(target.status)) {
      this.showNotice("error", "仅已完成或已取消预约可删除");
      return;
    }

    const userText = String(target.userDisplay || "").trim() || "未命名用户";
    const dateText =
      String(target.bookingDateDisplay || target.booking_date || "").trim() || "未设置日期";
    this.setData({
      bookingDeleteConfirmOpen: true,
      bookingDeletingTargetId: id,
      bookingDeletingTargetSummary: `${userText} / ${dateText}`,
    });
  },

  onCloseBookingDeleteConfirm() {
    if (this.data.bookingActionLoading || this.data.bookingUpdatingId) return;
    this.setData({
      bookingDeleteConfirmOpen: false,
      bookingDeletingTargetId: "",
      bookingDeletingTargetSummary: "",
    });
  },

  onConfirmBookingDelete() {
    const id = String(this.data.bookingDeletingTargetId || "").trim();
    if (!id) {
      this.onCloseBookingDeleteConfirm();
      return;
    }
    void this.onDeleteSingleBooking({
      currentTarget: {
        dataset: { id },
      },
    });
  },

  onOpenBookingBatchDeleteConfirm() {
    if (!this.data.bookingSelectionMode || this.data.bookingBatchDeleting) return;
    if (!this.data.bookingSelectedCount) {
      this.showNotice("error", "请先选择要删除的预约");
      return;
    }
    this.setData({ bookingBatchDeleteConfirmOpen: true });
  },

  onCloseBookingBatchDeleteConfirm() {
    if (this.data.bookingBatchDeleting) return;
    this.setData({ bookingBatchDeleteConfirmOpen: false });
  },

  onOpenBookingCancelConfirm(e) {
    if (this.data.bookingActionLoading || this.data.bookingUpdatingId) return;
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;
    const target = (this.data.bookings || []).find((item) => String(item.id) === id) || null;
    if (!target) return;
    if (!(target.status === "pending" || target.status === "confirmed" || target.status === "in_progress")) {
      this.showNotice("error", "当前状态不可取消");
      return;
    }
    this.setData({
      bookingCancelConfirmOpen: true,
      bookingCancelingTargetId: id,
    });
  },

  onCloseBookingCancelConfirm() {
    if (this.data.bookingActionLoading || this.data.bookingUpdatingId) return;
    this.setData({
      bookingCancelConfirmOpen: false,
      bookingCancelingTargetId: "",
    });
  },

  async updateBookingStatusWithGuard(bookingId, nextStatus, expectedStatuses, successText, invalidText) {
    const id = String(bookingId || "").trim();
    if (!id) return;
    if (this.data.bookingActionLoading || this.data.bookingUpdatingId) return;

    const booking = (this.data.bookings || []).find((item) => String(item.id) === id) || null;
    if (!booking) {
      this.showNotice("error", "预约不存在或已删除");
      return;
    }

    const expected = Array.isArray(expectedStatuses) ? expectedStatuses.map((item) => String(item)) : [];
    if (expected.length > 0 && !expected.includes(String(booking.status || ""))) {
      this.showNotice("error", String(invalidText || "当前状态不可执行该操作"));
      return;
    }

    this.setData({
      bookingActionLoading: true,
      bookingUpdatingId: id,
    });
    try {
      await updateAdminBookingStatus(id, nextStatus, expected);
      this.showNotice("success", String(successText || "预约状态已更新"));
      await this.safeRefresh([this.loadRecentBookings(), this.loadStats()], String(successText || "预约状态已更新"));
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "更新预约状态失败"));
    } finally {
      this.setData({
        bookingActionLoading: false,
        bookingUpdatingId: "",
        bookingCancelConfirmOpen: false,
        bookingCancelingTargetId: "",
      });
    }
  },

  onBookingConfirmAction(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    void this.updateBookingStatusWithGuard(id, "confirmed", ["pending"], "预约已确认", "仅待确认预约可执行确认");
  },

  onBookingStartAction(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    void this.updateBookingStatusWithGuard(id, "in_progress", ["confirmed"], "预约已开始", "仅已确认预约可开始");
  },

  onBookingFinishAction(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    void this.updateBookingStatusWithGuard(id, "finished", ["in_progress"], "预约已完成", "仅进行中预约可完成");
  },

  onConfirmBookingCancel() {
    const id = String(this.data.bookingCancelingTargetId || "").trim();
    if (!id) {
      this.onCloseBookingCancelConfirm();
      return;
    }
    void this.updateBookingStatusWithGuard(
      id,
      "cancelled",
      ["pending", "confirmed", "in_progress"],
      "预约已取消",
      "当前状态不可取消"
    );
  },

  async onConfirmBookingBatchDelete() {
    if (this.data.bookingBatchDeleting) return;
    const selectedIds = Array.isArray(this.data.bookingSelectedIds)
      ? this.data.bookingSelectedIds.map((item) => String(item || "")).filter(Boolean)
      : [];
    if (!selectedIds.length) {
      this.setData({ bookingBatchDeleteConfirmOpen: false });
      this.showNotice("error", "请先选择要删除的预约");
      return;
    }

    this.setData({
      bookingBatchDeleting: true,
      bookingBatchDeleteConfirmOpen: false,
    });
    try {
      const result = await deleteAdminBookings(selectedIds);
      const deletedCount = Number((result && result.deletedCount) || 0);
      const failedCount = Number((result && result.failedCount) || 0);
      const missingCount = Number((result && result.missingCount) || 0);

      if (deletedCount <= 0) {
        this.showNotice("error", missingCount > 0 ? `没有可删除的预约（${missingCount} 个预约已不存在）` : "没有可删除的预约");
      } else if (failedCount > 0 && missingCount > 0) {
        this.showNotice("info", `成功删除 ${deletedCount} 个预约，${failedCount} 个删除失败，${missingCount} 个预约已不存在`);
      } else if (failedCount > 0) {
        this.showNotice("info", `成功删除 ${deletedCount} 个预约，${failedCount} 个删除失败`);
      } else if (missingCount > 0) {
        this.showNotice("success", `成功删除 ${deletedCount} 个预约（${missingCount} 个预约已不存在）`);
      } else {
        this.showNotice("success", `成功删除 ${deletedCount} 个预约`);
      }

      if (deletedCount > 0 || missingCount > 0) {
        let refreshWarning = "";
        try {
          await Promise.all([this.loadRecentBookings(), this.loadStats()]);
        } catch (refreshError) {
          refreshWarning = readErrorMessage(refreshError, "请稍后手动刷新");
        }
        if (refreshWarning) {
          const refreshContext = deletedCount > 0 ? "预约删除已完成" : "预约列表状态已更新";
          this.showNotice("info", `${refreshContext}，但列表刷新失败：${refreshWarning}`);
        }
      }
      this.setData({
        bookingSelectionMode: false,
        bookingSelectedIds: [],
        bookingSelectedCount: 0,
        bookingAllSelected: false,
      });
    } catch (error) {
      const message = readErrorMessage(error, "批量删除预约失败");
      const noticeType = message.includes("无法删除") ? "info" : "error";
      this.showNotice(noticeType, message);
    } finally {
      this.setData({
        bookingBatchDeleting: false,
      });
      this.refreshBookingModuleView();
    }
  },

  onBookingTypeInput(e) {
    const field =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.field || "")
        : "";
    if (!field) return;
    const value = e && e.detail ? e.detail.value : "";
    this.setData({ [`bookingTypeForm.${field}`]: String(value || "") });
  },

  onOpenBookingTypeCreateModal() {
    if (this.data.bookingTypeSaving || this.data.bookingTypeTogglingId || this.data.bookingTypeDeletingId) return;
    this.setData({
      bookingTypeModalOpen: true,
      bookingTypeForm: {
        id: 0,
        name: "",
        description: "",
      },
    });
  },

  onCloseBookingTypeModal() {
    if (this.data.bookingTypeSaving) return;
    this.setData({
      bookingTypeModalOpen: false,
      bookingTypeForm: {
        id: 0,
        name: "",
        description: "",
      },
    });
  },

  onResetBookingTypeForm() {
    if (this.data.bookingTypeSaving || this.data.bookingTypeTogglingId || this.data.bookingTypeDeletingId) {
      return;
    }
    this.setData({
      bookingTypeForm: {
        id: 0,
        name: "",
        description: "",
      },
    });
  },

  onEditBookingType(e) {
    if (this.data.bookingTypeSaving || this.data.bookingTypeTogglingId || this.data.bookingTypeDeletingId) {
      return;
    }
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? Number(e.currentTarget.dataset.id || 0)
        : 0;
    if (!id) return;

    const target = (this.data.bookingTypes || []).find((item) => item.id === id) || null;
    if (!target) return;

    this.setData({
      bookingTypeModalOpen: true,
      bookingTypeForm: {
        id: target.id,
        name: String(target.name || ""),
        description: String(target.description || ""),
      },
    });
  },

  onOpenBookingTypeDeleteConfirm(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? Number(e.currentTarget.dataset.id || 0)
        : 0;
    if (!id) return;
    if (this.data.bookingTypeDeletingId || this.data.bookingTypeTogglingId || this.data.bookingTypeSaving) return;

    const target = (this.data.bookingTypes || []).find((item) => item.id === id) || null;
    if (!target) return;

    this.setData({
      bookingTypeDeleteConfirmOpen: true,
      bookingTypeDeletingTargetId: id,
      bookingTypeDeletingTargetName: String(target.name || ""),
    });
  },

  onCancelBookingTypeDeleteConfirm() {
    if (this.data.bookingTypeDeletingId) return;
    this.setData({
      bookingTypeDeleteConfirmOpen: false,
      bookingTypeDeletingTargetId: 0,
      bookingTypeDeletingTargetName: "",
    });
  },

  onCityInput(e) {
    const field =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.field || "")
        : "";
    if (!field) return;
    const value = e && e.detail ? e.detail.value : "";
    this.setData({ [`cityForm.${field}`]: String(value || "") });
  },

  onCityMetaBlur() {
    const cityForm = this.data && this.data.cityForm ? this.data.cityForm : {};
    const cityCode = String(cityForm.city_code || "").trim();
    if (cityCode) return;

    const cityName = String(cityForm.city_name || "").trim();
    const province = String(cityForm.province || "").trim();
    const latitude = Number(cityForm.latitude);
    const longitude = Number(cityForm.longitude);
    if ((!cityName && !province) || !isValidCoordinatePair(latitude, longitude)) return;

    void this.tryAutoFillCityCode(cityName, province, latitude, longitude);
  },

  onOpenCityCreateModal() {
    if (this.data.citySaving || this.data.cityTogglingId || this.data.cityDeletingId) return;
    this.setData({
      cityModalOpen: true,
      cityMapPickerOpen: false,
      cityForm: {
        id: 0,
        city_name: "",
        province: "",
        city_code: "",
        latitude: "",
        longitude: "",
        is_active: true,
      },
    });
  },

  onCloseCityModal() {
    if (this.data.citySaving) return;
    this.setData({
      cityModalOpen: false,
      cityMapPickerOpen: false,
      cityForm: {
        id: 0,
        city_name: "",
        province: "",
        city_code: "",
        latitude: "",
        longitude: "",
        is_active: true,
      },
    });
  },

  onOpenCityMapPicker() {
    if (!this.data.cityModalOpen || this.data.citySaving) return;
    this.setData({ cityMapPickerOpen: true });
  },

  onCityMapSelect(e) {
    const detail = e && e.detail ? e.detail : {};
    const location = String(detail.location || "").trim();
    const cityName = String(detail.cityName || "").trim();
    const province = String(detail.province || "").trim();
    const adcode = readAdcodeValue(detail);
    const latitude = Number(detail.latitude);
    const longitude = Number(detail.longitude);
    const hasMapCoordinate = isValidCoordinatePair(latitude, longitude);
    const inferred = inferCityMetaFromLocation(location);
    const nextCityName = cityName || inferred.cityName || this.data.cityForm.city_name || "";
    const nextProvince = province || inferred.province || this.data.cityForm.province || "";
    const nextLatitude = hasMapCoordinate ? String(latitude) : this.data.cityForm.latitude;
    const nextLongitude = hasMapCoordinate ? String(longitude) : this.data.cityForm.longitude;
    const nextCityCode = adcode || this.data.cityForm.city_code || "";

    this.setData(
      {
        cityMapPickerOpen: false,
        "cityForm.city_name": nextCityName,
        "cityForm.province": nextProvince,
        "cityForm.city_code": nextCityCode,
        "cityForm.latitude": nextLatitude,
        "cityForm.longitude": nextLongitude,
      },
      () => {
        if (!nextCityCode) {
          const lat = Number(nextLatitude);
          const lng = Number(nextLongitude);
          if (isValidCoordinatePair(lat, lng)) {
            void this.tryAutoFillCityCode(nextCityName, nextProvince, lat, lng);
          }
        }
      }
    );
  },

  onCityMapClose() {
    this.setData({ cityMapPickerOpen: false });
  },

  async resolveCityCoordinateByTencentApi(cityName, province, keywords) {
    const cityText = String(cityName || "").trim();
    const provinceText = String(province || "").trim();
    const tencentKey = String(
      (runtimeConfig &&
        (runtimeConfig.tencentMapKey ||
          runtimeConfig.TMAP_KEY ||
          runtimeConfig.tmapKey ||
          runtimeConfig.nextPublicTmapKey ||
          "")) ||
        ""
    ).trim();
    if (!tencentKey) return null;

    const searchKeywords = [];
    const addSearchKeyword = (value) => {
      const text = String(value || "").trim();
      if (!text || searchKeywords.includes(text)) return;
      searchKeywords.push(text);
    };
    if (Array.isArray(keywords)) {
      keywords.forEach((item) => addSearchKeyword(item));
    }
    buildCitySearchKeywords(cityText, provinceText).forEach((item) => addSearchKeyword(item));
    if (!searchKeywords.length) return null;

    const requestTencentApi = (url, data) =>
      new Promise((resolve) => {
        wx.request({
          url,
          data: Object.assign({}, data || {}, { key: tencentKey }),
          success: (res) => {
            const body = res && res.data && typeof res.data === "object" ? res.data : null;
            resolve(body);
          },
          fail: () => resolve(null),
        });
      });

    const toCandidate = (lat, lng, cityValue, provinceValue, adcodeSource) => {
      if (!isValidCoordinatePair(lat, lng)) return null;
      return {
        latitude: Number(lat),
        longitude: Number(lng),
        cityName: String(cityValue || cityText).trim(),
        province: String(provinceValue || provinceText).trim(),
        cityCode: readAdcodeValue(adcodeSource),
      };
    };

    for (let i = 0; i < searchKeywords.length; i += 1) {
      const keyword = searchKeywords[i];
      const geocodePayload = { address: keyword };
      const region = String(cityText || provinceText || "").trim();
      if (region) {
        geocodePayload.region = region;
      }

      // 优先走正向地理编码，城市名场景下比 POI 搜索更稳定。
      // eslint-disable-next-line no-await-in-loop
      const geocodeBody = await requestTencentApi("https://apis.map.qq.com/ws/geocoder/v1/", geocodePayload);
      const geocodeResult =
        geocodeBody && Number(geocodeBody.status) === 0 && geocodeBody.result && typeof geocodeBody.result === "object"
          ? geocodeBody.result
          : null;
      if (geocodeResult) {
        const location = geocodeResult.location && typeof geocodeResult.location === "object" ? geocodeResult.location : {};
        const component =
          geocodeResult.address_component && typeof geocodeResult.address_component === "object"
            ? geocodeResult.address_component
            : geocodeResult.address_components && typeof geocodeResult.address_components === "object"
              ? geocodeResult.address_components
              : {};
        const adInfo = geocodeResult.ad_info && typeof geocodeResult.ad_info === "object" ? geocodeResult.ad_info : {};
        const candidate = toCandidate(
          Number(location.lat || 0),
          Number(location.lng || 0),
          component.city || adInfo.city || cityText,
          component.province || adInfo.province || provinceText,
          Object.assign({}, geocodeResult, {
            ad_info: adInfo,
            address_component: component,
            addressComponent: component,
          })
        );
        if (candidate) {
          return candidate;
        }
      }
    }

    const boundaries = [];
    const regionBoundary = String(cityText || provinceText || "").trim();
    if (regionBoundary) {
      boundaries.push(`region(${regionBoundary},0)`);
    }
    boundaries.push("region(全国,0)");

    for (let i = 0; i < searchKeywords.length; i += 1) {
      const keyword = searchKeywords[i];
      for (let j = 0; j < boundaries.length; j += 1) {
        const boundary = boundaries[j];
        // eslint-disable-next-line no-await-in-loop
        const searchBody = await requestTencentApi("https://apis.map.qq.com/ws/place/v1/search", {
          keyword,
          boundary,
          page_size: 10,
        });
        const rows =
          searchBody && Number(searchBody.status) === 0 && Array.isArray(searchBody.data)
            ? searchBody.data
            : [];
        if (!rows.length) continue;

        let fallback = null;
        for (let k = 0; k < rows.length; k += 1) {
          const item = rows[k] && typeof rows[k] === "object" ? rows[k] : {};
          const location = item.location && typeof item.location === "object" ? item.location : {};
          const adInfo = item.ad_info && typeof item.ad_info === "object" ? item.ad_info : {};
          const candidate = toCandidate(
            Number(location.lat || 0),
            Number(location.lng || 0),
            item.cityName || item.city || adInfo.city || cityText,
            item.province || adInfo.province || provinceText,
            item
          );
          if (!candidate) continue;

          const rowCity = String(item.cityName || item.city || adInfo.city || "").trim();
          const rowProvince = String(item.province || adInfo.province || "").trim();
          const cityMatched =
            !cityText || !rowCity || isAdministrativeNameMatched(cityText, rowCity, "city");
          const provinceMatched =
            !provinceText ||
            !rowProvince ||
            isAdministrativeNameMatched(provinceText, rowProvince, "province");
          if (cityMatched || provinceMatched) {
            return candidate;
          }
          if (!fallback) {
            fallback = candidate;
          }
        }

        if (fallback) {
          return fallback;
        }
      }
    }

    return null;
  },

  async resolveCityCoordinateByMap(cityName, province) {
    const cityText = String(cityName || "").trim();
    const provinceText = String(province || "").trim();
    const keywords = buildCitySearchKeywords(cityText, provinceText);
    const searchRegions = [];
    const addSearchRegion = (value) => {
      const text = String(value || "").trim();
      if (searchRegions.includes(text)) return;
      searchRegions.push(text);
    };
    addSearchRegion(cityText || provinceText || "");
    addSearchRegion("");

    const isCityMatched = (row) => {
      const item = row && typeof row === "object" ? row : {};
      const adInfo = item.ad_info && typeof item.ad_info === "object" ? item.ad_info : {};
      const rowCity = String(item.cityName || item.city || adInfo.city || "").trim();
      const rowProvince = String(item.province || adInfo.province || "").trim();
      if (!cityText && !provinceText) return true;
      if (cityText && rowCity && isAdministrativeNameMatched(cityText, rowCity, "city")) return true;
      if (
        provinceText &&
        rowProvince &&
        isAdministrativeNameMatched(provinceText, rowProvince, "province")
      ) {
        return true;
      }
      return false;
    };

    for (let i = 0; i < keywords.length; i += 1) {
      const keyword = keywords[i];
      for (let regionIndex = 0; regionIndex < searchRegions.length; regionIndex += 1) {
        const region = searchRegions[regionIndex];
        try {
          const payload = await requestJson("/api/tencent-map/search", {
            method: "POST",
            data: {
              keyword,
              cityName: region || undefined,
            },
          });
          const body = payload && typeof payload === "object" ? payload : {};
          if (hasExplicitPayloadFailure(body)) {
            throw new Error(readPayloadErrorMessage(body, "腾讯地图搜索失败"));
          }

          const rows = readArrayFromPayloadChain(body, ["results", "rows", "list", "items", "data"]);
          let fallback = null;
          for (let j = 0; j < rows.length; j += 1) {
            const item = rows[j] && typeof rows[j] === "object" ? rows[j] : {};
            const location = item.location && typeof item.location === "object" ? item.location : {};
            const lat = Number(location.lat || item.latitude || 0);
            const lng = Number(location.lng || item.longitude || 0);
            if (!isValidCoordinatePair(lat, lng)) continue;

            const adInfo = item.ad_info && typeof item.ad_info === "object" ? item.ad_info : {};
            const candidate = {
              latitude: lat,
              longitude: lng,
              cityName: String(item.cityName || item.city || adInfo.city || cityText).trim(),
              province: String(item.province || adInfo.province || provinceText).trim(),
              cityCode: readAdcodeValue(item),
            };

            if (isCityMatched(item)) {
              return candidate;
            }
            if (!fallback) {
              fallback = candidate;
            }
          }
          if (fallback) {
            return fallback;
          }
        } catch (error) {
          // ignore
        }
      }
    }

    const fallbackByTencent = await this.resolveCityCoordinateByTencentApi(cityText, provinceText, keywords);
    if (fallbackByTencent) {
      return fallbackByTencent;
    }

    return null;
  },

  async resolveCityCodeByMap(cityName, province, latitude, longitude) {
    const cityText = String(cityName || "").trim();
    const provinceText = String(province || "").trim();
    const lat = Number(latitude);
    const lng = Number(longitude);

    const keywords = buildCitySearchKeywords(cityText, provinceText);
    const searchRegions = [];
    const addSearchRegion = (value) => {
      const text = String(value || "").trim();
      if (searchRegions.includes(text)) return;
      searchRegions.push(text);
    };
    addSearchRegion(cityText || provinceText || "");
    addSearchRegion("");

    const readAdcode = (row) => readAdcodeValue(row);

    const isCityMatched = (row) => {
      const item = row && typeof row === "object" ? row : {};
      const adInfo = item.ad_info && typeof item.ad_info === "object" ? item.ad_info : {};
      const rowCity = String(item.cityName || item.city || adInfo.city || "").trim();
      const rowProvince = String(item.province || adInfo.province || "").trim();
      if (!cityText && !provinceText) return true;
      if (cityText && rowCity && isAdministrativeNameMatched(cityText, rowCity, "city")) return true;
      if (
        provinceText &&
        rowProvince &&
        isAdministrativeNameMatched(provinceText, rowProvince, "province")
      ) {
        return true;
      }
      return false;
    };

    for (let i = 0; i < keywords.length; i += 1) {
      const keyword = keywords[i];
      for (let regionIndex = 0; regionIndex < searchRegions.length; regionIndex += 1) {
        const region = searchRegions[regionIndex];
        try {
          const payload = await requestJson("/api/tencent-map/search", {
            method: "POST",
            data: {
              keyword,
              cityName: region || undefined,
            },
          });
          const body = payload && typeof payload === "object" ? payload : {};
          if (hasExplicitPayloadFailure(body)) {
            throw new Error(readPayloadErrorMessage(body, "腾讯地图搜索失败"));
          }
          const rows = readArrayFromPayloadChain(body, ["results", "rows", "list", "items", "data"]);

          let fallbackAdcode = "";
          for (let j = 0; j < rows.length; j += 1) {
            const adcode = readAdcode(rows[j]);
            if (!adcode) continue;
            if (!fallbackAdcode) {
              fallbackAdcode = adcode;
            }
            if (isCityMatched(rows[j])) {
              return adcode;
            }
          }
          if (fallbackAdcode) {
            return fallbackAdcode;
          }
        } catch (error) {
          // 忽略补全失败，走后续兜底流程
        }
      }
    }

    if (isValidCoordinatePair(lat, lng)) {
      try {
        const payload = await requestJson("/api/tencent-map/reverse-geocode", {
          method: "POST",
          data: {
            lat,
            lng,
          },
        });
        const root = payload && typeof payload === "object" ? payload : {};
        if (hasExplicitPayloadFailure(root)) {
          throw new Error(readPayloadErrorMessage(root, "腾讯地图逆地址解析失败"));
        }
        const body = resolvePayloadObjectByKeys(root, ["result", "addressComponent", "address_component", "ad_info"]);
        const result = body.result && typeof body.result === "object" ? body.result : {};
        const component =
          body.addressComponent && typeof body.addressComponent === "object"
            ? body.addressComponent
            : body.address_component && typeof body.address_component === "object"
              ? body.address_component
            : body.result && body.result.address_component && typeof body.result.address_component === "object"
              ? body.result.address_component
              : body.result && body.result.addressComponent && typeof body.result.addressComponent === "object"
                ? body.result.addressComponent
                : {};
        const adInfo =
          body.ad_info && typeof body.ad_info === "object"
            ? body.ad_info
            : result.ad_info && typeof result.ad_info === "object"
              ? result.ad_info
              : {};
        const adcode = String(
          readAdcodeValue(component) ||
            readAdcodeValue(adInfo) ||
            readAdcodeValue(result) ||
            readAdcodeValue(body)
        ).trim();
        if (adcode) {
          return adcode;
        }
      } catch (error) {
        // ignore
      }
    }

    return "";
  },

  async tryAutoFillCityCode(cityName, province, latitude, longitude) {
    const currentForm = this.data && this.data.cityForm ? this.data.cityForm : {};
    const currentCode = String(currentForm.city_code || "").trim();
    if (currentCode) return;

    const targetCityName = String(cityName || "").trim();
    const targetProvince = String(province || "").trim();
    const lat = Number(latitude);
    const lng = Number(longitude);
    if ((!targetCityName && !targetProvince) || !isValidCoordinatePair(lat, lng)) return;

    try {
      const resolvedCode = await this.resolveCityCodeByMap(targetCityName, targetProvince, lat, lng);
      if (!resolvedCode) return;

      const latestForm = this.data && this.data.cityForm ? this.data.cityForm : {};
      const latestCode = String(latestForm.city_code || "").trim();
      if (latestCode) return;

      const latestCityName = String(latestForm.city_name || "").trim();
      const latestProvince = String(latestForm.province || "").trim();
      const latestLat = Number(latestForm.latitude);
      const latestLng = Number(latestForm.longitude);

      if (targetCityName && latestCityName && latestCityName !== targetCityName) return;
      if (targetProvince && latestProvince && latestProvince !== targetProvince) return;
      if (Number.isFinite(latestLat) && Number.isFinite(latestLng)) {
        if (Math.abs(latestLat - lat) > 0.000001 || Math.abs(latestLng - lng) > 0.000001) return;
      }

      this.setData({ "cityForm.city_code": resolvedCode });
    } catch (error) {
      // ignore auto-fill errors
    }
  },

  onPoseTagsInput(e) {
    const value = e && e.detail ? e.detail.value : "";
    const tags = normalizePoseTagsInput(value);
    this.setData(
      {
        poseTagsInput: String(value || ""),
        poseFormSelectedTags: tags.slice(0, 3),
      },
      () => {
        this.refreshPoseModuleView();
      }
    );
  },

  choosePoseImage() {
    if (this.data.poseCreating) return;
    this.syncSectionMeta("poses");
    if (this.data.mobileMenuOpen) {
      this.setData({ mobileMenuOpen: false });
    }

    this.markTransientForegroundReturn("pose-choose-media");
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: (res) => {
        const file = res && Array.isArray(res.tempFiles) ? res.tempFiles[0] : null;
        const filePath = String((file && file.tempFilePath) || "").trim();
        const fileSize = Number((file && file.size) || 0);
        if (!filePath) {
          this.showNotice("error", "选择图片失败，请重试");
          return;
        }

        const fileName = pickFileNameFromPath(filePath, `pose_${Date.now()}.jpg`);
        this.setData({
          poseFilePath: filePath,
          poseFileName: fileName,
          poseFileSize: fileSize,
          poseFileSizeText: formatFileSize(fileSize),
        });
      },
      fail: (error) => {
        const message = String((error && error.errMsg) || "");
        if (message.toLowerCase().includes("cancel")) return;
        this.showNotice("error", "选择图片失败，请重试");
      },
    });
  },

  async createPose() {
    if (this.data.poseCreating) return;
    this.setData({ poseCreating: true });
    try {
      const formMode = String(this.data.poseFormMode || "create");
      if (formMode === "edit") {
        const selected = Array.isArray(this.data.poseFormSelectedTags) ? this.data.poseFormSelectedTags : [];
        const tags = normalizePoseTagsInput(selected.join("，"));
        if (tags.length > 3) {
          this.showNotice("error", "摆姿标签最多 3 个");
          return;
        }
        const editingId = Number(this.data.poseEditingId || 0);
        if (!editingId) {
          this.showNotice("error", "目标摆姿不存在");
          return;
        }
        await updateAdminPoseTags(editingId, tags);
        this.showNotice("success", "摆姿标签已更新");
      } else {
        const tags = normalizePoseTagsInput(this.data.poseTagsInput);
        if (tags.length > 3) {
          this.showNotice("error", "摆姿标签最多 3 个");
          return;
        }
        const filePath = String(this.data.poseFilePath || "").trim();
        const fileName = String(this.data.poseFileName || "").trim();
        if (!filePath) {
          this.showNotice("error", "请先选择摆姿图片");
          return;
        }
        await createAdminPose({
          filePath,
          fileName,
          tags,
        });
        this.showNotice("success", "摆姿已新增");
      }

      this.setData(
        {
          poseCreateModalOpen: false,
          poseFormMode: "create",
          poseEditingId: 0,
          poseFilePath: "",
          poseFileName: "",
          poseFileSize: 0,
          poseFileSizeText: "",
          poseTagsInput: "",
          poseFormSelectedTags: [],
        },
        () => {
          this.refreshPoseModuleView();
        }
      );
      await this.safeRefresh([this.loadPoses(), this.loadPoseTags(), this.loadStats()], "摆姿保存已完成");
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "保存摆姿失败"));
    } finally {
      this.setData({ poseCreating: false });
    }
  },

  onOpenReleaseCreate() {
    if (this.data.releaseCreating) return;
    this.clearReleaseModeTimer();
    this.setData({
      releaseMode: "create",
      releaseVersion: "",
      releasePlatformIndex: 0,
      releaseUpdateLog: "",
      releaseForceUpdate: false,
      releaseFilePath: "",
      releaseFileName: "",
      releaseFileSize: 0,
      releaseFileSizeText: "",
      releaseDeleteModalOpen: false,
      releaseDeleteTargetId: 0,
      releaseDeleteTargetVersion: "",
      releaseDeleteTargetPlatform: "",
    });
  },

  onBackReleaseList() {
    if (this.data.releaseCreating) return;
    this.clearReleaseModeTimer();
    this.setData({
      releaseMode: "list",
      releaseVersion: "",
      releasePlatformIndex: 0,
      releaseUpdateLog: "",
      releaseForceUpdate: false,
      releaseFilePath: "",
      releaseFileName: "",
      releaseFileSize: 0,
      releaseFileSizeText: "",
      releaseDeleteModalOpen: false,
      releaseDeleteTargetId: 0,
      releaseDeleteTargetVersion: "",
      releaseDeleteTargetPlatform: "",
    });
  },

  onToggleReleaseForceUpdate() {
    if (this.data.releaseCreating) return;
    this.setData({ releaseForceUpdate: !Boolean(this.data.releaseForceUpdate) });
  },

  onCopyReleaseDownload(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? Number(e.currentTarget.dataset.id || 0)
        : 0;
    if (!id) return;

    const list = Array.isArray(this.data.releases) ? this.data.releases : [];
    const target = list.find((item) => Number(item && item.id) === id) || null;
    const url = target ? String(target.downloadUrl || "").trim() : "";
    if (!url) {
      this.showNotice("error", "下载地址不存在或已失效");
      return;
    }

    wx.setClipboardData({
      data: url,
      success: () => {
        this.showNotice("success", "下载链接已复制");
      },
      fail: () => {
        this.showNotice("error", "复制链接失败，请重试");
      },
    });
  },

  onOpenReleaseDeleteModal(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? Number(e.currentTarget.dataset.id || 0)
        : 0;
    if (!id) return;
    if (this.data.releaseCreating || this.data.releaseDeletingId) return;

    const list = Array.isArray(this.data.releases) ? this.data.releases : [];
    const target = list.find((item) => Number(item && item.id) === id) || null;
    this.setData({
      releaseDeleteModalOpen: true,
      releaseDeleteTargetId: id,
      releaseDeleteTargetVersion: String((target && target.version) || ""),
      releaseDeleteTargetPlatform: String((target && target.platform) || ""),
    });
  },

  onCloseReleaseDeleteModal() {
    if (this.data.releaseDeletingId) return;
    this.setData({
      releaseDeleteModalOpen: false,
      releaseDeleteTargetId: 0,
      releaseDeleteTargetVersion: "",
      releaseDeleteTargetPlatform: "",
    });
  },

  onReleaseModalTap() {
    // 阻止蒙层点击冒泡
  },

  async onConfirmDeleteRelease() {
    const id = Number(this.data.releaseDeleteTargetId || 0);
    if (!id) return;
    if (this.data.releaseDeletingId) return;

    this.setData({ releaseDeletingId: id });
    try {
      const result = await deleteAdminRelease(id);
      this.setData({
        releaseDeleteModalOpen: false,
        releaseDeleteTargetId: 0,
        releaseDeleteTargetVersion: "",
        releaseDeleteTargetPlatform: "",
      });
      if (result && result.storageCleanupFailed) {
        this.showNotice("warning", `版本记录已删除，但安装包清理失败：${result.warning || "请稍后处理"}`);
      } else {
        this.showNotice("success", "版本已删除");
      }
      await this.safeRefresh([this.loadReleases(), this.loadStats()], "版本已删除");
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "删除版本失败"));
    } finally {
      this.setData({ releaseDeletingId: 0 });
    }
  },

  onReleaseVersionInput(e) {
    const value = e && e.detail ? e.detail.value : "";
    this.setData({ releaseVersion: String(value || "") });
  },

  onReleasePlatformChange(e) {
    const index = e && e.detail ? Number(e.detail.value || 0) : 0;
    const maxIndex = Math.max(0, (this.data.releasePlatformOptions || []).length - 1);
    const safeIndex = Math.min(Math.max(index, 0), maxIndex);
    this.setData({ releasePlatformIndex: safeIndex });
  },

  onReleaseUpdateLogInput(e) {
    const value = e && e.detail ? e.detail.value : "";
    this.setData({ releaseUpdateLog: String(value || "") });
  },

  onReleaseForceUpdateChange(e) {
    const value = Boolean(e && e.detail ? e.detail.value : false);
    this.setData({ releaseForceUpdate: value });
  },

  chooseReleaseFile() {
    if (this.data.releaseCreating) return;
    this.syncSectionMeta("releases");
    if (this.data.mobileMenuOpen || this.data.releaseMode !== "create") {
      this.setData({
        mobileMenuOpen: false,
        releaseMode: "create",
      });
    }

    this.markTransientForegroundReturn("release-choose-message-file");
    wx.chooseMessageFile({
      count: 1,
      type: "file",
      success: (res) => {
        const file = res && Array.isArray(res.tempFiles) ? res.tempFiles[0] : null;
        const filePath = String((file && (file.path || file.tempFilePath)) || "").trim();
        const fileName = String((file && file.name) || "").trim();
        const fileSize = Number((file && file.size) || 0);

        if (!filePath) {
          this.showNotice("error", "选择安装包失败，请重试");
          return;
        }

        const finalName = fileName || pickFileNameFromPath(filePath, `release_${Date.now()}.bin`);
        this.setData({
          releaseFilePath: filePath,
          releaseFileName: finalName,
          releaseFileSize: fileSize,
          releaseFileSizeText: formatFileSize(fileSize),
        });
      },
      fail: (error) => {
        const message = String((error && error.errMsg) || "");
        if (message.toLowerCase().includes("cancel")) return;
        this.showNotice("error", "选择安装包失败，请重试");
      },
    });
  },

  async createRelease() {
    if (this.data.releaseCreating) return;

    const version = String(this.data.releaseVersion || "").trim();
    const platform = String(
      (this.data.releasePlatformOptions || [])[this.data.releasePlatformIndex] || ""
    ).trim();
    const updateLog = String(this.data.releaseUpdateLog || "").trim();
    const forceUpdate = Boolean(this.data.releaseForceUpdate);
    const filePath = String(this.data.releaseFilePath || "").trim();
    const fileName = String(this.data.releaseFileName || "").trim();
    const fileSize = Number(this.data.releaseFileSize || 0);

    if (!version) {
      this.showNotice("error", "请填写版本号");
      return;
    }
    if (!platform) {
      this.showNotice("error", "请选择发布平台");
      return;
    }
    if (!filePath || !fileName) {
      this.showNotice("error", "请先选择安装包");
      return;
    }
    if (!isReleaseFileAllowed(fileName)) {
      this.showNotice("error", "安装包格式不支持，请选择 apk/ipa/exe/dmg/zip/deb/rpm/appimage/tar.gz 文件");
      return;
    }
    if (fileSize > MAX_RELEASE_FILE_SIZE) {
      this.showNotice("error", "安装包大小超过 100MB 限制");
      return;
    }

    this.setData({ releaseCreating: true });
    try {
      await createAdminRelease({
        version,
        platform,
        update_log: updateLog,
        force_update: forceUpdate,
        filePath,
        fileName,
      });
      this.setData({
        releaseVersion: "",
        releasePlatformIndex: 0,
        releaseUpdateLog: "",
        releaseForceUpdate: false,
        releaseFilePath: "",
        releaseFileName: "",
        releaseFileSize: 0,
        releaseFileSizeText: "",
      });
      this.showNotice("success", "版本发布成功");
      try {
        await Promise.all([this.loadReleases(), this.loadStats()]);
      } catch (refreshError) {
        this.showNotice(
          "info",
          `版本已发布，但列表刷新失败：${readErrorMessage(refreshError, "请稍后手动刷新")}`
        );
      }
      this.clearReleaseModeTimer();
      this._releaseModeTimer = setTimeout(() => {
        this._releaseModeTimer = null;
        this.setData({ releaseMode: "list" });
      }, 1500);
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "新增版本发布失败"));
    } finally {
      this.setData({ releaseCreating: false });
    }
  },

  async saveBookingType() {
    if (this.data.bookingTypeSaving) return;

    const id = Number((this.data.bookingTypeForm && this.data.bookingTypeForm.id) || 0);
    const name = String((this.data.bookingTypeForm && this.data.bookingTypeForm.name) || "").trim();
    const description = String(
      (this.data.bookingTypeForm && this.data.bookingTypeForm.description) || ""
    ).trim();
    if (!name) {
      this.showNotice("error", "请填写预约类型名称");
      return;
    }

    this.setData({ bookingTypeSaving: true });
    try {
      await saveAdminBookingType({
        id: id > 0 ? id : undefined,
        name,
        description,
      });
      this.setData({
        bookingTypeModalOpen: false,
        bookingTypeForm: {
          id: 0,
          name: "",
          description: "",
        },
      });
      this.showNotice("success", id > 0 ? "类型已更新" : "类型已添加");
      await this.safeRefresh(
        [this.loadBookingTypes(), this.loadRecentBookings(), this.loadStats()],
        id > 0 ? "类型已更新" : "类型已添加"
      );
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, id > 0 ? "更新类型失败" : "新增类型失败"));
    } finally {
      this.setData({ bookingTypeSaving: false });
    }
  },

  async onToggleBookingType(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? Number(e.currentTarget.dataset.id || 0)
        : 0;
    if (!id) return;
    if (this.data.bookingTypeTogglingId || this.data.bookingTypeDeletingId || this.data.bookingTypeSaving || this.data.bookingTypeBatchDeleting) return;

    const target = (this.data.bookingTypes || []).find((item) => item.id === id) || null;
    if (!target) return;

    this.setData({ bookingTypeTogglingId: id });
    try {
      await toggleAdminBookingType(id, !Boolean(target.is_active));
      this.showNotice("success", "预约类型状态已更新");
      await this.safeRefresh([this.loadBookingTypes(), this.loadRecentBookings()], "预约类型状态已更新");
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "更新预约类型状态失败"));
    } finally {
      this.setData({ bookingTypeTogglingId: 0 });
    }
  },

  onDeleteBookingType(e) {
    this.onOpenBookingTypeDeleteConfirm(e);
  },

  onEnterBookingTypeSelectionMode() {
    if (
      this.data.bookingTypesLoading ||
      this.data.bookingTypesRefreshing ||
      this.data.bookingTypeSaving ||
      this.data.bookingTypeDeletingId !== 0 ||
      this.data.bookingTypeTogglingId !== 0 ||
      this.data.bookingTypeBatchDeleting ||
      !Array.isArray(this.data.bookingTypes) ||
      !this.data.bookingTypes.length
    ) {
      return;
    }
    const selectionState = buildSelectableListState(this.data.bookingTypes, []);
    this.setData({
      bookingTypeSelectionMode: true,
      bookingTypeSelectedIds: [],
      bookingTypeSelectedCount: 0,
      bookingTypeAllSelected: false,
      bookingTypes: selectionState.rows,
    });
  },

  onCancelBookingTypeSelectionMode() {
    if (this.data.bookingTypeBatchDeleting) return;
    const selectionState = buildSelectableListState(this.data.bookingTypes, []);
    this.setData({
      bookingTypeSelectionMode: false,
      bookingTypeSelectedIds: [],
      bookingTypeSelectedCount: 0,
      bookingTypeAllSelected: false,
      bookingTypes: selectionState.rows,
    });
  },

  onToggleBookingTypeSelection(e) {
    if (!this.data.bookingTypeSelectionMode || this.data.bookingTypeBatchDeleting) return;
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? Number(e.currentTarget.dataset.id || 0)
        : 0;
    if (!id) return;
    const currentIds = normalizePositiveIdList(this.data.bookingTypeSelectedIds);
    const nextIds = currentIds.includes(id)
      ? currentIds.filter((item) => item !== id)
      : currentIds.concat(id);
    const selectionState = buildSelectableListState(this.data.bookingTypes, nextIds);
    this.setData({
      bookingTypes: selectionState.rows,
      bookingTypeSelectedIds: selectionState.selectedIds,
      bookingTypeSelectedCount: selectionState.selectedCount,
      bookingTypeAllSelected: selectionState.allSelected,
    });
  },

  onToggleAllBookingTypes() {
    if (!this.data.bookingTypeSelectionMode || this.data.bookingTypeBatchDeleting) return;
    const nextIds = this.data.bookingTypeAllSelected
      ? []
      : (Array.isArray(this.data.bookingTypes) ? this.data.bookingTypes : [])
          .map((item) => Number(item && item.id))
          .filter((id) => id > 0);
    const selectionState = buildSelectableListState(this.data.bookingTypes, nextIds);
    this.setData({
      bookingTypes: selectionState.rows,
      bookingTypeSelectedIds: selectionState.selectedIds,
      bookingTypeSelectedCount: selectionState.selectedCount,
      bookingTypeAllSelected: selectionState.allSelected,
    });
  },

  async onBatchDeleteBookingTypes() {
    if (
      !this.data.bookingTypeSelectionMode ||
      this.data.bookingTypeBatchDeleting ||
      !this.data.bookingTypeSelectedCount
    ) {
      return;
    }

    const ids = normalizePositiveIdList(this.data.bookingTypeSelectedIds);
    if (!ids.length) return;

    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: "批量删除约拍类型",
        content: `确定删除已选择的 ${ids.length} 个约拍类型吗？此操作无法撤销。`,
        confirmColor: "#dc2626",
        success: (res) => resolve(Boolean(res && res.confirm)),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;

    this.setData({ bookingTypeBatchDeleting: true });
    try {
      for (let index = 0; index < ids.length; index += 1) {
        await deleteAdminBookingType(ids[index]);
      }
      const currentId = Number((this.data.bookingTypeForm && this.data.bookingTypeForm.id) || 0);
      if (currentId > 0 && ids.includes(currentId)) {
        this.setData({
          bookingTypeForm: {
            id: 0,
            name: "",
            description: "",
          },
        });
      }
      this.setData({
        bookingTypeSelectionMode: false,
        bookingTypeSelectedIds: [],
        bookingTypeSelectedCount: 0,
        bookingTypeAllSelected: false,
      });
      await this.safeRefresh(
        [this.loadBookingTypes(), this.loadRecentBookings(), this.loadStats()],
        `已删除 ${ids.length} 个约拍类型`
      );
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "批量删除约拍类型失败"));
    } finally {
      this.setData({ bookingTypeBatchDeleting: false });
    }
  },

  async onConfirmDeleteBookingType() {
    const id = Number(this.data.bookingTypeDeletingTargetId || 0);
    if (!id) {
      this.onCancelBookingTypeDeleteConfirm();
      return;
    }
    if (this.data.bookingTypeDeletingId || this.data.bookingTypeTogglingId || this.data.bookingTypeSaving || this.data.bookingTypeBatchDeleting) return;

    this.setData({ bookingTypeDeletingId: id });
    try {
      await deleteAdminBookingType(id);
      const currentId = Number((this.data.bookingTypeForm && this.data.bookingTypeForm.id) || 0);
      if (currentId === id) {
        this.setData({
          bookingTypeForm: {
            id: 0,
            name: "",
            description: "",
          },
        });
      }
      this.showNotice("success", "约拍类型已删除");
      this.setData({
        bookingTypeDeleteConfirmOpen: false,
        bookingTypeDeletingTargetId: 0,
        bookingTypeDeletingTargetName: "",
      });
      await this.safeRefresh(
        [this.loadBookingTypes(), this.loadRecentBookings(), this.loadStats()],
        "约拍类型已删除"
      );
    } catch (error) {
      this.setData({
        bookingTypeDeleteConfirmOpen: false,
        bookingTypeDeletingTargetId: 0,
        bookingTypeDeletingTargetName: "",
      });
      this.showNotice("error", readErrorMessage(error, "删除约拍类型失败"));
    } finally {
      this.setData({ bookingTypeDeletingId: 0 });
    }
  },

  async saveAllowedCity() {
    if (this.data.citySaving) return;

    const cityId = Number((this.data.cityForm && this.data.cityForm.id) || 0);
    const cityName = String(this.data.cityForm.city_name || "").trim();
    const province = String(this.data.cityForm.province || "").trim();
    const cityCode = String(this.data.cityForm.city_code || "").trim();
    let latitude = Number(this.data.cityForm.latitude);
    let longitude = Number(this.data.cityForm.longitude);
    let resolvedCityName = cityName;
    let resolvedProvince = province;
    const isActive = normalizeDbBoolean(this.data.cityForm.is_active, true);
    let resolvedCityCode = cityCode;

    if (!cityName) {
      this.showNotice("error", "请填写城市名称");
      return;
    }

    this.setData({ citySaving: true });
    try {
      if (!isValidCoordinatePair(latitude, longitude)) {
        const resolvedCoordinate = await this.resolveCityCoordinateByMap(cityName, province);
        if (!resolvedCoordinate || !isValidCoordinatePair(resolvedCoordinate.latitude, resolvedCoordinate.longitude)) {
          this.showNotice(
            "error",
            "未找到该城市坐标，请补充更准确城市名称或使用地图选择（若持续失败请检查腾讯地图 WebService 配置）"
          );
          return;
        }

        latitude = Number(resolvedCoordinate.latitude);
        longitude = Number(resolvedCoordinate.longitude);
        resolvedCityName = String(resolvedCityName || resolvedCoordinate.cityName || "").trim();
        resolvedProvince = String(resolvedProvince || resolvedCoordinate.province || "").trim();
        if (!resolvedCityCode) {
          resolvedCityCode = String(resolvedCoordinate.cityCode || "").trim();
        }

        this.setData({
          "cityForm.city_name": resolvedCityName,
          "cityForm.province": resolvedProvince,
          "cityForm.latitude": String(latitude),
          "cityForm.longitude": String(longitude),
          "cityForm.city_code": resolvedCityCode || this.data.cityForm.city_code || "",
        });
      }

      if (!resolvedCityCode) {
        resolvedCityCode = await this.resolveCityCodeByMap(resolvedCityName, resolvedProvince, latitude, longitude);
        if (resolvedCityCode) {
          this.setData({ "cityForm.city_code": resolvedCityCode });
        }
      }

      await saveAdminAllowedCity({
        id: cityId > 0 ? cityId : undefined,
        city_name: resolvedCityName || cityName,
        province: resolvedProvince || null,
        city_code: resolvedCityCode || null,
        latitude,
        longitude,
        is_active: isActive,
      });
      this.setData({
        cityModalOpen: false,
        cityMapPickerOpen: false,
        cityForm: {
          id: 0,
          city_name: "",
          province: "",
          city_code: "",
          latitude: "",
          longitude: "",
          is_active: true,
        },
      });
      this.showNotice("success", cityId > 0 ? "城市已更新" : "城市已添加");
      await this.safeRefresh(
        [this.loadAllowedCities(), this.loadStats()],
        cityId > 0 ? "城市已更新" : "城市已添加"
      );
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "保存城市失败"));
    } finally {
      this.setData({ citySaving: false });
    }
  },

  onEditAllowedCity(e) {
    if (this.data.citySaving || this.data.cityTogglingId || this.data.cityDeletingId || this.data.cityBatchDeleting) return;
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? Number(e.currentTarget.dataset.id || 0)
        : 0;
    if (!id) return;

    const target = (this.data.allowedCities || []).find((item) => item.id === id) || null;
    if (!target) return;

    this.setData({
      cityModalOpen: true,
      cityMapPickerOpen: false,
      cityForm: {
        id: target.id,
        city_name: String(target.city_name || ""),
        province: String(target.province || ""),
        city_code: String(target.city_code || ""),
        latitude: String(target.latitude || ""),
        longitude: String(target.longitude || ""),
        is_active: Boolean(target.is_active),
      },
    });
  },

  onResetCityForm() {
    if (this.data.citySaving || this.data.cityTogglingId || this.data.cityDeletingId || this.data.cityBatchDeleting) return;
    this.setData({
      cityModalOpen: false,
      cityMapPickerOpen: false,
      cityForm: {
        id: 0,
        city_name: "",
        province: "",
        city_code: "",
        latitude: "",
        longitude: "",
        is_active: true,
      },
    });
  },

  async onToggleAllowedCity(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? Number(e.currentTarget.dataset.id || 0)
        : 0;
    if (!id) return;
    if (this.data.cityTogglingId || this.data.citySaving || this.data.cityDeletingId || this.data.cityBatchDeleting) return;

    const target = (this.data.allowedCities || []).find((item) => item.id === id) || null;
    if (!target) return;

    this.setData({ cityTogglingId: id });
    try {
      const nextActive = !Boolean(target.is_active);
      await toggleAdminAllowedCity(id, nextActive);
      const currentFormId = Number((this.data.cityForm && this.data.cityForm.id) || 0);
      if (currentFormId === id) {
        this.setData({ "cityForm.is_active": nextActive });
      }
      this.showNotice("success", "城市状态已更新");
      await this.safeRefresh([this.loadAllowedCities()], "城市状态已更新");
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "更新可预约城市状态失败"));
    } finally {
      this.setData({ cityTogglingId: 0 });
    }
  },

  onDeleteAllowedCity(e) {
    this.onOpenCityDeleteConfirm(e);
  },

  onEnterCitySelectionMode() {
    if (
      this.data.citiesLoading ||
      this.data.citiesRefreshing ||
      this.data.citySaving ||
      this.data.cityDeletingId !== 0 ||
      this.data.cityTogglingId !== 0 ||
      this.data.cityBatchDeleting ||
      !Array.isArray(this.data.allowedCities) ||
      !this.data.allowedCities.length
    ) {
      return;
    }
    const selectionState = buildSelectableListState(this.data.allowedCities, []);
    this.setData({
      citySelectionMode: true,
      citySelectedIds: [],
      citySelectedCount: 0,
      cityAllSelected: false,
      allowedCities: selectionState.rows,
    });
  },

  onCancelCitySelectionMode() {
    if (this.data.cityBatchDeleting) return;
    const selectionState = buildSelectableListState(this.data.allowedCities, []);
    this.setData({
      citySelectionMode: false,
      citySelectedIds: [],
      citySelectedCount: 0,
      cityAllSelected: false,
      allowedCities: selectionState.rows,
    });
  },

  onToggleCitySelection(e) {
    if (!this.data.citySelectionMode || this.data.cityBatchDeleting) return;
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? Number(e.currentTarget.dataset.id || 0)
        : 0;
    if (!id) return;
    const currentIds = normalizePositiveIdList(this.data.citySelectedIds);
    const nextIds = currentIds.includes(id)
      ? currentIds.filter((item) => item !== id)
      : currentIds.concat(id);
    const selectionState = buildSelectableListState(this.data.allowedCities, nextIds);
    this.setData({
      allowedCities: selectionState.rows,
      citySelectedIds: selectionState.selectedIds,
      citySelectedCount: selectionState.selectedCount,
      cityAllSelected: selectionState.allSelected,
    });
  },

  onToggleAllCities() {
    if (!this.data.citySelectionMode || this.data.cityBatchDeleting) return;
    const nextIds = this.data.cityAllSelected
      ? []
      : (Array.isArray(this.data.allowedCities) ? this.data.allowedCities : [])
          .map((item) => Number(item && item.id))
          .filter((id) => id > 0);
    const selectionState = buildSelectableListState(this.data.allowedCities, nextIds);
    this.setData({
      allowedCities: selectionState.rows,
      citySelectedIds: selectionState.selectedIds,
      citySelectedCount: selectionState.selectedCount,
      cityAllSelected: selectionState.allSelected,
    });
  },

  async onBatchDeleteCities() {
    if (!this.data.citySelectionMode || this.data.cityBatchDeleting || !this.data.citySelectedCount) {
      return;
    }

    const ids = normalizePositiveIdList(this.data.citySelectedIds);
    if (!ids.length) return;

    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: "批量删除城市",
        content: `确定删除已选择的 ${ids.length} 个城市吗？此操作无法撤销。`,
        confirmColor: "#dc2626",
        success: (res) => resolve(Boolean(res && res.confirm)),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;

    this.setData({ cityBatchDeleting: true });
    try {
      for (let index = 0; index < ids.length; index += 1) {
        await deleteAdminAllowedCity(ids[index]);
      }
      const currentFormId = Number((this.data.cityForm && this.data.cityForm.id) || 0);
      if (currentFormId > 0 && ids.includes(currentFormId)) {
        this.setData({
          cityForm: {
            id: 0,
            city_name: "",
            province: "",
            city_code: "",
            latitude: "",
            longitude: "",
            is_active: true,
          },
        });
      }
      this.setData({
        citySelectionMode: false,
        citySelectedIds: [],
        citySelectedCount: 0,
        cityAllSelected: false,
      });
      await this.safeRefresh([this.loadAllowedCities(), this.loadStats()], `已删除 ${ids.length} 个城市`);
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "批量删除城市失败"));
    } finally {
      this.setData({ cityBatchDeleting: false });
    }
  },

  onOpenCityDeleteConfirm(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? Number(e.currentTarget.dataset.id || 0)
        : 0;
    if (!id) return;
    if (this.data.cityDeletingId || this.data.cityTogglingId || this.data.citySaving || this.data.cityBatchDeleting) return;

    const target = (this.data.allowedCities || []).find((item) => item.id === id) || null;
    if (!target) return;

    this.setData({
      cityDeleteConfirmOpen: true,
      cityDeletingTargetId: id,
      cityDeletingTargetName: String(target.city_name || ""),
    });
  },

  onCancelCityDeleteConfirm() {
    if (this.data.cityDeletingId) return;
    this.setData({
      cityDeleteConfirmOpen: false,
      cityDeletingTargetId: 0,
      cityDeletingTargetName: "",
    });
  },

  async onConfirmDeleteAllowedCity() {
    const id = Number(this.data.cityDeletingTargetId || 0);
    if (!id) {
      this.onCancelCityDeleteConfirm();
      return;
    }
    if (this.data.cityDeletingId || this.data.cityTogglingId || this.data.citySaving || this.data.cityBatchDeleting) return;

    this.setData({ cityDeletingId: id });
    try {
      await deleteAdminAllowedCity(id);
      const currentFormId = Number((this.data.cityForm && this.data.cityForm.id) || 0);
      if (currentFormId === id) {
        this.setData({
          cityForm: {
            id: 0,
            city_name: "",
            province: "",
            city_code: "",
            latitude: "",
            longitude: "",
            is_active: true,
          },
        });
      }
      this.showNotice("success", "城市已删除");
      this.setData({
        cityDeleteConfirmOpen: false,
        cityDeletingTargetId: 0,
        cityDeletingTargetName: "",
      });
      await this.safeRefresh([this.loadAllowedCities(), this.loadStats()], "城市已删除");
    } catch (error) {
      this.setData({
        cityDeleteConfirmOpen: false,
        cityDeletingTargetId: 0,
        cityDeletingTargetName: "",
      });
      this.showNotice("error", readErrorMessage(error, "删除城市失败"));
    } finally {
      this.setData({ cityDeletingId: 0 });
    }
  },

  onDeleteAlbum(e) {
    this.onOpenAlbumDeleteConfirm(e);
  },

  onOpenAlbumCreateModal() {
    if (this.data.albumCreating || this.data.albumActionLoading) return;
    this.setData({
      albumCreateModalOpen: true,
      albumCreateTitle: "",
      albumCreateRecipientName: "",
      albumCreateWelcomeLetter: "",
      albumCreateAutoKey: true,
      albumCreateAccessKey: generateAlbumAccessKey(),
      albumCreateEnableTipping: true,
      albumCreateWelcomeLetterMode: "envelope",
      albumCreateEnableFreeze: true,
      albumCreateExpiryMode: "days",
      albumCreateExpiryDays: 7,
      albumCreateExpiryDate: getDateAfterDaysText(7),
      albumCreateCoverPath: "",
      albumCreateCoverPreview: "",
      albumCreateCoverCompressed: false,
      albumCreateDonationQrPath: "",
      albumCreateDonationQrPreview: "",
    });
  },

  onCloseAlbumCreateModal() {
    if (this.data.albumCreating) return;
    this.setData({
      albumCreateModalOpen: false,
      albumCreateTitle: "",
      albumCreateRecipientName: "",
      albumCreateWelcomeLetter: "",
      albumCreateAutoKey: true,
      albumCreateAccessKey: "",
      albumCreateEnableTipping: true,
      albumCreateWelcomeLetterMode: "envelope",
      albumCreateEnableFreeze: true,
      albumCreateExpiryMode: "days",
      albumCreateExpiryDays: 7,
      albumCreateExpiryDate: getDateAfterDaysText(7),
      albumCreateCoverPath: "",
      albumCreateCoverPreview: "",
      albumCreateCoverCompressed: false,
      albumCreateDonationQrPath: "",
      albumCreateDonationQrPreview: "",
    });
  },

  onAlbumCreateInput(e) {
    const field =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.field || "")
        : "";
    const value = e && e.detail ? e.detail.value : "";
    if (!field) return;

    if (field === "title") {
      this.setData({ albumCreateTitle: String(value || "") });
      return;
    }
    if (field === "recipient_name") {
      this.setData({ albumCreateRecipientName: String(value || "") });
      return;
    }
    if (field === "welcome_letter") {
      this.setData({ albumCreateWelcomeLetter: String(value || "") });
      return;
    }
    if (field === "access_key") {
      this.setData({ albumCreateAccessKey: normalizeAlbumAccessKey(value) });
    }
  },

  onAlbumCreateAutoKeyChange(e) {
    const next = Boolean(e && e.detail ? e.detail.value : false);
    const patch = { albumCreateAutoKey: next };
    if (next) {
      patch.albumCreateAccessKey = generateAlbumAccessKey();
    } else {
      const key = normalizeAlbumAccessKey(this.data.albumCreateAccessKey);
      patch.albumCreateAccessKey = key || generateAlbumAccessKey();
    }
    this.setData(patch);
  },

  onAlbumCreateEnableTippingChange(e) {
    const next = Boolean(e && e.detail ? e.detail.value : false);
    this.setData({ albumCreateEnableTipping: next });
  },

  onAlbumCreateWelcomeLetterModeChange(e) {
    const mode =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.mode || "envelope")
        : "envelope";
    this.setData({
      albumCreateWelcomeLetterMode: normalizeWelcomeLetterMode(mode, true),
    });
  },

  onAlbumCreateEnableFreezeChange(e) {
    const next = Boolean(e && e.detail ? e.detail.value : false);
    this.setData({ albumCreateEnableFreeze: next });
  },

  onChooseAlbumCreateCover() {
    if (this.data.albumCreating) return;
    this.syncSectionMeta("albums");
    if (this.data.mobileMenuOpen) {
      this.setData({ mobileMenuOpen: false });
    }
    this.markTransientForegroundReturn("album-create-cover-choose-media");
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: async (res) => {
        const file = res && Array.isArray(res.tempFiles) ? res.tempFiles[0] : null;
        const filePath = String((file && file.tempFilePath) || "").trim();
        if (!filePath) {
          this.showNotice("error", "选择封面图片失败，请重试");
          return;
        }
        const optimized = await optimizeAlbumCoverPath(filePath);
        const finalPath = String(optimized.path || filePath).trim() || filePath;
        this.setData({
          albumCreateCoverPath: finalPath,
          albumCreateCoverPreview: finalPath,
          albumCreateCoverCompressed: Boolean(optimized.compressed),
        });
        if (optimized.notice) {
          this.showNotice("info", optimized.notice);
        }
      },
      fail: (error) => {
        const message = String((error && error.errMsg) || "").toLowerCase();
        if (message.includes("cancel")) return;
        this.showNotice("error", "选择封面图片失败，请重试");
      },
    });
  },

  onRemoveAlbumCreateCover() {
    if (this.data.albumCreating) return;
    this.setData({
      albumCreateCoverPath: "",
      albumCreateCoverPreview: "",
      albumCreateCoverCompressed: false,
    });
  },

  onChooseAlbumCreateDonationQr() {
    if (this.data.albumCreating) return;
    this.syncSectionMeta("albums");
    if (this.data.mobileMenuOpen) {
      this.setData({ mobileMenuOpen: false });
    }
    this.markTransientForegroundReturn("album-create-donation-choose-media");
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: (res) => {
        const file = res && Array.isArray(res.tempFiles) ? res.tempFiles[0] : null;
        const filePath = String((file && file.tempFilePath) || "").trim();
        if (!filePath) {
          this.showNotice("error", "选择赞赏码失败，请重试");
          return;
        }
        this.setData({
          albumCreateDonationQrPath: filePath,
          albumCreateDonationQrPreview: filePath,
        });
      },
      fail: (error) => {
        const message = String((error && error.errMsg) || "").toLowerCase();
        if (message.includes("cancel")) return;
        this.showNotice("error", "选择赞赏码失败，请重试");
      },
    });
  },

  onRemoveAlbumCreateDonationQr() {
    if (this.data.albumCreating) return;
    this.setData({
      albumCreateDonationQrPath: "",
      albumCreateDonationQrPreview: "",
    });
  },

  onAlbumCreateExpiryModeChange(e) {
    const mode =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.mode || "")
        : "";
    if (mode !== "days" && mode !== "date") return;

    if (mode === "days") {
      const nextDays = Math.max(1, Math.min(365, Number(this.data.albumCreateExpiryDays || 7) || 7));
      this.setData({
        albumCreateExpiryMode: "days",
        albumCreateExpiryDays: nextDays,
        albumCreateExpiryDate: getDateAfterDaysText(nextDays),
      });
      return;
    }

    const todayDate = getTodayDateText();
    const currentDate = String(this.data.albumCreateExpiryDate || "").trim();
    const safeDate = currentDate && currentDate >= todayDate ? currentDate : getDateAfterDaysText(7);
    const safeDays = Math.max(getDateDiffDays(todayDate, safeDate), 1);
    this.setData({
      albumCreateExpiryMode: "date",
      albumCreateExpiryDate: safeDate,
      albumCreateExpiryDays: safeDays,
    });
  },

  onAlbumCreateExpiryDaysInput(e) {
    const rawValue = e && e.detail ? Number(e.detail.value || 0) : 0;
    const nextDays = Math.max(1, Math.min(365, Number.isFinite(rawValue) ? Math.floor(rawValue) : 7));
    this.setData({
      albumCreateExpiryDays: nextDays,
      albumCreateExpiryDate: getDateAfterDaysText(nextDays),
    });
  },

  onAlbumCreateExpiryDateChange(e) {
    const value = e && e.detail ? String(e.detail.value || "").trim() : "";
    if (!value) return;
    const todayDate = getTodayDateText();
    const safeDate = value >= todayDate ? value : todayDate;
    const safeDays = Math.max(getDateDiffDays(todayDate, safeDate), 1);
    this.setData({
      albumCreateExpiryDate: safeDate,
      albumCreateExpiryDays: safeDays,
    });
  },

  onGenerateAlbumCreateKey() {
    this.setData({
      albumCreateAutoKey: false,
      albumCreateAccessKey: generateAlbumAccessKey(),
    });
  },

  async onSubmitCreateAlbum() {
    if (this.data.albumCreating) return;

    const title = String(this.data.albumCreateTitle || "").trim();
    const recipientName = String(this.data.albumCreateRecipientName || "").trim();
    const welcomeLetter = String(this.data.albumCreateWelcomeLetter || "").trim();
    const autoKey = Boolean(this.data.albumCreateAutoKey);
    const manualKey = normalizeAlbumAccessKey(this.data.albumCreateAccessKey);
    const enableTipping = Boolean(this.data.albumCreateEnableTipping);
    const welcomeLetterMode = normalizeWelcomeLetterMode(this.data.albumCreateWelcomeLetterMode, true);
    const enableWelcomeLetter = welcomeLetterMode !== "none";
    const enableFreeze = Boolean(this.data.albumCreateEnableFreeze);
    const expiryMode = String(this.data.albumCreateExpiryMode || "days");
    const expiryDays = Math.max(1, Math.min(365, Number(this.data.albumCreateExpiryDays || 7) || 7));
    const expiryDate = String(this.data.albumCreateExpiryDate || "").trim();
    const coverPath = String(this.data.albumCreateCoverPath || "").trim();
    const donationQrPath = String(this.data.albumCreateDonationQrPath || "").trim();
    const todayDate = getTodayDateText();

    if (!autoKey && manualKey.length !== 8) {
      this.showNotice("error", "访问密钥必须是 8 位大写字母或数字");
      return;
    }

    let expiresAt = getDateTimeAfterDaysText(expiryDays);
    if (expiryMode === "date") {
      const safeDate = expiryDate || getDateAfterDaysText(7);
      if (safeDate < todayDate) {
        this.showNotice("error", "过期日期不能早于今天");
        return;
      }
      expiresAt = `${safeDate} 23:59:59`;
    }

    this.setData({ albumCreating: true });
    try {
      const created = await createAdminAlbum({
        title,
        recipient_name: recipientName,
        welcome_letter: welcomeLetter,
        access_key: autoKey ? "" : manualKey,
        enable_tipping: enableTipping,
        enable_welcome_letter: enableWelcomeLetter,
        welcome_letter_mode: welcomeLetterMode,
        enable_freeze: enableFreeze,
        expires_at: expiresAt,
      });

      const createdId = String((created && created.id) || "").trim();
      const uploadWarnings = [];
      if (createdId && coverPath) {
        try {
          let coverUploadPath = coverPath;
          if (!this.data.albumCreateCoverCompressed) {
            const optimizedCover = await optimizeAlbumCoverPath(coverPath);
            coverUploadPath = String(optimizedCover.path || coverPath).trim() || coverPath;
            if (optimizedCover.notice) {
              uploadWarnings.push(optimizedCover.notice);
            }
          }
          const coverName = pickFileNameFromPath(coverUploadPath, `album_cover_${Date.now()}.jpg`);
          await uploadAdminAlbumCover(createdId, coverUploadPath, coverName);
        } catch (error) {
          uploadWarnings.push(`封面上传失败：${readErrorMessage(error, "请稍后重试")}`);
        }
      }
      if (createdId && enableTipping && donationQrPath) {
        try {
          const donationName = pickFileNameFromPath(donationQrPath, `album_donation_${Date.now()}.jpg`);
          await uploadAdminAlbumDonationQr(createdId, donationQrPath, donationName);
        } catch (error) {
          uploadWarnings.push(`赞赏码上传失败：${readErrorMessage(error, "请稍后重试")}`);
        }
      }

      this.setData({
        albumCreateModalOpen: false,
        albumCreateTitle: "",
        albumCreateRecipientName: "",
        albumCreateWelcomeLetter: "",
        albumCreateAutoKey: true,
        albumCreateAccessKey: "",
        albumCreateEnableTipping: true,
        albumCreateWelcomeLetterMode: "envelope",
        albumCreateEnableFreeze: true,
        albumCreateExpiryMode: "days",
        albumCreateExpiryDays: 7,
        albumCreateExpiryDate: getDateAfterDaysText(7),
        albumCreateCoverPath: "",
        albumCreateCoverPreview: "",
        albumCreateCoverCompressed: false,
        albumCreateDonationQrPath: "",
        albumCreateDonationQrPreview: "",
      });
      if (uploadWarnings.length) {
        this.showNotice("info", `专属空间已创建；${uploadWarnings.join("；")}`);
      } else {
        this.showNotice("success", "专属空间已创建");
      }
      try {
        await Promise.all([this.loadAlbums(), this.loadStats()]);
      } catch (refreshError) {
        this.showNotice(
          "info",
          `专属空间已创建，但列表刷新失败：${readErrorMessage(refreshError, "请稍后手动刷新")}`
        );
      }
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "创建专属空间失败"));
    } finally {
      this.setData({ albumCreating: false });
    }
  },

  onEnterAlbumSelectionMode() {
    if (this.data.albumBatchDeleting || this.data.albumActionLoading) return;
    if (!this.data.albumTotalCount) return;
    this.setData(
      {
        albumSelectionMode: true,
        albumSelectedIds: [],
        albumDeleteConfirmOpen: false,
        albumDeletingTargetId: "",
        albumDeletingTargetTitle: "",
        albumBatchDeleteConfirmOpen: false,
      },
      () => {
        this.refreshAlbumModuleView();
      }
    );
  },

  onCancelAlbumSelectionMode() {
    if (this.data.albumBatchDeleting || this.data.albumActionLoading) return;
    this.setData(
      {
        albumSelectionMode: false,
        albumSelectedIds: [],
        albumBatchDeleteConfirmOpen: false,
      },
      () => {
        this.refreshAlbumModuleView();
      }
    );
  },

  onToggleAlbumSelection(e) {
    if (!this.data.albumSelectionMode || this.data.albumBatchDeleting) return;
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;

    const selected = Array.isArray(this.data.albumSelectedIds) ? this.data.albumSelectedIds.slice() : [];
    const index = selected.indexOf(id);
    if (index >= 0) {
      selected.splice(index, 1);
    } else {
      selected.push(id);
    }

    this.setData({ albumSelectedIds: selected }, () => {
      this.refreshAlbumModuleView();
    });
  },

  onToggleAlbumSelectAll() {
    if (!this.data.albumSelectionMode || this.data.albumBatchDeleting) return;
    const allIds = (Array.isArray(this.data.albumRows) ? this.data.albumRows : [])
      .map((item) => String((item && item.id) || ""))
      .filter(Boolean);
    const nextSelected = this.data.albumAllSelected ? [] : allIds;
    this.setData({ albumSelectedIds: nextSelected }, () => {
      this.refreshAlbumModuleView();
    });
  },

  onOpenAlbumBatchDeleteConfirm() {
    if (!this.data.albumSelectionMode || this.data.albumBatchDeleting) return;
    if (!this.data.albumSelectedCount) {
      this.showNotice("error", "请先选择要删除的空间");
      return;
    }
    this.setData({ albumBatchDeleteConfirmOpen: true });
  },

  onCloseAlbumBatchDeleteConfirm() {
    if (this.data.albumBatchDeleting) return;
    this.setData({ albumBatchDeleteConfirmOpen: false });
  },

  async onConfirmAlbumBatchDelete() {
    if (this.data.albumBatchDeleting) return;
    const selectedIds = Array.isArray(this.data.albumSelectedIds)
      ? this.data.albumSelectedIds.map((item) => String(item || "")).filter(Boolean)
      : [];
    if (!selectedIds.length) {
      this.setData({ albumBatchDeleteConfirmOpen: false });
      this.showNotice("error", "请先选择要删除的空间");
      return;
    }

    this.setData({
      albumBatchDeleting: true,
      albumBatchDeleteConfirmOpen: false,
    });

    let deletedCount = 0;
    let failedCount = 0;
    let storageWarningCount = 0;

    for (let i = 0; i < selectedIds.length; i += 1) {
      const id = selectedIds[i];
      try {
        const result = await deleteAdminAlbum(id);
        deletedCount += 1;
        if (result && result.storageCleanupFailed) {
          storageWarningCount += 1;
        }
      } catch (error) {
        failedCount += 1;
      }
    }

    this.setData(
      {
        albumBatchDeleting: false,
        albumSelectionMode: false,
        albumSelectedIds: [],
      },
      () => {
        this.refreshAlbumModuleView();
      }
    );

    if (deletedCount > 0) {
      let refreshWarning = "";
      try {
        await Promise.all([this.loadAlbums(), this.loadStats()]);
      } catch (refreshError) {
        refreshWarning = readErrorMessage(refreshError, "请稍后手动刷新");
      }
      if (failedCount > 0 || storageWarningCount > 0) {
        const warningParts = [];
        if (failedCount > 0) warningParts.push(`失败 ${failedCount} 个`);
        if (storageWarningCount > 0) warningParts.push(`文件清理异常 ${storageWarningCount} 个`);
        if (refreshWarning) warningParts.push(`列表刷新失败：${refreshWarning}`);
        this.showNotice("info", `成功删除 ${deletedCount} 个空间，${warningParts.join("，")}`);
      } else {
        const suffix = refreshWarning ? `；列表刷新失败：${refreshWarning}` : "";
        this.showNotice("success", `成功删除 ${deletedCount} 个空间${suffix}`);
      }
    } else {
      this.showNotice("error", "批量删除空间失败，请稍后重试");
    }
  },

  onOpenAlbumDeleteConfirm(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;
    if (this.data.albumActionLoading || this.data.albumSelectionMode || this.data.albumBatchDeleting) return;
    const target = (this.data.albums || []).find((item) => String((item && item.id) || "") === id) || null;
    if (!target) return;
    this.setData({
      albumDeleteConfirmOpen: true,
      albumDeletingTargetId: id,
      albumDeletingTargetTitle: String(target.title || "未命名空间"),
    });
  },

  onCloseAlbumDeleteConfirm() {
    if (this.data.albumActionLoading || this.data.albumBatchDeleting) return;
    this.setData({
      albumDeleteConfirmOpen: false,
      albumDeletingTargetId: "",
      albumDeletingTargetTitle: "",
    });
  },

  async onConfirmAlbumDelete() {
    const id = String(this.data.albumDeletingTargetId || "").trim();
    if (!id) {
      this.onCloseAlbumDeleteConfirm();
      return;
    }
    if (this.data.albumActionLoading || this.data.albumBatchDeleting) return;

    this.setData({ albumActionLoading: true });
    try {
      const result = await deleteAdminAlbum(id);
      this.setData({
        albumDeleteConfirmOpen: false,
        albumDeletingTargetId: "",
        albumDeletingTargetTitle: "",
      });
      if (result && result.storageCleanupFailed) {
        this.showNotice("info", `空间记录已删除，但文件清理失败：${result.warning || "请稍后处理"}`);
      } else {
        this.showNotice("success", "专属空间已删除");
      }
      await this.safeRefresh([this.loadAlbums(), this.loadStats()], "专属空间已删除");
    } catch (error) {
      this.setData({
        albumDeleteConfirmOpen: false,
        albumDeletingTargetId: "",
        albumDeletingTargetTitle: "",
      });
      this.showNotice("error", readErrorMessage(error, "删除专属空间失败"));
    } finally {
      this.setData({ albumActionLoading: false });
    }
  },

  onOpenAlbumTitleModal(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;
    if (this.data.albumTitleSaving) return;
    const target = (this.data.albums || []).find((item) => String((item && item.id) || "") === id) || null;
    if (!target) return;
    this.setData({
      albumTitleModalOpen: true,
      albumEditingTitleId: id,
      albumEditingTitleValue: String(target.title || ""),
    });
  },

  onCloseAlbumTitleModal() {
    if (this.data.albumTitleSaving) return;
    this.setData({
      albumTitleModalOpen: false,
      albumEditingTitleId: "",
      albumEditingTitleValue: "",
    });
  },

  onAlbumTitleInput(e) {
    const value = e && e.detail ? e.detail.value : "";
    this.setData({ albumEditingTitleValue: String(value || "") });
  },

  async onSubmitAlbumTitle() {
    const id = String(this.data.albumEditingTitleId || "").trim();
    if (!id) {
      this.onCloseAlbumTitleModal();
      return;
    }
    if (this.data.albumTitleSaving) return;

    const title = String(this.data.albumEditingTitleValue || "").trim() || "未命名空间";
    this.setData({ albumTitleSaving: true });
    try {
      await updateAdminAlbumFields(id, { title });
      this.setData({
        albumTitleModalOpen: false,
        albumEditingTitleId: "",
        albumEditingTitleValue: "",
      });
      this.showNotice("success", "空间名称已更新");
      await this.safeRefresh([this.loadAlbums()], "空间名称已更新");
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "更新空间名称失败"));
    } finally {
      this.setData({ albumTitleSaving: false });
    }
  },

  onOpenAlbumKeyModal(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;
    if (this.data.albumKeySaving) return;
    const target = (this.data.albums || []).find((item) => String((item && item.id) || "") === id) || null;
    if (!target) return;
    this.setData({
      albumKeyModalOpen: true,
      albumEditingKeyId: id,
      albumEditingKeyTitle: String(target.title || "未命名空间"),
      albumEditingKeyValue: normalizeAlbumAccessKey(target.access_key),
    });
  },

  onCloseAlbumKeyModal() {
    if (this.data.albumKeySaving) return;
    this.setData({
      albumKeyModalOpen: false,
      albumEditingKeyId: "",
      albumEditingKeyTitle: "",
      albumEditingKeyValue: "",
    });
  },

  onAlbumKeyInput(e) {
    const value = e && e.detail ? e.detail.value : "";
    this.setData({ albumEditingKeyValue: normalizeAlbumAccessKey(value) });
  },

  async onSubmitAlbumKey() {
    const id = String(this.data.albumEditingKeyId || "").trim();
    if (!id) {
      this.onCloseAlbumKeyModal();
      return;
    }
    if (this.data.albumKeySaving) return;

    const nextKey = normalizeAlbumAccessKey(this.data.albumEditingKeyValue);
    if (nextKey.length !== 8) {
      this.showNotice("error", "访问密钥必须是 8 位大写字母或数字");
      return;
    }

    this.setData({ albumKeySaving: true });
    try {
      await updateAdminAlbumAccessKey(id, nextKey);
      this.setData({
        albumKeyModalOpen: false,
        albumEditingKeyId: "",
        albumEditingKeyTitle: "",
        albumEditingKeyValue: "",
      });
      this.showNotice("success", "访问密钥已更新");
      await this.safeRefresh([this.loadAlbums()], "访问密钥已更新");
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "更新访问密钥失败"));
    } finally {
      this.setData({ albumKeySaving: false });
    }
  },

  onOpenAlbumRecipientModal(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;
    if (this.data.albumRecipientSaving) return;
    const target = (this.data.albums || []).find((item) => String((item && item.id) || "") === id) || null;
    if (!target) return;
    this.setData({
      albumRecipientModalOpen: true,
      albumEditingRecipientId: id,
      albumEditingRecipientTitle: String(target.title || "未命名空间"),
      albumEditingRecipientName: String(target.recipient_name || ""),
      albumEditingWelcomeLetter: String(target.welcome_letter || ""),
      albumEditingWelcomeLetterMode: normalizeWelcomeLetterMode(
        target.welcome_letter_mode,
        target.enable_welcome_letter !== false
      ),
    });
  },

  onCloseAlbumRecipientModal() {
    if (this.data.albumRecipientSaving) return;
    this.setData({
      albumRecipientModalOpen: false,
      albumEditingRecipientId: "",
      albumEditingRecipientTitle: "",
      albumEditingRecipientName: "",
      albumEditingWelcomeLetter: "",
      albumEditingWelcomeLetterMode: "envelope",
    });
  },

  onAlbumRecipientNameInput(e) {
    const value = e && e.detail ? e.detail.value : "";
    this.setData({ albumEditingRecipientName: String(value || "") });
  },

  onAlbumWelcomeLetterInput(e) {
    const value = e && e.detail ? e.detail.value : "";
    this.setData({ albumEditingWelcomeLetter: String(value || "") });
  },

  onAlbumEditingWelcomeLetterModeChange(e) {
    const mode =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.mode || "envelope")
        : "envelope";
    this.setData({
      albumEditingWelcomeLetterMode: normalizeWelcomeLetterMode(mode, true),
    });
  },

  async onSubmitAlbumRecipient() {
    const id = String(this.data.albumEditingRecipientId || "").trim();
    if (!id) {
      this.onCloseAlbumRecipientModal();
      return;
    }
    if (this.data.albumRecipientSaving) return;

    const recipientName = String(this.data.albumEditingRecipientName || "").trim() || "拾光者";
    const welcomeLetter = String(this.data.albumEditingWelcomeLetter || "").trim();
    const welcomeLetterMode = normalizeWelcomeLetterMode(this.data.albumEditingWelcomeLetterMode, true);
    this.setData({ albumRecipientSaving: true });
    try {
      await updateAdminAlbumFields(id, {
        recipient_name: recipientName,
        welcome_letter: welcomeLetter,
        welcome_letter_mode: welcomeLetterMode,
        enable_welcome_letter: welcomeLetterMode !== "none",
      });
      this.setData({
        albumRecipientModalOpen: false,
        albumEditingRecipientId: "",
        albumEditingRecipientTitle: "",
        albumEditingRecipientName: "",
        albumEditingWelcomeLetter: "",
        albumEditingWelcomeLetterMode: "envelope",
      });
      this.showNotice("success", "收件人与欢迎信已更新");
      await this.safeRefresh([this.loadAlbums()], "收件人与欢迎信已更新");
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "更新收件人与欢迎信失败"));
    } finally {
      this.setData({ albumRecipientSaving: false });
    }
  },

  onOpenAlbumExpiryModal(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;
    if (this.data.albumExpirySaving) return;
    const target = (this.data.albums || []).find((item) => String((item && item.id) || "") === id) || null;
    if (!target) return;

    const todayDate = getTodayDateText();
    let targetDate = extractDateText(target.expires_at) || getDateAfterDaysText(7);
    if (targetDate < todayDate) {
      targetDate = todayDate;
    }
    const days = Math.max(getDateDiffDays(todayDate, targetDate), 1);

    this.setData({
      albumExpiryModalOpen: true,
      albumEditingExpiryId: id,
      albumEditingExpiryTitle: String(target.title || "未命名空间"),
      albumExpiryMode: "days",
      albumExpiryDays: days,
      albumExpiryDate: targetDate,
    });
  },

  onCloseAlbumExpiryModal() {
    if (this.data.albumExpirySaving) return;
    this.setData({
      albumExpiryModalOpen: false,
      albumEditingExpiryId: "",
      albumEditingExpiryTitle: "",
      albumExpiryMode: "days",
      albumExpiryDays: 7,
      albumExpiryDate: getDateAfterDaysText(7),
    });
  },

  onAlbumExpiryModeChange(e) {
    const mode =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.mode || "")
        : "";
    if (mode !== "days" && mode !== "date") return;

    if (mode === "days") {
      const days = Math.max(1, Math.min(365, Number(this.data.albumExpiryDays || 7) || 7));
      this.setData({
        albumExpiryMode: "days",
        albumExpiryDays: days,
        albumExpiryDate: getDateAfterDaysText(days),
      });
      return;
    }

    const todayDate = getTodayDateText();
    const currentDate = String(this.data.albumExpiryDate || "").trim();
    const safeDate = currentDate && currentDate >= todayDate ? currentDate : getDateAfterDaysText(7);
    const safeDays = Math.max(getDateDiffDays(todayDate, safeDate), 1);
    this.setData({
      albumExpiryMode: "date",
      albumExpiryDate: safeDate,
      albumExpiryDays: safeDays,
    });
  },

  onAlbumExpiryDaysInput(e) {
    const rawValue = e && e.detail ? Number(e.detail.value || 0) : 0;
    const nextDays = Math.max(1, Math.min(365, Number.isFinite(rawValue) ? Math.floor(rawValue) : 7));
    this.setData({
      albumExpiryDays: nextDays,
      albumExpiryDate: getDateAfterDaysText(nextDays),
    });
  },

  onAlbumExpiryQuickSelect(e) {
    const value =
      e && e.currentTarget && e.currentTarget.dataset
        ? Number(e.currentTarget.dataset.days || 0)
        : 0;
    const nextDays = Math.max(1, Math.min(365, Number.isFinite(value) ? Math.floor(value) : 7));
    this.setData({
      albumExpiryDays: nextDays,
      albumExpiryDate: getDateAfterDaysText(nextDays),
    });
  },

  onAlbumExpiryDateChange(e) {
    const value = e && e.detail ? String(e.detail.value || "").trim() : "";
    if (!value) return;
    const todayDate = getTodayDateText();
    const safeDate = value >= todayDate ? value : todayDate;
    const safeDays = Math.max(getDateDiffDays(todayDate, safeDate), 1);
    this.setData({
      albumExpiryDate: safeDate,
      albumExpiryDays: safeDays,
    });
  },

  async onSubmitAlbumExpiry() {
    const id = String(this.data.albumEditingExpiryId || "").trim();
    if (!id) {
      this.onCloseAlbumExpiryModal();
      return;
    }
    if (this.data.albumExpirySaving) return;

    const mode = String(this.data.albumExpiryMode || "days");
    const days = Math.max(1, Math.min(365, Number(this.data.albumExpiryDays || 7) || 7));
    const todayDate = getTodayDateText();
    let expiresAt = getDateTimeAfterDaysText(days);

    if (mode === "date") {
      const targetDate = String(this.data.albumExpiryDate || "").trim() || todayDate;
      if (targetDate < todayDate) {
        this.showNotice("error", "过期日期不能早于今天");
        return;
      }
      expiresAt = `${targetDate} 23:59:59`;
    }

    this.setData({ albumExpirySaving: true });
    try {
      await updateAdminAlbumFields(id, { expires_at: expiresAt });
      this.setData({
        albumExpiryModalOpen: false,
        albumEditingExpiryId: "",
        albumEditingExpiryTitle: "",
        albumExpiryMode: "days",
        albumExpiryDays: 7,
        albumExpiryDate: getDateAfterDaysText(7),
      });
      this.showNotice("success", "空间有效期已更新");
      await this.safeRefresh([this.loadAlbums(), this.loadStats()], "空间有效期已更新");
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "更新有效期失败"));
    } finally {
      this.setData({ albumExpirySaving: false });
    }
  },

  async onToggleAlbumTipping(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;
    if (this.data.albumActionLoading) return;

    const target = (this.data.albums || []).find((item) => String((item && item.id) || "") === id) || null;
    if (!target) return;
    const nextEnabled = !Boolean(target.enable_tipping);

    this.setData({ albumActionLoading: true });
    try {
      await updateAdminAlbumFields(id, { enable_tipping: nextEnabled });
      this.showNotice("success", nextEnabled ? "打赏功能已开启" : "打赏功能已关闭");
      await this.safeRefresh(
        [this.loadAlbums(), this.loadStats()],
        nextEnabled ? "打赏功能已开启" : "打赏功能已关闭"
      );
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "更新打赏状态失败"));
    } finally {
      this.setData({ albumActionLoading: false });
    }
  },

  async onToggleAlbumFreeze(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;
    if (this.data.albumActionLoading) return;

    const target = (this.data.albums || []).find((item) => String((item && item.id) || "") === id) || null;
    if (!target) return;
    const nextEnabled = !Boolean(target.enable_freeze);

    this.setData({ albumActionLoading: true });
    try {
      await updateAdminAlbumFields(id, { enable_freeze: nextEnabled });
      this.showNotice("success", nextEnabled ? "定格功能已开启" : "定格功能已关闭");
      await this.safeRefresh(
        [this.loadAlbums()],
        nextEnabled ? "定格功能已开启" : "定格功能已关闭"
      );
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "更新定格状态失败"));
    } finally {
      this.setData({ albumActionLoading: false });
    }
  },

  onOpenAlbumCoverModal(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;
    if (this.data.albumCoverUpdatingId || this.data.albumActionLoading || this.data.albumDonationUpdatingId) return;

    const target = (this.data.albums || []).find((item) => String((item && item.id) || "") === id) || null;
    if (!target) return;
    this.setData({
      albumCoverModalOpen: true,
      albumCoverTargetId: id,
      albumCoverTargetTitle: String(target.title || "未命名空间"),
      albumCoverCurrentUrl: String(target.coverResolved || ""),
    });
  },

  onCloseAlbumCoverModal() {
    if (this.data.albumCoverUpdatingId) return;
    this.setData({
      albumCoverModalOpen: false,
      albumCoverTargetId: "",
      albumCoverTargetTitle: "",
      albumCoverCurrentUrl: "",
    });
  },

  onUploadAlbumCover() {
    this.syncSectionMeta("albums");
    if (this.data.mobileMenuOpen) {
      this.setData({ mobileMenuOpen: false });
    }

    const id = String(this.data.albumCoverTargetId || "").trim();
    if (!id) return;
    if (this.data.albumCoverUpdatingId || this.data.albumActionLoading || this.data.albumDonationUpdatingId) return;

    this.markTransientForegroundReturn("album-cover-choose-media");
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: async (res) => {
        const file = res && Array.isArray(res.tempFiles) ? res.tempFiles[0] : null;
        const filePath = String((file && file.tempFilePath) || "").trim();
        if (!filePath) {
          this.showNotice("error", "选择封面图片失败，请重试");
          return;
        }
        const optimized = await optimizeAlbumCoverPath(filePath);
        const uploadPath = String(optimized.path || filePath).trim() || filePath;
        const fileName = pickFileNameFromPath(uploadPath, `album_cover_${Date.now()}.jpg`);
        this.setData({ albumCoverUpdatingId: id });
        try {
          const result = await uploadAdminAlbumCover(id, uploadPath, fileName);
          if (result && result.storageCleanupFailed) {
            this.showNotice("info", `封面已更新，但旧文件清理失败：${result.warning || "请稍后处理"}`);
          } else {
            this.showNotice("success", "封面图片已更新");
          }
          if (optimized.notice) {
            this.showNotice("info", optimized.notice);
          }
          this.setData({
            albumCoverModalOpen: false,
            albumCoverTargetId: "",
            albumCoverTargetTitle: "",
            albumCoverCurrentUrl: "",
          });
          await this.safeRefresh([this.loadAlbums()], "封面图片已更新");
        } catch (error) {
          this.showNotice("error", readErrorMessage(error, "更新封面图片失败"));
        } finally {
          this.setData({ albumCoverUpdatingId: "" });
        }
      },
      fail: (error) => {
        const message = String((error && error.errMsg) || "").toLowerCase();
        if (message.includes("cancel")) return;
        this.showNotice("error", "选择封面图片失败，请重试");
      },
    });
  },

  onOpenAlbumDonationModal(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;
    if (this.data.albumDonationUpdatingId || this.data.albumActionLoading || this.data.albumCoverUpdatingId) return;

    const target = (this.data.albums || []).find((item) => String((item && item.id) || "") === id) || null;
    if (!target) return;
    if (!target.enable_tipping) {
      this.showNotice("error", "请先开启打赏功能");
      return;
    }
    this.setData({
      albumDonationModalOpen: true,
      albumDonationTargetId: id,
      albumDonationTargetTitle: String(target.title || "未命名空间"),
      albumDonationCurrentUrl: String(target.donationQrResolved || ""),
    });
  },

  onCloseAlbumDonationModal() {
    if (this.data.albumDonationUpdatingId) return;
    this.setData({
      albumDonationModalOpen: false,
      albumDonationTargetId: "",
      albumDonationTargetTitle: "",
      albumDonationCurrentUrl: "",
    });
  },

  onUploadAlbumDonationQr() {
    this.syncSectionMeta("albums");
    if (this.data.mobileMenuOpen) {
      this.setData({ mobileMenuOpen: false });
    }

    const id = String(this.data.albumDonationTargetId || "").trim();
    if (!id) return;
    if (this.data.albumDonationUpdatingId || this.data.albumActionLoading || this.data.albumCoverUpdatingId) return;

    const target = (this.data.albums || []).find((item) => String((item && item.id) || "") === id) || null;
    if (!target || !target.enable_tipping) {
      this.showNotice("error", "请先开启打赏功能");
      return;
    }

    this.markTransientForegroundReturn("album-donation-choose-media");
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: async (res) => {
        const file = res && Array.isArray(res.tempFiles) ? res.tempFiles[0] : null;
        const filePath = String((file && file.tempFilePath) || "").trim();
        if (!filePath) {
          this.showNotice("error", "选择赞赏码失败，请重试");
          return;
        }
        const fileName = pickFileNameFromPath(filePath, `album_donation_${Date.now()}.jpg`);
        this.setData({ albumDonationUpdatingId: id });
        try {
          const result = await uploadAdminAlbumDonationQr(id, filePath, fileName);
          if (result && result.storageCleanupFailed) {
            this.showNotice("info", `赞赏码已更新，但旧文件清理失败：${result.warning || "请稍后处理"}`);
          } else {
            this.showNotice("success", "赞赏码已更新");
          }
          this.setData({
            albumDonationModalOpen: false,
            albumDonationTargetId: "",
            albumDonationTargetTitle: "",
            albumDonationCurrentUrl: "",
          });
          await this.safeRefresh([this.loadAlbums()], "赞赏码已更新");
        } catch (error) {
          this.showNotice("error", readErrorMessage(error, "更新赞赏码失败"));
        } finally {
          this.setData({ albumDonationUpdatingId: "" });
        }
      },
      fail: (error) => {
        const message = String((error && error.errMsg) || "").toLowerCase();
        if (message.includes("cancel")) return;
        this.showNotice("error", "选择赞赏码失败，请重试");
      },
    });
  },

  onCopyAlbumAccessKey(e) {
    const key =
      e && e.currentTarget && e.currentTarget.dataset
        ? normalizeAlbumAccessKey(e.currentTarget.dataset.key)
        : "";
    if (!key) return;
    wx.setClipboardData({
      data: key,
      success: () => {
        this.showNotice("success", "访问密钥已复制");
      },
      fail: () => {
        this.showNotice("error", "复制访问密钥失败，请重试");
      },
    });
  },

  onCopyAlbumLink(e) {
    const key =
      e && e.currentTarget && e.currentTarget.dataset
        ? normalizeAlbumAccessKey(e.currentTarget.dataset.key)
        : "";
    if (!key) {
      this.showNotice("error", "访问密钥无效");
      return;
    }
    const link = buildAlbumAccessLink(key);
    if (!link) {
      this.showNotice("error", "生成访问链接失败");
      return;
    }

    wx.setClipboardData({
      data: link,
      success: () => {
        this.showNotice("success", "访问链接已复制");
      },
      fail: () => {
        this.showNotice("error", "复制访问链接失败，请重试");
      },
    });
  },

  onViewAlbumDetail(e) {
    if (this.data.albumSelectionMode) {
      this.onToggleAlbumSelection(e);
      return;
    }
    if (this.data.albumBatchDeleting) return;

    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    const title =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.title || "")
        : "";
    const key =
      e && e.currentTarget && e.currentTarget.dataset
        ? normalizeAlbumAccessKey(e.currentTarget.dataset.key)
        : "";
    if (!id || !key) return;

    // 跳转到专属空间管理详情页面
    wx.navigateTo({
      url: `/pages/admin/album-detail/index?id=${id}&title=${encodeURIComponent(title)}&key=${key}`
    });
  },

  onCopyAlbumQrLink() {
    const key = normalizeAlbumAccessKey(this.data.albumQrAccessKey);
    if (!key) return;
    const link = buildAlbumAccessLink(key);
    if (!link) return;
    wx.setClipboardData({
      data: link,
      success: () => {
        this.showNotice("success", "二维码访问链接已复制");
      },
      fail: () => {
        this.showNotice("error", "复制链接失败，请重试");
      },
    });
  },

  onOpenAlbumQrModal(e) {
    const key =
      e && e.currentTarget && e.currentTarget.dataset
        ? normalizeAlbumAccessKey(e.currentTarget.dataset.key)
        : "";
    if (!key) {
      this.showNotice("error", "访问密钥无效");
      return;
    }
    this.setData({
      albumQrModalOpen: true,
      albumQrAccessKey: key,
      albumQrImageUrl: buildAlbumQrUrl(key),
    });
  },

  onCloseAlbumQrModal() {
    this.setData({
      albumQrModalOpen: false,
      albumQrAccessKey: "",
      albumQrImageUrl: "",
    });
  },



});
