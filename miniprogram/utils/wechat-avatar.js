const STORAGE_KEY = "wechat_avatar_cache_v1";

function normalizeText(value) {
  return String(value || "").trim();
}

function readCacheMap() {
  try {
    const value = wx.getStorageSync(STORAGE_KEY);
    return value && typeof value === "object" ? value : {};
  } catch (error) {
    return {};
  }
}

function writeCacheMap(map) {
  try {
    wx.setStorageSync(STORAGE_KEY, map && typeof map === "object" ? map : {});
  } catch (error) {
    // ignore
  }
}

function removeSavedFile(savedFilePath) {
  const target = normalizeText(savedFilePath);
  if (!target || typeof wx === "undefined" || typeof wx.removeSavedFile !== "function") {
    return;
  }

  try {
    wx.removeSavedFile({
      filePath: target,
      fail: () => {},
    });
  } catch (error) {
    // ignore
  }
}

function getUserAvatar(userId) {
  const normalizedUserId = normalizeText(userId);
  if (!normalizedUserId) {
    return "";
  }

  const map = readCacheMap();
  return normalizeText(map[normalizedUserId]);
}

function setUserAvatar(userId, avatarPath) {
  const normalizedUserId = normalizeText(userId);
  const normalizedAvatarPath = normalizeText(avatarPath);
  if (!normalizedUserId || !normalizedAvatarPath) {
    return "";
  }

  const map = readCacheMap();
  const previousPath = normalizeText(map[normalizedUserId]);
  map[normalizedUserId] = normalizedAvatarPath;
  writeCacheMap(map);

  if (previousPath && previousPath !== normalizedAvatarPath) {
    removeSavedFile(previousPath);
  }

  return normalizedAvatarPath;
}

function clearUserAvatar(userId) {
  const normalizedUserId = normalizeText(userId);
  if (!normalizedUserId) {
    return;
  }

  const map = readCacheMap();
  const previousPath = normalizeText(map[normalizedUserId]);
  if (!Object.prototype.hasOwnProperty.call(map, normalizedUserId)) {
    return;
  }

  delete map[normalizedUserId];
  writeCacheMap(map);
  if (previousPath) {
    removeSavedFile(previousPath);
  }
}

function persistUserAvatar(userId, avatarPath) {
  const normalizedUserId = normalizeText(userId);
  const normalizedAvatarPath = normalizeText(avatarPath);
  if (!normalizedUserId || !normalizedAvatarPath) {
    return Promise.resolve("");
  }

  if (typeof wx === "undefined" || typeof wx.saveFile !== "function") {
    return Promise.resolve(setUserAvatar(normalizedUserId, normalizedAvatarPath));
  }

  return new Promise((resolve) => {
    try {
      wx.saveFile({
        tempFilePath: normalizedAvatarPath,
        success: (res) => {
          const savedFilePath = normalizeText(res && res.savedFilePath) || normalizedAvatarPath;
          resolve(setUserAvatar(normalizedUserId, savedFilePath));
        },
        fail: () => {
          resolve(setUserAvatar(normalizedUserId, normalizedAvatarPath));
        },
      });
    } catch (error) {
      resolve(setUserAvatar(normalizedUserId, normalizedAvatarPath));
    }
  });
}

module.exports = {
  getUserAvatar,
  setUserAvatar,
  clearUserAvatar,
  persistUserAvatar,
};
