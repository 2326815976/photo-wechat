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
  const normalizedText = raw.toLowerCase();
  if (normalizedText === "null" || normalizedText === "undefined") {
    return "";
  }
  if (isHttpUrl(raw)) return raw;
  if (isDirectResolvableUrl(raw)) return raw;

  const domain = resolveStorageDomain();
  if (!domain) return raw;

  const normalized = raw.replace(/^\/+/, "");
  return `${domain}/${normalized}`;
}

module.exports = {
  resolvePublicUrl,
};
