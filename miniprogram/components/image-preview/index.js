function clampIndex(i, len) {
  const n = Number(i || 0);
  const max = Math.max(0, Number(len || 0) - 1);
  return Math.max(0, Math.min(max, n));
}

Component({
  properties: {
    show: {
      type: Boolean,
      value: false,
      observer(next) {
        if (next) {
          this.syncFromProps({ reset: true });
        } else {
          this.clearTapTimer();
          this.clearLongPress();
        }
      },
    },

    safeTop: {
      type: Number,
      value: 0,
    },

    images: {
      type: Array,
      value: [],
      observer() {
        this.syncFromProps({ reset: false });
      },
    },

    downloadUrls: {
      type: Array,
      value: [],
    },

    currentIndex: {
      type: Number,
      value: 0,
      observer() {
        this.syncFromProps({ reset: true });
      },
    },

    showCounter: {
      type: Boolean,
      value: true,
    },

    showScale: {
      type: Boolean,
      value: true,
    },

    showDownload: {
      type: Boolean,
      value: false,
    },

    tipText: {
      type: String,
      value: "双指缩放 · 双击还原",
    },

    downloadText: {
      type: String,
      value: "下载原图",
    },
  },

  data: {
    index: 0,
    currentScale: 1,
    displayScale: 100,
    isZoomed: false,
    swiperDisabled: false,
    longPressProgress: 0,
  },

  lifetimes: {
    attached() {
      this.lastTapAt = 0;
      this.tapTimer = null;
      this.longPressTimer = null;
      this.longPressInterval = null;

      // canvas 使用 rpx 布局，绘制坐标系以像素为准；这里按 128rpx 计算 px 尺寸
      this.ringCanvasSize = 64;
      try {
        const win = wx.getWindowInfo ? wx.getWindowInfo() : null;
        const w = Number((win && win.windowWidth) || 0);
        if (w) {
          this.ringCanvasSize = Math.max(48, Math.round((w * 128) / 750));
        }
      } catch (e) {
        // ignore
      }
    },
    detached() {
      this.clearTapTimer();
      this.clearLongPress();
    },
  },

  methods: {
    syncFromProps(opts) {
      if (!this.properties.show) return;

      const images = Array.isArray(this.properties.images) ? this.properties.images : [];
      const nextIndex = clampIndex(this.properties.currentIndex, images.length);

      if (opts && opts.reset) {
        this.resetImageState(nextIndex);
      } else {
        this.setData({ index: nextIndex });
      }
    },

    resetImageState(nextIndex) {
      this.clearTapTimer();
      this.clearLongPress();
      this.lastTapAt = 0;

      this.setData({
        index: Number(nextIndex || 0),
        currentScale: 1,
        displayScale: 100,
        isZoomed: false,
        swiperDisabled: false,
        longPressProgress: 0,
      });
    },

    clearTapTimer() {
      if (this.tapTimer) {
        clearTimeout(this.tapTimer);
        this.tapTimer = null;
      }
    },

    onOverlayTap() {
      if (this.tapTimer) {
        clearTimeout(this.tapTimer);
        this.tapTimer = null;
        return;
      }

      this.tapTimer = setTimeout(() => {
        this.tapTimer = null;
        this.triggerEvent("close");
      }, 300);
    },

    onCloseTap() {
      this.clearTapTimer();
      this.triggerEvent("close");
    },

    onImageTap() {
      const now = Date.now();
      const delta = now - Number(this.lastTapAt || 0);

      if (delta > 0 && delta < 300) {
        this.lastTapAt = 0;
        this.toggleZoom();
        return;
      }

      this.lastTapAt = now;
    },

    toggleZoom() {
      const currentScale = Number(this.data.currentScale || 1);
      const nextScale = currentScale > 1.01 ? 1 : 2;
      const displayScale = Math.round(nextScale * 100);
      const isZoomed = nextScale > 1.01;

      this.setData({
        currentScale: nextScale,
        displayScale,
        isZoomed,
        swiperDisabled: isZoomed,
      });
    },

    onScaleChange(e) {
      const slide =
        e && e.currentTarget && e.currentTarget.dataset
          ? Number(e.currentTarget.dataset.slide || -1)
          : -1;
      if (slide !== Number(this.data.index || 0)) return;

      const scale = e && e.detail ? Number(e.detail.scale || 1) : 1;
      const nextScale = Math.max(1, Math.min(6, scale));
      const displayScale = Math.round(nextScale * 100);
      const isZoomed = nextScale > 1.01;

      this.setData({
        currentScale: nextScale,
        displayScale,
        isZoomed,
        swiperDisabled: isZoomed,
      });
    },

    onSwiperChange(e) {
      const nextIndex = e && e.detail ? Number(e.detail.current || 0) : 0;
      this.resetImageState(nextIndex);
      this.triggerEvent("change", { index: nextIndex });
    },

    async ensureAlbumPermission() {
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

    async saveImage(url) {
      const download = await wx.downloadFile({ url });
      if (!download || download.statusCode !== 200 || !download.tempFilePath) {
        throw new Error("下载失败");
      }
      await wx.saveImageToPhotosAlbum({ filePath: download.tempFilePath });
    },

    async onDownloadTap() {
      const images = Array.isArray(this.properties.images) ? this.properties.images : [];
      const idx = clampIndex(this.data.index, images.length);
      const downloadUrls = Array.isArray(this.properties.downloadUrls)
        ? this.properties.downloadUrls
        : [];
      const rawUrl = downloadUrls[idx] || images[idx];
      const url = String(rawUrl || "").trim();
      if (!url) return;

      const granted = await this.ensureAlbumPermission();
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
        await this.saveImage(url);
        wx.showToast({ title: "保存成功", icon: "success" });
      } catch (e) {
        wx.showToast({ title: "保存失败", icon: "none" });
      } finally {
        wx.hideLoading();
      }
    },

    clearLongPress() {
      if (this.longPressTimer) {
        clearTimeout(this.longPressTimer);
        this.longPressTimer = null;
      }
      if (this.longPressInterval) {
        clearInterval(this.longPressInterval);
        this.longPressInterval = null;
      }
      if (this.data.longPressProgress) {
        this.setData({ longPressProgress: 0 });
      }
    },

    drawLongPressRing(progress) {
      const p = Math.max(0, Math.min(100, Number(progress || 0)));
      const ctx = wx.createCanvasContext("ip-longpress-ring", this);

      // Web 端 SVG: viewBox 56，r=24，stroke=4；按比例映射到当前 canvas 像素尺寸
      const size = Number(this.ringCanvasSize || 64);
      const cx = size / 2;
      const cy = size / 2;
      const radius = (size * 24) / 56;
      const lineWidth = (size * 4) / 56;

      ctx.clearRect(0, 0, size, size);

      // 背景环
      ctx.setStrokeStyle("rgba(255,255,255,0.35)");
      ctx.setLineWidth(lineWidth);
      ctx.setLineCap("round");
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2, false);
      ctx.stroke();

      // 进度环
      const start = -Math.PI / 2;
      const end = start + (Math.PI * 2 * p) / 100;
      ctx.setStrokeStyle("#FFFFFF");
      ctx.setLineWidth(lineWidth);
      ctx.setLineCap("round");
      ctx.beginPath();
      ctx.arc(cx, cy, radius, start, end, false);
      ctx.stroke();

      ctx.draw();
    },

    onImageTouchStart(e) {
      if (!this.properties.showDownload) return;

      const touches = e && e.touches ? e.touches : [];
      if (!touches || touches.length !== 1) return;

      this.clearLongPress();
      this.setData({ longPressProgress: 0 });

      this.longPressInterval = setInterval(() => {
        const next = Math.min(100, Number(this.data.longPressProgress || 0) + 12.5);
        this.setData({ longPressProgress: next }, () => this.drawLongPressRing(next));
      }, 100);

      this.longPressTimer = setTimeout(async () => {
        this.clearLongPress();
        await this.onDownloadTap();
      }, 800);
    },

    onImageTouchMove() {
      this.clearLongPress();
    },

    onImageTouchEnd() {
      this.clearLongPress();
    },

    onImageTouchCancel() {
      this.clearLongPress();
    },
  },
});
