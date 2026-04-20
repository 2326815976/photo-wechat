const { requestJson, requestUpload } = require("../utils/cloudrun");

const SESSION_CACHE_TTL_MS = 45 * 1000;
const TRANSIENT_DB_RETRY_TIMES = 2;
const TRANSIENT_DB_RETRY_DELAY_MS = 1200;
let cachedSessionPayload = null;
let cachedSessionAt = 0;
let pendingSessionRequest = null;

function wait(ms) {
  const delay = Math.max(0, Number(ms || 0));
  if (!delay) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, delay);
  });
}

function shouldRetryWithNextPath(error) {
  const statusCode = Number((error && error.statusCode) || 0);
  if ([301, 302, 307, 308, 404, 405].includes(statusCode)) {
    return true;
  }

  const message = String((error && error.message) || "").toLowerCase();
  if (statusCode === 400) {
    // 仅在明显的“路由不匹配/路径不存在”场景下才回退，
    // 避免把业务校验类 400（如验证码错误）误判为路径兼容问题。
    if (
      message.includes("not found") ||
      message.includes("no route") ||
      message.includes("route not found") ||
      message.includes("cannot") && message.includes("path")
    ) {
      return true;
    }
    return false;
  }
  return message.includes("404") || message.includes("not found");
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

function readPayloadFailureMessage(payload, fallback) {
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

function ensureSuccessPayload(payload, fallback) {
  if (hasExplicitPayloadFailure(payload)) {
    throw new Error(readPayloadFailureMessage(payload, fallback));
  }
  return payload;
}

function readPayloadFailureCode(payload) {
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") break;
    const directError = current.error;
    if (directError && typeof directError === "object") {
      const nestedCode = String(directError.code || "").trim();
      if (nestedCode) return nestedCode;
    }
    const directCode = String(current.code || "").trim();
    if (directCode) return directCode;
    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }
  return "";
}

function hasTransientBackendMessage(message) {
  const text = String(message || "").trim().toLowerCase();
  if (!text) return false;
  const hasDatabaseOutageSignal =
    text.includes("connection failed") ||
    text.includes("connect timeout") ||
    text.includes("request timeout") ||
    text.includes("timed out") ||
    text.includes("econnreset") ||
    text.includes("connection reset") ||
    text.includes("socket hang up") ||
    text.includes("connection refused") ||
    text.includes("econnrefused") ||
    text.includes("service unavailable") ||
    text.includes("temporarily unavailable");
  return (
    text.includes("service unavailable") ||
    text.includes("upstream connect error") ||
    text.includes("upstream request timeout") ||
    text.includes("gateway timeout") ||
    text.includes("connection reset") ||
    text.includes("econnreset") ||
    text.includes("socket hang up") ||
    text.includes("request:fail") ||
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("网络错误") ||
    text.includes("连接失败") ||
    text.includes("连接超时") ||
    text.includes("暂不可用") ||
    text.includes("云托管请求失败") ||
    ((text.includes("run query failed, database") || text.includes("run query failed: database")) &&
      hasDatabaseOutageSignal) ||
    text.includes("database connection failed") ||
    text.includes("服务暂时不可用") ||
    text.includes("服务正在恢复")
  );
}

function isTransientBackendFailure(input) {
  if (!input) return false;

  const statusCode = Number((input && input.statusCode) || 0);
  if ([502, 503, 504, 520, 521, 522, 523, 524].includes(statusCode)) {
    return true;
  }

  const directCode = String((input && input.code) || "").trim().toUpperCase();
  if (directCode === "TRANSIENT_BACKEND") {
    return true;
  }

  if (hasExplicitPayloadFailure(input)) {
    const payloadCode = readPayloadFailureCode(input).trim().toUpperCase();
    if (payloadCode === "TRANSIENT_BACKEND") {
      return true;
    }
    return hasTransientBackendMessage(readPayloadFailureMessage(input, ""));
  }

  const message = String((input && input.message) || "").trim();
  return hasTransientBackendMessage(message);
}

function normalizeTransientPayload(payload, fallbackCount) {
  const count = fallbackCount === undefined ? null : fallbackCount;
  return {
    data: null,
    error: {
      message: "服务暂时不可用，请稍后重试",
      code: "TRANSIENT_BACKEND",
    },
    count,
  };
}

async function requestDbEndpoint(path, payloadBuilder, options) {
  const opts = options && typeof options === "object" ? options : {};
  const maxRetryTimes = Boolean(opts.disableTransientRetry) ? 0 : TRANSIENT_DB_RETRY_TIMES;
  let lastTransientResult = null;

  for (let attempt = 0; attempt <= maxRetryTimes; attempt += 1) {
    try {
      const requestInit = Object.assign({}, payloadBuilder());
      if (opts.disableBackendRecovery) {
        requestInit.disableBackendRecovery = true;
      }
      const payload = await requestJson(path, requestInit);
      if (isTransientBackendFailure(payload)) {
        lastTransientResult = payload;
        if (attempt < maxRetryTimes) {
          await wait(TRANSIENT_DB_RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
        return normalizeTransientPayload(payload, payload && payload.count);
      }
      return payload;
    } catch (error) {
      if (!isTransientBackendFailure(error)) {
        throw error;
      }
      if (attempt < maxRetryTimes) {
        await wait(TRANSIENT_DB_RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
      const transientError = new Error("服务暂时不可用，请稍后重试");
      transientError.code = "TRANSIENT_BACKEND";
      transientError.statusCode = Number((error && error.statusCode) || 503) || 503;
      throw transientError;
    }
  }

  return normalizeTransientPayload(lastTransientResult, null);
}

async function requestWithFallback(candidates, init) {
  const rows = Array.isArray(candidates) ? candidates : [];
  let lastError = null;
  const triedPaths = [];

  for (let i = 0; i < rows.length; i += 1) {
    const item = rows[i];
    const path = String((item && item.path) || item || "").trim();
    if (!path) continue;
    triedPaths.push(path);

    const method = String((item && item.method) || (init && init.method) || "GET").toUpperCase();
    const requestInit = Object.assign({}, init || {}, { method });

    try {
      return await requestJson(path, requestInit);
    } catch (error) {
      lastError = error;
      const canRetry = shouldRetryWithNextPath(error) && i < rows.length - 1;
      if (canRetry) {
        continue;
      }
      try {
        console.warn("[photo-api] request fallback miss", {
          method,
          path,
          statusCode: Number((error && error.statusCode) || 0) || undefined,
          message: String((error && error.message) || ""),
        });
      } catch (_) {
        // ignore log error
      }
      throw error;
    }
  }

  if (lastError) {
    const msg = String(lastError.message || "请求失败");
    lastError.message = `${msg}（已执行接口路径兼容重试）`;
    lastError.triedPaths = triedPaths;
    try {
      console.warn("[photo-api] request fallback exhausted", {
        method: String((init && init.method) || "GET").toUpperCase(),
        totalTried: triedPaths.length,
        triedPaths,
        statusCode: Number((lastError && lastError.statusCode) || 0) || undefined,
      });
    } catch (_) {
      // ignore log error
    }
    throw lastError;
  }
  throw new Error("请求失败：未提供有效接口路径");
}

async function dbQuery(payload) {
  return requestDbEndpoint("/api/db/query", () => ({
    method: "POST",
    data: payload,
  }));
}

async function dbRpc(functionName, args, options) {
  const opts = options && typeof options === "object" ? options : {};
  return requestDbEndpoint(
    "/api/db/rpc",
    () => ({
      method: "POST",
      data: {
        functionName,
        args: args || {},
      },
    }),
    {
      disableTransientRetry: Boolean(opts.disableTransientRetry),
      disableBackendRecovery: Boolean(opts.disableBackendRecovery),
    }
  );
}

function clearSessionCache() {
  cachedSessionPayload = null;
  cachedSessionAt = 0;
  pendingSessionRequest = null;
}

async function getSession(options) {
  const opts = options && typeof options === "object" ? options : {};
  const force = Boolean(opts.force || opts.forceRefresh);

  if (!force && cachedSessionPayload) {
    const age = Date.now() - Number(cachedSessionAt || 0);
    if (age >= 0 && age <= SESSION_CACHE_TTL_MS) {
      return cachedSessionPayload;
    }
  }

  if (!force && pendingSessionRequest) {
    return pendingSessionRequest;
  }

  pendingSessionRequest = requestJson("/api/auth/session", { method: "GET" })
    .then((payload) => {
      cachedSessionPayload = payload || null;
      cachedSessionAt = Date.now();
      return payload;
    })
    .catch((error) => {
      clearSessionCache();
      throw error;
    })
    .finally(() => {
      pendingSessionRequest = null;
    });

  return pendingSessionRequest;
}

function extractSessionUser(sessionPayload) {
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

async function loginWithPassword(phone, password) {
  const payload = await requestJson("/api/auth/login", {
    method: "POST",
    data: { phone, password },
  });
  clearSessionCache();
  return ensureSuccessPayload(payload, "登录失败");
}

async function loginWithMiniProgram(code, profile) {
  const payload = {
    code: String(code || "").trim(),
  };

  if (profile && typeof profile === "object") {
    const nickName = String(profile.nickName || "").trim();
    const avatarUrl = String(profile.avatarUrl || "").trim();
    if (nickName) {
      payload.nickName = nickName;
    }
    if (avatarUrl) {
      payload.avatarUrl = avatarUrl;
    }
  }

  const response = await requestJson("/api/auth/wechat/miniprogram/login", {
    method: "POST",
    data: payload,
  });
  clearSessionCache();
  return ensureSuccessPayload(response, "微信登录失败");
}

async function issueCaptcha() {
  const ts = Date.now();
  const payload = await requestWithFallback(
    [
      { path: `/api/auth/captcha?t=${ts}`, method: "GET" },
      { path: "/api/auth/captcha", method: "GET" },
      { path: "/api/auth/captcha/issue", method: "GET" },
      { path: "/api/captcha", method: "GET" },
      { path: "/api/auth/captcha", method: "POST" },
      { path: "/api/auth/captcha/issue", method: "POST" },
      { path: "/api/captcha", method: "POST" },
    ],
    { method: "GET" }
  );
  return ensureSuccessPayload(payload, "获取验证码失败");
}

async function verifyCaptcha(payload) {
  const response = await requestWithFallback(
    [
      { path: "/api/auth/captcha/verify", method: "POST" },
      { path: "/api/captcha/verify", method: "POST" },
      { path: "/api/auth/verify-captcha", method: "POST" },
    ],
    {
      method: "POST",
      data: payload || {},
    }
  );
  return ensureSuccessPayload(response, "验证码校验失败");
}

async function registerWithPassword(phone, password, captchaId, captchaToken) {
  const payload = await requestJson("/api/auth/register", {
    method: "POST",
    data: {
      phone,
      password,
      captchaId,
      captchaToken,
    },
  });
  clearSessionCache();
  return ensureSuccessPayload(payload, "注册失败");
}

async function logout() {
  clearSessionCache();
  try {
    const payload = await requestJson("/api/auth/logout", { method: "POST" });
    return ensureSuccessPayload(payload, "退出登录失败");
  } finally {
    clearSessionCache();
  }
}

async function getBlockedDates(options) {
  const opts = options && typeof options === "object" ? options : {};
  const forceFresh = Boolean(opts.forceFresh);
  const path = forceFresh ? `/api/blocked-dates?t=${Date.now()}` : "/api/blocked-dates";
  const payload = await requestJson(path, { method: "GET" });
  return ensureSuccessPayload(payload, "获取锁档日期失败");
}

module.exports = {
  dbQuery,
  dbRpc,
  getSession,
  extractSessionUser,
  loginWithPassword,
  loginWithMiniProgram,
  issueCaptcha,
  verifyCaptcha,
  registerWithPassword,
  logout,
  getBlockedDates,
  requestJson,
  requestUpload,
  clearSessionCache,
};
