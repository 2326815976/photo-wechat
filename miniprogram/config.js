/**
 * 小程序运行时配置
 *
 * 注意：
 * 1) 不要在小程序端保存任何 Secret（如 SecretId/SecretKey）。
 * 2) 云托管服务名称需要你在 CloudBase 控制台确认后填写：
 *    云开发 -> 云托管 -> 服务列表 -> 服务名称
 */

let runtimeConfig = {};
try {
  // 可选：通过 scripts/sync-config-from-photo-env.js 自动生成
  // eslint-disable-next-line global-require, import/no-unresolved
  runtimeConfig = require("./config.runtime");
} catch (e) {
  runtimeConfig = {};
}

function normalizeUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function normalizeText(value) {
  return String(value || "").trim();
}

const resolvedStorageDomain = String(
  runtimeConfig.storageDomain || "https://736c-slogan-3gf3tz4nf12fa5ef-1403937484.tcb.qcloud.la"
);
const resolvedCloudbaseEnvId = String(runtimeConfig.cloudbaseEnvId || "slogan-3gf3tz4nf12fa5ef");
const resolvedAppUrl = normalizeUrl(
  runtimeConfig.appUrl ||
    runtimeConfig.APP_URL ||
    runtimeConfig.cloudRunBaseUrl ||
    runtimeConfig.cloudrunBaseUrl ||
    runtimeConfig.cloudRunOrigin ||
    runtimeConfig.cloudrunOrigin ||
    ""
);
const runtimeCloudRunService = normalizeText(runtimeConfig.cloudRunService || runtimeConfig.cloudrunService);
const inferredCloudRunService = String(
  runtimeCloudRunService ||
    (resolvedCloudbaseEnvId && resolvedCloudbaseEnvId.includes("-")
      ? resolvedCloudbaseEnvId.split("-")[0]
      : "")
);
const cloudRunServiceInferred =
  Boolean(
    runtimeConfig.cloudRunServiceInferred === true ||
      runtimeConfig.cloudRunServiceInferred === "true" ||
      runtimeConfig.cloudrunServiceInferred === true ||
      runtimeConfig.cloudrunServiceInferred === "true"
  ) || (!runtimeCloudRunService && Boolean(inferredCloudRunService));
const cloudRunServiceSource = runtimeCloudRunService
  ? "runtime"
  : cloudRunServiceInferred && inferredCloudRunService
    ? "inferred_from_env_id"
    : "missing";
const resolvedDebugRequests = Boolean(
  runtimeConfig.debugRequests === true ||
    runtimeConfig.debugRequests === "true" ||
    runtimeConfig.debugRequests === 1 ||
    runtimeConfig.debugRequests === "1"
);
const resolvedShareImageUrl = normalizeText(
  runtimeConfig.shareImageUrl ||
    runtimeConfig.shareImage ||
    runtimeConfig.MINIPROGRAM_SHARE_IMAGE_URL ||
    runtimeConfig.miniprogramShareImageUrl ||
    ""
);

module.exports = {
  // CloudBase 环境 ID（来自 demo/photo/.env.local 的 CLOUDBASE_ID）
  cloudbaseEnvId: resolvedCloudbaseEnvId,

  // 云托管服务名称（callContainer 必填：X-WX-SERVICE）
  cloudRunService: inferredCloudRunService,
  cloudRunServiceInferred,
  cloudRunServiceSource,

  // 可选：APP_URL 公网域名（用于上传文件时回退 wx.uploadFile）
  // 建议通过 scripts/sync-config-from-photo-env.js 从 photo/.env.local 的 APP_URL 同步
  // 例如：https://photo.example.com
  appUrl: resolvedAppUrl,
  // 兼容旧字段名（内部回退链路仍可读取）
  cloudRunBaseUrl: resolvedAppUrl,

  // 可选：打印 callContainer / upload 请求链路日志（开发期建议开启）
  debugRequests: resolvedDebugRequests,

  // CloudBase 云存储访问域名（来自 demo/photo/.env.local 的 CLOUDBASE_STORAGE_DOMAIN）
  // 用于在图片/字体是相对路径时，拼接为可访问 URL
  storageDomain: resolvedStorageDomain,

  // 小程序分享卡片封面图（可选）
  // 支持本地路径（如 /images/share/default.png）或 HTTPS 地址
  shareImageUrl: resolvedShareImageUrl,

  // 腾讯地图 Key（来自 demo/photo/.env.local 的 TMAP_KEY / NEXT_PUBLIC_TMAP_KEY）
  // 注意：若需在小程序里用 wx.request 调用 https://apis.map.qq.com/ws/*，
  // 需在腾讯位置服务控制台为该 Key 额外启用「WebServiceAPI」产品能力。
  tencentMapKey: String(runtimeConfig.tencentMapKey || "YZABZ-X7PK3-XUO3E-OHTW4-KV4L3-LGBZU"),
};
