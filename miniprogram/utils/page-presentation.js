const { isTabBarPagePath } = require("./runtime-config");

function normalizeMiniProgramRoutePath(value) {
  return String(value || "")
    .trim()
    .split("?")[0]
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function resolvePresentationFallbackRoute(mode, value) {
  const fallbackRoute = String(value || "").trim();
  if (fallbackRoute) {
    return fallbackRoute;
  }
  return mode === "beta" ? "/pages/profile/beta/index" : "";
}

function resolvePresentationFallbackTab(mode, value) {
  const fallbackTab = normalizeMiniProgramRoutePath(value);
  if (fallbackTab) {
    return fallbackTab;
  }
  return mode === "beta" ? "pages/profile/index" : "pages/index/index";
}

function normalizePagePresentation(input) {
  const current = input && typeof input === "object" ? input : {};
  const rawMode = String(current.mode || "").trim().toLowerCase();
  const mode = rawMode === "preview" ? "preview" : rawMode === "beta" ? "beta" : "tabbar";

  return {
    mode,
    pageKey: String(current.pageKey || "").trim(),
    routePath: normalizeMiniProgramRoutePath(current.routePath),
    fallbackRoute: resolvePresentationFallbackRoute(mode, current.fallbackRoute),
    fallbackTab: resolvePresentationFallbackTab(mode, current.fallbackTab),
  };
}

function readPagePresentationFromApp(app) {
  if (app && typeof app.getPagePresentation === "function") {
    return normalizePagePresentation(app.getPagePresentation());
  }
  const globalData = app && app.globalData ? app.globalData : {};
  return normalizePagePresentation(globalData.pagePresentation);
}

function readRuntimeConfigFromApp(app) {
  const globalData = app && app.globalData ? app.globalData : {};
  if (!Boolean(globalData.auditConfigReady)) {
    return null;
  }
  return globalData.runtimeConfig || null;
}

function readPreviewPresentationFromPage(page, pagePath) {
  const options = page && page.options && typeof page.options === "object" ? page.options : {};
  const rawMode = String(options.presentation || "").trim().toLowerCase();
  const mode = rawMode === "preview" ? "preview" : rawMode === "beta" ? "beta" : "";
  if (!mode) {
    return null;
  }

  const currentPagePath = normalizeMiniProgramRoutePath(pagePath || (page && page.route) || "");
  if (!currentPagePath) {
    return null;
  }

  return normalizePagePresentation({
    mode,
    pageKey: String(options.page_key || options.pageKey || "").trim(),
    routePath: currentPagePath,
    fallbackRoute: resolvePresentationFallbackRoute(
      mode,
      options.fallback_route || options.fallbackRoute
    ),
    fallbackTab: resolvePresentationFallbackTab(
      mode,
      options.fallback_tab || options.fallbackTab
    ),
  });
}

function resolvePagePresentationState(input, pagePath, runtimeConfig) {
  const presentation = normalizePagePresentation(input);
  const currentPagePath = normalizeMiniProgramRoutePath(pagePath);
  const isRegisteredTabBarPage = isTabBarPagePath(currentPagePath, runtimeConfig);
  const matchesCurrentPage = Boolean(
    presentation.routePath && currentPagePath && presentation.routePath === currentPagePath
  );
  const isPreview = presentation.mode === "preview" && matchesCurrentPage;
  const isBeta = presentation.mode === "beta" && matchesCurrentPage;
  const isStandalone = isPreview || isBeta;
  const accessMode = isPreview ? "preview" : isBeta ? "beta" : "tabbar";

  return {
    mode: isPreview ? "preview" : isBeta ? "beta" : "tabbar",
    accessMode,
    isStandalone,
    isPreview,
    isBeta,
    showBack: isStandalone,
    preferFallback: isStandalone,
    hasBottomTabbar: !isStandalone && isRegisteredTabBarPage,
    pageFallbackRoute: presentation.fallbackRoute,
    pageFallbackTab: presentation.fallbackTab,
    pageKey: isStandalone ? presentation.pageKey : "",
    routePath: presentation.routePath,
  };
}

function resolveEffectivePresentation(page, app, pagePath, input) {
  return (
    readPreviewPresentationFromPage(page, pagePath) ||
    normalizePagePresentation(input) ||
    readPagePresentationFromApp(app)
  );
}

function applyPagePresentationToPage(page, app, pagePath) {
  const presentation = readPreviewPresentationFromPage(page, pagePath) || readPagePresentationFromApp(app);
  const state = resolvePagePresentationState(presentation, pagePath, readRuntimeConfigFromApp(app));
  if (page && typeof page.setData === "function") {
    page.setData({
      pagePresentationMode: state.mode,
      pagePresentationAccessMode: state.accessMode,
      pageIsStandalone: state.isStandalone,
      pageIsPreviewMode: state.isPreview,
      pageIsBetaMode: state.isBeta,
      pageFallbackRoute: state.pageFallbackRoute,
      pageFallbackTab: state.pageFallbackTab,
      hasBottomTabbar: state.hasBottomTabbar,
    });
  }
  return state;
}

function subscribePagePresentation(app, page, pagePath) {
  if (!app || typeof app.subscribePagePresentation !== "function") {
    applyPagePresentationToPage(page, app, pagePath);
    return () => {};
  }

  return app.subscribePagePresentation((presentation) => {
    const effectivePresentation =
      readPreviewPresentationFromPage(page, pagePath) || normalizePagePresentation(presentation);
    const state = resolvePagePresentationState(
      effectivePresentation,
      pagePath,
      readRuntimeConfigFromApp(app)
    );
    if (page && typeof page.setData === "function") {
      page.setData({
        pagePresentationMode: state.mode,
        pagePresentationAccessMode: state.accessMode,
        pageIsStandalone: state.isStandalone,
        pageIsPreviewMode: state.isPreview,
        pageIsBetaMode: state.isBeta,
        pageFallbackRoute: state.pageFallbackRoute,
        pageFallbackTab: state.pageFallbackTab,
        hasBottomTabbar: state.hasBottomTabbar,
      });
    }
  });
}

module.exports = {
  applyPagePresentationToPage,
  normalizeMiniProgramRoutePath,
  normalizePagePresentation,
  readPagePresentationFromApp,
  resolvePagePresentationState,
  subscribePagePresentation,
};
