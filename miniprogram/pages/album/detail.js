const { dbRpc } = require("../../services/photo-api");
const { resolvePublicUrl } = require("../../utils/storage-url");
const { markGalleryCacheDirty } = require("../../utils/gallery-cache");
const { getCachedAlbumRootName, setCachedAlbumRootName } = require("../../utils/album-root-name-cache");

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
  // 兼容历史数据：部分记录只有 url 字段
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

function normalizePhoto(photo) {
  const thumbnailUrl = resolvePublicUrl(photo && photo.thumbnail_url);
  const previewUrl = resolvePublicUrl(photo && photo.preview_url);
  const originalUrl = resolveOriginalUrl(photo);
  return Object.assign({}, photo, {
    thumbnail_url_resolved: thumbnailUrl,
    preview_url_resolved: previewUrl,
    original_url_resolved: originalUrl,
    // 列表卡片优先走缩略图，保证清晰度同时降低首屏体积
    card_url_resolved: thumbnailUrl || previewUrl || originalUrl,
    // 全屏查看优先走原图，历史数据回退预览/缩略图
    fullscreen_url_resolved: originalUrl || previewUrl || thumbnailUrl,
  });
}

function withSelection(list, selectedMap) {
  const map = selectedMap || {};
  return (list || []).map((item) =>
    Object.assign({}, item, { _selected: Boolean(map[String(item.id)]) })
  );
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
    return "✨ 这里的照片只有 7 天的魔法时效，不被【定格】的瞬间会像泡沫一样悄悄飞走哦......";
  }

  const expiryDate = parseDateTimeUTC8(expiresAt);
  if (!expiryDate) {
    return "✨ 这里的照片只有 7 天的魔法时效，不被【定格】的瞬间会像泡沫一样悄悄飞走哦......";
  }

  const daysLeft = Math.ceil((expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  if (daysLeft > 0) {
    return `✨ 这里的照片只有 ${daysLeft} 天的魔法时效，不被【定格】的瞬间会像泡沫一样悄悄飞走哦......`;
  }
  return "✨ 这里的照片魔法时效已过期，未被【定格】的照片已经消失......";
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

function splitWaterfallColumns(list) {
  const left = [];
  const right = [];
  let leftHeight = 0;
  let rightHeight = 0;

  (list || []).forEach((item) => {
    const width = Number(item && item.width) || 0;
    const height = Number(item && item.height) || 0;
    const ratio = width > 0 && height > 0 ? height / width : 4 / 3;
    const estimatedHeight = Math.min(2.4, Math.max(0.75, ratio)) + 0.22;

    if (leftHeight <= rightHeight) {
      left.push(item);
      leftHeight += estimatedHeight;
    } else {
      right.push(item);
      rightHeight += estimatedHeight;
    }
  });

  return { left, right };
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

function isRpcFunctionNotImplemented(errorMessage) {
  const text = String(errorMessage || "").toLowerCase();
  if (!text) return false;
  return (
    text.includes("未实现的 rpc") ||
    text.includes("not implemented") ||
    text.includes("not support") ||
    text.includes("unknown rpc")
  );
}

function filterPhotosByFolder(list, folderId) {
  const targetFolderId = String(folderId || ROOT_FOLDER_ID);
  const rows = Array.isArray(list) ? list : [];

  if (targetFolderId === ROOT_FOLDER_ID) {
    return rows.filter((item) => !String(item && item.folder_id ? item.folder_id : "").trim());
  }

  return rows.filter((item) => String(item && item.folder_id ? item.folder_id : "") === targetFolderId);
}

Page({
  data: {
    safeTop: 0,
    serviceMissing: false,
    hideAudit: false,

    key: "",
    loading: true,
    loadingMore: false,
    hasMore: false,
    pageNo: 0,
    total: 0,

    album: null,
    headerTitle: "专属回忆",
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
    hasShownFolderSwitchToast: false,
    allPhotos: [],
    photos: [],
    leftPhotos: [],
    rightPhotos: [],

    selectedPhotoMap: {},
    selectedCount: 0,
    isSelectAll: false,
    batchLoading: false,

    confirmPhotoId: "",
    showDeleteConfirm: false,
    showWelcomeLetter: false,
    pendingFolderWaveAfterLetterClose: false,
    showDonationModal: false,
    welcomeStorageKey: "",

    toast: null,

    // Web 同款拆信交互：envelope -> opening -> letter -> closing
    letterStage: "envelope",

  },

  toastTimer: null,
  folderGuideTimer: null,
  folderWaveTimer: null,
  folderWaveRunToken: 0,
  photoLoadTicket: 0,
  useLegacyPhotoPaging: false,
  legacyPhotosByFolder: null,

  onLoad(options) {
    const app = getApp();
    const globalData = app && app.globalData ? app.globalData : {};
    const safeTop = Number(globalData.statusBarHeight || 0);
    const serviceMissing = !String(globalData.cloudRunService || "").trim();
    this.useLegacyPhotoPaging = false;
    this.legacyPhotosByFolder = Object.create(null);

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
      serviceMissing,
      hideAudit: Boolean(globalData.hideAudit),
      key,
      welcomeStorageKey: `album_welcome_seen_${key}`,
      rootFolderName: cachedRootFolderName || initialRootFolderName || "根目录",
      initialRootFolderName: cachedRootFolderName || initialRootFolderName || "",
    });

    if (app && typeof app.subscribeAuditConfig === "function") {
      this._unsubscribeAuditConfig = app.subscribeAuditConfig((hideAudit) => {
        const nextHideAudit = Boolean(hideAudit);
        if (nextHideAudit && this.data.confirmPhotoId) {
          this.setData({ hideAudit: nextHideAudit, confirmPhotoId: "" });
          return;
        }
        this.setData({ hideAudit: nextHideAudit });
      });
    }
    if (!serviceMissing) {
      this.loadAlbum();
    } else {
      this.setData({ loading: false });
    }
  },

  onUnload() {
    this.clearToastTimer();
    this.clearFolderGuideTimer();
    this.clearFolderWaveTimer();
    this.photoLoadTicket += 1;
    if (typeof this._unsubscribeAuditConfig === "function") {
      this._unsubscribeAuditConfig();
    }
    this._unsubscribeAuditConfig = null;
  },

  noop() {},

  clearToastTimer() {
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
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
    }, 7000);
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
    if (storageKey) {
      try {
        wx.setStorageSync(storageKey, "1");
      } catch (e) {
        // ignore
      }
    }
    // 关闭后重置阶段，确保下次打开从信封开始
    this.setData(
      {
        showWelcomeLetter: false,
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
    // Web 端：只有在信纸阶段点击遮罩才会关闭
    if (this.data.letterStage !== "letter") return;
    this.closeWelcomeLetterAnimated();
  },

  onOpenLetter() {
    if (!this.data.showWelcomeLetter) return;
    if (this.data.letterStage !== "envelope") return;

    this.setData({ letterStage: "opening" });
    setTimeout(() => {
      if (!this.data.showWelcomeLetter) return;
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
    this.setData({ showDonationModal: false });
  },

  findPhotoById(id) {
    return (this.data.allPhotos || []).find((x) => String(x.id) === String(id)) || null;
  },

  async loadAlbum() {
    this.setData({ loading: true, loadingMore: false });
    const loadTicket = this.photoLoadTicket + 1;
    this.photoLoadTicket = loadTicket;
    this.useLegacyPhotoPaging = false;
    this.legacyPhotosByFolder = Object.create(null);
    try {
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
      const showFolderGuide = folders.length > 1 && !this.hasSeenFolderGuide();
      const storageKey = String(this.data.welcomeStorageKey || "").trim();
      let hasSeenWelcome = false;
      if (storageKey) {
        try {
          hasSeenWelcome = Boolean(wx.getStorageSync(storageKey));
        } catch (e) {
          hasSeenWelcome = false;
        }
      }

      const showWelcomeLetter =
        Boolean(normalizedAlbum && normalizedAlbum.enable_welcome_letter !== false) && !hasSeenWelcome;
      await new Promise((resolve) => {
        this.setData(
          {
            album: normalizedAlbum,
            headerTitle: (normalizedAlbum && normalizedAlbum.title) || "专属回忆",
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
            hasShownFolderSwitchToast: false,
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
            pageNo: 0,
            total: 0,
            showWelcomeLetter,
            pendingFolderWaveAfterLetterClose: false,
            letterStage: showWelcomeLetter ? "envelope" : "envelope",
            showDonationModal: false,
          },
          () => {
            this.refreshSelectionMeta();
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
      this.setData({ loading: false, loadingMore: false });
    }
  },

  selectFolder(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || ROOT_FOLDER_ID)
        : ROOT_FOLDER_ID;
    const previousId = String(this.data.selectedFolder || ROOT_FOLDER_ID);
    if (this.data.showFolderGuide) {
      this.dismissFolderGuide();
    }
    if (id === previousId) return;

    const folder = (this.data.folders || []).find((item) => String(item.id || "") === id) || null;
    this.setData({
      selectedFolder: id,
      loading: true,
      loadingMore: false,
      hasMore: true,
      pageNo: 0,
      total: 0,
      allPhotos: [],
      photos: [],
      leftPhotos: [],
      rightPhotos: [],
    }, () => {
      this.refreshSelectionMeta();
      if (!this.data.hasShownFolderSwitchToast) {
        const folderName = String((folder && folder.name) || "分组").trim() || "分组";
        this.showToast(`已切换到：${folderName}`, "success", 1800);
        this.setData({ hasShownFolderSwitchToast: true });
      }
    });

    void this.loadPhotoPage(id, 1, { reset: true, silent: false });
  },

  applyFilter() {
    const selectedPhotos = withSelection(this.data.allPhotos || [], this.data.selectedPhotoMap || {});
    const columns = splitWaterfallColumns(selectedPhotos);

    this.setData(
      {
        photos: selectedPhotos,
        leftPhotos: columns.left,
        rightPhotos: columns.right,
      },
      () => this.refreshSelectionMeta()
    );
  },

  async loadPhotoPage(folderId, pageNo, opts) {
    if (this.data.serviceMissing) return;

    const reset = Boolean(opts && opts.reset);
    const silent = Boolean(opts && opts.silent);
    const targetFolderId = String(folderId || ROOT_FOLDER_ID);
    const nextPageNo = toPageNumber(pageNo, 1);

    if (!reset && this.data.loadingMore) return;
    if (!reset && !this.data.hasMore) return;

    if (this.useLegacyPhotoPaging) {
      await this.loadPhotoPageLegacy(targetFolderId, nextPageNo, { reset, silent });
      return;
    }

    if (reset) {
      if (!silent) {
        this.setData({ loading: true, loadingMore: false });
      }
    } else {
      this.setData({ loadingMore: true });
    }

    const ticket = this.photoLoadTicket + 1;
    this.photoLoadTicket = ticket;

    try {
      const r = await dbRpc("get_album_photo_page", {
        input_key: this.data.key,
        folder_id: targetFolderId,
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
        this.useLegacyPhotoPaging = true;
        this.photoLoadTicket += 1;
        await this.loadPhotoPageLegacy(targetFolderId, nextPageNo, { reset, silent });
        return;
      }

      if (rpcErrorMessage || payloadErrorMessage || !payload) {
        if (!(reset && silent)) {
          wx.showToast({ title: rpcErrorMessage || payloadErrorMessage || "加载失败", icon: "none" });
        }
        return;
      }

      if (ticket !== this.photoLoadTicket) return;
      if (String(this.data.selectedFolder || ROOT_FOLDER_ID) !== targetFolderId) return;

      const rows = Array.isArray(payload.photos) ? payload.photos : [];
      const normalizedRows = rows.map(normalizePhoto);
      let mergedRows = normalizedRows;

      if (!reset) {
        const existingRows = Array.isArray(this.data.allPhotos) ? this.data.allPhotos : [];
        const existingIds = new Set(existingRows.map((item) => String(item.id)));
        const incrementalRows = normalizedRows.filter((item) => !existingIds.has(String(item.id)));
        mergedRows = existingRows.concat(incrementalRows);
      }

      const total = readPageTotal(payload, mergedRows.length);
      const loadedCount = mergedRows.length;
      const hasKnownTotal = total > 0;
      const hasMoreFromPayload = Object.prototype.hasOwnProperty.call(payload, "has_more")
        ? Boolean(payload.has_more)
        : null;
      const hasMore = hasMoreFromPayload === null
        ? hasKnownTotal
          ? loadedCount < total
          : normalizedRows.length >= PHOTO_PAGE_SIZE
        : hasMoreFromPayload;
      const selectedPhotos = withSelection(mergedRows, this.data.selectedPhotoMap || {});
      const columns = splitWaterfallColumns(selectedPhotos);

      this.setData(
        {
          allPhotos: mergedRows,
          photos: selectedPhotos,
          leftPhotos: columns.left,
          rightPhotos: columns.right,
          pageNo: nextPageNo,
          total,
          hasMore,
        },
        () => this.refreshSelectionMeta()
      );
    } catch (e) {
      if (!(reset && silent)) {
        wx.showToast({ title: "加载失败", icon: "none" });
      }
    } finally {
      if (ticket === this.photoLoadTicket) {
        const shouldPlayWaveOnVisible = reset && nextPageNo === 1 && targetFolderId === ROOT_FOLDER_ID;
        this.setData({ loading: false, loadingMore: false }, () => {
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
    const targetFolderId = String(folderId || ROOT_FOLDER_ID);
    const nextPageNo = toPageNumber(pageNo, 1);

    if (reset) {
      if (!silent) {
        this.setData({ loading: true, loadingMore: false });
      }
    } else {
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
            wx.showToast({ title: rpcErrorMessage || payloadErrorMessage || "加载失败", icon: "none" });
          }
          return;
        }

        const allRows = (Array.isArray(payload.photos) ? payload.photos : []).map(normalizePhoto);
        fullRows = filterPhotosByFolder(allRows, targetFolderId);
        this.legacyPhotosByFolder[targetFolderId] = fullRows;
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
      const columns = splitWaterfallColumns(selectedPhotos);

      this.setData(
        {
          allPhotos: mergedRows,
          photos: selectedPhotos,
          leftPhotos: columns.left,
          rightPhotos: columns.right,
          pageNo: nextPageNo,
          total,
          hasMore,
        },
        () => this.refreshSelectionMeta()
      );
    } catch (e) {
      if (!(reset && silent)) {
        wx.showToast({ title: "加载失败", icon: "none" });
      }
    } finally {
      if (ticket === this.photoLoadTicket) {
        const shouldPlayWaveOnVisible = reset && nextPageNo === 1 && targetFolderId === ROOT_FOLDER_ID;
        this.setData({ loading: false, loadingMore: false }, () => {
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
    void this.loadPhotoPage(this.data.selectedFolder || ROOT_FOLDER_ID, Number(this.data.pageNo || 0) + 1, {
      reset: false,
      silent: false,
    });
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
      const columns = splitWaterfallColumns(selectedPhotos);
      const total = fullRows.length;
      const pageNo = total > 0 ? Math.ceil(total / PHOTO_PAGE_SIZE) : 0;

      this.setData(
        {
          selectedPhotoMap: map,
          allPhotos: fullRows,
          photos: selectedPhotos,
          leftPhotos: columns.left,
          rightPhotos: columns.right,
          total,
          pageNo,
          hasMore: false,
          loading: false,
          loadingMore: false,
        },
        () => this.refreshSelectionMeta()
      );

      if (total > 0) {
        this.showToast(`已全选 ${total} 张`, "success", 1800);
      } else {
        this.showToast("当前分组暂无照片", "error", 2200);
      }
    } catch (error) {
      this.setData({ loading: false, loadingMore: false });
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

      const allRows = (Array.isArray(payload.photos) ? payload.photos : []).map(normalizePhoto);
      fullRows = filterPhotosByFolder(allRows, targetFolderId);
      this.legacyPhotosByFolder[targetFolderId] = fullRows;
    }

    return Array.isArray(fullRows) ? fullRows.slice() : [];
  },

  async loadAllPhotosForFolder(folderId) {
    const targetFolderId = String(folderId || ROOT_FOLDER_ID);
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

      const pageRows = (Array.isArray(payload.photos) ? payload.photos : []).map(normalizePhoto);
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

      // 防止异常数据导致无限翻页
      if (pageNo > 200) {
        throw new Error("分页异常：页数超出上限");
      }
    }

    return rows;
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

  async handleBatchDownload() {
    if (this.data.batchLoading) return;

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

    this.setData({ batchLoading: true });

    let targets = selected;
    if (shouldDownloadAll) {
      try {
        this.showToast("正在拉取全部照片...", "success", 1400);
        targets = await this.loadAllPhotosForFolder(this.data.selectedFolder || ROOT_FOLDER_ID);
      } catch (error) {
        this.setData({ batchLoading: false });
        const message = String((error && error.message) || "").trim() || "加载全部照片失败";
        this.showToast(message, "error", 2600);
        return;
      }
    }

    if (!targets.length) {
      this.setData({ batchLoading: false });
      this.showToast("暂无可下载照片", "error", 2200);
      return;
    }

    let success = 0;
    let fail = 0;

    for (const photo of targets) {
      const url = photo.original_url_resolved;
      if (!url) {
        fail += 1;
        continue;
      }

      try {
        await this.savePhotoToAlbum(url);
        success += 1;
        await new Promise((resolve) => setTimeout(resolve, 120));
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

    this.setData({ batchLoading: false });

    if (fail > 0) {
      this.showToast(`保存完成：成功${success}张，失败${fail}张`, "error", 3200);
    } else {
      this.showToast(`成功保存 ${success} 张`, "success", 2600);
    }
  },

  handleBatchDelete() {
    if (this.data.batchLoading) return;

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
    if (this.data.batchLoading) return;

    const map = this.data.selectedPhotoMap || {};
    const selected = (this.data.photos || []).filter((p) => Boolean(map[String(p.id)]));
    if (selected.length === 0) {
      this.setData({ showDeleteConfirm: false });
      return;
    }

    this.setData({ batchLoading: true });

    let success = 0;
    let fail = 0;
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

      if (hasPublicDeleted) {
        markGalleryCacheDirty();
      }
    }

    this.setData({ batchLoading: false, showDeleteConfirm: false });

    if (fail > 0) {
      this.showToast(`删除完成：成功${success}张，失败${fail}张`, "error", 3200);
    } else {
      this.showToast(`成功删除 ${success} 张`, "success", 2600);
    }
  },

  openPhotoFullscreen(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;

    const list = this.data.photos || [];
    const images = list.map((p) => p.fullscreen_url_resolved).filter(Boolean);
    if (images.length === 0) {
      this.showToast("原图暂不可用", "error", 2200);
      return;
    }

    const target = list.find((p) => String(p.id) === id);
    if (!target) return;

    const currentUrl = target.fullscreen_url_resolved;
    if (!currentUrl) {
      this.showToast("该照片原图暂不可用", "error", 2200);
      return;
    }

    const idx = Math.max(0, images.findIndex((x) => String(x) === String(currentUrl)));
    wx.previewImage({
      current: images[idx],
      urls: images,
    });
  },

  closePinConfirm() {
    this.setData({ confirmPhotoId: "" });
  },

  async confirmPin() {
    if (this.data.hideAudit) return;
    const id = String(this.data.confirmPhotoId || "");
    if (!id) return;

    await this.performTogglePin(id);
    this.setData({ confirmPhotoId: "" });
  },

  async togglePin(e) {
    if (this.data.hideAudit) return;
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;

    const photo = this.findPhotoById(id);
    if (!photo) return;

    if (photo.is_public) {
      await this.performTogglePin(id);
      return;
    }

    this.setData({ confirmPhotoId: id });
  },

  async performTogglePin(id) {
    if (this.data.hideAudit) return;
    try {
      const r = await dbRpc("pin_photo_to_wall", {
        p_access_key: this.data.key,
        p_photo_id: id,
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
          "✨ 照片已定格到照片墙！虽然照片7天后会像魔法一样消失，但现在它会被魔法定格，永远保留哦！",
          "success",
          5000
        );
      } else {
        this.showToast("照片已从照片墙移除", "success", 2200);
      }
    } catch (e2) {
      this.showToast("操作失败", "error", 2600);
    }
  },
});
