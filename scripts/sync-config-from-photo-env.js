const fs = require("fs");
const path = require("path");

function parseEnv(content) {
  const map = {};
  String(content || "")
    .split(/\r?\n/)
    .forEach((line) => {
      const text = String(line || "").trim();
      if (!text || text.startsWith("#")) return;
      const idx = text.indexOf("=");
      if (idx <= 0) return;
      const key = text.slice(0, idx).trim();
      const value = text.slice(idx + 1).trim();
      if (!key) return;
      map[key] = value;
    });
  return map;
}

function toLiteral(value) {
  return JSON.stringify(String(value || ""));
}

function normalizeUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizePublicOrigin(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) return "";
  if (!/^https?:\/\//i.test(normalized)) return "";
  return normalized;
}

function joinUrl(origin, path) {
  const base = normalizeUrl(origin);
  const suffix = String(path || "").trim();
  if (!base) return suffix;
  if (!suffix) return base;
  if (suffix.startsWith("/")) return `${base}${suffix}`;
  return `${base}/${suffix}`;
}

function resolveStorageBucket(storageDomain) {
  const domain = normalizeUrl(storageDomain);
  if (!domain) return "";
  try {
    const host = new URL(domain).hostname || "";
    const suffix = ".tcb.qcloud.la";
    if (!host.endsWith(suffix)) return "";
    return host.slice(0, host.length - suffix.length);
  } catch (e) {
    return "";
  }
}

function buildCloudFileId(envId, storageDomain, objectPath) {
  const env = String(envId || "").trim();
  const bucket = resolveStorageBucket(storageDomain);
  const path = String(objectPath || "").trim().replace(/^\/+/, "");
  if (!env || !bucket || !path) return "";
  return `cloud://${env}.${bucket}/${path}`;
}

function pickFirstNonEmpty(rows) {
  const source = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < source.length; i += 1) {
    const value = String(source[i] || "").trim();
    if (value) return value;
  }
  return "";
}

function resolveAppEnv(envMap) {
  const value = String((envMap && envMap.NODE_ENV) || "").trim().toLowerCase();
  if (value === "production") return "production";
  return "development";
}

function main() {
  const workspaceRoot = path.resolve(__dirname, "..", "..");
  const photoEnvPath = path.join(workspaceRoot, "photo", ".env.local");
  const outputPath = path.join(workspaceRoot, "Slogan-WeChat", "miniprogram", "config.runtime.js");

  if (!fs.existsSync(photoEnvPath)) {
    throw new Error(`未找到环境变量文件: ${photoEnvPath}`);
  }

  const env = parseEnv(fs.readFileSync(photoEnvPath, "utf8"));
  const cloudbaseEnvId = env.CLOUDBASE_ID || "";
  const inferredCloudRunService =
    cloudbaseEnvId && cloudbaseEnvId.includes("-") ? cloudbaseEnvId.split("-")[0] : "";
  const explicitCloudRunService = pickFirstNonEmpty([
    env.MINIPROGRAM_CLOUDRUN_SERVICE,
    env.CLOUDRUN_SERVICE,
    env.CLOUDBASE_CLOUDRUN_SERVICE,
    env.CLOUDBASE_RUN_SERVICE,
    env.TCB_CLOUDRUN_SERVICE,
    env.NEXT_PUBLIC_CLOUDRUN_SERVICE,
  ]);
  const cloudRunService = explicitCloudRunService || inferredCloudRunService;
  const cloudRunServiceInferred = !explicitCloudRunService && Boolean(cloudRunService);
  const cloudRunServiceSource = explicitCloudRunService
    ? "runtime"
    : cloudRunServiceInferred
      ? "inferred_from_env_id"
      : "missing";
  // 按约定仅使用 APP_URL 作为云托管公网访问域名来源。
  const appUrl = normalizePublicOrigin(env.APP_URL || "");
  const storageDomain = env.CLOUDBASE_STORAGE_DOMAIN || env.NEXT_PUBLIC_CLOUDBASE_STORAGE_DOMAIN || "";
  const tencentMapKey = env.TMAP_KEY || env.NEXT_PUBLIC_TMAP_KEY || env.TMAP_SERVER_KEY || "";
  const appEnv = resolveAppEnv(env);
  const debugRequests = appEnv !== "production";
  const shareImageUrl = normalizeText(
    env.MINIPROGRAM_SHARE_IMAGE_URL || env.NEXT_PUBLIC_MINIPROGRAM_SHARE_IMAGE_URL || env.SHARE_IMAGE_URL || ""
  );
  const fontZqknny =
    env.MINIPROGRAM_FONT_ZQKNNY_URL ||
    env.FONT_ZQKNNY_URL ||
    env.NEXT_PUBLIC_FONT_ZQKNNY_URL ||
    joinUrl(storageDomain, "/fonts/ZQKNNY-Medium-2.woff2") ||
    joinUrl(appUrl, "/fonts/ZQKNNY-Medium-2.woff2") ||
    joinUrl(appUrl, "/fonts/ZQKNNY-Medium-2.ttf");
  const fontLetter =
    env.MINIPROGRAM_FONT_LETTER_URL ||
    env.FONT_LETTER_URL ||
    env.NEXT_PUBLIC_FONT_LETTER_URL ||
    joinUrl(storageDomain, "/fonts/AaZhuNiWoMingMeiXiangChunTian-2.woff2") ||
    buildCloudFileId(cloudbaseEnvId, storageDomain, "fonts/AaZhuNiWoMingMeiXiangChunTian-2.woff2") ||
    joinUrl(appUrl, "/fonts/AaZhuNiWoMingMeiXiangChunTian-2.woff2");

  const file = `/**
 * 由 scripts/sync-config-from-photo-env.js 自动生成
 * 来源：photo/.env.local
 */
module.exports = {
  cloudbaseEnvId: ${toLiteral(cloudbaseEnvId)},
  cloudRunService: ${toLiteral(cloudRunService)},
  cloudRunServiceInferred: ${cloudRunServiceInferred ? "true" : "false"},
  cloudRunServiceSource: ${toLiteral(cloudRunServiceSource)},
  appUrl: ${toLiteral(appUrl)},
  cloudRunBaseUrl: ${toLiteral(appUrl)},
  debugRequests: ${debugRequests ? "true" : "false"},
  storageDomain: ${toLiteral(storageDomain)},
  shareImageUrl: ${toLiteral(shareImageUrl)},
  tencentMapKey: ${toLiteral(tencentMapKey)},
  fonts: {
    zqknny: ${toLiteral(fontZqknny)},
    letter: ${toLiteral(fontLetter)},
  },
};
`;

  fs.writeFileSync(outputPath, file, "utf8");
  console.log(`已生成: ${outputPath}`);
  if (cloudRunServiceInferred) {
    console.warn(
      "[sync-config] 未在 .env.local 找到显式云托管服务名，已回退为 CLOUDBASE_ID 前缀推断值。建议配置 MINIPROGRAM_CLOUDRUN_SERVICE。"
    );
  }
}

main();
