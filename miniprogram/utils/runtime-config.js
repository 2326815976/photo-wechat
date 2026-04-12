const TAB_PAGE_OPTIONS = [
  {
    key: 'home',
    iconKey: 'home',
    pagePath: 'pages/index/index',
    defaultText: '首页',
    defaultGuestText: '首页',
  },
  {
    key: 'album',
    iconKey: 'album',
    pagePath: 'pages/album/index',
    defaultText: '提取',
    defaultGuestText: '提取',
  },
  {
    key: 'gallery',
    iconKey: 'gallery',
    pagePath: 'pages/gallery/index',
    defaultText: '照片墙',
    defaultGuestText: '照片墙',
  },
  {
    key: 'booking',
    iconKey: 'booking',
    pagePath: 'pages/booking/index',
    defaultText: '约拍',
    defaultGuestText: '约拍',
  },
  {
    key: 'profile',
    iconKey: 'profile',
    pagePath: 'pages/profile/index',
    defaultText: '我的',
    defaultGuestText: '我的',
  },
];

const SUPPORTED_ICON_KEYS = new Set(['home', 'album', 'gallery', 'booking', 'profile', 'about']);
const TAB_PAGE_MAP = TAB_PAGE_OPTIONS.reduce((map, item) => {
  map[item.pagePath] = item;
  return map;
}, {});
const TAB_KEY_MAP = TAB_PAGE_OPTIONS.reduce((map, item) => {
  map[item.key] = item;
  return map;
}, {});
const MAX_TAB_BAR_ITEMS = 5;

function normalizeMiniProgramPagePath(value) {
  return toText(value).replace(/^\/+/, '').replace(/\/+$/, '');
}

function toText(value) {
  return String(value || '').trim();
}

function parseBooleanLike(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value !== 0 : fallback;
  }

  const text = toText(value).toLowerCase();
  if (!text) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;
  return fallback;
}

function parseJsonObject(input) {
  if (!input) return null;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input;
  }
  if (typeof input !== 'string') return null;
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (error) {
    return null;
  }
  return null;
}

function parseJsonArray(input) {
  if (!input) return null;
  if (Array.isArray(input)) {
    return input.filter((item) => item && typeof item === 'object');
  }
  if (typeof input !== 'string') return null;
  try {
    const parsed = JSON.parse(input);
    if (Array.isArray(parsed)) {
      return parsed.filter((item) => item && typeof item === 'object');
    }
  } catch (error) {
    return null;
  }
  return null;
}

function normalizeTabKey(value, fallback) {
  return toText(value) || String(fallback || '');
}

function normalizeIconKey(value, fallback) {
  const text = toText(value).toLowerCase();
  if (text && SUPPORTED_ICON_KEYS.has(text)) {
    return text;
  }
  return fallback || 'profile';
}

function buildFeatureFlags(hideAudit) {
  return hideAudit
    ? {
        showProfileEdit: false,
        showProfileBookings: false,
        showDonationQrCode: false,
        allowPoseBetaBypass: true,
      }
    : {
        showProfileEdit: true,
        showProfileBookings: true,
        showDonationQrCode: true,
        allowPoseBetaBypass: false,
      };
}

function buildStandardTabBarItems() {
  return [
    {
      key: 'home',
      iconKey: 'home',
      pagePath: 'pages/index/index',
      text: '首页',
      guestText: '首页',
      enabled: true,
    },
    {
      key: 'album',
      iconKey: 'album',
      pagePath: 'pages/album/index',
      text: '提取',
      guestText: '提取',
      enabled: true,
    },
    {
      key: 'gallery',
      iconKey: 'gallery',
      pagePath: 'pages/gallery/index',
      text: '照片墙',
      guestText: '照片墙',
      enabled: true,
    },
    {
      key: 'booking',
      iconKey: 'booking',
      pagePath: 'pages/booking/index',
      text: '约拍',
      guestText: '约拍',
      enabled: true,
    },
    {
      key: 'profile',
      iconKey: 'profile',
      pagePath: 'pages/profile/index',
      text: '我的',
      guestText: '我的',
      enabled: true,
    },
  ];
}

function buildReviewTabBarItems() {
  return [
    {
      key: 'gallery',
      iconKey: 'gallery',
      pagePath: 'pages/gallery/index',
      text: '照片墙',
      guestText: '照片墙',
      enabled: true,
    },
    {
      key: 'album',
      iconKey: 'album',
      pagePath: 'pages/album/index',
      text: '提取',
      guestText: '提取',
      enabled: true,
    },
    {
      key: 'profile',
      iconKey: 'profile',
      pagePath: 'pages/profile/index',
      text: '我的',
      guestText: '关于',
      enabled: true,
    },
  ];
}

function buildRuntimeConfigPreset(sceneCode) {
  if (sceneCode === 'review') {
    return {
      configKey: 'default',
      configName: '审核版配置',
      sceneCode: 'review',
      hideAudit: true,
      homeMode: 'gallery',
      homeEntryPagePath: 'pages/gallery/index',
      guestProfileMode: 'about',
      authMode: 'wechat_only',
      tabBarItems: buildReviewTabBarItems(),
      featureFlags: buildFeatureFlags(true),
      notes: '',
      source: 'default_fallback',
      updatedAt: '',
    };
  }

  return {
    configKey: 'default',
    configName: sceneCode === 'custom' ? '自定义配置' : '正式版配置',
    sceneCode: sceneCode === 'custom' ? 'custom' : 'standard',
    hideAudit: false,
    homeMode: 'pose',
    homeEntryPagePath: 'pages/index/index',
    guestProfileMode: 'login',
    authMode: 'phone_password',
    tabBarItems: buildStandardTabBarItems(),
    featureFlags: buildFeatureFlags(false),
    notes: '',
    source: 'default_fallback',
    updatedAt: '',
  };
}

function normalizeTabBarItems(input, hideAudit) {
  const fallback = hideAudit ? buildReviewTabBarItems() : buildStandardTabBarItems();
  const rows = parseJsonArray(input);
  if (!rows || rows.length === 0) {
    return fallback;
  }

  const list = [];
  const seen = new Set();

  rows.forEach((row) => {
    const pagePath = normalizeMiniProgramPagePath(row.pagePath);
    const matchedByPath = TAB_PAGE_MAP[pagePath];
    const rawKey = toText(row.key);
    const matchedByKey = rawKey ? TAB_KEY_MAP[rawKey] : null;
    const option = matchedByPath || matchedByKey || null;
    const resolvedPagePath = pagePath || (option && option.pagePath) || '';
    if (!resolvedPagePath || seen.has(resolvedPagePath)) {
      return;
    }
    seen.add(resolvedPagePath);

    const text = toText(row.text) || (option && option.defaultText) || '页面';
    const guestText =
      toText(row.guestText) ||
      toText(row.guest_label) ||
      (option && option.defaultGuestText) ||
      text;
    const keyFallback = (option && option.key) || resolvedPagePath;
    const iconFallback = (option && option.iconKey) || 'profile';

    list.push({
      key: normalizeTabKey(row.key, keyFallback),
      iconKey: normalizeIconKey(row.iconKey, iconFallback),
      pagePath: resolvedPagePath,
      text,
      guestText,
      enabled: parseBooleanLike(row.enabled, true),
    });
  });

  const enabledRows = list.filter((item) => item.enabled);
  return (enabledRows.length > 0 ? enabledRows : fallback).slice(0, MAX_TAB_BAR_ITEMS);
}

function getTabBarPagePathSet(runtimeConfig, options) {
  const currentOptions = options && typeof options === 'object' ? options : {};
  const includeKnown = currentOptions.includeKnown !== false;
  const set = new Set();

  if (includeKnown) {
    TAB_PAGE_OPTIONS.forEach((item) => {
      const pagePath = normalizeMiniProgramPagePath(item && item.pagePath);
      if (pagePath) {
        set.add(pagePath);
      }
    });
  }

  const config = normalizeRuntimeConfig(runtimeConfig);
  (Array.isArray(config.tabBarItems) ? config.tabBarItems : []).forEach((item) => {
    const pagePath = normalizeMiniProgramPagePath(item && item.pagePath);
    if (!pagePath || (item && item.enabled === false)) {
      return;
    }
    set.add(pagePath);
  });

  return set;
}

function isTabBarPagePath(pagePath, runtimeConfig, options) {
  const normalizedPagePath = normalizeMiniProgramPagePath(pagePath);
  if (!normalizedPagePath) {
    return false;
  }

  return getTabBarPagePathSet(runtimeConfig, options).has(normalizedPagePath);
}

function normalizeFeatureFlags(input, hideAudit) {
  const fallback = buildFeatureFlags(hideAudit);
  const row = parseJsonObject(input);
  if (!row) {
    return fallback;
  }

  return {
    showProfileEdit: parseBooleanLike(row.showProfileEdit, fallback.showProfileEdit),
    showProfileBookings: parseBooleanLike(row.showProfileBookings, fallback.showProfileBookings),
    showDonationQrCode: parseBooleanLike(row.showDonationQrCode, fallback.showDonationQrCode),
    allowPoseBetaBypass: parseBooleanLike(row.allowPoseBetaBypass, fallback.allowPoseBetaBypass),
  };
}

function normalizeHomeEntryPagePath(value, tabBarItems, homeMode) {
  const raw = toText(value).replace(/^\/+/, '');
  const matched = (Array.isArray(tabBarItems) ? tabBarItems : []).find(
    (item) => item && item.pagePath === raw && item.enabled
  );
  if (matched) return matched.pagePath;
  if (homeMode === 'pose') return 'pages/index/index';
  const firstEnabled = (Array.isArray(tabBarItems) ? tabBarItems : []).find(
    (item) => item && item.enabled
  );
  return firstEnabled ? firstEnabled.pagePath : 'pages/gallery/index';
}

function normalizeManagedPageMetaMap(input) {
  const source =
    input && typeof input === 'object' && !Array.isArray(input)
      ? input
      : parseJsonObject(input) || {};

  return Object.keys(source).reduce((map, pageKey) => {
    const normalizedPageKey = toText(pageKey);
    if (!normalizedPageKey) return map;
    const current = source[pageKey] && typeof source[pageKey] === 'object' ? source[pageKey] : {};
    map[normalizedPageKey] = {
      title: toText(current.title),
      subtitle: toText(current.subtitle),
    };
    return map;
  }, {});
}

function normalizeManagedPageAccessMap(input) {
  const source =
    input && typeof input === 'object' && !Array.isArray(input)
      ? input
      : parseJsonObject(input) || {};

  return Object.keys(source).reduce((map, pageKey) => {
    const normalizedPageKey = toText(pageKey);
    if (!normalizedPageKey) return map;
    const current = source[pageKey] && typeof source[pageKey] === 'object' ? source[pageKey] : {};
    map[normalizedPageKey] = {
      pageKey: normalizedPageKey,
      routePath: normalizeMiniProgramPagePath(current.routePath),
      previewRoutePath: normalizeMiniProgramPagePath(current.previewRoutePath),
      publishState: toText(current.publishState) || 'offline',
      navText: toText(current.navText),
      guestNavText: toText(current.guestNavText),
      headerTitle: toText(current.headerTitle),
      headerSubtitle: toText(current.headerSubtitle),
    };
    return map;
  }, {});
}

function normalizeRuntimeConfig(input) {
  const current = input && typeof input === 'object' ? input : {};
  const directHideAudit =
    current && Object.prototype.hasOwnProperty.call(current, 'hideAudit')
      ? parseBooleanLike(current.hideAudit, null)
      : null;
  const hideAudit = directHideAudit === null ? false : directHideAudit;
  const sceneCode = ['standard', 'review', 'custom'].includes(toText(current.sceneCode))
    ? toText(current.sceneCode)
    : hideAudit
      ? 'review'
      : 'standard';

  const homeMode = ['pose', 'gallery'].includes(toText(current.homeMode))
    ? toText(current.homeMode)
    : hideAudit
      ? 'gallery'
      : 'pose';

  const guestProfileMode = ['login', 'about'].includes(toText(current.guestProfileMode))
    ? toText(current.guestProfileMode)
    : hideAudit
      ? 'about'
      : 'login';

  const authMode = ['phone_password', 'wechat_only', 'mixed'].includes(toText(current.authMode))
    ? toText(current.authMode)
    : hideAudit
      ? 'wechat_only'
      : 'phone_password';

  const tabBarItems = normalizeTabBarItems(current.tabBarItems, hideAudit);
  const featureFlags = normalizeFeatureFlags(current.featureFlags, hideAudit);
  const managedPageMetaMap = normalizeManagedPageMetaMap(current.managedPageMetaMap);
  const managedPageAccessMap = normalizeManagedPageAccessMap(current.managedPageAccessMap);
  const homeEntryPagePath = normalizeHomeEntryPagePath(
    current.homeEntryPagePath,
    tabBarItems,
    homeMode
  );

  return {
    configKey: toText(current.configKey) || 'default',
    configName:
      toText(current.configName) ||
      (hideAudit ? '审核版配置' : sceneCode === 'custom' ? '自定义配置' : '正式版配置'),
    sceneCode,
    hideAudit,
    homeMode,
    homeEntryPagePath,
    guestProfileMode,
    authMode,
    tabBarItems,
    featureFlags,
    managedPageMetaMap,
    managedPageAccessMap,
    notes: toText(current.notes),
    source: toText(current.source) || 'default_fallback',
    updatedAt: toText(current.updatedAt),
  };
}

function normalizeRuntimeConfigPayload(payload) {
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current && typeof current === 'object') {
      if (
        Object.prototype.hasOwnProperty.call(current, 'homeMode') ||
        Object.prototype.hasOwnProperty.call(current, 'authMode') ||
        Object.prototype.hasOwnProperty.call(current, 'tabBarItems') ||
        Object.prototype.hasOwnProperty.call(current, 'featureFlags')
      ) {
        return normalizeRuntimeConfig(current);
      }

      if (Object.prototype.hasOwnProperty.call(current, 'hideAudit')) {
        return normalizeRuntimeConfig({
          hideAudit: current.hideAudit,
          source: toText(current.source) || 'default_fallback',
        });
      }
    }

    const next = current && typeof current === 'object' ? current.data : null;
    if (!next || typeof next !== 'object' || next === current) {
      break;
    }
    current = next;
  }

  return buildRuntimeConfigPreset('standard');
}

function getDisplayedTabBarItems(runtimeConfig, isLoggedIn) {
  const config = normalizeRuntimeConfig(runtimeConfig);
  const loggedIn = Boolean(isLoggedIn);
  return config.tabBarItems
    .filter((item) => item && item.enabled)
    .map((item) => ({
      ...item,
      displayText: loggedIn ? item.text : item.guestText || item.text,
    }));
}

function getHomeRedirectPath(runtimeConfig) {
  const config = normalizeRuntimeConfig(runtimeConfig);
  const homeEntry = normalizeHomeEntryPagePath(
    config.homeEntryPagePath,
    config.tabBarItems,
    config.homeMode
  );
  if (homeEntry) {
    return homeEntry;
  }
  const firstEnabled = config.tabBarItems.find((item) => item && item.enabled);
  if (config.homeMode === 'gallery') {
    return firstEnabled ? firstEnabled.pagePath : 'pages/gallery/index';
  }
  return 'pages/index/index';
}

function getManagedPageAccess(runtimeConfig, pageKey) {
  const config = normalizeRuntimeConfig(runtimeConfig);
  const normalizedPageKey = toText(pageKey);
  if (!normalizedPageKey) {
    return null;
  }
  const accessMap =
    config.managedPageAccessMap && typeof config.managedPageAccessMap === 'object'
      ? config.managedPageAccessMap
      : {};
  return accessMap[normalizedPageKey] || null;
}

module.exports = {
  TAB_PAGE_OPTIONS,
  buildRuntimeConfigPreset,
  getDisplayedTabBarItems,
  getHomeRedirectPath,
  getManagedPageAccess,
  getTabBarPagePathSet,
  isTabBarPagePath,
  normalizeRuntimeConfig,
  normalizeRuntimeConfigPayload,
  normalizeMiniProgramPagePath,
  parseBooleanLike,
};
