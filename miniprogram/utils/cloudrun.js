const config = require("../config");
const {
  getStoredCookie,
  setStoredCookie,
  clearStoredCookie,
  resolveSessionCookieAction,
} = require("./auth");

let cloudClient = null;
let cloudInitPromise = null;
let initedEnv = "";
let runtimeFingerprint = "";
let requestTraceCounter = 0;
let backendRecoveryPromise = null;

const BACKEND_HEALTH_CHECK_PATH = "/api/health/ready";
const BACKEND_RECOVERY_MAX_WAIT_MS = 45 * 1000;
const BACKEND_RECOVERY_INTERVAL_MS = 2500;
const BACKEND_HEALTH_CHECK_TIMEOUT_MS = 12000;
const BACKEND_POST_RECOVERY_RETRY_TIMES = 2;
const BACKEND_POST_RECOVERY_RETRY_DELAY_MS = 1500;

function normalizeRuntimeValue(value) {
  return String(value || "").trim();
}

function toPositiveNumber(value, fallback) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return Number(fallback || 0);
}

function getRuntime() {
  const app = typeof getApp === "function" ? getApp() : null;
  const globalData = app && app.globalData ? app.globalData : {};
  const env = normalizeRuntimeValue(globalData.env || config.cloudbaseEnvId);
  const service = normalizeRuntimeValue(globalData.cloudRunService || config.cloudRunService);
  const uploadBaseUrl = normalizeRuntimeValue(
    globalData.appUrl ||
      globalData.cloudRunBaseUrl ||
      config.appUrl ||
      config.cloudRunBaseUrl ||
      ""
  );
  const debugRequests = Boolean(globalData.debugRequests || config.debugRequests);
  return { env, service, uploadBaseUrl, debugRequests };
}

async function ensureBackendReadyGate(options, runtime) {
  const opts = options && typeof options === "object" ? options : {};
  if (Boolean(opts.skipBackendReadyGate)) {
    return;
  }

  const app = typeof getApp === "function" ? getApp() : null;
  if (!app || typeof app.ensureBackendReady !== "function") {
    return;
  }

  const globalData = app && app.globalData ? app.globalData : {};
  const service = String(globalData.cloudRunService || (runtime && runtime.service) || "").trim();
  if (!service) {
    return;
  }

  if (Boolean(globalData.backendReady)) {
    return;
  }

  await app.ensureBackendReady();
}

function refreshRuntimeSession(runtime) {
  const current = runtime && typeof runtime === "object" ? runtime : {};
  const nextFingerprint = `${normalizeRuntimeValue(current.env)}::${normalizeRuntimeValue(current.service)}`;
  if (!runtimeFingerprint) {
    runtimeFingerprint = nextFingerprint;
    return;
  }

  if (runtimeFingerprint !== nextFingerprint) {
    clearStoredCookie();
    runtimeFingerprint = nextFingerprint;
    return;
  }

  runtimeFingerprint = nextFingerprint;
}

function nextRequestTraceId() {
  requestTraceCounter += 1;
  if (requestTraceCounter >= 99999999) {
    requestTraceCounter = 1;
  }
  return requestTraceCounter;
}

function normalizeMethod(value) {
  return String(value || "GET").toUpperCase();
}

function normalizeStatusCode(value) {
  const code = Number(value || 0);
  if (!Number.isFinite(code)) return 0;
  return code;
}

function sleep(ms) {
  const delay = toPositiveNumber(ms, 0);
  if (!delay) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, delay);
  });
}

function syncAppBackendStatus(patch) {
  const next = patch && typeof patch === "object" ? patch : {};
  const app = typeof getApp === "function" ? getApp() : null;
  if (!app || !app.globalData) return;

  if (typeof app.setBackendStatus === "function") {
    app.setBackendStatus(next);
    return;
  }

  if (Object.prototype.hasOwnProperty.call(next, "backendReady")) {
    app.globalData.backendReady = Boolean(next.backendReady);
  }
  if (Object.prototype.hasOwnProperty.call(next, "backendReconnecting")) {
    app.globalData.backendReconnecting = Boolean(next.backendReconnecting);
  }
  if (Object.prototype.hasOwnProperty.call(next, "backendLastError")) {
    app.globalData.backendLastError = String(next.backendLastError || "");
    app.globalData.cloudRunLastError = app.globalData.backendLastError;
  }
  if (Object.prototype.hasOwnProperty.call(next, "backendReady")) {
    app.globalData.cloudRunReachable = Boolean(next.backendReady);
  }
}

function isBackendUnavailableStatus(statusCode) {
  const code = normalizeStatusCode(statusCode);
  if (!code) return false;
  return [502, 503, 504, 520, 521, 522, 523, 524].includes(code);
}

function hasBackendUnavailableMessageKeyword(message) {
  const text = String(message || "").trim().toLowerCase();
  if (!text) return false;
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
    text.includes("云托管请求失败")
  );
}

function hasBackendTransientMessageKeyword(message) {
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
    hasBackendUnavailableMessageKeyword(text) ||
    ((text.includes("run query failed, database") || text.includes("run query failed: database")) &&
      hasDatabaseOutageSignal) ||
    text.includes("database connection failed") ||
    text.includes("服务暂时不可用") ||
    text.includes("服务正在恢复")
  );
}

function extractPayloadErrorInfo(payload) {
  let current = parseMaybeJson(payload);
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") break;

    const directError = current.error;
    if (typeof directError === "string" && directError.trim()) {
      return {
        message: directError.trim(),
        code: String(current.code || "").trim(),
      };
    }

    if (directError && typeof directError === "object") {
      const message = String(directError.message || current.message || "").trim();
      const code = String(directError.code || current.code || "").trim();
      if (message || code) {
        return {
          message,
          code,
        };
      }
    }

    if (Object.prototype.hasOwnProperty.call(current, "success") && current.success === false) {
      return {
        message: String(current.message || "请求失败").trim(),
        code: String(current.code || "").trim(),
      };
    }

    if (Object.prototype.hasOwnProperty.call(current, "ok") && current.ok === false) {
      return {
        message: String(current.message || "请求失败").trim(),
        code: String(current.code || "").trim(),
      };
    }

    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }

  return null;
}

function isTransientPayloadError(payload) {
  const info = extractPayloadErrorInfo(payload);
  if (!info) return false;
  const code = String(info.code || "").trim().toUpperCase();
  if (code === "TRANSIENT_BACKEND") {
    return true;
  }
  return hasBackendTransientMessageKeyword(info.message);
}

function shouldTriggerBackendRecovery(error, statusCodeHint) {
  const statusCode = normalizeStatusCode(
    statusCodeHint !== undefined && statusCodeHint !== null
      ? statusCodeHint
      : error && typeof error === "object"
      ? error.statusCode
      : 0
  );
  if (isBackendUnavailableStatus(statusCode)) {
    return true;
  }

  const errorCode =
    error && typeof error === "object" ? String(error.code || "").trim().toUpperCase() : "";
  if (errorCode === "TRANSIENT_BACKEND") {
    return true;
  }

  const message = String((error && error.message) || "").trim();
  if (!message) {
    return false;
  }

  // 500 仅在命中“后端不可用”关键字时触发恢复，避免掩盖真实业务错误。
  if (statusCode === 500) {
    return hasBackendTransientMessageKeyword(message);
  }

  if (!statusCode || statusCode >= 520) {
    return hasBackendTransientMessageKeyword(message);
  }

  return false;
}

function resolveLogWriter(level) {
  if (level === "warn" && typeof console.warn === "function") return console.warn;
  if (level === "error" && typeof console.error === "function") return console.error;
  if (typeof console.log === "function") return console.log;
  return null;
}

function logRequestTrace(runtime, level, label, payload) {
  if (!runtime || !runtime.debugRequests) return;
  const writer = resolveLogWriter(level);
  if (!writer) return;

  try {
    writer(`[cloudrun][${label}]`, payload);
  } catch (_) {
    // ignore
  }
}

function normalizeContainerPath(path) {
  const value = String(path || "").trim();
  if (!value) return "/";
  if (/^https?:\/\//i.test(value)) return value;
  return value.startsWith("/") ? value : `/${value}`;
}

function normalizeOrigin(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function joinUrl(origin, path) {
  const base = normalizeOrigin(origin);
  const suffix = normalizeContainerPath(path);
  if (!base) return suffix;
  if (/^https?:\/\//i.test(suffix)) return suffix;
  return `${base}${suffix}`;
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  const text = String(value || "").trim();
  if (!text) return text;
  try {
    return JSON.parse(text);
  } catch (e) {
    return value;
  }
}

function resolveErrorMessage(payload, statusCode, fallback) {
  const data = parseMaybeJson(payload);
  if (data && typeof data === "object") {
    const objectMessage =
      (data.error && typeof data.error === "object" && data.error.message) || data.error || data.message;
    if (typeof objectMessage === "string" && objectMessage.trim()) {
      return objectMessage;
    }
  }
  if (typeof data === "string" && data.trim()) {
    return data;
  }
  return String(fallback || `请求失败（${statusCode}）`);
}

function pushCookieCandidates(list, value) {
  if (!value) return;
  if (Array.isArray(value)) {
    value.forEach((item) => {
      pushCookieCandidates(list, item);
    });
    return;
  }

  const text = String(value || "").trim();
  if (!text) return;
  list.push(text);
}

function appendSetCookieCandidates(list, headerLike) {
  if (!headerLike || typeof headerLike !== "object") return;
  pushCookieCandidates(list, headerLike["Set-Cookie"]);
  pushCookieCandidates(list, headerLike["set-cookie"]);
  pushCookieCandidates(list, headerLike.setCookie);
}

function applySessionCookieFromResponse(responseLike) {
  const response = responseLike && typeof responseLike === "object" ? responseLike : {};
  const candidates = [];

  appendSetCookieCandidates(candidates, response);
  appendSetCookieCandidates(candidates, response.header);
  appendSetCookieCandidates(candidates, response.headers);
  pushCookieCandidates(candidates, response.cookies);

  for (let i = 0; i < candidates.length; i += 1) {
    const cookieAction = resolveSessionCookieAction(candidates[i]);
    if (!cookieAction) continue;

    if (cookieAction.shouldClear) {
      clearStoredCookie();
      return;
    }

    if (cookieAction.cookie) {
      setStoredCookie(cookieAction.cookie);
      return;
    }
  }
}

async function ensureCloudClient(env) {
  if (cloudClient && cloudInitPromise && initedEnv === env) {
    await cloudInitPromise;
    return cloudClient;
  }

  cloudClient = new wx.cloud.Cloud({
    resourceEnv: env,
  });
  cloudInitPromise = cloudClient.init();
  initedEnv = env;

  await cloudInitPromise;
  return cloudClient;
}

async function callContainerByWxCloud(payload) {
  if (!wx || !wx.cloud || typeof wx.cloud.callContainer !== "function") {
    return null;
  }

  return wx.cloud.callContainer(payload);
}

async function callContainer(options) {
  const opts = options && typeof options === "object" ? options : {};
  const runtime = getRuntime();
  refreshRuntimeSession(runtime);

  const { env, service } = runtime;
  if (!env) {
    throw new Error("云开发环境未配置：请在 miniprogram/config.js 中填写 cloudbaseEnvId。");
  }
  if (!service) {
    throw new Error(
      "云托管服务名称未配置：请在 miniprogram/config.js 中填写 cloudRunService（用于 X-WX-SERVICE）。"
    );
  }

  const header = Object.assign({}, opts.header && typeof opts.header === "object" ? opts.header : {});
  header["X-WX-SERVICE"] = service;

  const cookie = getStoredCookie();
  if (cookie) {
    header.Cookie = cookie;
    header.cookie = cookie;
  }

  const normalizedPath = normalizeContainerPath(opts.path);
  const payload = {
    path: normalizedPath,
    method: opts.method || "GET",
    data: opts.data,
    header,
    timeout: toPositiveNumber(opts.timeout, 20000),
  };
  const wxCloudPayload = Object.assign({}, payload, { config: { env } });
  const traceId = nextRequestTraceId();
  const startAt = Date.now();

  logRequestTrace(runtime, "log", "start", {
    id: traceId,
    method: normalizeMethod(payload.method),
    path: normalizedPath,
    service,
    env,
    timeout: payload.timeout,
  });

  let res;
  let via = "wx.cloud.callContainer";
  try {
    // 官方推荐：优先使用 wx.cloud.callContainer；旧基础库回退 Cloud 实例。
    res = await callContainerByWxCloud(wxCloudPayload);
    if (!res) {
      via = "wx.cloud.Cloud.callContainer";
      const client = await ensureCloudClient(env);
      res = await client.callContainer(payload);
    }
  } catch (error) {
    logRequestTrace(runtime, "error", "fail", {
      id: traceId,
      via,
      method: normalizeMethod(payload.method),
      path: normalizedPath,
      service,
      env,
      durationMs: Date.now() - startAt,
      message: String((error && error.message) || "云托管请求失败"),
    });

    const method = String((payload && payload.method) || "GET").toUpperCase();
    const message = String((error && error.message) || "云托管请求失败");
    const wrapped = new Error(
      `${message}（${method} ${normalizedPath}，服务：${String(service)}，环境：${String(env)}）`
    );
    wrapped.path = normalizedPath;
    wrapped.method = method;
    wrapped.service = service;
    wrapped.env = env;
    wrapped.cause = error;
    throw wrapped;
  }

  if (!res || typeof res !== "object") {
    logRequestTrace(runtime, "error", "invalid-response", {
      id: traceId,
      via,
      method: normalizeMethod(payload.method),
      path: normalizedPath,
      service,
      env,
      durationMs: Date.now() - startAt,
    });

    const method = String((payload && payload.method) || "GET").toUpperCase();
    const err = new Error(
      `云托管请求返回异常（${method} ${normalizedPath}，服务：${String(service)}，环境：${String(env)}）`
    );
    err.path = normalizedPath;
    err.method = method;
    err.service = service;
    err.env = env;
    throw err;
  }

  // 尝试持久化 session cookie（用于后续鉴权接口调用）
  applySessionCookieFromResponse(res);

  logRequestTrace(runtime, "log", "done", {
    id: traceId,
    via,
    method: normalizeMethod(payload.method),
    path: normalizedPath,
    statusCode: normalizeStatusCode(res.statusCode),
    durationMs: Date.now() - startAt,
  });

  return res;
}

async function probeBackendHealthOnce() {
  try {
    const response = await callContainer({
      path: BACKEND_HEALTH_CHECK_PATH,
      method: "GET",
      timeout: BACKEND_HEALTH_CHECK_TIMEOUT_MS,
    });
    const statusCode = normalizeStatusCode(response && response.statusCode);
    if (!statusCode || statusCode < 200 || statusCode >= 300) {
      return false;
    }
    const parsedData = parseMaybeJson(response ? response.data : undefined);
    return !extractPayloadErrorInfo(parsedData);
  } catch (error) {
    return false;
  }
}

async function waitForBackendRecovery(runtime, trigger) {
  if (backendRecoveryPromise) {
    return backendRecoveryPromise;
  }

  const startedAt = Date.now();
  backendRecoveryPromise = (async () => {
    let attempts = 0;
    const deadline = startedAt + BACKEND_RECOVERY_MAX_WAIT_MS;

    logRequestTrace(runtime, "warn", "backend-recovery-start", {
      trigger: String((trigger && trigger.message) || "unknown"),
      maxWaitMs: BACKEND_RECOVERY_MAX_WAIT_MS,
      intervalMs: BACKEND_RECOVERY_INTERVAL_MS,
      healthPath: BACKEND_HEALTH_CHECK_PATH,
    });

    while (Date.now() <= deadline) {
      attempts += 1;
      const healthy = await probeBackendHealthOnce();
      if (healthy) {
        const elapsedMs = Date.now() - startedAt;
        logRequestTrace(runtime, "log", "backend-recovery-ok", {
          attempts,
          elapsedMs,
        });
        return {
          recovered: true,
          attempts,
          elapsedMs,
        };
      }
      if (Date.now() + BACKEND_RECOVERY_INTERVAL_MS > deadline) {
        break;
      }
      await sleep(BACKEND_RECOVERY_INTERVAL_MS);
    }

    const elapsedMs = Date.now() - startedAt;
    logRequestTrace(runtime, "warn", "backend-recovery-timeout", {
      attempts,
      elapsedMs,
      maxWaitMs: BACKEND_RECOVERY_MAX_WAIT_MS,
    });
    return {
      recovered: false,
      attempts,
      elapsedMs,
    };
  })().finally(() => {
    backendRecoveryPromise = null;
  });

  return backendRecoveryPromise;
}

async function requestJson(path, init) {
  const options = init && typeof init === "object" ? init : {};
  const method = String((options && options.method) || "GET").toUpperCase();
  const header = Object.assign({}, options && options.header ? options.header : {});
  header["Content-Type"] = header["Content-Type"] || "application/json";
  const runtime = getRuntime();
  const disableBackendRecovery = Boolean(options.disableBackendRecovery);
  let recoveryAttempted = false;

  await ensureBackendReadyGate(options, runtime);

  const sendRequest = async () => {
    const response = await callContainer({
      path,
      method,
      data: options ? options.data : undefined,
      header,
      timeout: options && options.timeout,
    });
    return {
      response,
      statusCode: Number((response && response.statusCode) || 0),
      parsedData: parseMaybeJson(response ? response.data : undefined),
    };
  };

  const sendRequestWithCookieRetry = async () => {
    let { response: res, statusCode, parsedData } = await sendRequest();
    const hasStoredCookie = Boolean(getStoredCookie());
    const shouldRetryWithCleanCookie = hasStoredCookie && (statusCode === 401 || statusCode === 403);
    if (shouldRetryWithCleanCookie) {
      clearStoredCookie();
      const retried = await sendRequest();
      res = retried.response;
      statusCode = retried.statusCode;
      parsedData = retried.parsedData;
    }
    return {
      response: res,
      statusCode,
      parsedData,
    };
  };

  const buildHttpError = (res, statusCode, parsedData) => {
    const apiPath = String(path || "");
    const message = resolveErrorMessage(parsedData, statusCode, `请求失败（${statusCode}）`);
    const payloadErrorInfo = extractPayloadErrorInfo(parsedData) || {};
    const hint =
      statusCode === 404
        ? `（接口不存在：${method.toUpperCase()} ${apiPath}，当前服务：${String(
            runtime.service || ""
          )}，请确认云托管服务名是否正确且后端已部署最新版本）`
        : "";
    const err = new Error(String(message));
    err.code = String(payloadErrorInfo.code || "").trim();
    err.statusCode = statusCode;
    err.response = res;
    err.path = apiPath;
    err.method = String(method || "GET").toUpperCase();
    err.service = runtime.service;
    err.env = runtime.env;
    err.message = `${String(message)}${hint}`;
    return err;
  };

  const buildPayloadTransientError = (payload, statusCodeHint) => {
    const payloadErrorInfo = extractPayloadErrorInfo(payload) || {};
    const err = new Error("服务暂时不可用，请稍后重试");
    err.code = String(payloadErrorInfo.code || "").trim() || "TRANSIENT_BACKEND";
    err.statusCode = normalizeStatusCode(statusCodeHint || 503) || 503;
    err.path = String(path || "");
    err.method = String(method || "GET").toUpperCase();
    err.service = runtime.service;
    err.env = runtime.env;
    err.rawMessage = String(payloadErrorInfo.message || "").trim();
    return err;
  };

  const appendRecoveryHint = (error, recoveryResult, recovered) => {
    const err = error instanceof Error ? error : new Error(String(error || "请求失败"));
    if (recoveryResult && typeof recoveryResult === "object") {
      err.backendRecovery = recoveryResult;
    }
    const elapsedMs = Number((recoveryResult && recoveryResult.elapsedMs) || 0);
    const elapsedSeconds = elapsedMs > 0 ? (elapsedMs / 1000).toFixed(1) : "0";
    if (recovered) {
      err.message = `${String(err.message || "请求失败")}（后端已恢复并自动重试，等待约 ${elapsedSeconds}s）`;
    } else {
      err.message = `${String(err.message || "请求失败")}（后端可能处于冷启动，已自动等待 ${elapsedSeconds}s 仍未恢复）`;
    }
    return err;
  };

  const tryRecoverAndRetry = async (triggerError, statusCodeHint) => {
    if (recoveryAttempted) {
      return null;
    }
    if (disableBackendRecovery || !shouldTriggerBackendRecovery(triggerError, statusCodeHint)) {
      return null;
    }
    recoveryAttempted = true;
    syncAppBackendStatus({
      backendReady: false,
      backendReconnecting: true,
      backendLastError: String((triggerError && triggerError.message) || "服务器暂不可用"),
    });

    const recoveryResult = await waitForBackendRecovery(runtime, triggerError);
    if (!recoveryResult || !recoveryResult.recovered) {
      syncAppBackendStatus({
        backendReady: false,
        backendReconnecting: true,
        backendLastError: String((triggerError && triggerError.message) || "服务器暂不可用"),
      });
      throw appendRecoveryHint(triggerError, recoveryResult, false);
    }

    try {
      let retried = null;
      for (let attempt = 0; attempt <= BACKEND_POST_RECOVERY_RETRY_TIMES; attempt += 1) {
        retried = await sendRequestWithCookieRetry();
        const retriedStatusCode = Number((retried && retried.statusCode) || 0);
        const retriedPayload = retried ? retried.parsedData : null;
        const shouldRetryAgain =
          isBackendUnavailableStatus(retriedStatusCode) ||
          isTransientPayloadError(retriedPayload);
        if (!shouldRetryAgain) {
          break;
        }
        if (attempt >= BACKEND_POST_RECOVERY_RETRY_TIMES) {
          throw buildPayloadTransientError(retriedPayload, retriedStatusCode || 503);
        }
        await sleep(BACKEND_POST_RECOVERY_RETRY_DELAY_MS * (attempt + 1));
      }
      syncAppBackendStatus({
        backendReady: true,
        backendReconnecting: false,
        backendLastError: "",
      });
      return retried;
    } catch (retryError) {
      syncAppBackendStatus({
        backendReady: false,
        backendReconnecting: true,
        backendLastError: String((retryError && retryError.message) || "服务器暂不可用"),
      });
      throw appendRecoveryHint(retryError, recoveryResult, true);
    }
  };

  let result;
  try {
    result = await sendRequestWithCookieRetry();
  } catch (requestError) {
    const recoveredResult = await tryRecoverAndRetry(requestError);
    if (!recoveredResult) {
      throw requestError;
    }
    result = recoveredResult;
  }

  let { response: res, statusCode, parsedData } = result;
  if (statusCode && (statusCode < 200 || statusCode >= 300)) {
    let httpError = buildHttpError(res, statusCode, parsedData);
    const recoveredResult = await tryRecoverAndRetry(httpError, statusCode);
    if (!recoveredResult) {
      throw httpError;
    }
    res = recoveredResult.response;
    statusCode = recoveredResult.statusCode;
    parsedData = recoveredResult.parsedData;
  }

  if (statusCode && (statusCode < 200 || statusCode >= 300)) {
    const httpError = buildHttpError(res, statusCode, parsedData);
    throw httpError;
  }

  if (isTransientPayloadError(parsedData)) {
    const payloadError = buildPayloadTransientError(parsedData, 503);
    const recoveredResult = await tryRecoverAndRetry(payloadError, 503);
    if (!recoveredResult) {
      throw payloadError;
    }
    res = recoveredResult.response;
    statusCode = recoveredResult.statusCode;
    parsedData = recoveredResult.parsedData;
  }

  if (isTransientPayloadError(parsedData)) {
    throw buildPayloadTransientError(parsedData, 503);
  }

  syncAppBackendStatus({
    backendReady: true,
    backendReconnecting: false,
    backendLastError: "",
  });

  return parsedData;
}

function encodeUtf8(text) {
  const input = String(text || "");
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(input);
  }

  const encoded = unescape(encodeURIComponent(input));
  const bytes = new Uint8Array(encoded.length);
  for (let i = 0; i < encoded.length; i += 1) {
    bytes[i] = encoded.charCodeAt(i);
  }
  return bytes;
}

function concatUint8Arrays(chunks) {
  const rows = Array.isArray(chunks) ? chunks : [];
  const totalSize = rows.reduce((sum, item) => {
    if (!item) return sum;
    if (item instanceof Uint8Array) return sum + item.byteLength;
    if (item instanceof ArrayBuffer) return sum + item.byteLength;
    return sum;
  }, 0);

  const merged = new Uint8Array(totalSize);
  let offset = 0;
  rows.forEach((item) => {
    if (!item) return;
    const chunk = item instanceof Uint8Array ? item : new Uint8Array(item);
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  });

  return merged.buffer;
}

function toSafeFieldName(value, fallback) {
  const text = String(value || "").trim();
  if (!text) return String(fallback || "file");
  return text.replace(/[\r\n"]/g, "_");
}

function toSafeFileName(value, fallback) {
  const text = String(value || "").trim();
  if (!text) return String(fallback || `upload_${Date.now()}`);
  return text.replace(/[\\\/:*?"<>|\r\n]/g, "_");
}

function readWxErrorMessage(error, fallback) {
  if (!error || typeof error !== "object") {
    return String(fallback || "请求失败");
  }
  const message = String(error.message || "").trim();
  if (message) return message;
  const errMsg = String(error.errMsg || "").trim();
  if (errMsg) return errMsg;
  const fallbackMessage = String(fallback || "请求失败").trim();
  return fallbackMessage || "请求失败";
}

function isUploadDomainNotWhitelisted(message) {
  const text = String(message || "").trim().toLowerCase();
  if (!text) return false;
  return (
    text.includes("url not in domain list") ||
    text.includes("not in domain list") ||
    text.includes("uploadfile:fail") && text.includes("domain") ||
    text.includes("合法域名")
  );
}

function inferMimeTypeByFileName(fileName, filePath) {
  const rawName = String(fileName || "").trim() || String(filePath || "").trim();
  const normalized = rawName.toLowerCase().split(/[?#]/)[0];
  if (!normalized) return "application/octet-stream";

  if (/\.(jpg|jpeg)$/.test(normalized)) return "image/jpeg";
  if (/\.png$/.test(normalized)) return "image/png";
  if (/\.webp$/.test(normalized)) return "image/webp";
  if (/\.gif$/.test(normalized)) return "image/gif";
  if (/\.bmp$/.test(normalized)) return "image/bmp";
  if (/\.avif$/.test(normalized)) return "image/avif";
  if (/\.(heic|heif)$/.test(normalized)) return "image/heic";

  return "application/octet-stream";
}

function sliceArrayBuffer(buffer, byteOffset, byteLength) {
  const source = buffer instanceof ArrayBuffer ? buffer : null;
  if (!source) return null;

  const offset = Math.max(0, Number(byteOffset) || 0);
  const rawLength = Number(byteLength);
  const length = Number.isFinite(rawLength) && rawLength >= 0 ? rawLength : source.byteLength - offset;
  const end = Math.min(source.byteLength, offset + Math.max(0, length));
  if (end <= offset) return new ArrayBuffer(0);
  return source.slice(offset, end);
}

function normalizeBinaryDataToArrayBuffer(data) {
  if (data instanceof ArrayBuffer) {
    return data;
  }

  if (typeof ArrayBuffer !== "undefined" && typeof ArrayBuffer.isView === "function" && ArrayBuffer.isView(data)) {
    return sliceArrayBuffer(data.buffer, data.byteOffset, data.byteLength);
  }

  if (data && typeof data === "object" && data.buffer instanceof ArrayBuffer) {
    const byteLength =
      Number(data.byteLength) || Number(data.length) || Number((data.buffer && data.buffer.byteLength) || 0);
    const byteOffset = Number(data.byteOffset) || 0;
    return sliceArrayBuffer(data.buffer, byteOffset, byteLength);
  }

  if (data && typeof data === "object" && Array.isArray(data.data)) {
    try {
      return new Uint8Array(data.data).buffer;
    } catch (_) {
      return null;
    }
  }

  if (typeof data === "string") {
    const text = String(data || "").trim();
    if (!text) return null;
    if (typeof wx !== "undefined" && typeof wx.base64ToArrayBuffer === "function") {
      try {
        return wx.base64ToArrayBuffer(text);
      } catch (_) {
        // ignore and try byte-string fallback below
      }
    }
    // 兼容少量运行时返回“字节字符串”而非 ArrayBuffer 的场景
    try {
      const bytes = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i += 1) {
        bytes[i] = text.charCodeAt(i) & 0xff;
      }
      return bytes.buffer;
    } catch (_) {
      return null;
    }
  }

  return null;
}

function readLocalFileAsArrayBuffer(filePath) {
  return new Promise((resolve, reject) => {
    const path = String(filePath || "").trim();
    if (!path) {
      reject(new Error("文件路径不能为空"));
      return;
    }

    const fileSystemManager = wx.getFileSystemManager();
    const resolveByData = (data) => {
      const buffer = normalizeBinaryDataToArrayBuffer(data);
      if (buffer instanceof ArrayBuffer && buffer.byteLength > 0) {
        resolve(buffer);
        return true;
      }
      return false;
    };

    fileSystemManager.readFile({
      filePath: path,
      success: (res) => {
        if (resolveByData(res ? res.data : null)) {
          return;
        }

        fileSystemManager.readFile({
          filePath: path,
          encoding: "base64",
          success: (base64Res) => {
            if (resolveByData(base64Res ? base64Res.data : null)) {
              return;
            }
            reject(new Error("读取文件失败：未拿到有效二进制数据"));
          },
          fail: (error) => {
            reject(error);
          },
        });
      },
      fail: (error) => {
        fileSystemManager.readFile({
          filePath: path,
          encoding: "base64",
          success: (base64Res) => {
            if (resolveByData(base64Res ? base64Res.data : null)) {
              return;
            }
            reject(error);
          },
          fail: () => {
            reject(error);
          },
        });
      },
    });
  });
}

async function buildMultipartArrayBuffer(options) {
  const opts = options && typeof options === "object" ? options : {};
  const filePath = String(opts.filePath || "").trim();
  const boundary = String(opts.boundary || "").trim();
  const fieldName = toSafeFieldName(opts.name, "file");
  const fileName = toSafeFileName(opts.fileName, `upload_${Date.now()}`);
  const fileContentType = String(
    opts.contentType || inferMimeTypeByFileName(fileName, filePath) || "application/octet-stream"
  ).trim();
  const formData = opts.formData && typeof opts.formData === "object" ? opts.formData : {};

  if (!filePath) {
    throw new Error("上传失败：缺少本地文件路径");
  }
  if (!boundary) {
    throw new Error("上传失败：缺少 multipart boundary");
  }

  const fileBuffer = await readLocalFileAsArrayBuffer(filePath);
  const chunks = [];

  Object.keys(formData).forEach((key) => {
    const value = formData[key];
    if (value === undefined || value === null) return;
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="${toSafeFieldName(
      key,
      "field"
    )}"\r\n\r\n${String(value)}\r\n`;
    chunks.push(encodeUtf8(header));
  });

  const fileHead =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n` +
    `Content-Type: ${fileContentType || "application/octet-stream"}\r\n\r\n`;
  chunks.push(encodeUtf8(fileHead));
  chunks.push(new Uint8Array(fileBuffer));
  chunks.push(encodeUtf8(`\r\n--${boundary}--\r\n`));

  return concatUint8Arrays(chunks);
}

function shouldFallbackToUploadFile(error) {
  const statusCode = Number((error && error.statusCode) || 0);
  if (!statusCode) {
    return true;
  }

  return [413, 415, 431, 500, 502, 503, 504].includes(statusCode);
}

function uploadFileByWx(options) {
  const opts = options && typeof options === "object" ? options : {};

  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: String(opts.url || "").trim(),
      filePath: String(opts.filePath || "").trim(),
      name: String(opts.name || "file"),
      formData: opts.formData && typeof opts.formData === "object" ? opts.formData : {},
      header: opts.header && typeof opts.header === "object" ? opts.header : {},
      timeout: Number(opts.timeout || 120000),
      success: (res) => resolve(res),
      fail: (error) => reject(error),
    });
  });
}

async function requestUpload(path, init) {
  const options = init && typeof init === "object" ? init : {};
  const normalizedPath = normalizeContainerPath(path);
  const method = String(options.method || "POST").toUpperCase();
  const filePath = String(options.filePath || "").trim();
  const fieldName = toSafeFieldName(options.name, "file");
  const fileName = toSafeFileName(
    options.fileName,
    (() => {
      const matched = filePath.match(/[^\\/]+$/);
      return matched ? matched[0] : `upload_${Date.now()}`;
    })()
  );
  const fileContentType = String(
    options.contentType || inferMimeTypeByFileName(fileName, filePath) || "application/octet-stream"
  ).trim();
  const formData = options.formData && typeof options.formData === "object" ? options.formData : {};

  if (!filePath) {
    throw new Error("上传失败：缺少本地文件路径");
  }

  const runtime = getRuntime();
  await ensureBackendReadyGate(options, runtime);
  const uploadBaseUrl = String(options.uploadBaseUrl || runtime.uploadBaseUrl || "").trim();
  let uploadDomainBlockedError = null;

  // 优先走 wx.uploadFile，避免部分基础库/设备在读取本地文件为 ArrayBuffer 时兼容性不一致。
  if (uploadBaseUrl) {
    try {
      const directHeader = Object.assign({}, options.header || {});
      delete directHeader["Content-Type"];
      delete directHeader["content-type"];

      const service = runtime.service;
      if (service) {
        directHeader["X-WX-SERVICE"] = service;
      }

      const cookie = getStoredCookie();
      if (cookie) {
        directHeader.Cookie = cookie;
        directHeader.cookie = cookie;
      }

      const directResponse = await uploadFileByWx({
        url: joinUrl(uploadBaseUrl, normalizedPath),
        filePath,
        name: fieldName,
        formData,
        header: directHeader,
        timeout: options.timeout || 120000,
      });

      applySessionCookieFromResponse(directResponse);

      const directStatusCode = Number((directResponse && directResponse.statusCode) || 0);
      const directParsedData = parseMaybeJson(directResponse ? directResponse.data : undefined);
      if (directStatusCode && (directStatusCode < 200 || directStatusCode >= 300)) {
        const message = resolveErrorMessage(directParsedData, directStatusCode, `上传失败（${directStatusCode}）`);
        const err = new Error(String(message));
        err.statusCode = directStatusCode;
        err.response = directResponse;
        err.path = normalizedPath;
        err.method = method;
        throw err;
      }

      logRequestTrace(runtime, "log", "upload-done", {
        via: "wx.uploadFile",
        method,
        path: normalizedPath,
        statusCode: directStatusCode,
      });

      return directParsedData;
    } catch (directError) {
      const directReason = readWxErrorMessage(directError, "wx.uploadFile 直传失败");
      logRequestTrace(runtime, "warn", "upload-direct-fail", {
        method,
        path: normalizedPath,
        reason: directReason,
        uploadBaseUrl,
      });

      if (isUploadDomainNotWhitelisted(directReason)) {
        const host = normalizeOrigin(uploadBaseUrl);
        const err = new Error(
          `上传失败：当前 APP_URL 未加入小程序 uploadFile 合法域名，请在微信公众平台补充域名 ${host}`
        );
        err.code = "UPLOAD_DOMAIN_NOT_ALLOWED";
        err.path = normalizedPath;
        err.method = method;
        err.uploadBaseUrl = host;
        uploadDomainBlockedError = err;
      }
      // 直传失败后，继续尝试 callContainer multipart 上传链路。
    }
  }

  try {
    const boundary = `----SloganMiniProgram${Date.now().toString(16)}${Math.random()
      .toString(16)
      .slice(2)}`;
    const bodyBuffer = await buildMultipartArrayBuffer({
      filePath,
      name: fieldName,
      fileName,
      formData,
      boundary,
      contentType: fileContentType,
    });

    const requestHeader = Object.assign({}, options.header || {});
    requestHeader["Content-Type"] = `multipart/form-data; boundary=${boundary}`;

    const res = await callContainer({
      path: normalizedPath,
      method,
      data: bodyBuffer,
      header: requestHeader,
      timeout: options.timeout,
    });

    const statusCode = Number((res && res.statusCode) || 0);
    const parsedData = parseMaybeJson(res ? res.data : undefined);
    if (statusCode && (statusCode < 200 || statusCode >= 300)) {
      const message = resolveErrorMessage(parsedData, statusCode, `上传失败（${statusCode}）`);
      const err = new Error(String(message));
      err.statusCode = statusCode;
      err.response = res;
      err.path = normalizedPath;
      err.method = method;
      throw err;
    }
    return parsedData;
  } catch (error) {
    const canFallback = shouldFallbackToUploadFile(error);

    if (uploadDomainBlockedError && canFallback) {
      const original = String((error && error.message) || "callContainer 上传失败");
      const host = String(uploadDomainBlockedError.uploadBaseUrl || normalizeOrigin(uploadBaseUrl));
      const combined = new Error(
        `${uploadDomainBlockedError.message}；同时云托管上传失败：${original}`
      );
      combined.code = "UPLOAD_DOMAIN_NOT_ALLOWED";
      combined.path = normalizedPath;
      combined.method = method;
      combined.uploadBaseUrl = host;
      combined.cause = error;
      throw combined;
    }

    if (!uploadBaseUrl && canFallback) {
      const original = String((error && error.message) || "上传失败");
      error.message = `${original}（当前未配置 APP_URL 公网域名，无法回退 wx.uploadFile 上传）`;
      throw error;
    }

    if (!uploadBaseUrl || !canFallback) {
      throw error;
    }

    logRequestTrace(runtime, "warn", "upload-fallback", {
      method,
      path: normalizedPath,
      reason: String((error && error.message) || "callContainer 上传失败"),
      uploadBaseUrl,
    });

    const fallbackHeader = Object.assign({}, options.header || {});
    delete fallbackHeader["Content-Type"];
    delete fallbackHeader["content-type"];

    const service = runtime.service;
    if (service) {
      fallbackHeader["X-WX-SERVICE"] = service;
    }

    const cookie = getStoredCookie();
    if (cookie) {
      fallbackHeader.Cookie = cookie;
      fallbackHeader.cookie = cookie;
    }

    const uploadResponse = await uploadFileByWx({
      url: joinUrl(uploadBaseUrl, normalizedPath),
      filePath,
      name: fieldName,
      formData,
      header: fallbackHeader,
      timeout: options.timeout || 120000,
    });

    applySessionCookieFromResponse(uploadResponse);

    const statusCode = Number((uploadResponse && uploadResponse.statusCode) || 0);
    const parsedData = parseMaybeJson(uploadResponse ? uploadResponse.data : undefined);
    if (statusCode && (statusCode < 200 || statusCode >= 300)) {
      const message = resolveErrorMessage(parsedData, statusCode, `上传失败（${statusCode}）`);
      const err = new Error(String(message));
      err.statusCode = statusCode;
      err.response = uploadResponse;
      err.path = normalizedPath;
      err.method = method;
      throw err;
    }

    logRequestTrace(runtime, "log", "upload-done", {
      via: "wx.uploadFile",
      method,
      path: normalizedPath,
      statusCode,
    });

    return parsedData;
  }
}

module.exports = {
  callContainer,
  requestJson,
  requestUpload,
};
