const { requireAdminSession } = require("../../../services/photo-admin-api");
const { requestJson } = require("../../../services/photo-api");
const {
  isTabBarPagePath,
  TAB_PAGE_OPTIONS,
} = require("../../../utils/runtime-config");

const CHANNEL_META = {
  web: {
    title: "Web 页面管理",
    badge: "只管理 Web 页面",
    desc: "列表管理，仅保留编辑、状态切换、查看。",
  },
  miniprogram: {
    title: "小程序页面管理",
    badge: "只管理微信小程序页面",
    desc: "列表管理，仅保留编辑、状态切换、查看。",
  },
};

const STATE_LABEL_MAP = {
  offline: "下线",
  beta: "内测",
  online: "上线",
};

const STATE_FILTER_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "online", label: "上线中" },
  { value: "beta", label: "内测中" },
  { value: "offline", label: "已下线" },
];

const SECONDARY_PAGE_PARENT_MAP = new Map([
  ["login", "profile"],
  ["register", "profile"],
  ["profile-edit", "profile"],
  ["profile-bookings", "profile"],
  ["profile-beta", "profile"],
  ["about", "profile"],
  ["profile-change-password", "profile"],
  ["profile-delete-account", "profile"],
  ["album-detail", "album"],
]);
const PROFILE_GUEST_SECONDARY_PAGE_KEYS = new Set([
  "login",
  "register",
]);
const MINIPROGRAM_HIDDEN_PAGE_KEYS = new Set([
  "login",
  "register",
  "profile-change-password",
]);
const PROFILE_AUTHENTICATED_SECONDARY_PAGE_KEYS = new Set([
  "profile-edit",
  "profile-bookings",
  "profile-beta",
  "about",
  "profile-change-password",
  "profile-delete-account",
]);
const ICON_OPTIONS = ["", "home", "album", "gallery", "booking", "profile"];
const TAB_OPTIONS = [{ value: "", label: "不绑定底部菜单" }].concat(
  TAB_PAGE_OPTIONS.map((item) => ({
    value: normalizeText(item && item.key),
    label: `${normalizeText(item && item.key)} / ${normalizeText(item && item.defaultText)}`,
    iconKey: normalizeText(item && item.iconKey),
    pagePath: normalizeText(item && item.pagePath),
    defaultText: normalizeText(item && item.defaultText),
    defaultGuestText: normalizeText(item && item.defaultGuestText),
  }))
);
const TAB_OPTION_MAP = new Map(
  TAB_OPTIONS.filter((item) => normalizeText(item && item.value)).map((item) => [normalizeText(item.value), item])
);
const BETA_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const BETA_CODE_LENGTH = 8;
const PAGE_MANAGEMENT_CLIENT_HEADER = "x-page-management-client";

function normalizeText(value) {
  return String(value || "").trim();
}

function buildPageManagementRequestOptions(channel, options) {
  const currentChannel = normalizeText(channel) === "miniprogram" ? "miniprogram" : "web";
  const currentOptions = options && typeof options === "object" ? options : {};
  const currentHeader = currentOptions.header && typeof currentOptions.header === "object" ? currentOptions.header : {};
  return Object.assign({}, currentOptions, {
    header: Object.assign({}, currentHeader, {
      "x-page-management-client": currentChannel,
    }),
  });
}

function isSecondaryPageKey(pageKey) {
  return SECONDARY_PAGE_PARENT_MAP.has(normalizeText(pageKey));
}

function resolveSecondaryParentPageKey(pageKey) {
  return SECONDARY_PAGE_PARENT_MAP.get(normalizeText(pageKey)) || "";
}

function isProfileGuestSecondaryPageKey(pageKey) {
  return PROFILE_GUEST_SECONDARY_PAGE_KEYS.has(normalizeText(pageKey));
}

function shouldHidePageForChannel(pageKey, channel) {
  return normalizeText(channel) === "miniprogram" && MINIPROGRAM_HIDDEN_PAGE_KEYS.has(normalizeText(pageKey));
}

function isProfileGuestSecondaryPageForChannel(pageKey, channel) {
  return !shouldHidePageForChannel(pageKey, channel) && isProfileGuestSecondaryPageKey(pageKey);
}

function isProfileAuthenticatedSecondaryPageKey(pageKey) {
  return PROFILE_AUTHENTICATED_SECONDARY_PAGE_KEYS.has(normalizeText(pageKey));
}

function normalizeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number(fallback || 0);
}

function normalizeBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return Boolean(fallback);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function generateRandomBetaCode(length) {
  const targetLength = Math.max(1, Math.floor(Number(length) || BETA_CODE_LENGTH));
  let next = "";
  for (let index = 0; index < targetLength; index += 1) {
    const randomIndex = Math.floor(Math.random() * BETA_CODE_CHARS.length);
    next += BETA_CODE_CHARS[randomIndex] || "A";
  }
  return next;
}

function readArrayFromPayload(payload) {
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (Array.isArray(current)) return current;
    if (!current || typeof current !== "object") break;
    if (Array.isArray(current.data)) return current.data;
    if (Array.isArray(current.rows)) return current.rows;
    if (Array.isArray(current.list)) return current.list;
    if (Array.isArray(current.items)) return current.items;
    current = current.data;
  }
  return [];
}

function readErrorMessage(error, fallback) {
  if (typeof error === "string" && error.trim()) return error.trim();
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") break;
    const message = normalizeText(current.message);
    if (message) return message;
    if (typeof current.error === "string" && normalizeText(current.error)) {
      return normalizeText(current.error);
    }
    current = current.error && typeof current.error === "object" ? current.error : current.data;
  }
  return normalizeText(fallback || "请求失败");
}

function extractDateText(value) {
  const matched = normalizeText(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return matched ? matched[1] : "";
}

function createEmptyRegistryDraft() {
  return {
    pageKey: "",
    pageName: "",
    pageDescription: "",
    routePathWeb: "",
    routePathMiniProgram: "",
    previewRoutePathWeb: "",
    previewRoutePathMiniProgram: "",
    tabKey: "",
    iconKey: "",
    defaultTabText: "",
    defaultGuestTabText: "",
    isNavCandidateWeb: false,
    isTabCandidateMiniProgram: false,
    supportsBeta: true,
    supportsPreview: true,
    isBuiltIn: false,
    isActive: true,
  };
}

function createRegistryDraftFromRow(row) {
  return {
    pageKey: normalizeText(row.pageKey),
    pageName: normalizeText(row.pageName),
    pageDescription: normalizeText(row.pageDescription),
    routePathWeb: normalizeText(row.routePathWeb),
    routePathMiniProgram: normalizeText(row.routePathMiniProgram),
    previewRoutePathWeb: normalizeText(row.previewRoutePathWeb),
    previewRoutePathMiniProgram: normalizeText(row.previewRoutePathMiniProgram),
    tabKey: normalizeText(row.tabKey),
    iconKey: normalizeText(row.iconKey),
    defaultTabText: normalizeText(row.defaultTabText),
    defaultGuestTabText: normalizeText(row.defaultGuestTabText),
    isNavCandidateWeb: normalizeBoolean(row.isNavCandidateWeb, false),
    isTabCandidateMiniProgram: normalizeBoolean(row.isTabCandidateMiniProgram, false),
    supportsBeta: normalizeBoolean(row.supportsBeta, true),
    supportsPreview: normalizeBoolean(row.supportsPreview, true),
    isBuiltIn: normalizeBoolean(row.isBuiltIn, false),
    isActive: normalizeBoolean(row.isActive, true),
  };
}

function buildRegistryPayload(draft) {
  return {
    pageKey: normalizeText(draft.pageKey),
    pageName: normalizeText(draft.pageName),
    pageDescription: normalizeText(draft.pageDescription),
    routePathWeb: normalizeText(draft.routePathWeb),
    routePathMiniProgram: normalizeText(draft.routePathMiniProgram),
    previewRoutePathWeb: normalizeText(draft.previewRoutePathWeb),
    previewRoutePathMiniProgram: normalizeText(draft.previewRoutePathMiniProgram),
    tabKey: normalizeText(draft.tabKey),
    iconKey: normalizeText(draft.iconKey),
    defaultTabText: normalizeText(draft.defaultTabText),
    defaultGuestTabText: normalizeText(draft.defaultGuestTabText),
    isNavCandidateWeb: normalizeBoolean(draft.isNavCandidateWeb, false),
    isTabCandidateMiniProgram: normalizeBoolean(draft.isTabCandidateMiniProgram, false),
    supportsBeta: normalizeBoolean(draft.supportsBeta, true),
    supportsPreview: normalizeBoolean(draft.supportsPreview, true),
    isBuiltIn: normalizeBoolean(draft.isBuiltIn, false),
    isActive: normalizeBoolean(draft.isActive, true),
  };
}

function validateRegistryPayload(draft, channel) {
  if (!normalizeText(draft.pageKey)) return "请填写页面标识";
  if (channel !== "miniprogram" && !normalizeText(draft.routePathWeb)) return "请填写 Web 路由";
  if (channel !== "web" && !normalizeText(draft.routePathMiniProgram)) return "请填写小程序路由";
  return "";
}

function buildRegistryOptionPatch(currentDraft, field, value) {
  const current = currentDraft && typeof currentDraft === "object" ? currentDraft : createEmptyRegistryDraft();
  const normalizedField = normalizeText(field);
  const normalizedValue = normalizeText(value);
  const patch = { [normalizedField]: normalizedValue };

  if (normalizedField === "iconKey" && !normalizedValue) {
    patch.isNavCandidateWeb = false;
    patch.isTabCandidateMiniProgram = false;
  }

  if (normalizedField === "tabKey") {
    if (!normalizedValue) {
      patch.isTabCandidateMiniProgram = false;
    }
    const option = TAB_OPTION_MAP.get(normalizedValue);
    if (option) {
      if (!normalizeText(current.iconKey)) {
        patch.iconKey = normalizeText(option.iconKey);
      }
      if (!normalizeText(current.routePathMiniProgram)) {
        patch.routePathMiniProgram = normalizeText(option.pagePath);
      }
      if (!normalizeText(current.defaultTabText)) {
        patch.defaultTabText = normalizeText(option.defaultText);
      }
      if (!normalizeText(current.defaultGuestTabText)) {
        patch.defaultGuestTabText = normalizeText(option.defaultGuestText || option.defaultText);
      }
    }
  }

  return patch;
}

function createEmptyBetaDraft(channel) {
  const currentChannel = normalizeText(channel);
  return {
    codeId: "",
    betaName: "",
    betaCode: "",
    expiresAt: "",
    channel: currentChannel === "miniprogram" ? "miniprogram" : "web",
  };
}

function normalizeBetaCodeChannel(channel) {
  const normalized = normalizeText(channel);
  if (normalized === "web" || normalized === "miniprogram") {
    return normalized;
  }
  return "shared";
}

function filterBetaCodesByChannel(codes, channel) {
  const currentChannel = normalizeText(channel) === "miniprogram" ? "miniprogram" : "web";
  return (Array.isArray(codes) ? codes : []).filter((item) => {
    const codeChannel = normalizeBetaCodeChannel(item && item.channel);
    return codeChannel === "shared" || codeChannel === currentChannel;
  });
}

function getTodayDateText() {
  const current = new Date();
  const year = current.getFullYear();
  const month = String(current.getMonth() + 1).padStart(2, "0");
  const date = String(current.getDate()).padStart(2, "0");
  return `${year}-${month}-${date}`;
}

function getDateDiffFromToday(dateText) {
  const normalized = normalizeText(dateText);
  if (!normalized) return null;
  const today = new Date(`${getTodayDateText()}T00:00:00`);
  const target = new Date(`${normalized}T00:00:00`);
  const diff = target.getTime() - today.getTime();
  if (Number.isNaN(diff)) return null;
  return Math.round(diff / 86400000);
}

function buildBetaScopeMeta(codeChannel, channel) {
  if (normalizeBetaCodeChannel(codeChannel) === "shared") {
    return {
      scopeLabel: "旧体系兼容",
      scopeHint: "这是旧数据，仅保留查看；新建与保存不会再生成共享内测码。",
    };
  }
  return {
    scopeLabel: channel === "web" ? "仅 Web" : "仅小程序",
    scopeHint:
      channel === "web"
        ? "只有 Web 端登录用户可绑定并进入当前页面。"
        : "只有小程序端登录用户可绑定并进入当前页面。",
  };
}

function applyReadOnlyBetaMeta(code, payload) {
  if (!normalizeBoolean(code && code.readOnly, false) && normalizeBetaCodeChannel(code && code.channel) !== "shared") {
    return payload;
  }
  return Object.assign({}, payload, {
    readOnly: true,
    source: normalizeText(code && code.source) || "legacy",
    manageHint:
      normalizeText(code && code.manageHint) || "旧体系兼容码，仅参与兼容展示；如需维护，请使用旧版内测功能管理。",
    editActionText: "兼容只读",
  });
}

function decorateBetaCodeForChannel(code, channel) {
  const expiresDateText = extractDateText(code && code.expiresAt);
  const scopeMeta = buildBetaScopeMeta(code && code.channel, channel);
  const isActive = normalizeBoolean(code && code.isActive, true);

  if (!isActive) {
    return applyReadOnlyBetaMeta(code, Object.assign({}, code, scopeMeta, {
      lifecycleKey: "destroyed",
      lifecycleLabel: "已销毁",
      lifecycleHint: "已销毁后新用户不能再绑定；重新编辑并保存可恢复使用。",
      lifecycleClassName: "beta-pill beta-pill--destroyed",
      isUsable: false,
      expiresDateText,
      editActionText: "恢复并编辑",
    }));
  }

  const diffDays = getDateDiffFromToday(expiresDateText);
  if (typeof diffDays === "number" && diffDays < 0) {
    return applyReadOnlyBetaMeta(code, Object.assign({}, code, scopeMeta, {
      lifecycleKey: "expired",
      lifecycleLabel: "已失效",
      lifecycleHint: "内测码已过期，需调整到期日期后才可继续绑定。",
      lifecycleClassName: "beta-pill beta-pill--expired",
      isUsable: false,
      expiresDateText,
      editActionText: "续期并编辑",
    }));
  }

  if (typeof diffDays === "number" && diffDays <= 3) {
    return applyReadOnlyBetaMeta(code, Object.assign({}, code, scopeMeta, {
      lifecycleKey: "expiring",
      lifecycleLabel: diffDays === 0 ? "今日到期" : "即将到期",
      lifecycleHint:
        diffDays === 0 ? "今天到期，建议立即续期。" : `还有 ${diffDays} 天到期，建议提前续期。`,
      lifecycleClassName: "beta-pill beta-pill--expiring",
      isUsable: true,
      expiresDateText,
      editActionText: "续期并编辑",
    }));
  }

  return applyReadOnlyBetaMeta(code, Object.assign({}, code, scopeMeta, {
    lifecycleKey: "usable",
    lifecycleLabel: expiresDateText ? "有效中" : "长期有效",
    lifecycleHint: expiresDateText ? `有效期至 ${expiresDateText}` : "未设置到期日期，当前长期有效。",
    lifecycleClassName: "beta-pill beta-pill--usable",
    isUsable: true,
    expiresDateText,
    editActionText: "编辑",
  }));
}

function decorateBetaCodesByChannel(codes, channel) {
  return filterBetaCodesByChannel(codes, channel).map((item) => decorateBetaCodeForChannel(item, channel));
}

function summarizeDecoratedBetaCodes(codes) {
  return (Array.isArray(codes) ? codes : []).reduce(
    (summary, item) => {
      summary.total += 1;
      if (item && item.isUsable) summary.usable += 1;
      if (item && item.lifecycleKey === "expiring") summary.expiring += 1;
      if (item && item.lifecycleKey === "expired") summary.expired += 1;
      if (item && item.lifecycleKey === "destroyed") summary.destroyed += 1;
      return summary;
    },
    { total: 0, usable: 0, expiring: 0, expired: 0, destroyed: 0 }
  );
}

function buildBetaDraftHelperText(draft, channel, codes) {
  const currentDraft = draft && typeof draft === "object" ? draft : createEmptyBetaDraft(channel);
  const currentCode = (Array.isArray(codes) ? codes : []).find((item) => item.id === normalizeText(currentDraft.codeId));
  if (currentCode) {
    if (currentCode.readOnly) {
      return currentCode.manageHint || "旧体系兼容码在这里仅支持查看，不支持编辑。";
    }
    if (currentCode.lifecycleKey === "destroyed") {
      return "这条内测码当前已销毁；重新保存后会恢复使用。";
    }
    if (currentCode.lifecycleKey === "expired") {
      return "这条内测码当前已失效；建议调整到期日期后再保存。";
    }
    return `${currentCode.scopeHint} ${currentCode.lifecycleHint}`;
  }

  return channel === "web"
    ? "新建后，仅 Web 端登录用户可绑定这条内测码进入当前页面。"
    : "新建后，仅小程序端登录用户可绑定这条内测码进入当前页面。";
}

function buildBetaSaveButtonText(draft, codes) {
  const currentDraft = draft && typeof draft === "object" ? draft : null;
  const currentCode = (Array.isArray(codes) ? codes : []).find(
    (item) => item.id === normalizeText(currentDraft && currentDraft.codeId)
  );
  if (!currentCode) return "创建内测码";
  if (currentCode.readOnly) return "兼容只读";
  if (currentCode.lifecycleKey === "destroyed") return "恢复并保存";
  if (currentCode.lifecycleKey === "expired") return "续期并保存";
  return "更新内测码";
}

function buildBetaSectionDesc(row, channel) {
  const currentState = normalizeText(row && row.currentRule ? row.currentRule.publishState : "") || "offline";
  const visibleCodes = Array.isArray(row && row.betaCodesVisible) ? row.betaCodesVisible : [];
  const availableCodes = Array.isArray(row && row.betaCodesAvailable) ? row.betaCodesAvailable : [];
  const readOnlyVisibleCodes = visibleCodes.filter((item) => normalizeBoolean(item && item.readOnly, false));
  const readOnlyAvailableCodes = availableCodes.filter((item) => normalizeBoolean(item && item.readOnly, false));
  const editableAvailableCodes = availableCodes.filter((item) => !normalizeBoolean(item && item.readOnly, false));
  const currentChannel = normalizeText(channel) === "miniprogram" ? "miniprogram" : "web";
  const otherChannelCodes = (Array.isArray(row && row.betaCodes) ? row.betaCodes : []).filter((item) => {
    const codeChannel = normalizeBetaCodeChannel(item && item.channel);
    return codeChannel !== "shared" && codeChannel !== currentChannel;
  });

  if (currentState === "beta") {
    if (availableCodes.length > 0) {
      if (!editableAvailableCodes.length && readOnlyAvailableCodes.length) {
        return "当前页面仍处于内测状态，现有可用内测码来自旧体系兼容展示；此处仅可查看，如需维护请使用旧版内测功能管理。";
      }
      if (readOnlyAvailableCodes.length) {
        return "维护当前端可用的内测码；旧体系兼容码会一并展示为只读。";
      }
      return "维护当前端可用的内测码，并可继续保留内测发布。";
    }
    if (otherChannelCodes.length > 0 && visibleCodes.length === 0) {
      return "当前页面仍处于内测状态，但当前端没有可用内测码；现有内测码属于另一端。";
    }
    if (visibleCodes.length > 0) {
      if (readOnlyVisibleCodes.length === visibleCodes.length) {
        return "当前页面仍处于内测状态，但当前端仅剩旧体系兼容码，且暂时都不可用；如需维护请使用旧版内测功能管理。";
      }
      return "当前页面仍处于内测状态，但当前端内测码都已失效或不可用。";
    }
    return "当前页面仍处于内测状态，但当前端还没有内测码。";
  }

  if (availableCodes.length > 0) {
    if (!editableAvailableCodes.length && readOnlyAvailableCodes.length) {
      return "当前端已有可用的旧体系兼容码，可直接切换为内测；兼容码在这里仅作只读展示。";
    }
    if (readOnlyAvailableCodes.length) {
      return "已满足切换为内测条件；旧体系兼容码会一并展示为只读。";
    }
    return "已满足切换为内测条件，可从当前状态切换为内测。";
  }
  if (visibleCodes.length > 0) {
    if (readOnlyVisibleCodes.length === visibleCodes.length) {
      return "当前端仅有旧体系兼容码，且暂时都不可用；如需维护请使用旧版内测功能管理。";
    }
    return "当前端已有内测码，但暂时都不可用；建议续期、恢复或新建一条可用内测码。";
  }
  return "请先创建至少一个当前端可用的内测码，才能切换为内测。";
}

function buildBetaEmptyStateText(row, channel) {
  const visibleCodes = Array.isArray(row && row.betaCodesVisible) ? row.betaCodesVisible : [];
  const availableCodes = Array.isArray(row && row.betaCodesAvailable) ? row.betaCodesAvailable : [];
  const readOnlyVisibleCodes = visibleCodes.filter((item) => normalizeBoolean(item && item.readOnly, false));
  const currentState = normalizeText(row && row.currentRule ? row.currentRule.publishState : "") || "offline";
  const currentChannelLabel = normalizeText(channel) === "miniprogram" ? "小程序" : "Web";
  const currentChannel = normalizeText(channel) === "miniprogram" ? "miniprogram" : "web";
  const otherChannelCodes = (Array.isArray(row && row.betaCodes) ? row.betaCodes : []).filter((item) => {
    const codeChannel = normalizeBetaCodeChannel(item && item.channel);
    return codeChannel !== "shared" && codeChannel !== currentChannel;
  });

  if (availableCodes.length > 0) {
    return "";
  }
  if (otherChannelCodes.length > 0 && visibleCodes.length === 0) {
    return `当前${currentChannelLabel}端没有内测码；现有内测码属于另一端，请为当前端补充内测码。`;
  }
  if (visibleCodes.length > 0) {
    if (readOnlyVisibleCodes.length === visibleCodes.length) {
      return `当前${currentChannelLabel}端只有旧体系兼容内测码，且当前均不可用；如需维护请使用旧版内测功能管理。`;
    }
    return `当前${currentChannelLabel}端暂无可用内测码，请续期、恢复或新建一条可用内测码。`;
  }
  if (currentState === "beta") {
    return `当前${currentChannelLabel}端还没有内测码；页面虽然仍标记为内测，但普通用户已无法通过内测码进入。`;
  }
  return `当前${currentChannelLabel}端还没有内测码，请先创建至少一个可用内测码。`;
}

function applyBetaPresentation(row, channel) {
  const betaCodesVisible = decorateBetaCodesByChannel(row.betaCodes, channel);
  row.betaCodesVisible = betaCodesVisible;
  row.betaCodesAvailable = betaCodesVisible.filter((item) => item.isUsable);
  row.betaCodeSummary = summarizeDecoratedBetaCodes(betaCodesVisible);
  row.betaDraftHelperText = buildBetaDraftHelperText(row.betaDraft, channel, betaCodesVisible);
  row.betaSaveButtonText = buildBetaSaveButtonText(row.betaDraft, betaCodesVisible);
  row.betaSectionDesc = buildBetaSectionDesc(row, channel);
  row.betaEmptyStateText = buildBetaEmptyStateText(row, channel);
  return row;
}

function canShowInNav(row, channel) {
  if (isSecondaryPageKey(row && row.pageKey)) {
    return false;
  }

  if (channel === "web") {
    return normalizeBoolean(row.isNavCandidateWeb, Boolean(normalizeText(row.iconKey)));
  }
  return Boolean(
    normalizeBoolean(row.isTabCandidateMiniProgram, false) &&
      normalizeText(row.tabKey) &&
      normalizeText(row.iconKey)
  );
}

function resolveForcedPublishState(pageKey, channel) {
  void pageKey;
  void channel;
  return "";
}

function isForcedHomeEntry(pageKey, channel) {
  void pageKey;
  void channel;
  return false;
}

function buildForcedStateHint(forcedState) {
  void forcedState;
  return "";
}

function buildQuickActionSuccessNotice(pageName, channel, state, isSecondaryPage) {
  if (isSecondaryPage) {
    if (state === "online") {
      return `${pageName} 入口已显示，页面顶部标题会同步更新`;
    }
    if (state === "beta") {
      return `${pageName} 已切换为内测`;
    }
    return `${pageName} 入口已隐藏，所属一级页中不再展示`;
  }

  if (state === "online") {
    return `${pageName} 已上线并进入${channel === "web" ? "Web" : "小程序"}底部菜单`;
  }
  if (state === "beta") {
    return `${pageName} 已切换为内测，需登录并绑定内测码后从无底栏入口进入`;
  }
  return `${pageName} 已下线，普通用户无法访问`;
}

function resolveQuickActionMeta(row, channel) {
  const currentState = normalizeText(row && row.currentRule ? row.currentRule.publishState : "") || "offline";
  const isSecondaryPage = isSecondaryPageKey(row && row.pageKey);
  const forcedState = resolveForcedPublishState(row && row.pageKey, channel);
  const betaSummary = row && row.betaCodeSummary ? row.betaCodeSummary : summarizeDecoratedBetaCodes(decorateBetaCodesByChannel(row && row.betaCodes, channel));
  const canOnline = (isSecondaryPage || canShowInNav(row, channel)) && (!forcedState || forcedState === "online");
  const canBeta = normalizeBoolean(row && row.supportsBeta, false) && normalizeNumber(betaSummary && betaSummary.usable, 0) > 0 && (!forcedState || forcedState === "beta");
  const canOffline = !forcedState || forcedState === "offline";

  const createMeta = (state, disabled) => ({
    type: state,
    disabled: normalizeBoolean(disabled, false),
    label:
      state === "online"
        ? isSecondaryPage
          ? "显示"
          : "上线"
        : state === "beta"
          ? "内测"
          : isSecondaryPage
            ? "隐藏"
            : "下线",
    loadingLabel:
      state === "online"
        ? isSecondaryPage
          ? "显示中..."
          : "上线中..."
        : state === "beta"
          ? "切换中..."
          : isSecondaryPage
            ? "隐藏中..."
            : "下线中...",
    className: state === "online" ? "action-btn--online" : state === "beta" ? "action-btn--beta" : "action-btn--offline",
  });

  if (currentState === "offline") {
    if (canOnline) return createMeta("online", false);
    if (canBeta) return createMeta("beta", false);
    if (normalizeBoolean(row && row.supportsBeta, false) && (!forcedState || forcedState === "beta")) {
      return createMeta("beta", true);
    }
    return createMeta("online", true);
  }

  if (currentState === "beta") {
    if (canOnline) return createMeta("online", false);
    return createMeta("offline", !canOffline);
  }

  return createMeta("offline", !canOffline);
}

function getDisplayStateMeta(row) {
  const currentState = normalizeText(row && row.currentRule ? row.currentRule.publishState : "") || "offline";
  const betaUsableCount = normalizeNumber(row && row.betaCodeSummary ? row.betaCodeSummary.usable : 0, 0);
  if (isSecondaryPageKey(row && row.pageKey)) {
    if (currentState === "online") {
      return { type: "online", label: "显示中" };
    }
    if (currentState === "beta") {
      return { type: "beta", label: betaUsableCount > 0 ? "内测中" : "内测异常" };
    }
    return { type: "offline", label: "已隐藏" };
  }

  return {
    type: currentState,
    label: currentState === "beta" && betaUsableCount <= 0 ? "内测异常" : (STATE_LABEL_MAP[currentState] || "下线"),
  };
}

function compareSecondaryRows(left, right) {
  if (left.currentRule.navOrder !== right.currentRule.navOrder) {
    return left.currentRule.navOrder - right.currentRule.navOrder;
  }
  return normalizeText(left.pageName).localeCompare(normalizeText(right.pageName), "zh-CN");
}

function sortSecondaryRows(rows) {
  return (Array.isArray(rows) ? rows : []).slice().sort((left, right) => compareSecondaryRows(left, right));
}

function buildSecondaryChildGroups(parent, children, channel) {
  const orderedChildren = sortSecondaryRows(children);
  if (normalizeText(parent && parent.pageKey) !== "profile") {
    return orderedChildren.length > 0
      ? [
          {
            key: `${normalizeText(parent && parent.pageKey)}:all`,
            title: "",
            description: "",
            rows: orderedChildren,
          },
        ]
      : [];
  }

  const guestRows = orderedChildren.filter((item) =>
    isProfileGuestSecondaryPageForChannel(item && item.pageKey, channel)
  );
  const authenticatedRows = orderedChildren.filter((item) =>
    isProfileAuthenticatedSecondaryPageKey(item && item.pageKey)
  );
  const otherRows = orderedChildren.filter(
    (item) =>
      !isProfileGuestSecondaryPageForChannel(item && item.pageKey, channel) &&
      !isProfileAuthenticatedSecondaryPageKey(item && item.pageKey)
  );

  return [
    guestRows.length > 0
      ? {
          key: `${normalizeText(parent && parent.pageKey)}:guest`,
          title: "认证流程页",
          description: "用于登录前流程，不参与登录后「我的」菜单排序。",
          rows: guestRows,
        }
      : null,
    authenticatedRows.length > 0
      ? {
          key: `${normalizeText(parent && parent.pageKey)}:authenticated`,
          title: "登录后菜单",
          description: "这里的入口会出现在登录后的「我的」页内，并支持单独调整展示顺序。",
          rows: authenticatedRows,
        }
      : null,
    otherRows.length > 0
      ? {
          key: `${normalizeText(parent && parent.pageKey)}:other`,
          title: "其他二级页",
          description: "当前仍属于该一级页的二级页面。",
          rows: otherRows,
        }
      : null,
  ].filter(Boolean);
}

function buildPageSections(allRows, visibleRows, channel, expandedKey, hasActiveFilter) {
  const orderedAllRows = Array.isArray(allRows) ? allRows : [];
  const orderedVisibleRows = Array.isArray(visibleRows) ? visibleRows : [];
  const visibleRowKeySet = new Set(orderedVisibleRows.map((item) => normalizeText(item && item.pageKey)));
  const childrenByParent = orderedVisibleRows.reduce((map, item) => {
    const parentPageKey = resolveSecondaryParentPageKey(item && item.pageKey);
    if (!parentPageKey) {
      return map;
    }
    const currentRows = map.get(parentPageKey) || [];
    currentRows.push(item);
    map.set(parentPageKey, currentRows);
    return map;
  }, new Map());
  const collectionRows = orderedAllRows
    .filter((item) => !isSecondaryPageKey(item && item.pageKey))
    .filter((item) => {
      const pageKey = normalizeText(item && item.pageKey);
      return visibleRowKeySet.has(pageKey) || (childrenByParent.get(pageKey) || []).length > 0;
    })
    .map((item) => {
      const children = sortSecondaryRows(childrenByParent.get(normalizeText(item && item.pageKey)) || []).map((child) =>
        Object.assign({}, child, {
          parentPageName: normalizeText(item && item.pageName),
          entryHint:
            normalizeText(child && child.pageDescription) ||
            `显示后将作为“${normalizeText(item && item.pageName)}”页的入口名称与顶部标题。`,
        })
      );
      return {
        key: normalizeText(item && item.pageKey),
        parent: item,
        children,
        childGroups: buildSecondaryChildGroups(item, children, channel),
        childCount: children.length,
        isExpanded: children.length > 0 && (normalizeText(expandedKey) === normalizeText(item && item.pageKey) || hasActiveFilter),
      };
    });

  if (!collectionRows.length) {
    return [];
  }

  return [
    {
      key: "collection",
      title: "页面集合",
      description:
        channel === "miniprogram"
          ? "维护当前小程序端页面集合。一级页面可展开查看所属二级菜单；“我的”页仅保留登录后菜单排序，微信登录入口不再作为独立二级页维护。"
          : "维护当前 Web 端页面集合。一级页面可展开查看所属二级菜单，当前已支持在“我的”“提取”页下维护二级入口，便于统一定位与精准屏蔽。",
      rows: collectionRows,
    },
  ];
}

function createRuleForm(rule, row) {
  const current = rule && typeof rule === "object" ? rule : {};
  const isSecondaryPage = isSecondaryPageKey(row && row.pageKey);
  const isMiniProgramProfilePrimaryPage =
    normalizeText(row && row.routePathMiniProgram) === "pages/profile/index" &&
    !isSecondaryPage;
  const navText = isMiniProgramProfilePrimaryPage
    ? "我的"
    : normalizeText(current.navText) || normalizeText(row.defaultTabText) || normalizeText(row.pageName);
  return {
    publishState: normalizeText(current.publishState) || "offline",
    showInNav: isSecondaryPage ? false : normalizeBoolean(current.showInNav, false),
    navOrder: normalizeNumber(current.navOrder, 99),
    navText,
    guestNavText: isSecondaryPage
      ? navText
      : isMiniProgramProfilePrimaryPage
        ? "我的"
      : normalizeText(current.guestNavText) ||
        normalizeText(row.defaultGuestTabText) ||
        navText ||
        normalizeText(row.pageName),
    headerTitle: isSecondaryPage ? navText : normalizeText(current.headerTitle),
    headerSubtitle: normalizeText(current.headerSubtitle),
    isHomeEntry: normalizeBoolean(current.isHomeEntry, false),
    notes: normalizeText(current.notes),
  };
}

function normalizeRuleForm(row, channel, form) {
  const current = form && typeof form === "object" ? form : {};
  const publishState = normalizeText(current.publishState) || "offline";
  const isSecondaryPage = isSecondaryPageKey(row && row.pageKey);
  const navSupported = canShowInNav(row, channel);
  const showInNav = isSecondaryPage ? false : publishState === "online" && navSupported;
  const resolvedNavOrder = normalizeNumber(current.navOrder, isSecondaryPage ? 99 : 0);
  const isMiniProgramProfilePrimaryPage =
    normalizeText(channel) === "miniprogram" &&
    normalizeText(row && row.pageKey) === "profile" &&
    !isSecondaryPage;
  const navText = isMiniProgramProfilePrimaryPage
    ? "我的"
    : normalizeText(current.navText) || normalizeText(row.defaultTabText) || normalizeText(row.pageName);
  const guestNavText = isSecondaryPage
    ? navText
    : isMiniProgramProfilePrimaryPage
      ? "我的"
    : normalizeText(current.guestNavText) ||
      normalizeText(row.defaultGuestTabText) ||
      navText ||
      normalizeText(row.pageName);
  return {
    publishState,
    showInNav,
    navOrder: resolvedNavOrder,
    navText,
    guestNavText,
    headerTitle: isSecondaryPage ? navText : normalizeText(current.headerTitle),
    headerSubtitle: normalizeText(current.headerSubtitle),
    isHomeEntry: false,
    notes: normalizeText(current.notes),
  };
}

function buildDialogEditableRule(row, channel, form) {
  const savedRule = createRuleForm(row && row.channels ? row.channels[channel] : null, row);
  const draftRule = normalizeRuleForm(row, channel, form);
  const isSecondaryPage = isSecondaryPageKey(row && row.pageKey);

  if (isSecondaryPage) {
    const titleText = normalizeText(draftRule.navText);
    return normalizeRuleForm(row, channel, Object.assign({}, savedRule, {
      publishState: draftRule.publishState,
      navOrder: draftRule.navOrder,
      notes: draftRule.notes,
      navText: titleText,
      guestNavText: titleText,
      headerTitle: titleText,
    }));
  }

  if (draftRule.publishState === "beta") {
    return normalizeRuleForm(row, channel, Object.assign({}, savedRule, {
      publishState: draftRule.publishState,
      navOrder: draftRule.navOrder,
      notes: draftRule.notes,
      headerTitle: normalizeText(draftRule.headerTitle),
    }));
  }

  const navText = normalizeText(draftRule.navText);
  return normalizeRuleForm(row, channel, Object.assign({}, savedRule, {
    publishState: draftRule.publishState,
    navOrder: draftRule.navOrder,
    notes: draftRule.notes,
    navText,
    guestNavText: navText,
    headerTitle: normalizeText(draftRule.headerTitle),
    headerSubtitle: normalizeText(draftRule.headerSubtitle),
  }));
}

function withDisplayLabel(item) {
  return Object.assign({}, item, {
    displayLabel:
      normalizeText(item && item.loginNavLabel) ||
      normalizeText(item && item.currentRule && item.currentRule.navText) ||
      normalizeText(item && item.pageName),
  });
}

function sortNavRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter(
      (item) =>
        !isSecondaryPageKey(item && item.pageKey) &&
        item.currentRule.publishState === "online" &&
        item.currentRule.showInNav
    )
    .slice()
    .sort((left, right) => {
      if (left.currentRule.navOrder !== right.currentRule.navOrder) {
        return left.currentRule.navOrder - right.currentRule.navOrder;
      }
      return normalizeText(left.pageName).localeCompare(normalizeText(right.pageName), "zh-CN");
    })
    .map((item) => withDisplayLabel(item));
}

function sortProfileAuthenticatedSecondaryRows(rows) {
  return sortSecondaryRows(
    (Array.isArray(rows) ? rows : []).filter(
      (item) =>
        resolveSecondaryParentPageKey(item && item.pageKey) === "profile" &&
        isProfileAuthenticatedSecondaryPageKey(item && item.pageKey) &&
        normalizeText(item && item.currentRule && item.currentRule.publishState) === "online"
    )
  ).map((item) => withDisplayLabel(item));
}

function buildRow(item, channel) {
  const current = item && typeof item === "object" ? item : {};
  const channels = current.channels && typeof current.channels === "object" ? current.channels : {};
  const currentChannelRule = channels[channel] && typeof channels[channel] === "object" ? channels[channel] : {};
  const row = {
    pageKey: normalizeText(current.pageKey),
    isSecondaryPage: isSecondaryPageKey(current.pageKey),
    pageName: normalizeText(current.pageName),
    pageDescription: normalizeText(current.pageDescription),
    routePathWeb: normalizeText(current.routePathWeb),
    routePathMiniProgram: normalizeText(current.routePathMiniProgram),
    previewRoutePathWeb: normalizeText(current.previewRoutePathWeb),
    previewRoutePathMiniProgram: normalizeText(current.previewRoutePathMiniProgram),
    tabKey: normalizeText(current.tabKey),
    iconKey: normalizeText(current.iconKey),
    defaultTabText: normalizeText(current.defaultTabText),
    defaultGuestTabText: normalizeText(current.defaultGuestTabText),
    isNavCandidateWeb: normalizeBoolean(current.isNavCandidateWeb, false),
    isTabCandidateMiniProgram: normalizeBoolean(current.isTabCandidateMiniProgram, false),
    supportsBeta: normalizeBoolean(current.supportsBeta, true),
    supportsPreview: normalizeBoolean(current.supportsPreview, true),
    isBuiltIn: normalizeBoolean(current.isBuiltIn, false),
    isActive: normalizeBoolean(current.isActive, true),
    channels: {
      web: Object.assign({ routePath: "", previewRoutePath: "" }, channels.web || {}),
      miniprogram: Object.assign({ routePath: "", previewRoutePath: "" }, channels.miniprogram || {}),
    },
    registryDraft: createRegistryDraftFromRow(current),
    currentRule: createRuleForm(currentChannelRule, current),
    betaDraft: createEmptyBetaDraft(channel),
    betaCodes: Array.isArray(current.betaCodes) ? current.betaCodes : [],
    navSupported: false,
    statusLabel: "下线",
    statusType: "offline",
    isExpanded: false,
    currentRoutePath: "",
    currentPreviewRoutePath: "",
    betaCodesVisible: [],
    betaCodesAvailable: [],
    betaCodeSummary: { total: 0, usable: 0, expiring: 0, expired: 0, destroyed: 0 },
    betaDraftHelperText: "",
    betaSaveButtonText: "创建内测码",
    betaSectionDesc: "",
    betaEmptyStateText: "当前端还没有内测码，请先创建至少一个可用内测码。",
    quickActionType: "offline",
    quickActionLabel: "下线",
    quickActionLoadingLabel: "下线中...",
    quickActionClassName: "action-btn--offline",
    quickActionDisabled: false,
    forcedState: "",
    forcedStateLabel: "",
    forcedStateHint: "",
    forcedHomeEntry: false,
    navRank: 0,
    navTotal: 0,
    isNavHome: false,
    loginNavLabel: "",
    guestNavLabel: "",
    headerTitlePreview: "",
    headerSubtitlePreview: "",
  };
  row.navSupported = canShowInNav(row, channel);
  row.currentRoutePath = normalizeText(row.channels[channel] && row.channels[channel].routePath);
  row.currentPreviewRoutePath = normalizeText(row.channels[channel] && row.channels[channel].previewRoutePath);
  applyBetaPresentation(row, channel);
  row.forcedState = resolveForcedPublishState(row.pageKey, channel);
  row.forcedStateLabel = STATE_LABEL_MAP[row.forcedState] || "";
  row.forcedStateHint = buildForcedStateHint(row.forcedState);
  row.forcedHomeEntry = isForcedHomeEntry(row.pageKey, channel);
  return row;
}
function buildPresentation(rows, channel, keyword, expandedKey, stateFilter) {
  const allRows = (Array.isArray(rows) ? rows : []).filter(
    (item) => !shouldHidePageForChannel(item && item.pageKey, channel)
  );
  const normalizedKeyword = normalizeText(keyword).toLowerCase();
  const normalizedStateFilter = normalizeText(stateFilter) || "all";
  const normalizedExpandedKey = normalizeText(expandedKey);
  const nextExpandedKey =
    normalizedExpandedKey && allRows.some((item) => item.pageKey === normalizedExpandedKey)
      ? normalizedExpandedKey
      : "";
  const navRows = sortNavRows(allRows);
  const profileAuthenticatedSecondaryRows = sortProfileAuthenticatedSecondaryRows(allRows);
  const navMetaMap = new Map(
    navRows.map((item, index) => [item.pageKey, { navRank: index + 1, isNavHome: index === 0 }])
  );
  const secondaryNavMetaMap = new Map(
    profileAuthenticatedSecondaryRows.map((item, index) => [
      item.pageKey,
      {
        secondaryNavRank: index + 1,
        secondaryNavTotal: profileAuthenticatedSecondaryRows.length,
      },
    ])
  );

  const displayOrderMap = new Map(navRows.map((item, index) => [item.pageKey, index]));
  const fallbackOrderMap = new Map(allRows.map((item, index) => [item.pageKey, index]));

  const orderedAllRows = allRows
    .slice()
    .sort((left, right) => {
      const leftDisplayOrder = displayOrderMap.has(left.pageKey)
        ? Number(displayOrderMap.get(left.pageKey))
        : 1000 + Number(fallbackOrderMap.get(left.pageKey) ?? 0);
      const rightDisplayOrder = displayOrderMap.has(right.pageKey)
        ? Number(displayOrderMap.get(right.pageKey))
        : 1000 + Number(fallbackOrderMap.get(right.pageKey) ?? 0);
      if (leftDisplayOrder !== rightDisplayOrder) {
        return leftDisplayOrder - rightDisplayOrder;
      }
      return normalizeText(left.pageName).localeCompare(normalizeText(right.pageName), "zh-CN");
    })
    .map((item) => {
      const row = clone(item);
      const navMeta = navMetaMap.get(row.pageKey) || { navRank: 0, isNavHome: false };
      const secondaryNavMeta = secondaryNavMetaMap.get(row.pageKey) || {
        secondaryNavRank: 0,
        secondaryNavTotal: 0,
      };
      const stateMeta = getDisplayStateMeta(row);
      row.isExpanded = row.pageKey === nextExpandedKey;
      row.statusType = stateMeta.type;
      row.statusLabel = stateMeta.label;
      applyBetaPresentation(row, channel);
      row.navRank = navMeta.navRank;
      row.navTotal = navRows.length;
      row.isNavHome = Boolean(navMeta.isNavHome);
      row.supportsSecondaryOrder =
        resolveSecondaryParentPageKey(row.pageKey) === "profile" &&
        isProfileAuthenticatedSecondaryPageKey(row.pageKey);
      row.secondaryNavRank = secondaryNavMeta.secondaryNavRank;
      row.secondaryNavTotal = secondaryNavMeta.secondaryNavTotal;
      row.loginNavLabel =
        normalizeText(row.currentRule.navText) || normalizeText(row.defaultTabText) || normalizeText(row.pageName);
      row.guestNavLabel =
        normalizeText(row.currentRule.guestNavText) ||
        normalizeText(row.defaultGuestTabText) ||
        row.loginNavLabel;
      row.headerTitlePreview =
        normalizeText(row.currentRule.headerTitle) || row.loginNavLabel || normalizeText(row.pageName);
      row.headerSubtitlePreview =
        normalizeText(row.currentRule.headerSubtitle) || "留空时不单独显示";
      row.showPrimaryBetaTitleEdit = !row.isSecondaryPage && row.currentRule.publishState === "beta";
      row.showPrimaryFullEdit = !row.isSecondaryPage && row.currentRule.publishState !== "beta";
      row.editSectionTitle = row.isSecondaryPage
        ? row.pageKey === "album-detail"
          ? "默认名称"
          : "标题设置"
        : row.showPrimaryBetaTitleEdit
          ? "顶部标题"
          : "页面信息";
      row.editSectionDesc = row.isSecondaryPage
        ? row.pageKey === "album-detail"
          ? "实际页面顶部优先显示相册名；只有相册未命名时，才会使用这里的默认名称。"
          : "二级页入口名称会同步作为页面顶部标题，并与所属一级页中的入口保持一致。"
        : row.showPrimaryBetaTitleEdit
          ? "当前为内测状态，只维护页面顶部标题；小标题和底部菜单名称沿用正式配置。"
          : "上线、下线状态下可维护大标题、小标题与底部菜单名称。";
      row.editSaveButtonText = row.isSecondaryPage
        ? row.pageKey === "album-detail"
          ? "保存默认名称"
          : "保存页面标题"
        : row.showPrimaryBetaTitleEdit
          ? "保存顶部标题"
          : "保存页面信息";
      const quickAction = resolveQuickActionMeta(row, channel);
      row.quickActionType = quickAction.type;
      row.quickActionLabel = quickAction.label;
      row.quickActionLoadingLabel = quickAction.loadingLabel;
      row.quickActionClassName = quickAction.className;
      row.quickActionDisabled = quickAction.disabled;
      return row;
    });
  const visibleRows = orderedAllRows.filter((item) => {
    if (normalizedStateFilter !== "all" && item.currentRule.publishState !== normalizedStateFilter) {
      return false;
    }

    if (!normalizedKeyword) return true;
    return [
      item.pageKey,
      item.pageName,
      item.pageDescription,
      item.routePathWeb,
      item.routePathMiniProgram,
      item.currentRoutePath,
      item.currentPreviewRoutePath,
    ]
      .join(" ")
      .toLowerCase()
      .includes(normalizedKeyword);
  });
  const hasActiveFilter = Boolean(normalizedKeyword) || normalizedStateFilter !== "all";

  const summary = allRows.reduce(
    (stats, item) => {
      stats.total += 1;
      if (item.currentRule.publishState === "online") stats.online += 1;
      if (item.currentRule.publishState === "beta") stats.beta += 1;
      if (item.currentRule.publishState === "offline") stats.offline += 1;
      if (item.currentRule.publishState === "online" && item.currentRule.showInNav) stats.nav += 1;
      stats.betaCodes += decorateBetaCodesByChannel(item.betaCodes, channel).filter((code) => code.isUsable).length;
      return stats;
    },
    { total: 0, online: 0, beta: 0, offline: 0, nav: 0, betaCodes: 0 }
  );

  return {
    rows: visibleRows,
    pageSections: buildPageSections(orderedAllRows, visibleRows, channel, nextExpandedKey, hasActiveFilter),
    navRows,
    profileAuthenticatedSecondaryRows,
    summary,
    filteredCount: visibleRows.length,
    expandedKey: nextExpandedKey,
    keyword: normalizeText(keyword),
    stateFilter: normalizedStateFilter,
  };
}

function countMiniprogramNavItems(rows, pageKey, nextRule) {
  return (Array.isArray(rows) ? rows : []).reduce((count, item) => {
    const matched = item.pageKey === pageKey ? nextRule : item.currentRule;
    return count + (matched.publishState === "online" && matched.showInNav ? 1 : 0);
  }, 0);
}

function normalizeMiniProgramRoutePath(value) {
  const text = normalizeText(value);
  if (!text) return "";
  return text.startsWith("/") ? text : `/${text}`;
}

function extractNavigationErrorText(error) {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (!error || typeof error !== "object") return "";
  return String(error.errMsg || error.message || "").trim();
}

function shouldRetryRouteWithRedirect(error) {
  const lowerMessage = extractNavigationErrorText(error).toLowerCase();
  return (
    lowerMessage.includes("webview count limit exceed") ||
    lowerMessage.includes("page stack depth exceed") ||
    (lowerMessage.includes("page stack") && lowerMessage.includes("exceed")) ||
    lowerMessage.includes("limit exceed")
  );
}

function prepareMiniProgramAdminPreview(pageKey, routePath, channel) {
  const app = typeof getApp === "function" ? getApp() : null;
  if (!app || typeof app.setPagePresentation !== "function") return;
  const normalizedRoute = normalizeMiniProgramRoutePath(routePath).replace(/^\//, "");
  if (!normalizedRoute) return;
  app.setPagePresentation({
    mode: "preview",
    pageKey: normalizeText(pageKey),
    routePath: normalizedRoute,
    fallbackRoute: `/pages/admin/page-center/index?channel=${channel}`,
    fallbackTab: "pages/profile/index",
  });
}

function openMiniProgramAdminRoute(url) {
  const target = normalizeMiniProgramRoutePath(url);
  if (!target) {
    return Promise.reject(new Error("缺少小程序预览路由"));
  }
  const path = target.split("?")[0] || target;
  const app = typeof getApp === "function" ? getApp() : null;
  const runtimeConfig = app && app.globalData ? app.globalData.runtimeConfig : null;
  if (isTabBarPagePath(path, runtimeConfig)) {
    return new Promise((resolve, reject) => {
      wx.switchTab({ url: path, success: resolve, fail: reject });
    });
  }
  return new Promise((resolve, reject) => {
    wx.navigateTo({
      url: target,
      success: resolve,
      fail: (error) => {
        const message = extractNavigationErrorText(error).toLowerCase();
        if (message.includes("tabbar page") && path) {
          wx.switchTab({
            url: path,
            success: resolve,
            fail: reject,
          });
          return;
        }
        if (shouldRetryRouteWithRedirect(error)) {
          wx.redirectTo({
            url: target,
            success: resolve,
            fail: reject,
          });
          return;
        }
        reject(error);
      },
    });
  });
}

function buildAdminWebPreviewUrl(routePath) {
  const app = typeof getApp === "function" ? getApp() : null;
  const globalData = app && app.globalData ? app.globalData : {};
  const appUrl = normalizeText(globalData.appUrl).replace(/\/$/, "");
  const normalizedRoute = normalizeText(routePath);
  if (!appUrl || !normalizedRoute) return "";
  if (/^https?:\/\//i.test(normalizedRoute)) return normalizedRoute;
  return `${appUrl}${normalizedRoute.startsWith("/") ? normalizedRoute : `/${normalizedRoute}`}`;
}

function buildChannelPanelCopy(channel) {
  const currentMeta = CHANNEL_META[normalizeText(channel) === "miniprogram" ? "miniprogram" : "web"] || CHANNEL_META.web;
  return {
    pageTitle: currentMeta.title,
    pageBadge: currentMeta.badge,
    pageDesc: currentMeta.desc,
    runtimeHint: normalizeText(channel) === "miniprogram"
      ? "页面显示与隐藏统一由页面管理控制；一级页进入底部菜单，二级页进入“我的”菜单，不再受旧审核开关影响。"
      : "页面显示与隐藏统一由页面管理控制；这里只维护 Web 页面，不会改动小程序页面排序。",
  };
}
Component({
  properties: {
    channel: {
      type: String,
      value: "web",
    },
    embedded: {
      type: Boolean,
      value: false,
    },
  },
  data: {
    safeTop: 0,
    loading: true,
    savingKey: "",
    noticeType: "",
    noticeText: "",
    dialogMode: "",
    dialogPageKey: "",
    dialogRow: null,
    betaDeleteConfirm: null,
    channelTitle: CHANNEL_META.web.title,
    channelBadge: CHANNEL_META.web.badge,
    channelDesc: CHANNEL_META.web.desc,
    heroOnlineTip: "上线：进入 Web 底部菜单，最多 5 个",
    channelOnlyDesc: "这里只维护 Web 页面路由、查看入口与底栏规则；不会改动小程序页面排序。",
    journeyRangeDesc: "先确认这里只影响 Web 页面，避免误以为会同步修改小程序页面。",
    journeyNavDesc: "上线页面会进入 Web 底部菜单；顺序第 1 项自动作为首页。",
    summaryTotalNote: "Web 端当前已登记页总数",
    summaryNavNote: "Web 底部菜单容量",
    runtimeHint: "页面显示与隐藏统一由页面管理控制；一级页进入底部菜单，二级页进入“我的”菜单，不再受旧审核开关影响。",
    compactNavHint: "• 上线后进入 Web 底部菜单，顺序第 1 项自动成为首页",
    navPanelHint: "查看与内测均走无底栏路由；上线后进入 Web 底部菜单并支持顺序调整，第 1 项自动作为首页。",
    embeddedChannelTag: "当前入口：Web 页面管理",
    searchKeyword: "",
    stateFilter: "all",
    expandedKey: "",
    filteredCount: 0,
    createExpanded: false,
    createDraft: createEmptyRegistryDraft(),
    allRows: [],
    pageRows: [],
    pageSections: [],
    navRows: [],
    profileAuthenticatedSecondaryRows: [],
    summary: { total: 0, online: 0, beta: 0, offline: 0, nav: 0, betaCodes: 0 },
        betaEditorFocusPageKey: "",
    iconOptions: ICON_OPTIONS,
    stateFilterOptions: STATE_FILTER_OPTIONS,
    tabOptions: TAB_OPTIONS,
  },
  observers: {
    channel(nextChannel) {
      const currentChannel = normalizeText(nextChannel) === "miniprogram" ? "miniprogram" : "web";
      this.setData(buildChannelPanelCopy(currentChannel));
    },
  },
  lifetimes: {
    attached() {
      const app = getApp();
      const globalData = app && app.globalData ? app.globalData : {};
      const safeTop = Number(globalData.statusBarHeight || 0);
      const channel = normalizeText(this.properties.channel) === "miniprogram" ? "miniprogram" : "web";
      this.setData(Object.assign({
        safeTop,
      }, buildChannelPanelCopy(channel)), () => {
        void this.bootstrap();
      });
    },
    detached() {
      if (this._noticeTimer) {
        clearTimeout(this._noticeTimer);
        this._noticeTimer = null;
      }
      if (this._betaEditorFocusTimer) {
        clearTimeout(this._betaEditorFocusTimer);
        this._betaEditorFocusTimer = null;
      }
    },
  },
  pageLifetimes: {
    show() {
      void this.refresh();
    },
  },
  methods: {
  refresh() {
    return this.bootstrap();
  },

  showNotice(type, text) {
    this.setData({ noticeType: type, noticeText: normalizeText(text) });
    if (this._noticeTimer) clearTimeout(this._noticeTimer);
    this._noticeTimer = setTimeout(() => {
      this.setData({ noticeType: "", noticeText: "" });
      this._noticeTimer = null;
    }, 2600);
  },

  async bootstrap() {
    this.setData({ loading: true });
    try {
      await requireAdminSession();
      await this.loadOverview();
    } catch (error) {
      this.setData({ loading: false });
      this.showNotice("error", readErrorMessage(error, "加载页面管理失败"));
    }
  },

  refreshPresentation(options) {
    const optionBag = options && typeof options === "object" ? options : {};
    const rows = Array.isArray(optionBag.rows) ? optionBag.rows : this.data.allRows;
    const keyword = Object.prototype.hasOwnProperty.call(optionBag, "keyword") ? optionBag.keyword : this.data.searchKeyword;
    const expandedKey = Object.prototype.hasOwnProperty.call(optionBag, "expandedKey") ? optionBag.expandedKey : this.data.expandedKey;
    const stateFilter = Object.prototype.hasOwnProperty.call(optionBag, "stateFilter") ? optionBag.stateFilter : this.data.stateFilter;
    const dialogMode = Object.prototype.hasOwnProperty.call(optionBag, "dialogMode")
      ? normalizeText(optionBag.dialogMode)
      : normalizeText(this.data.dialogMode);
    const dialogPageKey = Object.prototype.hasOwnProperty.call(optionBag, "dialogPageKey")
      ? normalizeText(optionBag.dialogPageKey)
      : normalizeText(this.data.dialogPageKey);
    const presentation = buildPresentation(
      rows,
      this.data.channel,
      keyword,
      expandedKey,
      stateFilter
    );
    const dialogRow = dialogPageKey
      ? presentation.rows.find((item) => item.pageKey === dialogPageKey) || null
      : null;
    this.setData({
      allRows: rows,
      pageRows: presentation.rows,
      pageSections: presentation.pageSections,
      navRows: presentation.navRows,
      profileAuthenticatedSecondaryRows: presentation.profileAuthenticatedSecondaryRows,
      summary: presentation.summary,
      filteredCount: presentation.filteredCount,
      expandedKey: presentation.expandedKey,
      searchKeyword: presentation.keyword,
      stateFilter: presentation.stateFilter,
      dialogMode: dialogRow ? dialogMode : "",
      dialogPageKey: dialogRow ? dialogPageKey : "",
      dialogRow,
      loading: false,
    });
  },

  async loadOverview() {
    const payload = await requestJson(
      "/api/admin/page-center/overview",
      buildPageManagementRequestOptions(this.data.channel, { method: "GET", timeout: 10000 })
    );
    if (payload && payload.error) {
      throw new Error(String(payload.error || "读取页面管理数据失败"));
    }    this.setData(buildChannelPanelCopy(this.data.channel));
    const rows = readArrayFromPayload(payload).map((item) => buildRow(item, this.data.channel));
    this.refreshPresentation({ rows });
  },

  findRow(pageKey) {
    return (Array.isArray(this.data.allRows) ? this.data.allRows : []).find((item) => item.pageKey === pageKey) || null;
  },

  noop() {},

  openActionDialog(pageKey, mode) {
    const row = this.findRow(pageKey);
    if (!row) return;
    this.refreshPresentation({ dialogPageKey: pageKey, dialogMode: mode });
  },

  closeActionDialog() {
    this.setData({ dialogMode: "", dialogPageKey: "", dialogRow: null, betaDeleteConfirm: null });
  },

  cancelDestroyBetaCode() {
    const current = this.data.betaDeleteConfirm;
    if (!current) return;
    if (this.data.savingKey === `destroy:${normalizeText(current.codeId)}`) return;
    this.setData({ betaDeleteConfirm: null });
  },

  async confirmDestroyBetaCode() {
    const current = this.data.betaDeleteConfirm;
    const codeId = normalizeText(current && current.codeId);
    if (!codeId) return;
    this.setData({ savingKey: `destroy:${codeId}` });
    try {
      const response = await requestJson(
        `/api/admin/page-center/beta-codes/${encodeURIComponent(codeId)}`,
        buildPageManagementRequestOptions(this.data.channel, {
          method: "DELETE",
          timeout: 10000,
        })
      );
      if (response && response.error) {
        throw new Error(String(response.error || "删除内测码失败"));
      }
      this.setData({ betaDeleteConfirm: null });
      await this.loadOverview();
      this.showNotice("success", normalizeText(response && response.message) || "内测码已删除");
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "删除内测码失败"));
    } finally {
      this.setData({ savingKey: "" });
    }
  },

  updateRow(pageKey, updater) {
    const nextRows = (Array.isArray(this.data.allRows) ? this.data.allRows : []).map((item) => {
      if (item.pageKey !== pageKey) return item;
      return updater(clone(item));
    });
    this.refreshPresentation({ rows: nextRows });
  },

  focusBetaEditor(pageKey) {
    const targetPageKey = normalizeText(pageKey);
    if (!targetPageKey) return;
    this.setData({ betaEditorFocusPageKey: "" }, () => {
      wx.nextTick(() => {
        this.setData({ betaEditorFocusPageKey: targetPageKey });
        if (this._betaEditorFocusTimer) {
          clearTimeout(this._betaEditorFocusTimer);
        }
        this._betaEditorFocusTimer = setTimeout(() => {
          this.setData({ betaEditorFocusPageKey: "" });
          this._betaEditorFocusTimer = null;
        }, 180);
      });
    });
  },

  updateRuleDraft(pageKey, updater) {
    const nextRows = (Array.isArray(this.data.allRows) ? this.data.allRows : []).map((item) => clone(item));
    const targetRow = nextRows.find((item) => item.pageKey === pageKey);
    if (!targetRow) return;

    const nextRule = updater(clone(targetRow.currentRule), targetRow) || targetRow.currentRule;
    targetRow.currentRule = normalizeRuleForm(targetRow, this.data.channel, nextRule);

    this.refreshPresentation({ rows: nextRows });
  },

  onSearchInput(e) {
    this.refreshPresentation({ keyword: e && e.detail ? e.detail.value : "" });
  },

  onStateFilterTap(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const value = normalizeText(dataset.value) || "all";
    this.refreshPresentation({ stateFilter: value, expandedKey: this.data.expandedKey });
  },

  onToggleCreate() {
    this.setData({ createExpanded: !this.data.createExpanded });
  },

  onCreateInput(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const field = normalizeText(dataset.field);
    if (!field) return;
    this.setData({ [`createDraft.${field}`]: e && e.detail ? e.detail.value : "" });
  },

  onCreateSwitch(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const field = normalizeText(dataset.field);
    if (!field) return;
    this.setData({ [`createDraft.${field}`]: normalizeBoolean(e && e.detail ? e.detail.value : false, false) });
  },

  onCreateOptionTap(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const field = normalizeText(dataset.field);
    const value = normalizeText(dataset.value);
    if (!field) return;
    const currentDraft = clone(this.data.createDraft || createEmptyRegistryDraft());
    this.setData({
      createDraft: Object.assign({}, currentDraft, buildRegistryOptionPatch(currentDraft, field, value)),
    });
  },

  async onSaveCreate() {
    const payload = buildRegistryPayload(this.data.createDraft);
    const message = validateRegistryPayload(payload, this.data.channel);
    if (message) {
      this.showNotice("error", message);
      return;
    }
    this.setData({ savingKey: "create:registry" });
    try {
      const response = await requestJson(
        "/api/admin/page-center/registry",
        buildPageManagementRequestOptions(this.data.channel, {
          method: "POST",
          data: Object.assign({}, payload, { scopeChannel: this.data.channel }),
          timeout: 10000,
        })
      );
      if (response && response.error) {
        throw new Error(String(response.error || "创建页面失败"));
      }
      this.setData({ createDraft: createEmptyRegistryDraft(), createExpanded: false });
      await this.loadOverview();
      this.showNotice("success", "新页面已注册成功");
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "创建页面失败"));
    } finally {
      this.setData({ savingKey: "" });
    }
  },

  onResetCreate() {
    this.setData({ createDraft: createEmptyRegistryDraft() });
  },
  onToggleExpand(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const pageKey = normalizeText(dataset.pageKey);
    this.refreshPresentation({ expandedKey: this.data.expandedKey === pageKey ? "" : pageKey });
  },

  onRegistryInput(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const pageKey = normalizeText(dataset.pageKey);
    const field = normalizeText(dataset.field);
    if (!pageKey || !field) return;
    const value = e && e.detail ? e.detail.value : "";
    this.updateRow(pageKey, (row) => {
      row.registryDraft[field] = value;
      return row;
    });
  },

  onRegistrySwitch(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const pageKey = normalizeText(dataset.pageKey);
    const field = normalizeText(dataset.field);
    if (!pageKey || !field) return;
    this.updateRow(pageKey, (row) => {
      row.registryDraft[field] = normalizeBoolean(e && e.detail ? e.detail.value : false, false);
      return row;
    });
  },

  onRegistryOptionTap(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const pageKey = normalizeText(dataset.pageKey);
    const field = normalizeText(dataset.field);
    const value = normalizeText(dataset.value);
    if (!pageKey || !field) return;
    this.updateRow(pageKey, (row) => {
      row.registryDraft = Object.assign(
        {},
        row.registryDraft,
        buildRegistryOptionPatch(row.registryDraft, field, value)
      );
      return row;
    });
  },

  async onSaveRegistry(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const pageKey = normalizeText(dataset.pageKey);
    const row = this.findRow(pageKey);
    if (!row) return;
    const payload = buildRegistryPayload(row.registryDraft);
    const message = validateRegistryPayload(payload, this.data.channel);
    if (message) {
      this.showNotice("error", message);
      return;
    }
    this.setData({ savingKey: `${pageKey}:registry` });
    try {
      const response = await requestJson(
        "/api/admin/page-center/registry",
        buildPageManagementRequestOptions(this.data.channel, {
          method: "POST",
          data: Object.assign({}, payload, { scopeChannel: this.data.channel }),
          timeout: 10000,
        })
      );
      if (response && response.error) {
        throw new Error(String(response.error || "保存页面注册信息失败"));
      }
      await this.loadOverview();
      this.showNotice("success", "页面注册信息已保存");
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "保存页面注册信息失败"));
    } finally {
      this.setData({ savingKey: "" });
    }
  },

  onResetRegistry(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const pageKey = normalizeText(dataset.pageKey);
    const row = this.findRow(pageKey);
    if (!row) return;
    this.updateRow(pageKey, (current) => {
      current.registryDraft = createRegistryDraftFromRow(current);
      return current;
    });
  },

  onRuleInput(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const pageKey = normalizeText(dataset.pageKey);
    const field = normalizeText(dataset.field);
    if (!pageKey || !field) return;
    const value = e && e.detail ? e.detail.value : "";
    this.updateRuleDraft(pageKey, (rule) => {
      rule[field] = field === "navOrder" ? Math.max(0, normalizeNumber(value, 99)) : value;
      return rule;
    });
  },

  onToggleShowInNav(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const pageKey = normalizeText(dataset.pageKey);
    this.updateRuleDraft(pageKey, (rule, row) => {
      if (rule.publishState !== "online" || !row.navSupported) {
        rule.showInNav = false;
      } else {
        rule.showInNav = !normalizeBoolean(rule.showInNav, false);
      }
      if (!rule.showInNav) {
        rule.isHomeEntry = false;
      }
      return rule;
    });
  },

  onToggleHomeEntry(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const pageKey = normalizeText(dataset.pageKey);
    this.updateRuleDraft(pageKey, (rule) => {
      if (rule.publishState === "online" && rule.showInNav) {
        rule.isHomeEntry = !normalizeBoolean(rule.isHomeEntry, false);
      }
      return rule;
    });
  },

  async persistRule(pageKey, form, successText, saveKey) {
    const row = this.findRow(pageKey);
    if (!row) return false;
    const nextRule = normalizeRuleForm(row, this.data.channel, form);
    const forcedState = resolveForcedPublishState(pageKey, this.data.channel, false);
    if (forcedState && nextRule.publishState !== forcedState) {
      this.showNotice("error", buildForcedStateHint(forcedState, false));
      return false;
    }
    const nextCount = countMiniprogramNavItems(this.data.allRows, pageKey, nextRule);
    if (nextCount > 5) {
      this.showNotice("error", `${this.data.channel === 'miniprogram' ? '小程序' : 'Web'} 底部菜单最多显示 5 个页面`);
      return false;
    }
    if (
      row.currentRule.publishState === "online" &&
      row.currentRule.showInNav &&
      !(nextRule.publishState === "online" && nextRule.showInNav) &&
      nextCount < 1
    ) {
      this.showNotice("error", "当前端至少需要保留 1 个已上线页面，不能下线最后一个底部菜单页面");
      return false;
    }
    this.setData({ savingKey: saveKey || `${pageKey}:rule` });
    try {
      const response = await requestJson(
        "/api/admin/page-center/pages",
        buildPageManagementRequestOptions(this.data.channel, {
          method: "POST",
          data: Object.assign({ pageKey, channel: this.data.channel }, nextRule),
          timeout: 10000,
        })
      );
      if (response && response.error) {
        throw new Error(String(response.error || "保存页面规则失败"));
      }
      await this.loadOverview();
      this.showNotice("success", successText || "页面规则已保存");
      return true;
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "保存页面规则失败"));
      return false;
    } finally {
      this.setData({ savingKey: "" });
    }
  },

  onSaveRule(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const pageKey = normalizeText(dataset.pageKey);
    const row = this.findRow(pageKey);
    if (!row) return;
    void this.persistRule(pageKey, row.currentRule, "页面规则已保存");
  },

  onSaveTitleRule(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const pageKey = normalizeText(dataset.pageKey);
    const row = this.findRow(pageKey);
    if (!row) return;
    const nextRule = buildDialogEditableRule(row, this.data.channel, row.currentRule);
    void this.persistRule(
      pageKey,
      nextRule,
      row.editSaveButtonText || (row.isSecondaryPage ? "页面标题已保存" : "页面信息已保存"),
      `${pageKey}:rule:title`
    );
  },

  onResetRule(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const pageKey = normalizeText(dataset.pageKey);
    const row = this.findRow(pageKey);
    if (!row) return;
    this.updateRow(pageKey, (current) => {
      current.currentRule = createRuleForm(current.channels[this.data.channel], current);
      return current;
    });
    this.showNotice("info", "已恢复当前页面已保存规则");
  },


  onQuickAction(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const pageKey = normalizeText(dataset.pageKey);
    const action = normalizeText(dataset.action);
    const row = this.findRow(pageKey);
    if (!row) return;
    if (action === "view") {
      void this.viewPage(pageKey);
      return;
    }
    if (action === "edit") {
      this.openActionDialog(pageKey, "edit");
      return;
    }
    const forcedState = resolveForcedPublishState(pageKey, this.data.channel, false);
    if (forcedState && action !== forcedState) {
      this.showNotice("error", buildForcedStateHint(forcedState, false));
      return;
    }
    if (action === "online" || action === "beta") {
      void this.quickSwitchState(row, action);
      return;
    }
    if (action !== "offline") {
      return;
    }
    this.openActionDialog(pageKey, "offline");
  },

  async quickSwitchState(row, state) {
    const targetState = normalizeText(state);
    const currentRow = row && typeof row === "object" ? row : null;
    if (!currentRow || !targetState) return false;
    if (targetState === "online" && !currentRow.isSecondaryPage && !currentRow.navSupported) {
      this.showNotice("error", `当前页面未标记为${this.data.channel === "web" ? "Web" : "小程序"}底栏候选，无法直接上线到底栏`);
      return false;
    }
    if (targetState === "beta") {
      if (!currentRow.supportsBeta) {
        this.showNotice("error", "当前页面未开启内测能力");
        return false;
      }
      if (!Array.isArray(currentRow.betaCodesAvailable) || !currentRow.betaCodesAvailable.length) {
        this.showNotice("error", "请先创建至少一个当前端可用的内测码，再切换为内测");
        return false;
      }
    }
    const nextRule = clone(currentRow.currentRule);
    if (targetState === "online") {
      nextRule.publishState = "online";
    } else if (targetState === "beta") {
      nextRule.publishState = "beta";
      nextRule.showInNav = false;
      nextRule.isHomeEntry = false;
    } else {
      nextRule.publishState = "offline";
      nextRule.showInNav = false;
      nextRule.isHomeEntry = false;
    }
    return this.persistRule(
      currentRow.pageKey,
      nextRule,
      buildQuickActionSuccessNotice(
        currentRow.pageName,
        this.data.channel,
        targetState,
        currentRow.isSecondaryPage
      ),
      `${currentRow.pageKey}:state:${targetState}`
    );
  },

  async onDialogSaveRule() {
    const pageKey = normalizeText(this.data.dialogPageKey);
    const row = this.findRow(pageKey);
    if (!row) return;
    const success = await this.persistRule(
      pageKey,
      buildDialogEditableRule(row, this.data.channel, row.currentRule),
      row.editSaveButtonText || "页面信息已保存"
    );
    if (success) {
      this.closeActionDialog();
    }
  },


  async onDialogSubmit(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const explicitAction = normalizeText(dataset.action);
    const pageKey = normalizeText(this.data.dialogPageKey);
    const mode = explicitAction || normalizeText(this.data.dialogMode);
    const row = this.findRow(pageKey);
    if (!row || !mode) return;

    if (mode === "beta") {
      if (!row.supportsBeta) {
        this.showNotice("error", "当前页面未开启内测能力");
        return;
      }
      if (!Array.isArray(row.betaCodesAvailable) || row.betaCodesAvailable.length === 0) {
        this.showNotice("error", "请先创建至少一个当前端可用的内测码，再切换到内测");
        return;
      }
    }

    if (mode === "online" && !row.isSecondaryPage && !row.navSupported) {
      this.showNotice("error", `当前页面未标记为${this.data.channel === "web" ? "Web" : "小程序"}底栏候选，无法直接上线到底栏`);
      return;
    }

    const nextRule = clone(row.currentRule);
    if (mode === "online") {
      nextRule.publishState = "online";
    } else if (mode === "beta") {
      nextRule.publishState = "beta";
      nextRule.showInNav = false;
      nextRule.isHomeEntry = false;
    } else {
      nextRule.publishState = "offline";
      nextRule.showInNav = false;
      nextRule.isHomeEntry = false;
    }

    const success = await this.persistRule(
      pageKey,
      buildDialogEditableRule(row, this.data.channel, nextRule),
      buildQuickActionSuccessNotice(row.pageName, this.data.channel, mode, row.isSecondaryPage)
    );
    if (success) {
      this.closeActionDialog();
    }
  },

  async onMoveNav(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const pageKey = normalizeText(dataset.pageKey);
    const direction = normalizeText(dataset.direction);
    const scope = normalizeText(dataset.scope);
    const isSecondaryOrder = scope === "profile-authenticated-secondary";
    const orderedRows = isSecondaryOrder
      ? sortProfileAuthenticatedSecondaryRows(this.data.allRows)
      : sortNavRows(this.data.allRows);
    const currentIndex = orderedRows.findIndex((item) => item.pageKey === pageKey);
    const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= orderedRows.length) return;
    const currentRow = orderedRows[currentIndex];
    const targetRow = orderedRows[targetIndex];
    if (
      !isSecondaryOrder &&
      (isForcedHomeEntry(currentRow.pageKey, this.data.channel, false) ||
        isForcedHomeEntry(targetRow.pageKey, this.data.channel, false))
    ) {
      this.showNotice("error", "当前环境下 pose 页面固定为首页，菜单顺序不可调整");
      return;
    }
    const currentRule = normalizeRuleForm(currentRow, this.data.channel, currentRow.currentRule);
    const targetRule = normalizeRuleForm(targetRow, this.data.channel, targetRow.currentRule);
    this.setData({ savingKey: `${pageKey}:${isSecondaryOrder ? "secondary-move" : "move"}` });
    let swapPersisted = false;
    try {
      await requestJson(
        "/api/admin/page-center/pages",
        buildPageManagementRequestOptions(this.data.channel, {
          method: "POST",
          data: Object.assign({ pageKey: currentRow.pageKey, channel: this.data.channel }, currentRule, {
            navOrder: targetRule.navOrder,
          }),
          timeout: 10000,
        })
      );
      await requestJson(
        "/api/admin/page-center/pages",
        buildPageManagementRequestOptions(this.data.channel, {
          method: "POST",
          data: Object.assign({ pageKey: targetRow.pageKey, channel: this.data.channel }, targetRule, {
            navOrder: currentRule.navOrder,
          }),
          timeout: 10000,
        })
      );
      swapPersisted = true;
      await this.loadOverview();
      this.showNotice(
        "success",
        isSecondaryOrder ? "登录后菜单顺序已更新" : "底部菜单顺序已更新"
      );
    } catch (error) {
      if (!swapPersisted) {
        try {
          await Promise.all([
            requestJson(
              "/api/admin/page-center/pages",
              buildPageManagementRequestOptions(this.data.channel, {
                method: "POST",
                data: Object.assign({ pageKey: currentRow.pageKey, channel: this.data.channel }, currentRule),
                timeout: 10000,
              })
            ),
            requestJson(
              "/api/admin/page-center/pages",
              buildPageManagementRequestOptions(this.data.channel, {
                method: "POST",
                data: Object.assign({ pageKey: targetRow.pageKey, channel: this.data.channel }, targetRule),
                timeout: 10000,
              })
            ),
          ]);
        } catch (_) {
          // ignore rollback errors
        }
      }
      this.showNotice(
        "error",
        readErrorMessage(error, isSecondaryOrder ? "调整登录后菜单顺序失败" : "调整底部菜单顺序失败")
      );
    } finally {
      this.setData({ savingKey: "" });
    }
  },

  onBetaInput(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const pageKey = normalizeText(dataset.pageKey);
    const field = normalizeText(dataset.field);
    if (!pageKey || !field) return;
    const value = e && e.detail ? e.detail.value : "";
    this.updateRow(pageKey, (row) => {
      row.betaDraft[field] = value;
      return row;
    });
  },

  onBetaChannelTap(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const pageKey = normalizeText(dataset.pageKey);
    if (!pageKey) return;
    this.updateRow(pageKey, (row) => {
      row.betaDraft.channel = this.data.channel;
      return row;
    });
  },

  onResetBeta(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const pageKey = normalizeText(dataset.pageKey);
    this.updateRow(pageKey, (row) => {
      row.betaDraft = createEmptyBetaDraft(this.data.channel);
      return row;
    });
  },

  onGenerateBetaCode(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const pageKey = normalizeText(dataset.pageKey);
    this.updateRow(pageKey, (row) => {
      row.betaDraft = Object.assign({}, row.betaDraft || createEmptyBetaDraft(this.data.channel), {
        betaCode: generateRandomBetaCode(),
        channel: normalizeText((row.betaDraft || {}).channel) || this.data.channel,
      });
      return row;
    });
  },

  onEditBetaCode(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const pageKey = normalizeText(dataset.pageKey);
    const codeId = normalizeText(dataset.codeId);
    const row = this.findRow(pageKey);
    if (!row) return;
    const code = row.betaCodesVisible.find((item) => item.id === codeId);
    if (!code) return;
    if (code.readOnly) {
      this.showNotice("info", code.manageHint || "旧体系兼容码在这里仅支持查看，不支持编辑。");
      return;
    }
    this.updateRow(pageKey, (current) => {
      current.betaDraft = {
        codeId: code.id,
        betaName: normalizeText(code.betaName),
        betaCode: normalizeText(code.betaCode),
        expiresAt: extractDateText(code.expiresAt),
        channel: normalizeText(code.channel) || this.data.channel,
      };
      return current;
    });
    this.focusBetaEditor(pageKey);
    this.showNotice(
      "info",
      code.lifecycleKey === "destroyed"
        ? "已载入已销毁内测码，重新保存后会恢复使用。"
        : code.lifecycleKey === "expired"
          ? "已载入已失效内测码，调整到期日期后可继续使用。"
          : "已载入内测码，可直接修改并保存。"
    );
  },

  onCopyBetaCode(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const betaCode = normalizeText(dataset.betaCode);
    if (!betaCode) {
      this.showNotice("error", "暂无可复制的内测码");
      return;
    }
    wx.setClipboardData({
      data: betaCode,
      success: () => this.showNotice("success", "内测码已复制"),
      fail: () => this.showNotice("error", "复制内测码失败，请重试"),
    });
  },

  async onSaveBetaCode(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const pageKey = normalizeText(dataset.pageKey);
    const row = this.findRow(pageKey);
    if (!row) return;
    if (!row.supportsBeta) {
      this.showNotice("error", "当前页面未开启内测能力");
      return;
    }
    const draft = row.betaDraft || createEmptyBetaDraft(this.data.channel);
    if (!normalizeText(draft.betaName)) {
      this.showNotice("error", "请先填写内测码名称");
      return;
    }
    this.setData({ savingKey: `${pageKey}:beta` });
    try {
      const response = await requestJson(
        "/api/admin/page-center/beta-codes",
        buildPageManagementRequestOptions(this.data.channel, {
          method: "POST",
          data: {
            pageKey,
            codeId: normalizeText(draft.codeId),
            betaName: normalizeText(draft.betaName),
            betaCode: normalizeText(draft.betaCode),
            expiresAt: normalizeText(draft.expiresAt),
            channel: this.data.channel,
          },
          timeout: 10000,
        })
      );
      if (response && response.error) {
        throw new Error(String(response.error || "保存内测码失败"));
      }
      await this.loadOverview();
      this.showNotice("success", normalizeText(response && response.message) || "内测码已保存");
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "保存内测码失败"));
    } finally {
      this.setData({ savingKey: "" });
    }
  },

  async onDestroyBetaCode(e) {
    const dataset = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {};
    const pageKey = normalizeText(dataset.pageKey);
    const codeId = normalizeText(dataset.codeId);
    const betaName = normalizeText(dataset.betaName) || "未命名内测码";
    if (!codeId) return;
    const row = this.findRow(pageKey);
    const code = row && Array.isArray(row.betaCodesVisible)
      ? row.betaCodesVisible.find((item) => item.id === codeId)
      : null;
    this.setData({
      betaDeleteConfirm: {
        pageKey,
        codeId,
        betaName,
      },
    });
  },

  async viewPage(pageKey) {
    const row = this.findRow(pageKey);
    if (!row) return;
    if (!row.supportsPreview) {
      this.showNotice("error", "当前页面未开启查看能力");
      return;
    }
    const previewRoute = normalizeText(row.currentPreviewRoutePath);
    if (!previewRoute) {
      this.showNotice("error", "当前页面缺少查看路由");
      return;
    }

    if (this.data.channel === "web") {
      const targetUrl = buildAdminWebPreviewUrl(previewRoute);
      if (!targetUrl) {
        this.showNotice("error", "当前未配置 Web 预览域名，无法打开查看页");
        return;
      }
      wx.navigateTo({
        url: `/pages/admin/web-preview/index?url=${encodeURIComponent(targetUrl)}`,
        fail: () => {
          wx.setClipboardData({
            data: targetUrl,
            success: () => this.showNotice("success", "已复制 Web 查看链接"),
            fail: () => this.showNotice("error", "打开失败，复制链接也失败了"),
          });
        },
      });
      return;
    }

    try {
      prepareMiniProgramAdminPreview(row.pageKey, previewRoute, this.data.channel);
      await openMiniProgramAdminRoute(previewRoute);
    } catch (error) {
      this.showNotice("error", readErrorMessage(error, "打开小程序查看页失败"));
    }
  },
  },
});
