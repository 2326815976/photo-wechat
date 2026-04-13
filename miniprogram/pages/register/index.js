const {
  issueCaptcha,
  verifyCaptcha,
  registerWithPassword,
  loginWithPassword,
  getSession,
  extractSessionUser,
} = require("../../services/photo-api");
const {
  clampChinaMobileInput,
  isValidChinaMobile,
  normalizeChinaMobile,
} = require("../../utils/phone");
const { getLegalDocuments, getLegalDocumentByKey } = require("../../utils/legal-docs");
const { getManagedPageAccess, normalizeRuntimeConfig } = require("../../utils/runtime-config");
const { guardMiniProgramPageAccess } = require("../../utils/page-access");

const SLIDER_WIDTH_FALLBACK = 56;
const CAPTCHA_TOKEN_EXPIRE_MS = 2 * 60 * 1000;

function parseMaybeJson(payload) {
  if (typeof payload !== "string") return payload;
  const text = String(payload || "").trim();
  if (!text) return text;
  try {
    return JSON.parse(text);
  } catch (e) {
    return payload;
  }
}

function pickRetryAfterFromHeaders(headerLike) {
  if (!headerLike || typeof headerLike !== "object") return 0;
  const raw =
    headerLike["Retry-After"] ||
    headerLike["retry-after"] ||
    headerLike["Retry-after"] ||
    headerLike.retryAfter ||
    "";
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.ceil(seconds);
  }
  return 0;
}

function readRetryAfterSeconds(error) {
  const direct = Number(error && error.retryAfter);
  if (Number.isFinite(direct) && direct > 0) {
    return Math.ceil(direct);
  }

  const response = error && typeof error === "object" ? error.response : null;
  if (response && typeof response === "object") {
    const body = parseMaybeJson(response.data);
    const bodyRetry = Number(body && body.retryAfter);
    if (Number.isFinite(bodyRetry) && bodyRetry > 0) {
      return Math.ceil(bodyRetry);
    }

    const headerRetry =
      pickRetryAfterFromHeaders(response.header) ||
      pickRetryAfterFromHeaders(response.headers) ||
      pickRetryAfterFromHeaders(response);
    if (headerRetry > 0) {
      return headerRetry;
    }
  }

  return 0;
}

function formatRetryAfterLabel(seconds) {
  const total = Math.max(1, Number(seconds || 0));
  if (total >= 3600) {
    const hours = Math.ceil(total / 3600);
    return `${hours}小时`;
  }
  if (total >= 60) {
    const minutes = Math.ceil(total / 60);
    return `${minutes}分钟`;
  }
  return `${total}秒`;
}

function toEpochMillis(input) {
  const value = input;
  if (value === null || value === undefined || value === "") return 0;

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    // 兼容秒级时间戳
    return numeric < 1e12 ? Math.round(numeric * 1000) : Math.round(numeric);
  }

  const parsed = new Date(String(value || "")).getTime();
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return 0;
}

function normalizeRegisterErrorMessage(raw) {
  const text = String(raw || "").trim();
  if (!text) return "注册失败，请重试";

  const lower = text.toLowerCase();
  if (text.includes("已注册")) {
    return "该手机号已注册，请直接登录";
  }
  if (text.includes("验证码") || lower.includes("captcha")) {
    return "验证码错误或已过期，请重新验证";
  }
  if (text.includes("手机号格式")) {
    return "手机号格式不正确";
  }
  if (text.includes("密码至少")) {
    return "密码至少需要 6 位";
  }
  return text;
}

function shouldReloadCaptchaAfterRegisterError(message, statusCode) {
  if (Number(statusCode) === 429) return false;
  const text = String(message || "");
  if (!text) return true;
  if (text.includes("已注册")) return false;
  return true;
}

function extractAuthUserFromPayload(payload) {
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") break;
    if (current.user && typeof current.user === "object") return current.user;
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

function readPayloadMessage(payload, fallback) {
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
      const nestedErrorMessage = String(directError.message || "").trim();
      if (nestedErrorMessage) return nestedErrorMessage;
    }

    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }
  return String(fallback || "");
}

Page({
  data: {
    safeTop: 0,
    serviceMissing: false,

    phone: "",
    password: "",
    showPassword: false,
    submitting: false,
    error: "",
    focusField: "",

    captchaId: "",
    captchaToken: "",
    captchaExpiresAt: 0,
    captchaTokenExpiresAt: 0,
    registerRetryUntil: 0,

    sliderTrackWidth: 0,
    sliderThumbWidth: SLIDER_WIDTH_FALLBACK,
    sliderFillWidth: SLIDER_WIDTH_FALLBACK,
    sliderPixelPosition: 0,
    isDragging: false,
    isVerified: false,
    isCaptchaVerifying: false,
    legalDocTabs: [],
    showLegalModal: false,
    activeLegalKey: "",
    activeLegalTitle: "",
    activeLegalVersion: "",
    activeLegalSections: [],
    activeLegalFooter: [],
    agreedToLegal: false,
    hideAudit: false,
    authMode: "phone_password",
    phoneLoginEnabled: true,
    pageTitle: "注册",
    loginEntryVisible: true,
    loginEntryLabel: "登录",
  },

  applyRuntimeConfig(runtimeConfig) {
    const normalized = normalizeRuntimeConfig(runtimeConfig);
    const authMode = String(normalized.authMode || "phone_password");
    const phoneLoginEnabled = authMode === "phone_password" || authMode === "mixed";
    const registerAccess = getManagedPageAccess(normalized, "register");
    const loginAccess = getManagedPageAccess(normalized, "login");
    const pageTitle =
      String((registerAccess && (registerAccess.headerTitle || registerAccess.navText)) || "").trim() ||
      "注册";
    const loginEntryVisible =
      Boolean(loginAccess) && String((loginAccess && loginAccess.publishState) || "").trim() === "online";
    const loginEntryLabel =
      String((loginAccess && (loginAccess.navText || loginAccess.headerTitle)) || "").trim() || "登录";
    this.setData({
      hideAudit: Boolean(normalized.hideAudit),
      authMode,
      phoneLoginEnabled,
      pageTitle,
      loginEntryVisible,
      loginEntryLabel,
    });
    this.initLegalDocuments(Boolean(normalized.hideAudit));
    return normalized;
  },

  async onLoad() {
    const app = getApp();
    const globalData = app && app.globalData ? app.globalData : {};
    const safeTop = Number(globalData.statusBarHeight || 0);
    const serviceMissing = !String(globalData.cloudRunService || "").trim();

    this.startX = 0;
    this.startTime = 0;
    this.trajectory = [];
    this.captchaExpireTimer = null;

    this.setData({ safeTop, serviceMissing });
    const runtimeConfig = this.applyRuntimeConfig(
      globalData.runtimeConfig || { hideAudit: globalData.hideAudit }
    );
    const blocked = await this.guardManagedAccess();
    if (blocked) {
      return;
    }
    if (runtimeConfig.authMode === "wechat_only" || !this.data.phoneLoginEnabled) {
      wx.showToast({ title: "当前未开放手机号注册", icon: "none" });
      wx.redirectTo({ url: "/pages/login/index" });
      return;
    }
    if (!serviceMissing) {
      void this.loadCaptcha();
    }

    if (app && typeof app.subscribeMiniProgramRuntimeConfig === "function") {
      this._unsubscribeAuditConfig = app.subscribeMiniProgramRuntimeConfig((nextRuntimeConfig) => {
        const normalized = this.applyRuntimeConfig(nextRuntimeConfig);
        if (normalized.authMode === "wechat_only") {
          wx.showToast({ title: "当前未开放手机号注册", icon: "none" });
          wx.redirectTo({ url: "/pages/login/index" });
        }
      });
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
    const normalized = this.applyRuntimeConfig(
      app && app.globalData
        ? app.globalData.runtimeConfig || { hideAudit: app.globalData.hideAudit }
        : { hideAudit: false }
    );
    const blocked = await this.guardManagedAccess();
    if (blocked) {
      return;
    }
    if (normalized.authMode === "wechat_only" || !this.data.phoneLoginEnabled) {
      wx.showToast({ title: "当前未开放手机号注册", icon: "none" });
      wx.redirectTo({ url: "/pages/login/index" });
    }
  },

  onReady() {
    this.measureSlider();
  },

  onUnload() {
    this.clearCaptchaExpireTimer();
    this.trajectory = [];
    if (typeof this._unsubscribeAuditConfig === "function") {
      this._unsubscribeAuditConfig();
      this._unsubscribeAuditConfig = null;
    }
  },

  async guardManagedAccess() {
    const result = await guardMiniProgramPageAccess({
      pageKey: "register",
      fallbackTab: "pages/profile/index",
    });
    return !result.allowed;
  },

  goBack() {
    wx.navigateBack({
      delta: 1,
      fail: () => {
        wx.navigateTo({ url: "/pages/login/index" });
      },
    });
  },

  goLogin() {
    if (!this.data.loginEntryVisible) {
      wx.showToast({ title: "当前未开放登录入口", icon: "none" });
      return;
    }
    wx.redirectTo({ url: "/pages/login/index" });
  },

  initLegalDocuments(hideAudit) {
    const nextHideAudit =
      typeof hideAudit === "boolean" ? hideAudit : Boolean(this.data.hideAudit);
    const docs = getLegalDocuments({ hideAudit: nextHideAudit });
    this.legalDocMap = {};
    docs.forEach((doc) => {
      const key = String((doc && doc.key) || "").trim();
      if (!key) return;
      this.legalDocMap[key] = doc;
    });

    const tabs = docs.map((doc) => ({
      key: String((doc && doc.key) || ""),
      title: String((doc && doc.title) || ""),
      shortTitle: String((doc && doc.shortTitle) || (doc && doc.title) || ""),
    }));
    const activeKey = String(this.data.activeLegalKey || "").trim();
    const hasActiveKey = tabs.some((tab) => String((tab && tab.key) || "") === activeKey);
    const defaultKey = hasActiveKey ? activeKey : (tabs.length > 0 ? String(tabs[0].key || "") : "");
    this.setData({ legalDocTabs: tabs });
    if (defaultKey) {
      this.applyLegalDocument(defaultKey, nextHideAudit);
    }
  },

  applyLegalDocument(key, hideAudit) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) return false;
    const nextHideAudit =
      typeof hideAudit === "boolean" ? hideAudit : Boolean(this.data.hideAudit);

    const doc =
      (this.legalDocMap && this.legalDocMap[normalizedKey]) ||
      getLegalDocumentByKey(normalizedKey, { hideAudit: nextHideAudit });
    if (!doc) return false;

    this.setData({
      activeLegalKey: String(doc.key || normalizedKey),
      activeLegalTitle: String(doc.title || ""),
      activeLegalVersion: String(doc.versionLine || ""),
      activeLegalSections: Array.isArray(doc.sections) ? doc.sections : [],
      activeLegalFooter: Array.isArray(doc.footer) ? doc.footer : [],
    });
    return true;
  },

  onOpenLegalDoc(e) {
    const key =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.docKey || "")
        : "";
    if (!this.applyLegalDocument(key)) return;
    this.setData({ showLegalModal: true });
  },

  onToggleLegalAgreement() {
    const nextAgreed = !this.data.agreedToLegal;
    const currentError = String(this.data.error || "");
    const shouldClearError =
      nextAgreed &&
      (currentError.includes("请先阅读并勾选同意") ||
        currentError.includes("用户协议") ||
        currentError.includes("隐私政策") ||
        currentError.includes("用户信息收集说明"));
    this.setData({
      agreedToLegal: nextAgreed,
      error: shouldClearError ? "" : currentError,
    });
  },

  onSwitchLegalDoc(e) {
    const key =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.docKey || "")
        : "";
    this.applyLegalDocument(key);
  },

  onCloseLegalModal() {
    if (!this.data.showLegalModal) return;
    this.setData({ showLegalModal: false });
  },

  onAcknowledgeLegal() {
    const currentError = String(this.data.error || "");
    const shouldClearError =
      currentError.includes("请先阅读并勾选同意") ||
      currentError.includes("用户协议") ||
      currentError.includes("隐私政策") ||
      currentError.includes("用户信息收集说明");
    this.setData({
      showLegalModal: false,
      agreedToLegal: true,
      error: shouldClearError ? "" : currentError,
    });
  },

  onStopPropagation() {},

  onPhoneInput(e) {
    const value = e && e.detail ? e.detail.value : "";
    this.setData({ phone: clampChinaMobileInput(value) });
  },

  onPasswordInput(e) {
    const value = e && e.detail ? e.detail.value : "";
    this.setData({ password: String(value || "") });
  },

  onFieldFocus(e) {
    const field =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.field || "")
        : "";
    this.setData({ focusField: field });
  },

  onFieldBlur() {
    this.setData({ focusField: "" });
  },

  togglePassword() {
    this.setData({ showPassword: !this.data.showPassword });
  },

  getSliderThumbWidth() {
    return Number(this.data.sliderThumbWidth || SLIDER_WIDTH_FALLBACK);
  },

  getSliderTrackWidth() {
    const thumb = this.getSliderThumbWidth();
    const track = Number(this.data.sliderTrackWidth || 0);
    return Math.max(track, thumb + 40);
  },

  getMaxSliderPosition() {
    return Math.max(this.getSliderTrackWidth() - this.getSliderThumbWidth(), 0);
  },

  updateSliderFillWidth() {
    const thumb = this.getSliderThumbWidth();
    const position = Number(this.data.sliderPixelPosition || 0);
    const width = Math.max(thumb, position + thumb);
    if (Math.abs(width - Number(this.data.sliderFillWidth || 0)) < 0.2) {
      return;
    }
    this.setData({ sliderFillWidth: width });
  },

  measureSlider(cb) {
    const query = wx.createSelectorQuery().in(this);
    query.select(".slider-track").boundingClientRect();
    query.select(".slider-thumb").boundingClientRect();
    query.exec((rows) => {
      const trackRect = rows && rows[0] ? rows[0] : null;
      const thumbRect = rows && rows[1] ? rows[1] : null;

      const trackWidth = Number((trackRect && trackRect.width) || 0);
      const thumbWidth = Number((thumbRect && thumbRect.width) || SLIDER_WIDTH_FALLBACK);

      this.setData(
        {
          sliderTrackWidth: trackWidth,
          sliderThumbWidth: thumbWidth || SLIDER_WIDTH_FALLBACK,
        },
        () => {
          this.updateSliderFillWidth();
          if (typeof cb === "function") cb();
        }
      );
    });
  },

  clearCaptchaExpireTimer() {
    if (this.captchaExpireTimer) {
      clearTimeout(this.captchaExpireTimer);
      this.captchaExpireTimer = null;
    }
  },

  scheduleCaptchaExpiryWatch() {
    this.clearCaptchaExpireTimer();
    if (this.data.serviceMissing) return;

    const now = Date.now();
    const captchaExpiresAt = Number(this.data.captchaExpiresAt || 0);
    const captchaTokenExpiresAt = Number(this.data.captchaTokenExpiresAt || 0);
    const hasVerifiedToken = Boolean(this.data.isVerified && this.data.captchaToken);

    let targetAt = captchaExpiresAt;
    if (hasVerifiedToken && captchaTokenExpiresAt > 0) {
      targetAt = targetAt > 0 ? Math.min(targetAt, captchaTokenExpiresAt) : captchaTokenExpiresAt;
    }
    if (!targetAt || targetAt <= 0) return;

    const waitMs = Math.max(80, targetAt - now);
    this.captchaExpireTimer = setTimeout(() => {
      this.captchaExpireTimer = null;

      if (this.data.submitting || this.data.isCaptchaVerifying || this.data.isDragging) {
        this.scheduleCaptchaExpiryWatch();
        return;
      }

      const current = Date.now();
      const isCaptchaExpired =
        Number(this.data.captchaExpiresAt || 0) > 0 &&
        current >= Number(this.data.captchaExpiresAt || 0);
      const isTokenExpired =
        Boolean(this.data.isVerified && this.data.captchaToken) &&
        Number(this.data.captchaTokenExpiresAt || 0) > 0 &&
        current >= Number(this.data.captchaTokenExpiresAt || 0);

      if (!isCaptchaExpired && !isTokenExpired) {
        this.scheduleCaptchaExpiryWatch();
        return;
      }

      this.setData({
        error: isTokenExpired ? "验证结果已过期，请重新拖动验证" : "验证码已过期，请重新验证",
      });
      void this.loadCaptcha();
    }, waitMs + 60);
  },

  getRegisterRetryRemainSeconds() {
    const retryUntil = Number(this.data.registerRetryUntil || 0);
    const diff = retryUntil - Date.now();
    if (diff <= 0) return 0;
    return Math.ceil(diff / 1000);
  },

  resetSlider() {
    this.startX = 0;
    this.startTime = 0;
    this.trajectory = [];

    this.setData(
      {
        sliderPixelPosition: 0,
        isDragging: false,
        isVerified: false,
        isCaptchaVerifying: false,
        captchaToken: "",
        captchaTokenExpiresAt: 0,
      },
      () => {
        this.updateSliderFillWidth();
        this.scheduleCaptchaExpiryWatch();
      }
    );
  },

  async loadCaptcha() {
    if (this.data.serviceMissing) return;

    try {
      const data = await issueCaptcha();
      const payload = data && typeof data === "object" ? data : {};
      const captchaId = String(readFieldFromPayloadChain(payload, "captchaId") || "").trim();
      const expiresAtRaw = readFieldFromPayloadChain(payload, ["expiresAt", "expires_at"]) || 0;
      if (!captchaId) {
        throw new Error("加载验证码失败，请稍后重试");
      }
      this.resetSlider();
      this.setData({
        captchaId,
        captchaExpiresAt: toEpochMillis(expiresAtRaw),
        error: "",
      }, () => {
        this.scheduleCaptchaExpiryWatch();
      });
      this.measureSlider();
    } catch (e) {
      const statusCode = Number((e && e.statusCode) || 0);
      const retryAfter = readRetryAfterSeconds(e);
      if (statusCode === 429 || retryAfter > 0) {
        const waitSeconds = Math.max(1, retryAfter || 60);
        const blockedUntil = Date.now() + waitSeconds * 1000;
        this.setData({
          registerRetryUntil: Math.max(Number(this.data.registerRetryUntil || 0), blockedUntil),
          error: `操作过于频繁，请在${formatRetryAfterLabel(waitSeconds)}后重试`,
        });
        return;
      }

      const service = String((e && e.service) || "");
      const baseMessage = String((e && e.message) || "加载验证码失败，请刷新重试");
      const hint404 =
        statusCode === 404
          ? `验证码接口不存在（当前服务：${service || "未识别"}），请确认云托管服务名并重新部署后端`
          : "";
      if (Array.isArray(e && e.triedPaths)) {
        try {
          console.warn("[register] captcha tried paths", e.triedPaths);
        } catch (_) {
          // ignore
        }
      }
      this.setData({
        error: hint404 || baseMessage,
      });
    }
  },

  onRefreshCaptcha() {
    if (this.data.serviceMissing || this.data.submitting || this.data.isCaptchaVerifying || this.data.isDragging) {
      return;
    }
    void this.loadCaptcha();
  },

  recordTrajectory(position) {
    const now = Date.now();
    const points = Array.isArray(this.trajectory) ? this.trajectory : [];
    const last = points.length > 0 ? points[points.length - 1] : null;

    if (!last || now - last.timestamp >= 12 || Math.abs(position - last.position) >= 1) {
      const timestamp = last ? Math.max(now, last.timestamp + 1) : now;
      points.push({
        position,
        timestamp,
      });
      this.trajectory = points.slice(0, 600);
    }
  },

  onSliderStart(e) {
    if (
      this.data.isVerified ||
      this.data.isCaptchaVerifying ||
      !this.data.captchaId ||
      this.data.serviceMissing
    ) {
      return;
    }

    const touch = e && e.touches && e.touches[0] ? e.touches[0] : null;
    if (!touch) return;

    if (!this.data.sliderTrackWidth || !this.data.sliderThumbWidth) {
      this.measureSlider();
    }

    const now = Date.now();
    this.startX = Number(touch.clientX || 0);
    this.startTime = now;
    this.trajectory = [
      {
        position: Number(this.data.sliderPixelPosition || 0),
        timestamp: now,
      },
    ];

    this.setData({
      isDragging: true,
      isVerified: false,
      captchaToken: "",
      captchaTokenExpiresAt: 0,
      error: "",
    });
  },

  onSliderMove(e) {
    if (!this.data.isDragging || this.data.isVerified || this.data.isCaptchaVerifying) {
      return;
    }

    const touch = e && e.touches && e.touches[0] ? e.touches[0] : null;
    if (!touch) return;

    const maxPosition = this.getMaxSliderPosition();
    const offset = Number(touch.clientX || 0) - Number(this.startX || 0);
    let next = offset;
    if (next < 0) next = 0;
    if (next > maxPosition) next = maxPosition;

    this.setData(
      {
        sliderPixelPosition: next,
      },
      () => {
        this.updateSliderFillWidth();
      }
    );
    this.recordTrajectory(next);
  },

  async onSliderEnd() {
    if (!this.data.isDragging || this.data.isVerified || this.data.isCaptchaVerifying) {
      return;
    }

    const maxPosition = this.getMaxSliderPosition();
    this.setData({ isDragging: false });

    if (this.data.sliderPixelPosition < maxPosition - 3) {
      this.setData(
        {
          sliderPixelPosition: 0,
        },
        () => {
          this.updateSliderFillWidth();
        }
      );
      return;
    }

    if (!this.data.captchaId || !this.startTime) {
      this.setData({ error: "验证码已失效，请刷新重试" });
      await this.loadCaptcha();
      return;
    }

    if (Number(this.data.captchaExpiresAt || 0) > 0 && Date.now() > Number(this.data.captchaExpiresAt || 0)) {
      this.setData({ error: "验证码已过期，请重新验证" });
      await this.loadCaptcha();
      return;
    }

    this.setData(
      {
        sliderPixelPosition: maxPosition,
      },
      () => {
        this.updateSliderFillWidth();
      }
    );

    const last = this.trajectory.length > 0 ? this.trajectory[this.trajectory.length - 1] : null;
    const finalTimestamp = last ? Math.max(Date.now(), Number(last.timestamp || 0) + 1) : Date.now();
    this.trajectory.push({
      position: maxPosition,
      timestamp: finalTimestamp,
    });

    this.setData({ isCaptchaVerifying: true });

    try {
      const data = await verifyCaptcha({
        captchaId: this.data.captchaId,
        positionPercent: 100,
        trajectory: this.trajectory,
        startTime: this.startTime,
        containerWidth: this.getSliderTrackWidth(),
        sliderWidth: this.getSliderThumbWidth(),
      });
      const payload = data && typeof data === "object" ? data : {};
      const verifyToken = String(readFieldFromPayloadChain(payload, "verificationToken") || "").trim();
      const verifyValid = Boolean(readFieldFromPayloadChain(payload, "valid"));
      const shouldRefreshCaptcha = Boolean(readFieldFromPayloadChain(payload, "refreshCaptcha"));

      if (verifyValid && verifyToken) {
        const tokenExpiresAt = Date.now() + CAPTCHA_TOKEN_EXPIRE_MS;
        this.setData({
          isVerified: true,
          captchaToken: verifyToken,
          captchaTokenExpiresAt: tokenExpiresAt,
          error: "",
        }, () => {
          this.scheduleCaptchaExpiryWatch();
        });
        return;
      }

      this.setData({
        isVerified: false,
        captchaToken: "",
        captchaTokenExpiresAt: 0,
        error: readPayloadMessage(payload, "验证失败，请重新拖动"),
      });

      if (shouldRefreshCaptcha) {
        await this.loadCaptcha();
      } else {
        this.setData(
          {
            sliderPixelPosition: 0,
          },
          () => {
            this.updateSliderFillWidth();
          }
        );
      }
    } catch (e) {
      const statusCode = Number((e && e.statusCode) || 0);
      const retryAfter = readRetryAfterSeconds(e);
      const failureMessage = String((e && e.message) || "").trim();
      if (statusCode === 429 || retryAfter > 0) {
        const waitSeconds = Math.max(1, retryAfter || 60);
        const blockedUntil = Date.now() + waitSeconds * 1000;
        this.setData({
          isVerified: false,
          captchaToken: "",
          captchaTokenExpiresAt: 0,
          registerRetryUntil: Math.max(Number(this.data.registerRetryUntil || 0), blockedUntil),
          error: `操作过于频繁，请在${formatRetryAfterLabel(waitSeconds)}后重试`,
        });
        return;
      }

      this.setData({
        isVerified: false,
        captchaToken: "",
        captchaTokenExpiresAt: 0,
        error: failureMessage || "验证失败，请重新拖动",
      });
      await this.loadCaptcha();
    } finally {
      this.setData({ isCaptchaVerifying: false });
    }
  },

  async submit() {
    if (this.data.serviceMissing || this.data.submitting || this.data.isCaptchaVerifying) return;
    if (!this.data.phoneLoginEnabled) {
      this.setData({ error: "当前未开放手机号注册" });
      return;
    }

    const phone = normalizeChinaMobile(this.data.phone);
    const password = String(this.data.password || "");
    const retryRemainSeconds = this.getRegisterRetryRemainSeconds();

    if (!this.data.agreedToLegal) {
      this.setData({
        error: "请先阅读并勾选同意《用户协议》《隐私政策》《用户信息收集说明》",
      });
      return;
    }

    if (retryRemainSeconds > 0) {
      this.setData({
        error: `注册过于频繁，请在${formatRetryAfterLabel(retryRemainSeconds)}后重试`,
      });
      return;
    }

    if (!isValidChinaMobile(phone)) {
      this.setData({ error: "请输入有效的手机号" });
      return;
    }
    if (password.length < 6) {
      this.setData({ error: "密码至少需要 6 位" });
      return;
    }
    if (!this.data.isVerified || !this.data.captchaToken) {
      this.setData({ error: "请完成滑块验证" });
      return;
    }
    if (!this.data.captchaId) {
      this.setData({ error: "验证码已过期，请刷新重试" });
      return;
    }
    if (Number(this.data.captchaExpiresAt || 0) > 0 && Date.now() > Number(this.data.captchaExpiresAt || 0)) {
      this.setData({ error: "验证码已过期，请重新验证" });
      await this.loadCaptcha();
      return;
    }
    if (
      Number(this.data.captchaTokenExpiresAt || 0) > 0 &&
      Date.now() > Number(this.data.captchaTokenExpiresAt || 0)
    ) {
      this.setData({ error: "验证结果已过期，请重新拖动验证" });
      await this.loadCaptcha();
      return;
    }

    this.setData({
      submitting: true,
      error: "",
    });

    try {
      await registerWithPassword(phone, password, this.data.captchaId, this.data.captchaToken);

      let hasSessionUser = false;
      try {
        const session = await getSession();
        hasSessionUser = Boolean(extractSessionUser(session));
      } catch (e) {
        hasSessionUser = false;
      }

      if (!hasSessionUser) {
        const loginRes = await loginWithPassword(phone, password);
        const user = extractAuthUserFromPayload(loginRes);
        if (!user) {
          this.setData({ error: "注册成功，但自动登录失败，请前往登录页手动登录" });
          wx.redirectTo({ url: "/pages/login/index" });
          return;
        }
      }

      wx.showToast({
        title: "注册成功",
        icon: "success",
      });
      this.setData({ registerRetryUntil: 0 });
      wx.switchTab({ url: "/pages/profile/index" });
    } catch (e) {
      const statusCode = Number((e && e.statusCode) || 0);
      const retryAfter = readRetryAfterSeconds(e);
      if (statusCode === 429 || retryAfter > 0) {
        const waitSeconds = Math.max(1, retryAfter || 60);
        const blockedUntil = Date.now() + waitSeconds * 1000;
        this.setData({
          registerRetryUntil: Math.max(Number(this.data.registerRetryUntil || 0), blockedUntil),
          error: `注册过于频繁，请在${formatRetryAfterLabel(waitSeconds)}后重试`,
        });
        return;
      }

      const message = normalizeRegisterErrorMessage((e && e.message) || "");
      this.setData({
        error: message,
      });
      if (shouldReloadCaptchaAfterRegisterError(message, statusCode)) {
        await this.loadCaptcha();
      }
    } finally {
      this.setData({ submitting: false });
    }
  },
});
