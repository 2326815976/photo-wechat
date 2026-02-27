const SESSION_COOKIE_NAME = "photo_session";
const STORAGE_KEY = "photo_session_cookie_v1";

function getStoredCookie() {
  try {
    return String(wx.getStorageSync(STORAGE_KEY) || "");
  } catch (e) {
    return "";
  }
}

function setStoredCookie(cookie) {
  const value = String(cookie || "").trim();
  if (!value) return;
  try {
    wx.setStorageSync(STORAGE_KEY, value);
  } catch (e) {
    // ignore
  }
}

function clearStoredCookie() {
  try {
    wx.removeStorageSync(STORAGE_KEY);
  } catch (e) {
    // ignore
  }
}

function normalizeSetCookieRows(setCookieHeader) {
  if (!setCookieHeader) return [];

  if (Array.isArray(setCookieHeader)) {
    return setCookieHeader
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }

  return String(setCookieHeader)
    .split(/,(?=\s*[^;,=\s]+=[^;,]*)/g)
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function parseCookieValue(setCookieRow, cookieName) {
  const row = String(setCookieRow || "").trim();
  if (!row) return null;

  const pattern = new RegExp(`(?:^|\\s*)${cookieName}=([^;]*)`);
  const match = row.match(pattern);
  if (!match) return null;
  return String(match[1] || "");
}

function resolveSessionCookieAction(setCookieHeader) {
  const rows = normalizeSetCookieRows(setCookieHeader);
  if (!rows.length) {
    return { cookie: "", shouldClear: false };
  }

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const value = parseCookieValue(row, SESSION_COOKIE_NAME);
    if (value === null) continue;

    const rowLower = row.toLowerCase();
    const shouldClear =
      value === "" ||
      /;\s*max-age=0(?:;|$)/i.test(rowLower) ||
      /;\s*expires=thu,\s*01\s*jan\s*1970/i.test(rowLower);

    return {
      cookie: value ? `${SESSION_COOKIE_NAME}=${value}` : "",
      shouldClear,
    };
  }

  return { cookie: "", shouldClear: false };
}

function extractSessionCookie(setCookieHeader) {
  const resolved = resolveSessionCookieAction(setCookieHeader);
  return resolved && resolved.shouldClear ? "" : String((resolved && resolved.cookie) || "");
}

module.exports = {
  SESSION_COOKIE_NAME,
  getStoredCookie,
  setStoredCookie,
  clearStoredCookie,
  resolveSessionCookieAction,
  extractSessionCookie,
};
