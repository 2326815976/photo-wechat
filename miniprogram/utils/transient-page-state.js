const STORAGE_KEY = "transient_page_state_v1";
const DEFAULT_TTL_MS = 30 * 60 * 1000;

function readStateMap() {
  try {
    const value = wx.getStorageSync(STORAGE_KEY);
    if (!value || typeof value !== "object") {
      return {};
    }
    return value;
  } catch (error) {
    return {};
  }
}

function writeStateMap(map) {
  try {
    wx.setStorageSync(STORAGE_KEY, map && typeof map === "object" ? map : {});
  } catch (error) {
    // ignore
  }
}

function clearTransientPageState(key) {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) return;

  const stateMap = readStateMap();
  if (!Object.prototype.hasOwnProperty.call(stateMap, normalizedKey)) return;
  delete stateMap[normalizedKey];
  writeStateMap(stateMap);
}

function saveTransientPageState(key, payload, ttlMs) {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) return;

  const expiresIn = Math.max(1000, Number(ttlMs || DEFAULT_TTL_MS));
  const stateMap = readStateMap();
  stateMap[normalizedKey] = {
    payload: payload && typeof payload === "object" ? payload : {},
    savedAt: Date.now(),
    expiresAt: Date.now() + expiresIn,
  };
  writeStateMap(stateMap);
}

function loadTransientPageState(key) {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) return null;

  const stateMap = readStateMap();
  const record = stateMap[normalizedKey];
  if (!record || typeof record !== "object") {
    return null;
  }

  const expiresAt = Number(record.expiresAt || 0);
  if (expiresAt > 0 && Date.now() > expiresAt) {
    delete stateMap[normalizedKey];
    writeStateMap(stateMap);
    return null;
  }

  return record.payload && typeof record.payload === "object" ? record.payload : null;
}

module.exports = {
  saveTransientPageState,
  loadTransientPageState,
  clearTransientPageState,
};
