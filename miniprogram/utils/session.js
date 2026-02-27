const STORAGE_KEY = "photo_anonymous_session_id_v1";

function createId() {
  const rnd = Math.random().toString(16).slice(2);
  return `s_${Date.now()}_${rnd}`;
}

function getSessionId() {
  try {
    const existing = String(wx.getStorageSync(STORAGE_KEY) || "");
    if (existing) return existing;

    const next = createId();
    wx.setStorageSync(STORAGE_KEY, next);
    return next;
  } catch (e) {
    return createId();
  }
}

module.exports = {
  getSessionId,
};

