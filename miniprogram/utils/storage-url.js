const config = require("../config");

function resolveStorageDomain() {
  const app = typeof getApp === "function" ? getApp() : null;
  const globalData = app && app.globalData ? app.globalData : {};
  const domain = globalData.storageDomain || config.storageDomain;
  return String(domain || "").replace(/\/+$/, "");
}

function isHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || ""));
}

function normalizeNullLikeText(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw
    .replace(/^['"]+|['"]+$/g, "")
    .replace(/^\/+|\/+$/g, "")
    .trim()
    .toLowerCase();
}

function isNullLikeValue(value) {
  const normalized = normalizeNullLikeText(value);
  if (!normalized) return false;
  return (
    normalized === "null" ||
    normalized === "undefined" ||
    normalized === "none" ||
    normalized === "nil"
  );
}

function isNullLikeHttpUrl(url) {
  try {
    const parsed = new URL(String(url || "").trim());
    return isNullLikeValue(parsed.pathname);
  } catch (error) {
    return false;
  }
}

function isDirectResolvableUrl(url) {
  const value = String(url || "");
  return (
    /^cloud:\/\//i.test(value) ||
    /^wxfile:\/\//i.test(value) ||
    /^weapp:\/\//i.test(value) ||
    /^data:/i.test(value) ||
    /^blob:/i.test(value)
  );
}

function resolvePublicUrl(urlOrPath) {
  const raw = String(urlOrPath || "").trim();
  if (!raw) return "";
  if (isNullLikeValue(raw)) {
    return "";
  }
  if (isHttpUrl(raw)) {
    if (isNullLikeHttpUrl(raw)) {
      return "";
    }
    return raw;
  }
  if (isDirectResolvableUrl(raw)) return raw;

  const domain = resolveStorageDomain();
  if (!domain) return raw;

  const normalized = raw.replace(/^\/+/, "");
  if (isNullLikeValue(normalized)) {
    return "";
  }
  return `${domain}/${normalized}`;
}

module.exports = {
  resolvePublicUrl,
};
