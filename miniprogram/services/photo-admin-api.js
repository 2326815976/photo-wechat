const { dbQuery, dbRpc, getSession, requestJson, requestUpload } = require("./photo-api");

const ADMIN_BOOKING_STATUS = new Set([
  "pending",
  "confirmed",
  "in_progress",
  "finished",
  "cancelled",
]);
const ADMIN_RELEASE_PLATFORMS = new Set([
  "Android",
  "iOS",
  "HarmonyOS",
  "Windows",
  "MacOS",
  "Linux",
]);
const ADMIN_RELEASE_ALLOWED_EXTENSIONS = [
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
const ADMIN_PHOTO_WALL_ALBUM_ID = "00000000-0000-0000-0000-000000000000";
const ADMIN_SESSION_CACHE_TTL_MS = 1200;

let cachedAdminSessionUser = null;
let cachedAdminSessionAt = 0;
let pendingAdminSessionPromise = null;

function getSessionUser(sessionPayload) {
  let current = sessionPayload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") break;
    if (current.user && typeof current.user === "object") {
      return current.user;
    }
    if (
      current.session &&
      typeof current.session === "object" &&
      current.session.user &&
      typeof current.session.user === "object"
    ) {
      return current.session.user;
    }
    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }
  return null;
}

function clearAdminSessionCache() {
  cachedAdminSessionUser = null;
  cachedAdminSessionAt = 0;
}

function toErrorMessage(error, fallback) {
  if (typeof error === "string" && error.trim()) return error;

  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") break;
    const msg = String(current.message || "").trim();
    if (msg) return msg;

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

function assertAdminMutationPayload(payload, fallback) {
  const body = payload && typeof payload === "object" ? payload : {};
  if (hasExplicitRpcFailure(body)) {
    throw new Error(toErrorMessage(body, fallback));
  }
  return body;
}

function isColumnMissingError(error, columnName) {
  const message = toErrorMessage(error, "").toLowerCase();
  const column = String(columnName || "").trim().toLowerCase();
  if (!message || !column) return false;
  return (
    message.includes(column) &&
    (message.includes("unknown column") ||
      message.includes("does not exist") ||
      message.includes("column") && message.includes("not found"))
  );
}

function getTodayDateUTC8() {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function assertDbSuccess(result, fallback) {
  if (result && result.error) {
    throw new Error(toErrorMessage(result.error, fallback));
  }
  return result ? result.data : null;
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

function readFieldFromPayloadChain(payload, fields) {
  const keys = Array.isArray(fields) ? fields : [fields];
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") break;
    for (let i = 0; i < keys.length; i += 1) {
      const key = String(keys[i] || "").trim();
      if (!key) continue;
      if (Object.prototype.hasOwnProperty.call(current, key)) {
        const value = current[key];
        if (value !== undefined && value !== null) {
          return value;
        }
      }
    }
    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }
  return undefined;
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

function unwrapDeepestDataObject(payload) {
  if (Array.isArray(payload)) {
    const first = payload.find((item) => item && typeof item === "object" && !Array.isArray(item));
    return first || null;
  }

  let current = payload;
  let lastObject = null;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) break;
    lastObject = current;
    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    if (Array.isArray(next)) {
      const first = next.find((item) => item && typeof item === "object" && !Array.isArray(item));
      return first || lastObject;
    }
    current = next;
  }
  return lastObject;
}

function assertRpcSuccess(result, fallback) {
  if (result && result.error) {
    throw new Error(toErrorMessage(result.error, fallback));
  }
  const payload = result ? result.data : null;
  if (hasExplicitRpcFailure(payload)) {
    throw new Error(toErrorMessage(payload, fallback));
  }
  return payload;
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

function normalizePoseTags(tagsInput) {
  let source = [];
  if (Array.isArray(tagsInput)) {
    source = tagsInput;
  } else if (typeof tagsInput === "string") {
    source = tagsInput.split(/[,，]/g);
  }

  const dedupMap = new Map();
  source.forEach((item) => {
    const text = String(item || "").trim().replace(/\s+/g, " ");
    if (!text) return;
    const key = text.toLowerCase();
    if (!dedupMap.has(key)) {
      dedupMap.set(key, text);
    }
  });

  const tags = Array.from(dedupMap.values());
  if (tags.length > 3) {
    throw new Error("摆姿标签最多 3 个");
  }
  return tags;
}

function normalizeTagName(input) {
  return String(input || "").trim().replace(/\s+/g, " ");
}

function parseUniqueTagNames(input) {
  const rows = Array.isArray(input) ? input : String(input || "").split(/[,，]/g);
  const map = new Map();
  rows
    .map((item) => normalizeTagName(item))
    .filter(Boolean)
    .forEach((name) => {
      const key = name.toLowerCase();
      if (!map.has(key)) {
        map.set(key, name);
      }
    });
  return Array.from(map.values());
}

function normalizeAlbumAccessKey(input) {
  const raw = String(input || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return raw.slice(0, 8);
}

function generateRandomAlbumAccessKey() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let key = "";
  for (let i = 0; i < 8; i += 1) {
    const idx = Math.floor(Math.random() * chars.length);
    key += chars.charAt(idx);
  }
  return key;
}

function isDuplicateEntryError(error) {
  const text = toErrorMessage(error, "").toLowerCase();
  return (
    text.includes("duplicate") ||
    text.includes("already exists") ||
    text.includes("uk_pose_tags_name") ||
    text.includes("重复")
  );
}

function isAdminReleaseFileNameAllowed(fileName) {
  const lower = String(fileName || "").trim().toLowerCase();
  if (!lower) return false;
  return ADMIN_RELEASE_ALLOWED_EXTENSIONS.some((suffix) => lower.endsWith(suffix));
}

function normalizeDbBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value || "").trim().toLowerCase();
  if (!text) return Boolean(fallback);
  if (["1", "true", "t", "yes", "y", "on"].includes(text)) return true;
  if (["0", "false", "f", "no", "n", "off"].includes(text)) return false;
  return Boolean(fallback);
}

async function bestEffortDeleteStorageTargets(targets) {
  const keys = toUniqueNonEmptyStrings(targets);
  if (!keys.length) {
    return {
      deleted: 0,
      storageCleanupFailed: false,
      warning: "",
    };
  }

  try {
    const payload = await requestJson("/api/batch-delete", {
      method: "DELETE",
      data: {
        keys,
      },
    });
    const body = payload && typeof payload === "object" ? payload : {};
    if (hasExplicitRpcFailure(body)) {
      return {
        deleted: 0,
        storageCleanupFailed: true,
        warning: toErrorMessage(body, "清理云存储失败"),
      };
    }

    const deletedRaw = readFieldFromPayloadChain(body, ["deleted"]);
    const deleted = Number(deletedRaw);
    return {
      deleted:
        deletedRaw !== undefined && Number.isFinite(deleted) && deleted >= 0
          ? Math.round(deleted)
          : keys.length,
      storageCleanupFailed: false,
      warning: "",
    };
  } catch (error) {
    return {
      deleted: 0,
      storageCleanupFailed: true,
      warning: toErrorMessage(error, "清理云存储失败"),
    };
  }
}

function resolveUploadResult(payload) {
  const body = payload && typeof payload === "object" ? payload : {};
  if (hasExplicitRpcFailure(body)) {
    throw new Error(toErrorMessage(body, "上传失败"));
  }

  const url = String(readFieldFromPayloadChain(body, ["url"]) || "").trim();
  const fileId = String(readFieldFromPayloadChain(body, ["fileId"]) || "").trim();
  const cloudPath = String(readFieldFromPayloadChain(body, ["path"]) || "").trim();
  if (!url) {
    throw new Error("上传失败：后端未返回文件访问地址");
  }
  if (!cloudPath) {
    throw new Error("上传失败：后端未返回云存储路径");
  }

  return {
    url,
    fileId,
    path: cloudPath,
  };
}

async function uploadAdminAsset(filePath, fileName, folder, fallbackPrefix) {
  const normalizedPath = String(filePath || "").trim();
  if (!normalizedPath) {
    throw new Error("上传失败：文件路径不能为空");
  }

  const normalizedFolder = String(folder || "").trim().toLowerCase();
  if (!normalizedFolder) {
    throw new Error("上传失败：上传目录不能为空");
  }

  const finalFileName = normalizeUploadFileName(fileName, fallbackPrefix);
  const key = buildUploadKey(finalFileName, fallbackPrefix);
  const payload = await requestUpload("/api/upload", {
    method: "POST",
    filePath: normalizedPath,
    fileName: finalFileName,
    name: "file",
    formData: {
      folder: normalizedFolder,
      key,
    },
  });

  const upload = resolveUploadResult(payload);
  return {
    url: upload.url,
    fileId: upload.fileId,
    path: upload.path,
    key,
  };
}

async function requireAdminSession() {
  const now = Date.now();
  if (
    cachedAdminSessionUser &&
    cachedAdminSessionAt > 0 &&
    now - cachedAdminSessionAt <= ADMIN_SESSION_CACHE_TTL_MS
  ) {
    return cachedAdminSessionUser;
  }

  if (pendingAdminSessionPromise) {
    return pendingAdminSessionPromise;
  }

  pendingAdminSessionPromise = (async () => {
    const session = await getSession();
    const user = getSessionUser(session);
    if (!user || !user.id) {
      clearAdminSessionCache();
      throw new Error("未登录，请先登录后再访问管理后台");
    }
    if (String(user.role || "") !== "admin") {
      clearAdminSessionCache();
      throw new Error("无权访问：仅管理员可使用该功能");
    }

    cachedAdminSessionUser = user;
    cachedAdminSessionAt = Date.now();
    return user;
  })();

  try {
    return await pendingAdminSessionPromise;
  } finally {
    pendingAdminSessionPromise = null;
  }
}

async function getAdminDashboardStats() {
  await requireAdminSession();
  const result = await dbRpc("get_admin_dashboard_stats");
  const payload = assertRpcSuccess(result, "获取管理统计失败");
  return payload && typeof payload === "object" ? payload : {};
}

async function runAdminMaintenanceTasks() {
  await requireAdminSession();
  const result = await dbRpc("run_maintenance_tasks");
  const payload = assertRpcSuccess(result, "执行维护任务失败");
  return payload && typeof payload === "object" ? payload : {};
}

async function listAdminBlockedDates() {
  await requireAdminSession();
  const payload = await requestJson("/api/admin/blocked-dates", { method: "GET" });
  const body = assertAdminMutationPayload(payload, "获取锁档日期失败");
  if (Array.isArray(body)) return body;
  return readArrayFromPayloadChain(body, ["rows", "list", "items", "data"]);
}

async function createAdminBlockedDate(date, reason) {
  await requireAdminSession();
  const payload = await requestJson("/api/admin/blocked-dates", {
    method: "POST",
    data: {
      date: String(date || "").trim(),
      reason: String(reason || "").trim() || null,
    },
  });
  const body = assertAdminMutationPayload(payload, "新增锁档日期失败");
  return unwrapDeepestDataObject(body);
}

async function deleteAdminBlockedDate(id) {
  await requireAdminSession();
  const payload = await requestJson(`/api/admin/blocked-dates/${encodeURIComponent(String(id || ""))}`, {
    method: "DELETE",
  });
  assertAdminMutationPayload(payload, "删除锁档日期失败");
  return true;
}

async function listAdminBookingTypes() {
  await requireAdminSession();
  const result = await dbQuery({
    table: "booking_types",
    action: "select",
    columns: "id,name,description,is_active,created_at",
    orders: [{ column: "id", ascending: true }],
    limit: 200,
  });
  const data = assertDbSuccess(result, "获取预约类型失败");
  return Array.isArray(data) ? data : [];
}

async function saveAdminBookingType(payload) {
  await requireAdminSession();
  const input = payload && typeof payload === "object" ? payload : {};

  const id = Number(input.id || 0);
  const name = String(input.name || "").trim();
  const description = String(input.description || "").trim();
  const hasIsActive = Object.prototype.hasOwnProperty.call(input, "is_active");
  const isActive = hasIsActive ? Boolean(input.is_active) : true;

  if (!name) {
    throw new Error("预约类型名称不能为空");
  }

  if (id > 0) {
    const values = {
      name,
      description: description || null,
    };
    if (hasIsActive) {
      values.is_active = isActive;
    }
    const updateResult = await dbQuery({
      table: "booking_types",
      action: "update",
      values,
      filters: [{ column: "id", operator: "eq", value: id }],
      selectAfterWrite: true,
      maybeSingle: true,
      columns: "id,name,description,is_active,created_at",
    });
    const updated = assertDbSuccess(updateResult, "更新预约类型失败");
    if (!updated) {
      throw new Error("目标预约类型不存在或更新失败");
    }
    return updated;
  }

  const insertResult = await dbQuery({
    table: "booking_types",
    action: "insert",
    values: {
      name,
      description: description || null,
      is_active: isActive,
    },
    selectAfterWrite: true,
    maybeSingle: true,
    columns: "id,name,description,is_active,created_at",
  });
  return assertDbSuccess(insertResult, "新增预约类型失败");
}

async function toggleAdminBookingType(typeId, isActive) {
  await requireAdminSession();
  const id = Number(typeId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("预约类型 ID 不合法");
  }

  const result = await dbQuery({
    table: "booking_types",
    action: "update",
    values: {
      is_active: Boolean(isActive),
    },
    filters: [{ column: "id", operator: "eq", value: id }],
    selectAfterWrite: true,
    maybeSingle: true,
    columns: "id,is_active",
  });
  const updated = assertDbSuccess(result, "更新预约类型状态失败");
  if (!updated) {
    throw new Error("目标预约类型不存在或更新失败");
  }
  return updated;
}

async function deleteAdminBookingType(typeId) {
  await requireAdminSession();
  const id = Number(typeId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("预约类型 ID 不合法");
  }

  const result = await dbQuery({
    table: "booking_types",
    action: "delete",
    filters: [{ column: "id", operator: "eq", value: id }],
    selectAfterWrite: true,
    maybeSingle: true,
    columns: "id",
  });
  const deleted = assertDbSuccess(result, "删除预约类型失败");
  if (!deleted) {
    throw new Error("目标预约类型不存在或删除失败");
  }
  return deleted;
}

async function listAdminRecentBookings(limit) {
  await requireAdminSession();
  const pageLimit = Math.max(1, Math.min(1000, Number(limit || 200)));

  let bookingResult = await dbQuery({
    table: "bookings",
    action: "select",
    columns:
      "id,user_id,type_id,booking_date,location,city_name,phone,wechat,notes,status,latitude,longitude,created_at",
    orders: [{ column: "created_at", ascending: false }],
    limit: pageLimit,
  });
  if (
    bookingResult &&
    bookingResult.error &&
    (isColumnMissingError(bookingResult.error, "latitude") ||
      isColumnMissingError(bookingResult.error, "longitude"))
  ) {
    bookingResult = await dbQuery({
      table: "bookings",
      action: "select",
      columns: "id,user_id,type_id,booking_date,location,city_name,phone,wechat,notes,status,created_at",
      orders: [{ column: "created_at", ascending: false }],
      limit: pageLimit,
    });
  }
  const bookings = assertDbSuccess(bookingResult, "获取预约列表失败");
  const bookingRows = Array.isArray(bookings) ? bookings : [];

  const typeRows = await listAdminBookingTypes();
  const typeMap = {};
  typeRows.forEach((item) => {
    const key = String(item && item.id ? item.id : "");
    if (!key) return;
    typeMap[key] = String((item && item.name) || "");
  });

  const userIds = Array.from(
    new Set(
      bookingRows
        .map((item) => String((item && item.user_id) || "").trim())
        .filter(Boolean)
    )
  );

  let userMap = {};
  if (userIds.length > 0) {
    const profileResult = await dbQuery({
      table: "profiles",
      action: "select",
      columns: "id,name,phone,email",
      filters: [{ column: "id", operator: "in", value: userIds }],
      limit: userIds.length,
    });
    const profiles = assertDbSuccess(profileResult, "获取预约用户信息失败");
    const rows = Array.isArray(profiles) ? profiles : [];
    userMap = rows.reduce((acc, row) => {
      const key = String((row && row.id) || "").trim();
      if (!key) return acc;
      acc[key] = {
        name: String((row && row.name) || "").trim(),
        phone: String((row && row.phone) || "").trim(),
        email: String((row && row.email) || "").trim(),
      };
      return acc;
    }, {});
  }

  return bookingRows.map((row) => {
    const typeId = String((row && row.type_id) || "");
    const userId = String((row && row.user_id) || "").trim();
    const profile = userMap[userId] || null;

    return Object.assign({}, row, {
      type_name: typeMap[typeId] || "",
      user_name: profile ? profile.name || profile.phone || userId : userId,
      user_phone: profile ? profile.phone || "" : "",
      user_email: profile ? profile.email || "" : "",
    });
  });
}

async function updateAdminBookingStatus(bookingId, nextStatus, expectedStatuses) {
  await requireAdminSession();

  const id = String(bookingId || "").trim();
  if (!id) {
    throw new Error("预约 ID 不能为空");
  }

  const status = String(nextStatus || "").trim();
  if (!ADMIN_BOOKING_STATUS.has(status)) {
    throw new Error("预约状态不合法");
  }

  const expected = Array.isArray(expectedStatuses)
    ? expectedStatuses
        .map((item) => String(item || "").trim())
        .filter((item) => ADMIN_BOOKING_STATUS.has(item))
    : [];
  const updateFilters = [{ column: "id", operator: "eq", value: id }];
  if (expected.length > 0) {
    updateFilters.push({ column: "status", operator: "in", value: expected });
  }

  const result = await dbQuery({
    table: "bookings",
    action: "update",
    values: { status },
    filters: updateFilters,
    selectAfterWrite: true,
    maybeSingle: true,
    columns: "id,status,booking_date,updated_at",
  });

  const updated = assertDbSuccess(result, "更新预约状态失败");
  if (updated) {
    return updated;
  }

  const snapshotResult = await dbQuery({
    table: "bookings",
    action: "select",
    columns: "id,status",
    filters: [{ column: "id", operator: "eq", value: id }],
    maybeSingle: true,
  });
  const snapshot = assertDbSuccess(snapshotResult, "读取预约状态失败");
  if (!snapshot) {
    throw new Error("预约不存在或更新失败");
  }

  const currentStatus = String((snapshot && snapshot.status) || "").trim();
  if (currentStatus === status) {
    // 并发场景下可能已由其他管理端更新为目标状态，视为成功。
    return snapshot;
  }
  if (expected.length > 0 && !expected.includes(currentStatus)) {
    throw new Error(`预约状态已变化（当前：${currentStatus || "未知"}），请刷新后重试`);
  }
  throw new Error("预约状态更新失败，请稍后重试");
}

async function deleteAdminBookings(bookingIds) {
  await requireAdminSession();

  const source = Array.isArray(bookingIds) ? bookingIds : [bookingIds];
  const seen = new Set();
  const ids = source
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

  if (!ids.length) {
    throw new Error("请选择要删除的预约");
  }

  const snapshotResult = await dbQuery({
    table: "bookings",
    action: "select",
    columns: "id,status",
    filters: [{ column: "id", operator: "in", value: ids }],
    limit: ids.length,
  });
  const snapshotRows = assertDbSuccess(snapshotResult, "获取预约快照失败");
  const rows = Array.isArray(snapshotRows) ? snapshotRows : [];

  const missingCount = Math.max(0, ids.length - rows.length);
  const deletableRows = rows.filter((row) => {
    const status = String((row && row.status) || "").trim();
    return status === "finished" || status === "cancelled";
  });
  const blockedCount = rows.length - deletableRows.length;

  if (blockedCount > 0) {
    const missingText = missingCount > 0 ? `、${missingCount} 个预约已不存在` : "";
    throw new Error(`有 ${blockedCount} 个预约状态已变化${missingText}，无法删除（仅已完成/已取消可删）`);
  }

  const deletableIds = deletableRows.map((row) => String((row && row.id) || "").trim()).filter(Boolean);
  if (!deletableIds.length) {
    return {
      deletedCount: 0,
      failedCount: 0,
      missingCount,
    };
  }

  const deleteResult = await dbQuery({
    table: "bookings",
    action: "delete",
    filters: [
      { column: "id", operator: "in", value: deletableIds },
      { column: "status", operator: "in", value: ["finished", "cancelled"] },
    ],
    selectAfterWrite: true,
    columns: "id,status",
  });
  assertDbSuccess(deleteResult, "删除预约失败");

  const verifyResult = await dbQuery({
    table: "bookings",
    action: "select",
    columns: "id",
    filters: [{ column: "id", operator: "in", value: deletableIds }],
    limit: deletableIds.length,
  });
  const remainingRows = assertDbSuccess(verifyResult, "校验预约删除结果失败");
  const remaining = Array.isArray(remainingRows) ? remainingRows : [];
  const failedCount = remaining.length;
  const deletedCount = Math.max(0, deletableIds.length - failedCount);

  if (deletedCount <= 0) {
    throw new Error("批量删除失败，请稍后重试");
  }

  return {
    deletedCount,
    failedCount,
    missingCount,
  };
}

async function createAdminPose(input) {
  await requireAdminSession();

  const payload = input && typeof input === "object" ? input : {};
  const filePath = String(payload.filePath || "").trim();
  const fileName = String(payload.fileName || "").trim();
  if (!filePath) {
    throw new Error("请选择要上传的摆姿图片");
  }

  const tags = normalizePoseTags(payload.tags);
  const uploadResult = await uploadAdminAsset(filePath, fileName, "poses", "pose");
  try {
    const insertResult = await dbQuery({
      table: "poses",
      action: "insert",
      values: {
        image_url: uploadResult.url,
        storage_path: uploadResult.path,
        tags,
      },
      selectAfterWrite: true,
      maybeSingle: true,
      columns: "id,image_url,storage_path,tags,view_count,created_at",
    });

    return assertDbSuccess(insertResult, "新增摆姿失败");
  } catch (error) {
    const cleanup = await bestEffortDeleteStorageTargets([
      uploadResult.path,
      uploadResult.url,
      uploadResult.fileId,
    ]);
    const message = toErrorMessage(error, "新增摆姿失败");
    if (cleanup.storageCleanupFailed) {
      throw new Error(`${message}；上传文件回滚失败：${cleanup.warning || "请稍后手动清理"}`);
    }
    throw new Error(message);
  }
}

async function listAdminPoses(limit) {
  await requireAdminSession();
  const pageLimit = Math.max(1, Math.min(2000, Number(limit || 500)));
  const result = await dbQuery({
    table: "poses",
    action: "select",
    columns: "id,image_url,tags,view_count,created_at,storage_path",
    orders: [{ column: "created_at", ascending: false }],
    limit: pageLimit,
  });
  const data = assertDbSuccess(result, "获取摆姿列表失败");
  return Array.isArray(data) ? data : [];
}

async function listAdminPoseTags(limit) {
  await requireAdminSession();
  const pageLimit = Math.max(1, Math.min(500, Number(limit || 200)));
  try {
    const result = await dbQuery({
      table: "pose_tags",
      action: "select",
      columns: "id,name,usage_count,sort_order,created_at",
      orders: [
        { column: "sort_order", ascending: true },
        { column: "created_at", ascending: true },
        { column: "id", ascending: true },
      ],
      limit: pageLimit,
    });
    const data = assertDbSuccess(result, "获取摆姿标签失败");
    return Array.isArray(data) ? data : [];
  } catch (error) {
    if (!isColumnMissingError(error, "sort_order")) {
      throw error;
    }

    // 老库兼容：sort_order 字段尚未迁移时，回退旧排序逻辑，避免页面不可用。
    const fallbackResult = await dbQuery({
      table: "pose_tags",
      action: "select",
      columns: "id,name,usage_count,created_at",
      orders: [
        { column: "usage_count", ascending: false },
        { column: "name", ascending: true },
      ],
      limit: pageLimit,
    });
    const fallbackRows = assertDbSuccess(fallbackResult, "获取摆姿标签失败");
    const rows = Array.isArray(fallbackRows) ? fallbackRows : [];
    return rows.map((row, index) =>
      Object.assign({}, row, {
        sort_order: (index + 1) * 10,
      })
    );
  }
}

async function moveAdminPoseTag(tagId, directionInput) {
  await requireAdminSession();
  const id = Number(tagId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("标签 ID 不合法");
  }

  const direction = String(directionInput || "").trim().toLowerCase();
  if (direction !== "up" && direction !== "down") {
    throw new Error("排序方向不合法");
  }

  const migrationHint = "数据库缺少 sort_order 字段，请先执行 SQL 迁移：photo/sql/migrations/04_pose_tag_sort_order.sql";
  try {
    const listResult = await dbQuery({
      table: "pose_tags",
      action: "select",
      columns: "id,name,sort_order,created_at",
      orders: [
        { column: "sort_order", ascending: true },
        { column: "created_at", ascending: true },
        { column: "id", ascending: true },
      ],
      limit: 500,
    });
    const listRows = assertDbSuccess(listResult, "读取标签排序失败");
    const list = (Array.isArray(listRows) ? listRows : [])
      .map((row, index) => {
        const rowId = Number((row && row.id) || 0);
        const orderNum = Number(row && row.sort_order);
        return {
          id: rowId,
          sort_order: Number.isFinite(orderNum) && orderNum > 0 ? Math.round(orderNum) : (index + 1) * 10,
        };
      })
      .filter((row) => Number.isInteger(row.id) && row.id > 0);

    const currentIndex = list.findIndex((item) => item.id === id);
    if (currentIndex < 0) {
      throw new Error("标签不存在或已删除");
    }

    const nextIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
    if (nextIndex < 0 || nextIndex >= list.length) {
      return {
        moved: false,
        boundary: true,
        updatedCount: 0,
      };
    }

    const reordered = list.slice();
    const current = reordered[currentIndex];
    reordered.splice(currentIndex, 1);
    reordered.splice(nextIndex, 0, current);

    const currentMap = new Map();
    list.forEach((item) => currentMap.set(item.id, Number(item.sort_order || 0)));
    const desiredRows = reordered.map((item, index) => ({
      id: item.id,
      sort_order: (index + 1) * 10,
    }));
    const changedRows = desiredRows.filter((item) => Number(currentMap.get(item.id) || 0) !== item.sort_order);

    for (let i = 0; i < changedRows.length; i += 1) {
      const row = changedRows[i];
      const updateResult = await dbQuery({
        table: "pose_tags",
        action: "update",
        values: {
          sort_order: row.sort_order,
        },
        filters: [{ column: "id", operator: "eq", value: row.id }],
      });
      assertDbSuccess(updateResult, "更新标签排序失败");
    }

    return {
      moved: changedRows.length > 0,
      boundary: false,
      updatedCount: changedRows.length,
    };
  } catch (error) {
    if (isColumnMissingError(error, "sort_order")) {
      throw new Error(migrationHint);
    }
    throw error;
  }
}

async function createAdminPoseTags(input) {
  await requireAdminSession();
  const names = parseUniqueTagNames(input);
  if (names.length === 0) {
    throw new Error("请输入标签名称");
  }

  const existingResult = await dbQuery({
    table: "pose_tags",
    action: "select",
    columns: "id,name",
    filters: [{ column: "name", operator: "in", value: names }],
    limit: names.length,
  });
  const existingRows = assertDbSuccess(existingResult, "检查标签是否存在失败");
  const existingSet = new Set(
    (Array.isArray(existingRows) ? existingRows : [])
      .map((row) => normalizeTagName(row && row.name))
      .filter(Boolean)
      .map((name) => name.toLowerCase())
  );

  const namesToInsert = names.filter((name) => !existingSet.has(name.toLowerCase()));
  let insertedCount = 0;
  let skippedCount = names.length - namesToInsert.length;

  for (let i = 0; i < namesToInsert.length; i += 1) {
    const name = namesToInsert[i];
    try {
      const insertResult = await dbQuery({
        table: "pose_tags",
        action: "insert",
        values: {
          name,
        },
      });
      assertDbSuccess(insertResult, "新增标签失败");
      insertedCount += 1;
    } catch (error) {
      if (isDuplicateEntryError(error)) {
        skippedCount += 1;
        continue;
      }
      throw error;
    }
  }

  return {
    insertedCount,
    skippedCount,
    totalCount: names.length,
  };
}

async function updateAdminPoseTag(tagId, nextNameInput) {
  await requireAdminSession();
  const id = Number(tagId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("标签 ID 不合法");
  }

  const nextName = normalizeTagName(nextNameInput);
  if (!nextName) {
    throw new Error("标签名称不能为空");
  }

  const duplicateResult = await dbQuery({
    table: "pose_tags",
    action: "select",
    columns: "id",
    filters: [{ column: "name", operator: "eq", value: nextName }],
    limit: 1,
  });
  const duplicateRows = assertDbSuccess(duplicateResult, "检查标签名称失败");
  const hasOther = (Array.isArray(duplicateRows) ? duplicateRows : []).some((row) => {
    const rowId = Number((row && row.id) || 0);
    return Number.isInteger(rowId) && rowId !== id;
  });
  if (hasOther) {
    throw new Error("标签名称已存在");
  }

  const updateResult = await dbQuery({
    table: "pose_tags",
    action: "update",
    values: {
      name: nextName,
    },
    filters: [{ column: "id", operator: "eq", value: id }],
    selectAfterWrite: true,
    maybeSingle: true,
    columns: "id,name,usage_count,created_at",
  });
  const updated = assertDbSuccess(updateResult, "更新标签失败");
  if (!updated) {
    throw new Error("标签不存在或更新失败");
  }
  return updated;
}

async function deleteAdminPoseTag(tagId) {
  await requireAdminSession();
  const id = Number(tagId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("标签 ID 不合法");
  }

  const deleteResult = await dbQuery({
    table: "pose_tags",
    action: "delete",
    filters: [{ column: "id", operator: "eq", value: id }],
    selectAfterWrite: true,
    maybeSingle: true,
    columns: "id,name",
  });
  const deleted = assertDbSuccess(deleteResult, "删除标签失败");
  if (!deleted) {
    throw new Error("标签不存在或删除失败");
  }
  return deleted;
}

async function deleteAdminPoseTags(tagIds) {
  await requireAdminSession();
  const ids = Array.from(
    new Set(
      (Array.isArray(tagIds) ? tagIds : [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    )
  );
  if (ids.length === 0) {
    throw new Error("请先选择要删除的标签");
  }

  const snapshotResult = await dbQuery({
    table: "pose_tags",
    action: "select",
    columns: "id,name",
    filters: [{ column: "id", operator: "in", value: ids }],
    limit: ids.length,
  });
  const snapshotRows = assertDbSuccess(snapshotResult, "读取标签快照失败");
  const rows = Array.isArray(snapshotRows) ? snapshotRows : [];
  const targetIds = rows
    .map((row) => Number((row && row.id) || 0))
    .filter((id) => Number.isInteger(id) && id > 0);

  const missingCount = Math.max(0, ids.length - targetIds.length);
  if (targetIds.length === 0) {
    return {
      deletedCount: 0,
      failedCount: 0,
      missingCount,
      remainingIds: [],
    };
  }

  const deleteResult = await dbQuery({
    table: "pose_tags",
    action: "delete",
    filters: [{ column: "id", operator: "in", value: targetIds }],
  });
  assertDbSuccess(deleteResult, "批量删除标签失败");

  const verifyResult = await dbQuery({
    table: "pose_tags",
    action: "select",
    columns: "id",
    filters: [{ column: "id", operator: "in", value: targetIds }],
    limit: targetIds.length,
  });
  const verifyRows = assertDbSuccess(verifyResult, "校验标签删除结果失败");
  const remainingIds = (Array.isArray(verifyRows) ? verifyRows : [])
    .map((row) => Number((row && row.id) || 0))
    .filter((id) => Number.isInteger(id) && id > 0);

  const failedCount = remainingIds.length;
  const deletedCount = Math.max(0, targetIds.length - failedCount);
  return {
    deletedCount,
    failedCount,
    missingCount,
    remainingIds,
  };
}

async function updateAdminPoseTags(poseId, tagsInput) {
  await requireAdminSession();
  const id = Number(poseId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("摆姿 ID 不合法");
  }

  const tags = normalizePoseTags(tagsInput);
  const updateResult = await dbQuery({
    table: "poses",
    action: "update",
    values: {
      tags,
    },
    filters: [{ column: "id", operator: "eq", value: id }],
    selectAfterWrite: true,
    maybeSingle: true,
    columns: "id,tags",
  });
  const updated = assertDbSuccess(updateResult, "更新摆姿标签失败");
  if (!updated) {
    throw new Error("摆姿不存在或更新失败");
  }
  return updated;
}

async function createAdminRelease(input) {
  await requireAdminSession();

  const payload = input && typeof input === "object" ? input : {};
  const version = String(payload.version || "").trim();
  const platform = String(payload.platform || "").trim();
  const updateLog = String(payload.update_log || payload.updateLog || "").trim();
  const forceUpdate = Boolean(payload.force_update || payload.forceUpdate);
  const filePath = String(payload.filePath || "").trim();
  const fileName = String(payload.fileName || "").trim();

  if (!version) {
    throw new Error("版本号不能为空");
  }
  if (!platform || !ADMIN_RELEASE_PLATFORMS.has(platform)) {
    throw new Error("平台参数不合法");
  }
  if (!filePath) {
    throw new Error("请选择要上传的安装包文件");
  }
  if (fileName && !isAdminReleaseFileNameAllowed(fileName)) {
    throw new Error("安装包格式不支持，请选择 apk/ipa/exe/dmg/zip/deb/rpm/appimage/tar.gz 文件");
  }

  const uploadResult = await uploadAdminAsset(filePath, fileName, "releases", "release");
  try {
    const insertResult = await dbQuery({
      table: "app_releases",
      action: "insert",
      values: {
        version,
        platform,
        download_url: uploadResult.url,
        storage_provider: "cloudbase",
        storage_file_id: uploadResult.fileId || null,
        update_log: updateLog || null,
        force_update: forceUpdate,
      },
      selectAfterWrite: true,
      maybeSingle: true,
      columns: "id,version,platform,download_url,force_update,update_log,created_at,storage_file_id",
    });

    return assertDbSuccess(insertResult, "新增版本发布失败");
  } catch (error) {
    const cleanup = await bestEffortDeleteStorageTargets([
      uploadResult.path,
      uploadResult.url,
      uploadResult.fileId,
    ]);
    const message = toErrorMessage(error, "新增版本发布失败");
    if (cleanup.storageCleanupFailed) {
      throw new Error(`${message}；上传文件回滚失败：${cleanup.warning || "请稍后手动清理"}`);
    }
    throw new Error(message);
  }
}

async function listAdminAlbums(limit) {
  await requireAdminSession();
  const pageLimit = Math.max(1, Math.min(2000, Number(limit || 500)));
  let result = await dbQuery({
    table: "albums",
    action: "select",
    columns:
      "id,title,access_key,cover_url,created_at,expires_at,enable_tipping,enable_welcome_letter,recipient_name,welcome_letter,donation_qr_code_url",
    orders: [{ column: "created_at", ascending: false }],
    limit: pageLimit,
  });
  if (
    result &&
    result.error &&
    (isColumnMissingError(result.error, "recipient_name") ||
      isColumnMissingError(result.error, "welcome_letter") ||
      isColumnMissingError(result.error, "donation_qr_code_url"))
  ) {
    result = await dbQuery({
      table: "albums",
      action: "select",
      columns: "id,title,access_key,cover_url,created_at,expires_at,enable_tipping,enable_welcome_letter",
      orders: [{ column: "created_at", ascending: false }],
      limit: pageLimit,
    });
  }
  const dataRaw = assertDbSuccess(result, "获取相册列表失败");
  const data = (Array.isArray(dataRaw) ? dataRaw : []).map((row) =>
    Object.assign(
      {
        recipient_name: "",
        welcome_letter: "",
        donation_qr_code_url: null,
      },
      row || {}
    )
  );
  return Array.isArray(data) ? data : [];
}

async function ensureUniqueAlbumAccessKey(accessKey, excludeAlbumId) {
  const key = normalizeAlbumAccessKey(accessKey);
  if (!key || key.length !== 8) {
    throw new Error("访问密钥必须是 8 位大写字母或数字");
  }

  const filters = [{ column: "access_key", operator: "eq", value: key }];
  const excludeId = String(excludeAlbumId || "").trim();
  if (excludeId) {
    filters.push({ column: "id", operator: "neq", value: excludeId });
  }

  const result = await dbQuery({
    table: "albums",
    action: "select",
    columns: "id,access_key",
    filters,
    limit: 1,
  });
  const rows = assertDbSuccess(result, "检查访问密钥失败");
  const first = Array.isArray(rows) && rows.length ? rows[0] : null;
  if (first && String(first.id || "").trim()) {
    throw new Error("该访问密钥已被其他空间使用");
  }
  return key;
}

async function createAdminAlbum(payload) {
  await requireAdminSession();
  const input = payload && typeof payload === "object" ? payload : {};

  const title = String(input.title || "").trim() || "未命名空间";
  const accessKeyInput = normalizeAlbumAccessKey(input.access_key || "");
  const accessKey = await ensureUniqueAlbumAccessKey(
    accessKeyInput || generateRandomAlbumAccessKey(),
    ""
  );
  const recipientName = String(input.recipient_name || "").trim() || "拾光者";
  const welcomeLetter = String(input.welcome_letter || "").trim();
  const enableTipping = Boolean(input.enable_tipping);
  const enableWelcomeLetter =
    input.enable_welcome_letter === undefined ? true : Boolean(input.enable_welcome_letter);
  const expiresAt = String(input.expires_at || "").trim();
  const coverUrl = String(input.cover_url || "").trim();
  const donationQrUrl = String(input.donation_qr_code_url || "").trim();

  const values = {
    title,
    access_key: accessKey,
    recipient_name: recipientName,
    welcome_letter: welcomeLetter,
    enable_tipping: enableTipping,
    enable_welcome_letter: enableWelcomeLetter,
    cover_url: coverUrl || null,
    donation_qr_code_url: donationQrUrl || null,
  };
  if (expiresAt) {
    values.expires_at = expiresAt;
  }

  const insertResult = await dbQuery({
    table: "albums",
    action: "insert",
    values,
    selectAfterWrite: true,
    maybeSingle: true,
    columns:
      "id,title,access_key,cover_url,created_at,expires_at,enable_tipping,enable_welcome_letter,recipient_name,welcome_letter,donation_qr_code_url",
  });
  const created = assertDbSuccess(insertResult, "创建专属空间失败");
  if (!created || !String(created.id || "").trim()) {
    throw new Error("创建专属空间失败，请稍后重试");
  }
  return created;
}

async function updateAdminAlbumFields(albumId, payload) {
  await requireAdminSession();
  const id = String(albumId || "").trim();
  if (!id) {
    throw new Error("空间 ID 不能为空");
  }

  const input = payload && typeof payload === "object" ? payload : {};
  const values = {};
  if (Object.prototype.hasOwnProperty.call(input, "title")) {
    const text = String(input.title || "").trim();
    values.title = text || "未命名空间";
  }
  if (Object.prototype.hasOwnProperty.call(input, "recipient_name")) {
    const text = String(input.recipient_name || "").trim();
    values.recipient_name = text || "拾光者";
  }
  if (Object.prototype.hasOwnProperty.call(input, "welcome_letter")) {
    values.welcome_letter = String(input.welcome_letter || "").trim();
  }
  if (Object.prototype.hasOwnProperty.call(input, "enable_tipping")) {
    values.enable_tipping = Boolean(input.enable_tipping);
  }
  if (Object.prototype.hasOwnProperty.call(input, "enable_welcome_letter")) {
    values.enable_welcome_letter = Boolean(input.enable_welcome_letter);
  }
  if (Object.prototype.hasOwnProperty.call(input, "expires_at")) {
    const text = String(input.expires_at || "").trim();
    values.expires_at = text || null;
  }
  if (Object.prototype.hasOwnProperty.call(input, "cover_url")) {
    const text = String(input.cover_url || "").trim();
    values.cover_url = text || null;
  }
  if (Object.prototype.hasOwnProperty.call(input, "donation_qr_code_url")) {
    const text = String(input.donation_qr_code_url || "").trim();
    values.donation_qr_code_url = text || null;
  }

  if (!Object.keys(values).length) {
    throw new Error("没有可更新的字段");
  }

  const result = await dbQuery({
    table: "albums",
    action: "update",
    values,
    filters: [{ column: "id", operator: "eq", value: id }],
    selectAfterWrite: true,
    maybeSingle: true,
    columns:
      "id,title,access_key,cover_url,created_at,expires_at,enable_tipping,enable_welcome_letter,recipient_name,welcome_letter,donation_qr_code_url",
  });
  const updated = assertDbSuccess(result, "更新专属空间失败");
  if (!updated) {
    throw new Error("空间不存在或更新失败");
  }
  return updated;
}

async function updateAdminAlbumAccessKey(albumId, nextAccessKey) {
  await requireAdminSession();
  const id = String(albumId || "").trim();
  if (!id) {
    throw new Error("空间 ID 不能为空");
  }

  const accessKey = await ensureUniqueAlbumAccessKey(nextAccessKey, id);
  const result = await dbQuery({
    table: "albums",
    action: "update",
    values: {
      access_key: accessKey,
    },
    filters: [{ column: "id", operator: "eq", value: id }],
    selectAfterWrite: true,
    maybeSingle: true,
    columns: "id,access_key",
  });
  const updated = assertDbSuccess(result, "更新访问密钥失败");
  if (!updated) {
    throw new Error("空间不存在或更新失败");
  }
  return updated;
}

async function uploadAdminAlbumCover(albumId, filePath, fileName) {
  await requireAdminSession();
  const id = String(albumId || "").trim();
  if (!id) {
    throw new Error("空间 ID 不能为空");
  }
  const path = String(filePath || "").trim();
  if (!path) {
    throw new Error("请先选择封面图片");
  }

  const snapshotResult = await dbQuery({
    table: "albums",
    action: "select",
    columns: "id,cover_url",
    filters: [{ column: "id", operator: "eq", value: id }],
    maybeSingle: true,
  });
  const snapshot = assertDbSuccess(snapshotResult, "获取空间信息失败");
  if (!snapshot || !String(snapshot.id || "").trim()) {
    throw new Error("空间不存在或已删除");
  }

  const upload = await uploadAdminAsset(path, fileName, "albums", "album_cover");
  try {
    const updated = await updateAdminAlbumFields(id, { cover_url: upload.url });
    const cleanup = await bestEffortDeleteStorageTargets(
      toUniqueNonEmptyStrings([snapshot.cover_url]).filter((item) => item !== upload.url)
    );
    return {
      album: updated,
      storageCleanupFailed: cleanup.storageCleanupFailed,
      warning: cleanup.warning,
    };
  } catch (error) {
    const cleanup = await bestEffortDeleteStorageTargets([upload.path, upload.url, upload.fileId]);
    const message = toErrorMessage(error, "更新封面失败");
    if (cleanup.storageCleanupFailed) {
      throw new Error(`${message}；上传文件回滚失败：${cleanup.warning || "请稍后手动清理"}`);
    }
    throw new Error(message);
  }
}

async function uploadAdminAlbumDonationQr(albumId, filePath, fileName) {
  await requireAdminSession();
  const id = String(albumId || "").trim();
  if (!id) {
    throw new Error("空间 ID 不能为空");
  }
  const path = String(filePath || "").trim();
  if (!path) {
    throw new Error("请先选择赞赏码图片");
  }

  const snapshotResult = await dbQuery({
    table: "albums",
    action: "select",
    columns: "id,donation_qr_code_url",
    filters: [{ column: "id", operator: "eq", value: id }],
    maybeSingle: true,
  });
  const snapshot = assertDbSuccess(snapshotResult, "获取空间信息失败");
  if (!snapshot || !String(snapshot.id || "").trim()) {
    throw new Error("空间不存在或已删除");
  }

  const upload = await uploadAdminAsset(path, fileName, "albums", "donation_qr");
  try {
    const updated = await updateAdminAlbumFields(id, { donation_qr_code_url: upload.url });
    const cleanup = await bestEffortDeleteStorageTargets(
      toUniqueNonEmptyStrings([snapshot.donation_qr_code_url]).filter((item) => item !== upload.url)
    );
    return {
      album: updated,
      storageCleanupFailed: cleanup.storageCleanupFailed,
      warning: cleanup.warning,
    };
  } catch (error) {
    const cleanup = await bestEffortDeleteStorageTargets([upload.path, upload.url, upload.fileId]);
    const message = toErrorMessage(error, "更新赞赏码失败");
    if (cleanup.storageCleanupFailed) {
      throw new Error(`${message}；上传文件回滚失败：${cleanup.warning || "请稍后手动清理"}`);
    }
    throw new Error(message);
  }
}

async function deleteAdminAlbum(albumId) {
  await requireAdminSession();
  const id = String(albumId || "").trim();
  if (!id) {
    throw new Error("相册 ID 不能为空");
  }
  const payload = await requestJson(`/api/admin/albums/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return assertAdminMutationPayload(payload, "删除相册失败");
}

async function listAdminReleases(limit) {
  await requireAdminSession();
  const pageLimit = Math.max(1, Math.min(1000, Number(limit || 200)));
  const result = await dbQuery({
    table: "app_releases",
    action: "select",
    columns: "id,version,platform,download_url,force_update,update_log,created_at",
    orders: [{ column: "created_at", ascending: false }],
    limit: pageLimit,
  });
  const data = assertDbSuccess(result, "获取版本列表失败");
  return Array.isArray(data) ? data : [];
}

async function deleteAdminRelease(releaseId) {
  await requireAdminSession();
  const id = Number(releaseId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error("版本 ID 不合法");
  }
  const payload = await requestJson(`/api/admin/releases/${id}`, {
    method: "DELETE",
  });
  return assertAdminMutationPayload(payload, "删除版本失败");
}

async function listAdminGalleryPhotos(limit) {
  await requireAdminSession();
  const pageLimit = Math.max(1, Math.min(2000, Number(limit || 500)));
  let result = await dbQuery({
    table: "album_photos",
    action: "select",
    columns:
      "id,album_id,folder_id,url,thumbnail_url,preview_url,original_url,is_public,view_count,like_count,shot_date,created_at,width,height",
    orders: [{ column: "shot_date", ascending: false }, { column: "created_at", ascending: false }],
    limit: pageLimit,
  });
  if (result && result.error && isColumnMissingError(result.error, "shot_date")) {
    result = await dbQuery({
      table: "album_photos",
      action: "select",
      columns:
        "id,album_id,folder_id,url,thumbnail_url,preview_url,original_url,is_public,view_count,like_count,created_at,width,height",
      orders: [{ column: "created_at", ascending: false }],
      limit: pageLimit,
    });
  }
  const data = assertDbSuccess(result, "获取照片墙列表失败");
  const rows = Array.isArray(data) ? data : [];

  // 管理端“照片墙管理”仅展示系统照片墙内容或已定格到照片墙的照片，
  // 不展示专属返图空间中未定格（is_public=false）的私有照片。
  return rows.filter((row) => {
    const albumId = String((row && row.album_id) || "").trim();
    const isPublic = normalizeDbBoolean(row && row.is_public, false);
    return albumId === ADMIN_PHOTO_WALL_ALBUM_ID || isPublic;
  });
}

async function createAdminGalleryPhoto(input) {
  await requireAdminSession();

  const payload = input && typeof input === "object" ? input : {};
  const filePath = String(payload.filePath || "").trim();
  const fileName = String(payload.fileName || "").trim();
  const width = Number(payload.width || 0);
  const height = Number(payload.height || 0);
  if (!filePath) {
    throw new Error("请选择要上传的照片");
  }

  const uploadResult = await uploadAdminAsset(filePath, fileName, "gallery", "gallery");
  try {
    const values = {
      album_id: ADMIN_PHOTO_WALL_ALBUM_ID,
      url: uploadResult.url,
      thumbnail_url: uploadResult.url,
      preview_url: uploadResult.url,
      original_url: uploadResult.url,
      is_public: true,
      shot_date: getTodayDateUTC8(),
    };
    if (Number.isFinite(width) && width > 0) {
      values.width = Math.round(width);
    }
    if (Number.isFinite(height) && height > 0) {
      values.height = Math.round(height);
    }

    const insertResult = await dbQuery({
      table: "album_photos",
      action: "insert",
      values,
      selectAfterWrite: true,
      maybeSingle: true,
      columns:
        "id,album_id,url,thumbnail_url,preview_url,original_url,is_public,view_count,like_count,created_at,width,height",
    });
    return assertDbSuccess(insertResult, "上传照片失败");
  } catch (error) {
    const cleanup = await bestEffortDeleteStorageTargets([
      uploadResult.path,
      uploadResult.url,
      uploadResult.fileId,
    ]);
    let message = toErrorMessage(error, "上传照片失败");
    const normalized = String(message || "").toLowerCase();
    if (
      normalized.includes("fk_album_photos_album") ||
      (normalized.includes("foreign key") && normalized.includes("album"))
    ) {
      message = "系统照片墙相册不存在，请先初始化系统数据";
    }
    if (cleanup.storageCleanupFailed) {
      throw new Error(`${message}；上传文件回滚失败：${cleanup.warning || "请稍后手动清理"}`);
    }
    throw new Error(message);
  }
}

async function deleteAdminPose(poseId, assetTargets) {
  await requireAdminSession();
  const id = Number(poseId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error("摆姿 ID 不合法");
  }

  const result = await dbQuery({
    table: "poses",
    action: "delete",
    filters: [{ column: "id", operator: "eq", value: id }],
    selectAfterWrite: true,
    maybeSingle: true,
    columns: "id,image_url,storage_path",
  });
  const deletedRow = assertDbSuccess(result, "删除摆姿失败");
  if (!deletedRow) {
    throw new Error("摆姿不存在或删除失败");
  }

  const cleanup = await bestEffortDeleteStorageTargets(
    toUniqueNonEmptyStrings(
      [deletedRow.image_url, deletedRow.storage_path].concat(Array.isArray(assetTargets) ? assetTargets : [])
    )
  );

  return {
    deleted: true,
    storageCleanupFailed: cleanup.storageCleanupFailed,
    warning: cleanup.warning,
  };
}

async function setAdminGalleryPhotoPublic(photoId, isPublic) {
  await requireAdminSession();
  const id = String(photoId || "").trim();
  if (!id) {
    throw new Error("照片 ID 不能为空");
  }

  const result = await dbQuery({
    table: "album_photos",
    action: "update",
    values: {
      is_public: Boolean(isPublic),
    },
    filters: [{ column: "id", operator: "eq", value: id }],
    selectAfterWrite: true,
    maybeSingle: true,
    columns: "id,is_public",
  });
  const updated = assertDbSuccess(result, "更新照片公开状态失败");
  if (!updated) {
    throw new Error("照片不存在或更新失败");
  }
  return updated;
}

async function deleteAdminGalleryPhoto(photoId, assetTargets) {
  await requireAdminSession();
  const id = String(photoId || "").trim();
  if (!id) {
    throw new Error("照片 ID 不能为空");
  }

  const snapshotResult = await dbQuery({
    table: "album_photos",
    action: "select",
    columns: "id,album_id,is_public,url,thumbnail_url,preview_url,original_url",
    filters: [{ column: "id", operator: "eq", value: id }],
    maybeSingle: true,
  });
  const snapshot = assertDbSuccess(snapshotResult, "读取照片信息失败");
  if (!snapshot) {
    throw new Error("照片不存在或删除失败");
  }

  const albumId = String(snapshot.album_id || "").trim();
  if (albumId && albumId !== ADMIN_PHOTO_WALL_ALBUM_ID) {
    const updateResult = await dbQuery({
      table: "album_photos",
      action: "update",
      values: {
        is_public: false,
      },
      filters: [{ column: "id", operator: "eq", value: id }],
      selectAfterWrite: true,
      maybeSingle: true,
      columns: "id,is_public",
    });
    const updated = assertDbSuccess(updateResult, "从照片墙移除失败");
    if (!updated) {
      throw new Error("照片不存在或更新失败");
    }
    return {
      deleted: false,
      removedFromWall: true,
      storageCleanupFailed: false,
      warning: "",
    };
  }

  const result = await dbQuery({
    table: "album_photos",
    action: "delete",
    filters: [{ column: "id", operator: "eq", value: id }],
    selectAfterWrite: true,
    maybeSingle: true,
    columns: "id,url,thumbnail_url,preview_url,original_url",
  });
  const deletedRow = assertDbSuccess(result, "删除照片失败");
  if (!deletedRow) {
    throw new Error("照片不存在或删除失败");
  }

  const cleanup = await bestEffortDeleteStorageTargets(
    toUniqueNonEmptyStrings(
      [deletedRow.url, deletedRow.thumbnail_url, deletedRow.preview_url, deletedRow.original_url].concat(
        Array.isArray(assetTargets) ? assetTargets : []
      )
    )
  );

  return {
    deleted: true,
    storageCleanupFailed: cleanup.storageCleanupFailed,
    warning: cleanup.warning,
  };
}

async function listAdminAllowedCities(limit) {
  await requireAdminSession();
  const pageLimit = Math.max(1, Math.min(500, Number(limit || 200)));
  let result = await dbQuery({
    table: "allowed_cities",
    action: "select",
    columns: "id,city_name,province,city_code,latitude,longitude,is_active,created_at",
    orders: [{ column: "created_at", ascending: false }],
    limit: pageLimit,
  });
  if (result && result.error && isColumnMissingError(result.error, "city_code")) {
    result = await dbQuery({
      table: "allowed_cities",
      action: "select",
      columns: "id,city_name,province,latitude,longitude,is_active,created_at",
      orders: [{ column: "created_at", ascending: false }],
      limit: pageLimit,
    });
  }
  const data = assertDbSuccess(result, "获取可预约城市失败");
  return Array.isArray(data) ? data : [];
}

async function saveAdminAllowedCity(payload) {
  await requireAdminSession();

  const input = payload && typeof payload === "object" ? payload : {};
  const cityName = String(input.city_name || "").trim();
  const province = String(input.province || "").trim();
  const cityCode = String(input.city_code || "").trim();
  const latitude = Number(input.latitude);
  const longitude = Number(input.longitude);
  const isActive = input.is_active === undefined ? true : Boolean(input.is_active);
  const id = Number(input.id || 0);

  if (!cityName) {
    throw new Error("城市名称不能为空");
  }
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error("经纬度不合法");
  }

  if (id > 0) {
    let updateResult = await dbQuery({
      table: "allowed_cities",
      action: "update",
      values: {
        city_name: cityName,
        province: province || null,
        city_code: cityCode || null,
        latitude,
        longitude,
        is_active: isActive,
      },
      filters: [{ column: "id", operator: "eq", value: id }],
      selectAfterWrite: true,
      maybeSingle: true,
      columns: "id,city_name,province,city_code,latitude,longitude,is_active",
    });
    if (updateResult && updateResult.error && isColumnMissingError(updateResult.error, "city_code")) {
      updateResult = await dbQuery({
        table: "allowed_cities",
        action: "update",
        values: {
          city_name: cityName,
          province: province || null,
          latitude,
          longitude,
          is_active: isActive,
        },
        filters: [{ column: "id", operator: "eq", value: id }],
        selectAfterWrite: true,
        maybeSingle: true,
        columns: "id,city_name,province,latitude,longitude,is_active",
      });
    }
    const updated = assertDbSuccess(updateResult, "更新可预约城市失败");
    if (!updated) {
      throw new Error("目标城市不存在或更新失败");
    }
    return updated;
  }

  let insertResult = await dbQuery({
    table: "allowed_cities",
    action: "insert",
    values: {
      city_name: cityName,
      province: province || null,
      city_code: cityCode || null,
      latitude,
      longitude,
      is_active: isActive,
    },
    selectAfterWrite: true,
    maybeSingle: true,
    columns: "id,city_name,province,city_code,latitude,longitude,is_active",
  });
  if (insertResult && insertResult.error && isColumnMissingError(insertResult.error, "city_code")) {
    insertResult = await dbQuery({
      table: "allowed_cities",
      action: "insert",
      values: {
        city_name: cityName,
        province: province || null,
        latitude,
        longitude,
        is_active: isActive,
      },
      selectAfterWrite: true,
      maybeSingle: true,
      columns: "id,city_name,province,latitude,longitude,is_active",
    });
  }
  return assertDbSuccess(insertResult, "新增可预约城市失败");
}

async function toggleAdminAllowedCity(cityId, isActive) {
  await requireAdminSession();
  const id = Number(cityId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("城市 ID 不合法");
  }
  const result = await dbQuery({
    table: "allowed_cities",
    action: "update",
    values: {
      is_active: Boolean(isActive),
    },
    filters: [{ column: "id", operator: "eq", value: id }],
    selectAfterWrite: true,
    maybeSingle: true,
    columns: "id,is_active",
  });
  const updated = assertDbSuccess(result, "更新可预约城市状态失败");
  if (!updated) {
    throw new Error("目标城市不存在或更新失败");
  }
  return updated;
}

async function deleteAdminAllowedCity(cityId) {
  await requireAdminSession();
  const id = Number(cityId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("城市 ID 不合法");
  }
  const result = await dbQuery({
    table: "allowed_cities",
    action: "delete",
    filters: [{ column: "id", operator: "eq", value: id }],
    selectAfterWrite: true,
    maybeSingle: true,
    columns: "id",
  });
  const deleted = assertDbSuccess(result, "删除可预约城市失败");
  if (!deleted) {
    throw new Error("目标城市不存在或删除失败");
  }
  return deleted;
}

async function queryAdminAboutSettings() {
  let result = await dbQuery({
    table: "about_settings",
    action: "select",
    columns: "id,author_name,phone,wechat,email,donation_qr_code,author_message,created_at,updated_at",
    orders: [
      { column: "updated_at", ascending: false },
      { column: "id", ascending: false },
    ],
    limit: 1,
    maybeSingle: true,
  });
  if (result && result.error && isColumnMissingError(result.error, "updated_at")) {
    result = await dbQuery({
      table: "about_settings",
      action: "select",
      columns: "id,author_name,phone,wechat,email,donation_qr_code,author_message,created_at",
      orders: [{ column: "id", ascending: false }],
      limit: 1,
      maybeSingle: true,
    });
  }
  const data = assertDbSuccess(result, "获取关于信息失败");
  return data || null;
}

async function getAdminAboutSettings() {
  await requireAdminSession();
  return queryAdminAboutSettings();
}

async function saveAdminAboutSettings(payload) {
  await requireAdminSession();
  const input = payload && typeof payload === "object" ? payload : {};
  const authorName = String(input.author_name || "").trim();
  const phone = String(input.phone || "").trim();
  const wechat = String(input.wechat || "").trim();
  const email = String(input.email || "").trim();
  const donationQrCode = String(input.donation_qr_code || "").trim();
  const authorMessage = String(input.author_message || "").trim();

  const values = {
    author_name: authorName || null,
    phone: phone || null,
    wechat: wechat || null,
    email: email || null,
    donation_qr_code: donationQrCode || null,
    author_message: authorMessage || null,
  };

  const snapshot = await queryAdminAboutSettings();
  if (snapshot && Number(snapshot.id) > 0) {
    let updateResult = await dbQuery({
      table: "about_settings",
      action: "update",
      values,
      filters: [{ column: "id", operator: "eq", value: Number(snapshot.id) }],
      selectAfterWrite: true,
      maybeSingle: true,
      columns: "id,author_name,phone,wechat,email,donation_qr_code,author_message,created_at,updated_at",
    });
    if (updateResult && updateResult.error && isColumnMissingError(updateResult.error, "updated_at")) {
      updateResult = await dbQuery({
        table: "about_settings",
        action: "update",
        values,
        filters: [{ column: "id", operator: "eq", value: Number(snapshot.id) }],
        selectAfterWrite: true,
        maybeSingle: true,
        columns: "id,author_name,phone,wechat,email,donation_qr_code,author_message,created_at",
      });
    }
    const updated = assertDbSuccess(updateResult, "保存关于信息失败");
    if (!updated) {
      throw new Error("关于信息不存在或更新失败");
    }
    return updated;
  }

  let insertResult = await dbQuery({
    table: "about_settings",
    action: "insert",
    values,
    selectAfterWrite: true,
    maybeSingle: true,
    columns: "id,author_name,phone,wechat,email,donation_qr_code,author_message,created_at,updated_at",
  });
  if (insertResult && insertResult.error && isColumnMissingError(insertResult.error, "updated_at")) {
    insertResult = await dbQuery({
      table: "about_settings",
      action: "insert",
      values,
      selectAfterWrite: true,
      maybeSingle: true,
      columns: "id,author_name,phone,wechat,email,donation_qr_code,author_message,created_at",
    });
  }
  const created = assertDbSuccess(insertResult, "保存关于信息失败");
  if (!created) {
    throw new Error("关于信息创建失败");
  }
  return created;
}

async function uploadAdminAboutDonationQr(filePath, fileName) {
  await requireAdminSession();
  const path = String(filePath || "").trim();
  if (!path) {
    throw new Error("请先选择赞赏码图片");
  }

  const snapshot = await queryAdminAboutSettings();
  const upload = await uploadAdminAsset(path, fileName, "albums", "about_donation_qr");
  try {
    const saved = await saveAdminAboutSettings(
      Object.assign({}, snapshot || {}, {
        donation_qr_code: upload.url,
      })
    );
    const cleanup = await bestEffortDeleteStorageTargets(
      toUniqueNonEmptyStrings([snapshot && snapshot.donation_qr_code]).filter((item) => item !== upload.url)
    );
    return {
      about: saved,
      storageCleanupFailed: cleanup.storageCleanupFailed,
      warning: cleanup.warning,
    };
  } catch (error) {
    const cleanup = await bestEffortDeleteStorageTargets([upload.path, upload.url, upload.fileId]);
    const message = toErrorMessage(error, "更新关于赞赏码失败");
    if (cleanup.storageCleanupFailed) {
      throw new Error(`${message}；上传文件回滚失败：${cleanup.warning || "请稍后手动清理"}`);
    }
    throw new Error(message);
  }
}

async function clearAdminAboutDonationQr() {
  await requireAdminSession();
  const snapshot = await queryAdminAboutSettings();
  if (!snapshot) {
    return {
      about: null,
      storageCleanupFailed: false,
      warning: "",
    };
  }

  const oldDonationQr = String(snapshot.donation_qr_code || "").trim();
  const saved = await saveAdminAboutSettings(
    Object.assign({}, snapshot, {
      donation_qr_code: "",
    })
  );
  const cleanup = await bestEffortDeleteStorageTargets(oldDonationQr ? [oldDonationQr] : []);
  return {
    about: saved,
    storageCleanupFailed: cleanup.storageCleanupFailed,
    warning: cleanup.warning,
  };
}

module.exports = {
  clearAdminSessionCache,
  requireAdminSession,
  getAdminDashboardStats,
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
  listAdminPoseTags,
  moveAdminPoseTag,
  createAdminPoseTags,
  updateAdminPoseTag,
  deleteAdminPoseTag,
  deleteAdminPoseTags,
  updateAdminPoseTags,
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
  listAdminGalleryPhotos,
  createAdminGalleryPhoto,
  deleteAdminPose,
  setAdminGalleryPhotoPublic,
  deleteAdminGalleryPhoto,
  listAdminAllowedCities,
  saveAdminAllowedCity,
  toggleAdminAllowedCity,
  deleteAdminAllowedCity,
  getAdminAboutSettings,
  saveAdminAboutSettings,
  uploadAdminAboutDonationQr,
  clearAdminAboutDonationQr,
};
