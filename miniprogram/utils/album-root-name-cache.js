const STORAGE_KEY = "album_root_name_cache_v1";

function normalizeAccessKey(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeRootName(value) {
  return String(value || "").trim();
}

function readCacheMap() {
  try {
    const data = wx.getStorageSync(STORAGE_KEY);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data;
    }
  } catch (error) {
    // ignore
  }
  return {};
}

function writeCacheMap(map) {
  try {
    wx.setStorageSync(STORAGE_KEY, map);
  } catch (error) {
    // ignore
  }
}

function getCachedAlbumRootName(accessKey) {
  const key = normalizeAccessKey(accessKey);
  if (!key) return "";
  const map = readCacheMap();
  return normalizeRootName(map[key]);
}

function setCachedAlbumRootName(accessKey, rootName) {
  const key = normalizeAccessKey(accessKey);
  const name = normalizeRootName(rootName);
  if (!key || !name) return;

  const map = readCacheMap();
  map[key] = name;
  writeCacheMap(map);
}

module.exports = {
  getCachedAlbumRootName,
  setCachedAlbumRootName,
};
