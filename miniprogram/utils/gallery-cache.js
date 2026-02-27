const GALLERY_PAGE_CACHE_KEY = "gallery-page-1-cache-v1";
const GALLERY_CACHE_DIRTY_KEY = "gallery-cache-dirty-v1";

function safeGetStorage(key) {
  try {
    return wx.getStorageSync(key);
  } catch (e) {
    return "";
  }
}

function safeSetStorage(key, value) {
  try {
    wx.setStorageSync(key, value);
  } catch (e) {
    // ignore
  }
}

function safeRemoveStorage(key) {
  try {
    wx.removeStorageSync(key);
  } catch (e) {
    // ignore
  }
}

function clearGalleryStorageCache() {
  safeRemoveStorage(GALLERY_PAGE_CACHE_KEY);
}

function setGalleryDirtyFlag(timestamp) {
  const mark = Number(timestamp || Date.now()) || Date.now();
  const app = typeof getApp === "function" ? getApp() : null;
  if (app && app.globalData) {
    app.globalData.galleryCacheDirtyAt = mark;
  }
  safeSetStorage(GALLERY_CACHE_DIRTY_KEY, String(mark));
}

function markGalleryCacheDirty(timestamp) {
  clearGalleryStorageCache();
  setGalleryDirtyFlag(timestamp);
}

function consumeGalleryCacheDirty() {
  const app = typeof getApp === "function" ? getApp() : null;
  const globalData = app && app.globalData ? app.globalData : {};
  const dirtyAt = Number(globalData.galleryCacheDirtyAt || 0);

  if (dirtyAt > 0) {
    if (app && app.globalData) {
      app.globalData.galleryCacheDirtyAt = 0;
    }
    safeRemoveStorage(GALLERY_CACHE_DIRTY_KEY);
    return true;
  }

  const dirtyFromStorage = String(safeGetStorage(GALLERY_CACHE_DIRTY_KEY) || "").trim();
  if (!dirtyFromStorage) {
    return false;
  }

  safeRemoveStorage(GALLERY_CACHE_DIRTY_KEY);
  return true;
}

module.exports = {
  GALLERY_PAGE_CACHE_KEY,
  clearGalleryStorageCache,
  markGalleryCacheDirty,
  consumeGalleryCacheDirty,
};

