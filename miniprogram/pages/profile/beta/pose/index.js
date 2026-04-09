const { dbQuery, dbRpc } = require("../../../../services/photo-api");
const { resolvePublicUrl } = require("../../../../utils/storage-url");
const {
  applyPagePresentationToPage,
  subscribePagePresentation,
} = require("../../../../utils/page-presentation");
const { normalizeRuntimeConfig } = require("../../../../utils/runtime-config");

const TAGS_CACHE_KEY = "pose-tags-cache-v2";
const TAGS_CACHE_TTL = 2 * 60 * 60 * 1000;
const TAGS_REFRESH_MIN_INTERVAL = 10 * 1000;
const TAGS_REFRESH_POLL_INTERVAL = 60 * 1000;

const POSE_CACHE_KEY = "pose-current-cache-v1";
const POSE_CACHE_TTL = 30 * 60 * 1000;
const BETA_POSE_BYPASS_STORAGE_KEY = "beta_pose_bypass_until";

const VIEW_BUFFER_FLUSH_INTERVAL = 5000;
const VIEW_BUFFER_MAX_SIZE = 50;
const PAGE_READY_DELAY = 20;
const POSE_ENTER_DELAY = 12;
const POSE_SWITCH_OUT_DURATION = 170;
const POSE_SWITCH_IN_DURATION = 340;
const POSE_SWITCH_TOTAL_DURATION = POSE_SWITCH_OUT_DURATION + POSE_SWITCH_IN_DURATION + 24;

function isSortOrderColumnMissing(error) {
  const message = String(
    (error && typeof error === "object" && error.message) || error || ""
  ).toLowerCase();
  return (
    message.includes("sort_order") &&
    (
      message.includes("unknown column") ||
      message.includes("does not exist") ||
      (message.includes("column") && message.includes("not found"))
    )
  );
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

function extractPoseRows(payload) {
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (Array.isArray(current)) return current;
    if (!current || typeof current !== "object") break;
    if (Array.isArray(current.poses)) return current.poses;
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
  const headerInnerHeight = 88 * unit; // 与照片墙保持一致
  const top = Number(safeTop || 0) + headerInnerHeight;
  return Math.max(0, Math.round(top));
}

Page({
  data: {
    safeTop: 0,
    tagbarStickyTop: 0,

    serviceMissing: false,
    hideAudit: false,
    betaPoseBypassAllowed: false,
    backendReady: false,
    backendReconnecting: false,

    tags: [],
    displayTags: [],
    selectedTags: [],
    selectedTagsMap: {},

    currentPose: null,
    posePool: [],
    isAnimating: false,
    poseWrapAnimation: {},

    showTagSelector: false,
    shakeEnabled: false,
    auditChecking: true,
    pageReady: false,
    pagePresentationMode: "tabbar",
    pageFallbackRoute: "",
    pageFallbackTab: "pages/profile/index",
    hasBottomTabbar: false,

    skeletonTags: [1, 2, 3, 4, 5, 6, 7, 8],
    skeletonChips: [1, 2, 3],

  },

  // 非 data 状态：避免频繁 setData
  recentPoseIds: [],
  viewBuffer: {},
  viewFlushTimer: null,
  isPrefetching: false,
  accelListening: false,
  lastShakeAt: 0,
  lastAccel: null,
  pageReadyTimer: null,
  poseEnterTimer: null,
  shuffleSwapTimer: null,
  shuffleDoneTimer: null,
  tagsRefreshTimer: null,
  lastTagsRefreshAt: 0,
  isRefreshingTags: false,
  isPageAlive: false,
  homeBootstrapped: false,

  applyRuntimeConfig(runtimeConfig) {
    const normalized = normalizeRuntimeConfig(runtimeConfig);
    this.betaPoseBypassAllowed = Boolean(
      normalized.featureFlags && normalized.featureFlags.allowPoseBetaBypass
    );
    this.setData({
      hideAudit: Boolean(normalized.hideAudit),
      betaPoseBypassAllowed: Boolean(this.betaPoseBypassAllowed),
      auditChecking: false,
    });
    return normalized;
  },

  applyPagePresentation() {
    const app = typeof getApp === "function" ? getApp() : null;
    return applyPagePresentationToPage(this, app, "pages/profile/beta/pose/index");
  },

  onLoad() {
    this.isPageAlive = true;
    const app = getApp();
    const globalData = app && app.globalData ? app.globalData : {};
    const safeTop = Number(globalData.statusBarHeight || 0);
    const serviceMissing = !String(globalData.cloudRunService || "").trim();
    const backendReady = serviceMissing ? true : Boolean(globalData.backendReady);
    const backendReconnecting = !backendReady && Boolean(globalData.backendReconnecting);
    this.homeBootstrapped = false;
    this._lastSeenAppEnterSeq = Math.max(0, Number(globalData.appEnterSeq || 0));
    this.setData({
      safeTop,
      tagbarStickyTop: computeTagbarStickyTop(safeTop),
      serviceMissing,
      backendReady,
      backendReconnecting,
    });
    this.applyRuntimeConfig(globalData.runtimeConfig || { hideAudit: globalData.hideAudit });
    this.applyPagePresentation();

    if (app && typeof app.subscribeMiniProgramRuntimeConfig === "function") {
      this._unsubscribeAuditConfig = app.subscribeMiniProgramRuntimeConfig((runtimeConfig) => {
        this.applyRuntimeConfig(runtimeConfig);
        this.startHomePageIfNeeded();
      });
    }
    this._unsubscribePagePresentation = subscribePagePresentation(
      app,
      this,
      "pages/profile/beta/pose/index"
    );
    if (app && typeof app.subscribeBackendStatus === "function") {
      this._unsubscribeBackendStatus = app.subscribeBackendStatus((status) => {
        const ready = Boolean(status && status.backendReady);
        const reconnecting = !ready && Boolean(status && status.backendReconnecting);
        this.setData({
          backendReady: ready,
          backendReconnecting: reconnecting,
        });
        this.startHomePageIfNeeded();
      });
    }

    if (!serviceMissing && !backendReady && app && typeof app.ensureBackendReady === "function") {
      void app.ensureBackendReady();
    }
    this.startHomePageIfNeeded();
  },

  async onShow() {
    const app = typeof getApp === "function" ? getApp() : null;
    this.applyPagePresentation();
    const appEnterSeq = Math.max(0, Number(app && app.globalData ? app.globalData.appEnterSeq : 0));
    const lastSeenAppEnterSeq = Math.max(0, Number(this._lastSeenAppEnterSeq || 0));
    const isForegroundReturn = appEnterSeq > lastSeenAppEnterSeq;
    this._lastSeenAppEnterSeq = Math.max(appEnterSeq, lastSeenAppEnterSeq);
    this.applyRuntimeConfig(
      app && app.globalData
        ? app.globalData.runtimeConfig || { hideAudit: app.globalData.hideAudit }
        : { hideAudit: false }
    );
    if (!this.data.serviceMissing) {
      const accessResult = await guardMiniProgramPageAccess({
        pageKey: "pose",
        presentationMode: presentationState.accessMode || presentationState.mode,
      });
      if (!accessResult.allowed) {
        return;
      }
    }
    if (!this.data.serviceMissing && app && typeof app.ensureBackendReady === "function") {
      if (!this.data.backendReady) {
        this.setData({ backendReconnecting: true });
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

    this.startHomePageIfNeeded();
    if (!this.data.pageReady) {
      this.markPageReady();
    }

    if (this.data.shakeEnabled) {
      this.startShake();
    }

    const skipSoftRefresh = this.consumeSuppressRefreshOnShow() || (isForegroundReturn && this.homeBootstrapped && !nextBackendReconnecting);
    if (!this.data.serviceMissing) {
      if (!skipSoftRefresh) {
        this.refreshTags({ force: false });
      }
      this.startTagsRefreshTimer();
    }
    this.startViewFlushTimer();
  },

  onHide() {
    this.clearAnimationTimers();
    this.stopShake();
    this.stopTagsRefreshTimer();
    this.stopViewFlushTimer();
    this.flushViewCounts();
  },

  onUnload() {
    this.isPageAlive = false;
    this.homeBootstrapped = false;
    this.betaPoseBypassAllowed = false;
    this.clearAnimationTimers();
    this.stopShake();
    this.stopTagsRefreshTimer();
    this.stopViewFlushTimer();
    this.flushViewCounts();
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

  consumeBetaPoseBypass() {
    const app = typeof getApp === "function" ? getApp() : null;
    const globalData = app && app.globalData ? app.globalData : {};
    const route = String(globalData.betaFeatureBypassRoute || "")
      .trim()
      .toLowerCase()
      .split("?")[0]
      .replace(/\/+$/, "");
    const expiresAt = Number(globalData.betaFeatureBypassExpiresAt || 0);
    let isValid =
      (route === "/pose" ||
        route === "/poses" ||
        route === "/pages/index/index" ||
        route === "pages/index/index") &&
      expiresAt > Date.now();

    if (!isValid) {
      try {
        const cachedUntil = Number(wx.getStorageSync(BETA_POSE_BYPASS_STORAGE_KEY) || 0);
        isValid = cachedUntil > Date.now();
      } catch (error) {
        isValid = false;
      }
    }

    if (!isValid) {
      return false;
    }

    globalData.betaFeatureBypassRoute = "";
    globalData.betaFeatureBypassExpiresAt = 0;
    try {
      wx.removeStorageSync(BETA_POSE_BYPASS_STORAGE_KEY);
    } catch (error) {
      // ignore storage cleanup errors
    }
    return true;
  },

  redirectToGallery() {
    if (this._redirectingToGallery) return;
    this._redirectingToGallery = true;
    wx.switchTab({
      url: "/pages/gallery/index",
      complete: () => {
        this._redirectingToGallery = false;
      },
    });
  },

  startHomePageIfNeeded() {
    if (this.homeBootstrapped) return;
    if ((this.data.hideAudit && !this.betaPoseBypassAllowed) || this.data.auditChecking) return;
    if (!this.data.serviceMissing && !this.data.backendReady) return;
    this.homeBootstrapped = true;

    this.loadCachedTags();
    this.loadCachedPose();
    this.markPageReady();
    this.bootstrap();
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

  clearAnimationTimers() {
    if (this.pageReadyTimer) {
      clearTimeout(this.pageReadyTimer);
      this.pageReadyTimer = null;
    }
    if (this.poseEnterTimer) {
      clearTimeout(this.poseEnterTimer);
      this.poseEnterTimer = null;
    }
    if (this.shuffleSwapTimer) {
      clearTimeout(this.shuffleSwapTimer);
      this.shuffleSwapTimer = null;
    }
    if (this.shuffleDoneTimer) {
      clearTimeout(this.shuffleDoneTimer);
      this.shuffleDoneTimer = null;
    }
  },

  markPageReady() {
    if (this.pageReadyTimer) {
      clearTimeout(this.pageReadyTimer);
      this.pageReadyTimer = null;
    }
    this.pageReadyTimer = setTimeout(() => {
      this.pageReadyTimer = null;
      if (!this.isPageAlive) return;
      this.setData({ pageReady: true });
    }, PAGE_READY_DELAY);
  },

  triggerPoseEnter() {
    if (!this.data.currentPose) return;
    if (this.poseEnterTimer) {
      clearTimeout(this.poseEnterTimer);
      this.poseEnterTimer = null;
    }
    const rotate = this.calcPoseRotate(this.data.currentPose);
    const startAnimation = wx.createAnimation({ transformOrigin: "50% 50%" });
    startAnimation.opacity(0).scale(0.9).rotate(-5).step({ duration: 0 });

    this.setData({
      poseWrapAnimation: startAnimation.export(),
    });
    this.poseEnterTimer = setTimeout(() => {
      this.poseEnterTimer = null;
      if (!this.isPageAlive) return;
      const firstSegmentDuration = Math.max(
        120,
        Math.min(220, POSE_SWITCH_IN_DURATION - 120)
      );
      const secondSegmentDuration = Math.max(
        100,
        POSE_SWITCH_IN_DURATION - firstSegmentDuration
      );
      const overshootRotate = rotate + (rotate >= 0 ? 0.45 : -0.45);
      const enterAnimation = wx.createAnimation({ transformOrigin: "50% 50%" });
      enterAnimation
        .opacity(1)
        .scale(1.035)
        .rotate(overshootRotate)
        .step({
          duration: firstSegmentDuration,
          timingFunction: "ease-out",
        });
      enterAnimation
        .opacity(1)
        .scale(1)
        .rotate(rotate)
        .step({
          duration: secondSegmentDuration,
          timingFunction: "ease-in-out",
        });

      this.setData({
        poseWrapAnimation: enterAnimation.export(),
      });
    }, POSE_ENTER_DELAY);
  },

  triggerPoseExit() {
    const exitAnimation = wx.createAnimation({ transformOrigin: "50% 50%" });
    exitAnimation
      .opacity(0)
      .scale(0.9)
      .rotate(5)
      .step({
        duration: POSE_SWITCH_OUT_DURATION,
        timingFunction: "ease-in",
      });

    this.setData({
      poseWrapAnimation: exitAnimation.export(),
    });
  },

  openTagSelector() {
    this.setData({ showTagSelector: true });
  },

  closeTagSelector() {
    this.setData({ showTagSelector: false });
  },

  openFullscreen() {
    const pose = this.data.currentPose;
    if (!pose || !pose.image_url_resolved) return;
    this.markTransientForegroundReturn();
    wx.previewImage({
      current: pose.image_url_resolved,
      urls: [pose.image_url_resolved],
    });
  },

  onShakeToggle(e) {
    const enabled = Boolean(e && e.detail && e.detail.value);
    this.setData({ shakeEnabled: enabled });

    if (enabled) {
      this.startShake();
    } else {
      this.stopShake();
    }
  },

  startShake() {
    if (this.accelListening) return;
    this.accelListening = true;
    this.lastAccel = null;

    wx.startAccelerometer({
      interval: "game",
      fail: () => {
        this.accelListening = false;
      },
    });

    wx.onAccelerometerChange((res) => {
      if (!this.data.shakeEnabled) return;

      const now = Date.now();
      if (now - this.lastShakeAt < 2000) return;

      const last = this.lastAccel;
      this.lastAccel = res;
      if (!last) return;

      const speed =
        Math.abs(res.x - last.x) + Math.abs(res.y - last.y) + Math.abs(res.z - last.z);

      // WeChat 加速度值通常在 [-1, 1] 左右，简单阈值足够。
      if (speed > 1.6) {
        this.lastShakeAt = now;
        this.onShuffle();
      }
    });
  },

  stopShake() {
    if (!this.accelListening) return;
    this.accelListening = false;
    this.lastAccel = null;
    this.lastShakeAt = 0;
    wx.stopAccelerometer({}); // 忽略失败
    if (wx.offAccelerometerChange) {
      wx.offAccelerometerChange();
    }
  },

  startViewFlushTimer() {
    if (this.viewFlushTimer) return;
    this.viewFlushTimer = setInterval(() => {
      this.flushViewCounts();
    }, VIEW_BUFFER_FLUSH_INTERVAL);
  },

  stopViewFlushTimer() {
    if (!this.viewFlushTimer) return;
    clearInterval(this.viewFlushTimer);
    this.viewFlushTimer = null;
  },

  startTagsRefreshTimer() {
    if (this.data.serviceMissing) return;
    if (this.tagsRefreshTimer) return;
    this.tagsRefreshTimer = setInterval(() => {
      this.refreshTags({ force: false });
    }, TAGS_REFRESH_POLL_INTERVAL);
  },

  stopTagsRefreshTimer() {
    if (!this.tagsRefreshTimer) return;
    clearInterval(this.tagsRefreshTimer);
    this.tagsRefreshTimer = null;
  },

  recordPoseView(poseId) {
    const id = Number(poseId || 0);
    if (!id) return;

    const currentBuffer =
      this.viewBuffer && typeof this.viewBuffer === "object" ? this.viewBuffer : {};
    if (currentBuffer !== this.viewBuffer) {
      this.viewBuffer = currentBuffer;
    }

    currentBuffer[id] = Number(currentBuffer[id] || 0) + 1;

    if (Object.keys(currentBuffer).length >= VIEW_BUFFER_MAX_SIZE) {
      this.flushViewCounts();
    }
  },

  async flushViewCounts() {
    const buffer =
      this.viewBuffer && typeof this.viewBuffer === "object" ? this.viewBuffer : {};
    if (buffer !== this.viewBuffer) {
      this.viewBuffer = buffer;
    }
    const ids = Object.keys(buffer);
    if (ids.length === 0) return;

    const poseViews = ids
      .map((id) => ({
        pose_id: Number(id),
        count: Number(buffer[id] || 0),
      }))
      .filter((x) => x.pose_id && x.count);

    if (poseViews.length === 0) {
      this.viewBuffer = {};
      return;
    }

    // 先清空（失败也不阻塞 UI；下次自然继续累计）
    this.viewBuffer = {};

    try {
      await dbRpc("batch_increment_pose_views", { pose_views: poseViews });
    } catch (e) {
      // ignore
    }
  },

  loadCachedTags() {
    try {
      const raw = wx.getStorageSync(TAGS_CACHE_KEY);
      if (!raw) return;

      const parsed = JSON.parse(raw);
      const tags = parsed && Array.isArray(parsed.tags) ? parsed.tags : [];
      const cachedAt = Number((parsed && parsed.cachedAt) || 0);
      if (!tags.length) return;

      const expired = !cachedAt || Date.now() - cachedAt > TAGS_CACHE_TTL;
      if (expired) return;

      this.applyTags(tags);
    } catch (e) {
      // ignore
    }
  },

  loadCachedPose() {
    try {
      const raw = wx.getStorageSync(POSE_CACHE_KEY);
      if (!raw) return;

      const parsed = JSON.parse(raw);
      const pose = parsed && parsed.pose ? parsed.pose : null;
      const cachedAt = Number((parsed && parsed.cachedAt) || 0);
      if (!pose || !pose.id) return;

      const expired = !cachedAt || Date.now() - cachedAt > POSE_CACHE_TTL;
      if (expired) return;

      const normalized = this.normalizePose(pose);
      this.setData({
        currentPose: normalized,
      }, () => {
        this.triggerPoseEnter();
      });
      this.addRecentPoseId(normalized.id);
    } catch (e) {
      // ignore
    }
  },

  savePoseCache(pose) {
    if (!pose || !pose.id) return;
    try {
      wx.setStorageSync(
        POSE_CACHE_KEY,
        JSON.stringify({ pose, cachedAt: Date.now() })
      );
    } catch (e) {
      // ignore
    }
  },

  saveTagsCache(tags) {
    try {
      wx.setStorageSync(
        TAGS_CACHE_KEY,
        JSON.stringify({ tags, cachedAt: Date.now() })
      );
    } catch (e) {
      // ignore
    }
  },

  sortPoseTags(tags) {
    return (Array.isArray(tags) ? tags : [])
      .map((row, index) => {
        const name = String((row && row.name) || "").trim();
        if (!name) return null;

        const usageCountRaw = Number(row && row.usage_count);
        const sortOrderRaw = Number(row && row.sort_order);
        return Object.assign({}, row, {
          name,
          usage_count: Number.isFinite(usageCountRaw) ? usageCountRaw : 0,
          sort_order:
            Number.isFinite(sortOrderRaw) && sortOrderRaw > 0
              ? Math.round(sortOrderRaw)
              : (index + 1) * 10,
        });
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (a.sort_order !== b.sort_order) {
          return a.sort_order - b.sort_order;
        }
        if (b.usage_count !== a.usage_count) {
          return b.usage_count - a.usage_count;
        }
        return String(a.name).localeCompare(String(b.name), "zh-CN");
      });
  },

  applyTags(tags) {
    const orderedTags = this.sortPoseTags(tags);
    // 首屏仅展示前 8 个标签
    const displayTags = orderedTags.slice(0, 8);
    const selectedTagsMap = this.buildSelectedTagMap(this.data.selectedTags);

    this.setData({
      tags: orderedTags,
      displayTags,
      selectedTagsMap,
    });
  },

  buildSelectedTagMap(selectedTags) {
    const map = {};
    (selectedTags || []).forEach((name) => {
      map[String(name)] = true;
    });
    return map;
  },

  async bootstrap() {
    if (this.data.serviceMissing) {
      // UI 可展示，但不发起请求
      return;
    }

    const hasCachedPose = Boolean(this.data.currentPose && this.data.currentPose.id);
    await Promise.all([
      this.refreshTags(),
      this.refreshPosePool({ reset: !hasCachedPose }),
    ]);
  },

  async refreshTags(options) {
    const opts = options && typeof options === "object" ? options : {};
    const force = Boolean(opts.force);
    const now = Date.now();
    if (
      !force &&
      this.lastTagsRefreshAt > 0 &&
      now - this.lastTagsRefreshAt < TAGS_REFRESH_MIN_INTERVAL
    ) {
      return;
    }
    if (this.isRefreshingTags) {
      return;
    }

    this.isRefreshingTags = true;
    this.lastTagsRefreshAt = now;
    try {
      let result = await dbQuery({
        table: "pose_tags",
        action: "select",
        columns: "id,name,usage_count,sort_order",
        orders: [
          { column: "sort_order", ascending: true },
          { column: "usage_count", ascending: false },
          { column: "name", ascending: true },
        ],
        limit: 200,
      });

      if (result && result.error && isSortOrderColumnMissing(result.error)) {
        result = await dbQuery({
          table: "pose_tags",
          action: "select",
          columns: "id,name,usage_count",
          orders: [{ column: "usage_count", ascending: false }],
          limit: 200,
        });
      }

      const tags = result && Array.isArray(result.data) ? result.data : [];
      if (tags.length > 0) {
        this.applyTags(tags);
        this.saveTagsCache(tags);
      }
    } catch (e) {
      // ignore
    } finally {
      this.isRefreshingTags = false;
    }
  },

  normalizePose(pose) {
    const imageUrl = resolvePublicUrl(pose && pose.image_url);
    return Object.assign({}, pose, {
      tags: pose && Array.isArray(pose.tags) ? pose.tags : [],
      image_url_resolved: imageUrl,
    });
  },

  // Web: rotate: (id % 3 - 1) * 1.2
  calcPoseRotate(pose) {
    const id = Number(pose && pose.id ? pose.id : 0);
    if (!id) return 0;
    return ((id % 3) - 1) * 1.2;
  },

  addRecentPoseId(id) {
    const poseId = Number(id || 0);
    if (!poseId) return;

    const history = Array.isArray(this.recentPoseIds) ? this.recentPoseIds : [];
    const next = [poseId, ...history.filter((x) => x !== poseId)];
    this.recentPoseIds = next.slice(0, 10);
  },

  getRecentPoseIds() {
    if (!Array.isArray(this.recentPoseIds)) {
      this.recentPoseIds = [];
    }
    return this.recentPoseIds;
  },

  async refreshPosePool(opts) {
    const reset = Boolean(opts && opts.reset);
    const selectedTags = this.data.selectedTags;
    const tagFilter = selectedTags.length > 0 ? selectedTags : null;

    try {
      const result = await dbRpc("get_random_poses_batch", {
        tag_filter: tagFilter,
        batch_size: 12,
        exclude_ids: this.getRecentPoseIds(),
      });

      if (result && result.error) return;
      const payload = result ? result.data : null;
      if (hasExplicitRpcFailure(payload)) return;
      const poses = extractPoseRows(payload);
      const normalized = poses.map((p) => this.normalizePose(p));
      const uniqueById = [];
      const seenIds = new Set();
      normalized.forEach((pose) => {
        const poseId = Number((pose && pose.id) || 0);
        if (!poseId || seenIds.has(poseId)) return;
        seenIds.add(poseId);
        uniqueById.push(pose);
      });
      if (!uniqueById.length) return;

      if (reset) {
        const firstIndex = Math.floor(Math.random() * uniqueById.length);
        const first = uniqueById[firstIndex];
        const rest = uniqueById.filter((_, index) => index !== firstIndex);
        this.setData({
          currentPose: first,
          posePool: rest,
        }, () => {
          this.triggerPoseEnter();
        });
        this.savePoseCache(first);
        this.addRecentPoseId(first.id);
        this.recordPoseView(first.id);
      } else {
        const currentPoseId = Number((this.data.currentPose && this.data.currentPose.id) || 0);
        const existing = this.data.posePool || [];
        const existingIds = new Set(existing.map((p) => Number(p.id || 0)));
        const merged = existing.concat(
          uniqueById.filter((p) => {
            const poseId = Number((p && p.id) || 0);
            if (!poseId) return false;
            if (poseId === currentPoseId) return false;
            return !existingIds.has(poseId);
          })
        );
        this.setData({ posePool: merged });
      }
    } catch (e) {
      // ignore
    }
  },

  async prefetchMoreIfNeeded() {
    if (this.isPrefetching) return;
    if (this.data.selectedTags.length > 0) return;
    if ((this.data.posePool || []).length >= 5) return;

    this.isPrefetching = true;
    try {
      const result = await dbRpc("get_random_poses_batch", {
        tag_filter: null,
        batch_size: 25,
        exclude_ids: this.getRecentPoseIds(),
      });

      if (result && result.error) return;
      const payload = result ? result.data : null;
      if (hasExplicitRpcFailure(payload)) return;
      const poses = extractPoseRows(payload);
      const normalized = poses.map((p) => this.normalizePose(p));
      if (!normalized.length) return;

      const existing = this.data.posePool || [];
      const currentPoseId = Number((this.data.currentPose && this.data.currentPose.id) || 0);
      const existingIds = new Set(existing.map((p) => Number(p.id || 0)));
      const merged = existing.concat(
        normalized.filter((p) => {
          const poseId = Number((p && p.id) || 0);
          if (!poseId) return false;
          if (poseId === currentPoseId) return false;
          return !existingIds.has(poseId);
        })
      );
      this.setData({ posePool: merged });
    } catch (e) {
      // ignore
    } finally {
      this.isPrefetching = false;
    }
  },

  async onShuffle() {
    if (this.data.serviceMissing) return;
    if (this.data.isAnimating) return;
    if (this.shuffleSwapTimer) {
      clearTimeout(this.shuffleSwapTimer);
      this.shuffleSwapTimer = null;
    }
    if (this.shuffleDoneTimer) {
      clearTimeout(this.shuffleDoneTimer);
      this.shuffleDoneTimer = null;
    }

    const pool = this.data.posePool || [];
    if (pool.length === 0) {
      this.setData({
        isAnimating: true,
      });
      this.triggerPoseExit();
      try {
        await this.refreshPosePool({ reset: true });
      } finally {
        if (!this.isPageAlive) return;
        this.shuffleDoneTimer = setTimeout(() => {
          this.shuffleDoneTimer = null;
          if (!this.isPageAlive) return;
          this.setData({ isAnimating: false });
        }, 220);
      }
      return;
    }

    const randomIndex = Math.floor(Math.random() * pool.length);
    const nextPose = pool[randomIndex];
    const rest = pool.filter((_, index) => index !== randomIndex);

    this.setData({
      isAnimating: true,
    });
    this.triggerPoseExit();
    if (this.shuffleSwapTimer) {
      clearTimeout(this.shuffleSwapTimer);
      this.shuffleSwapTimer = null;
    }
    if (this.shuffleDoneTimer) {
      clearTimeout(this.shuffleDoneTimer);
      this.shuffleDoneTimer = null;
    }

    this.shuffleSwapTimer = setTimeout(() => {
      this.shuffleSwapTimer = null;
      if (!this.isPageAlive) return;

      this.setData(
        {
          currentPose: nextPose,
          posePool: rest,
        },
        () => {
          this.triggerPoseEnter();
        }
      );
      this.savePoseCache(nextPose);
      this.addRecentPoseId(nextPose.id);
      this.recordPoseView(nextPose.id);
    }, POSE_SWITCH_OUT_DURATION);

    this.shuffleDoneTimer = setTimeout(() => {
      this.shuffleDoneTimer = null;
      if (!this.isPageAlive) return;
      this.setData({ isAnimating: false });
    }, POSE_SWITCH_TOTAL_DURATION);

    this.prefetchMoreIfNeeded();
  },

  async onToggleTag(e) {
    if (this.data.serviceMissing) return;

    const name =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.name || "").trim()
        : "";
    if (!name) return;

    const selected = this.data.selectedTags || [];
    const has = selected.includes(name);

    let next = [];
    if (has) {
      next = selected.filter((t) => t !== name);
    } else {
      if (selected.length >= 3) {
        // 与 Web 端一致：达到上限时静默忽略
        return;
      }
      next = selected.concat([name]);
    }

    this.recentPoseIds = [];
    this.setData({
      selectedTags: next,
      selectedTagsMap: this.buildSelectedTagMap(next),
      posePool: [],
    });
  },

  clearSelectedTags() {
    if (this.data.serviceMissing) return;

    this.recentPoseIds = [];
    const next = [];
    this.setData({
      selectedTags: next,
      selectedTagsMap: {},
      posePool: [],
      showTagSelector: false,
    });
  },
});
