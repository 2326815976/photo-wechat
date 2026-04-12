const { normalizeMiniProgramPagePath, normalizeRuntimeConfig } = require("./runtime-config");

function toText(value) {
  return String(value || "").trim();
}

function resolveManagedMeta(runtimeConfig, pageKey) {
  const metaMap =
    runtimeConfig && runtimeConfig.managedPageMetaMap && typeof runtimeConfig.managedPageMetaMap === "object"
      ? runtimeConfig.managedPageMetaMap
      : {};
  return pageKey && metaMap[pageKey] && typeof metaMap[pageKey] === "object" ? metaMap[pageKey] : {};
}

function resolveTabBarItem(runtimeConfig, pagePath) {
  const normalizedPagePath = normalizeMiniProgramPagePath(pagePath);
  const tabBarItems = Array.isArray(runtimeConfig && runtimeConfig.tabBarItems)
    ? runtimeConfig.tabBarItems
    : [];

  return (
    tabBarItems.find(
      (item) => normalizeMiniProgramPagePath(item && item.pagePath) === normalizedPagePath
    ) || null
  );
}

function resolveDisplayLabels(runtimeConfig, options) {
  const normalizedRuntimeConfig = normalizeRuntimeConfig(runtimeConfig);
  const currentOptions = options && typeof options === "object" ? options : {};
  const currentTabBarItem = resolveTabBarItem(normalizedRuntimeConfig, currentOptions.pagePath);
  const managedMeta = resolveManagedMeta(normalizedRuntimeConfig, currentOptions.pageKey);
  const isLoggedIn = Boolean(currentOptions.isLoggedIn);
  const navTitle = isLoggedIn
    ? toText(currentTabBarItem && (currentTabBarItem.text || currentTabBarItem.guestText))
    : toText(currentTabBarItem && (currentTabBarItem.guestText || currentTabBarItem.text));
  const managedTitle = toText(managedMeta.title) || toText(currentOptions.fallbackTitle);

  return {
    normalizedRuntimeConfig,
    displayTitle: navTitle || managedTitle || "页面",
    contentTitle: managedTitle || navTitle || "页面",
  };
}

function buildManagedPageLoadingCopy(runtimeConfig, options) {
  const labels = resolveDisplayLabels(runtimeConfig, options);
  const currentOptions = options && typeof options === "object" ? options : {};
  const description =
    typeof currentOptions.descriptionFormatter === "function"
      ? currentOptions.descriptionFormatter(labels.contentTitle, labels)
      : `正在载入${labels.contentTitle}内容`;
  const switchDescription =
    typeof currentOptions.switchDescriptionFormatter === "function"
      ? currentOptions.switchDescriptionFormatter(labels.contentTitle, labels)
      : `正在切换${labels.contentTitle}标签`;

  return {
    normalizedRuntimeConfig: labels.normalizedRuntimeConfig,
    title: labels.displayTitle,
    description,
    switchDescription,
  };
}

module.exports = {
  buildManagedPageLoadingCopy,
};
