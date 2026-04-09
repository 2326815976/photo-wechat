const {
  getSession,
  dbQuery,
  dbRpc,
  getBlockedDates,
  extractSessionUser,
} = require("../../services/photo-api");
const {
  clampChinaMobileInput,
  isValidChinaMobile,
  normalizeChinaMobile,
} = require("../../utils/phone");
const {
  applyPagePresentationToPage,
  subscribePagePresentation,
} = require("../../utils/page-presentation");
const { guardMiniProgramPageAccess } = require("../../utils/page-access");

function getDateAfterDaysUTC8(days) {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  shifted.setUTCDate(shifted.getUTCDate() + Number(days || 0));
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getTodayUTC8() {
  return getDateAfterDaysUTC8(0);
}

function formatBookingDateCN(dateStr) {
  const raw = String(dateStr || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const parts = raw.split("-").map((x) => Number(x));
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];
  if (!y || !m || !d) return raw;

  // 使用 UTC 构造，确保 weekday 计算与本地时区无关。
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const weeks = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  return `${y}年${m}月${d}日${weeks[weekday] || ""}`.trim();
}

function normalizeCity(name) {
  return String(name || "")
    .replace(/市$/, "")
    .replace(/自治区$/, "")
    .replace(/特别行政区$/, "")
    .trim();
}

function inferCityNameFromLocation(location) {
  const normalized = String(location || "").replace(/\s+/g, "");
  if (!normalized) return "";

  const municipalityMatch = normalized.match(/(北京市|上海市|天津市|重庆市)/);
  if (municipalityMatch) {
    return municipalityMatch[1];
  }

  const cityLikeMatch = normalized.match(/([\u4e00-\u9fa5]{2,}?(?:自治州|地区|盟|市))/);
  if (cityLikeMatch) {
    return cityLikeMatch[1];
  }

  const provinceMatch = normalized.match(/([\u4e00-\u9fa5]{2,}?(?:省|自治区|特别行政区))/);
  if (provinceMatch) {
    return provinceMatch[1];
  }

  return "";
}

function toRad(value) {
  return (Number(value || 0) * Math.PI) / 180;
}

function calculateDistanceKm(lat1, lng1, lat2, lng2) {
  const earthRadiusKm = 6371;
  const latDiff = toRad(lat2 - lat1);
  const lngDiff = toRad(lng2 - lng1);

  const a =
    Math.sin(latDiff / 2) * Math.sin(latDiff / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(lngDiff / 2) * Math.sin(lngDiff / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
}

function inferNearestAllowedCityByCoordinates(lat, lng, allowedCities, maxDistanceKm) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
    return "";
  }

  const rows = Array.isArray(allowedCities) ? allowedCities : [];
  let nearestCityName = "";
  let minDistance = Number.POSITIVE_INFINITY;

  rows.forEach((city) => {
    const cityLat = Number(city.latitude);
    const cityLng = Number(city.longitude);
    if (!Number.isFinite(cityLat) || !Number.isFinite(cityLng)) {
      return;
    }

    const distance = calculateDistanceKm(lat, lng, cityLat, cityLng);
    if (distance < minDistance) {
      minDistance = distance;
      nearestCityName = String(city.city_name || "");
    }
  });

  if (!nearestCityName || minDistance > Number(maxDistanceKm || 120)) {
    return "";
  }

  return nearestCityName;
}

function isValidCoordinatePair(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90) return false;
  if (lng < -180 || lng > 180) return false;
  if (Math.abs(lat) < 0.000001 && Math.abs(lng) < 0.000001) return false;
  return true;
}

function isMissingColumnError(error, columnName) {
  const message = String((error && error.message) || "").toLowerCase();
  const column = String(columnName || "").toLowerCase();
  if (!message || !column) return false;
  return (
    message.includes(column) &&
    (message.includes("unknown column") ||
      message.includes("does not exist") ||
      (message.includes("column") && message.includes("not found")))
  );
}

function isMultiRowMaybeSingleError(error) {
  const message = String((error && error.message) || "").toLowerCase();
  if (!message) return false;
  return (
    message.includes("multiple") ||
    message.includes("more than one row") ||
    message.includes("json object requested, multiple") ||
    message.includes("single row")
  );
}

function normalizeBlockedDateValue(input) {
  const value = String(input || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

function readArrayFromPayloadChain(payload, fields) {
  const keys = Array.isArray(fields) ? fields : [fields];
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") break;
    for (let i = 0; i < keys.length; i += 1) {
      const key = String(keys[i] || "").trim();
      if (!key || !Object.prototype.hasOwnProperty.call(current, key)) continue;
      const value = current[key];
      if (Array.isArray(value)) {
        return value;
      }
    }
    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }
  return [];
}

function normalizeBlockedDatesPayload(payload) {
  const source = Array.isArray(payload)
    ? payload
    : readArrayFromPayloadChain(payload, ["dates", "data"]);

  const seen = new Set();
  source.forEach((item) => {
    const raw =
      typeof item === "string"
        ? item
        : item && typeof item === "object"
          ? item.date || item.blocked_date || item.day || ""
          : "";
    const date = normalizeBlockedDateValue(raw);
    if (!date) return;
    seen.add(date);
  });

  return Array.from(seen).sort((a, b) => String(a).localeCompare(String(b), "zh-CN"));
}

function readRpcPayloadErrorMessage(payload) {
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") break;
    const directMessage = String(current.message || "").trim();
    if (directMessage) return directMessage;

    const directError = current.error;
    if (typeof directError === "string" && directError.trim()) {
      return directError.trim();
    }
    if (directError && typeof directError === "object") {
      const nestedErrorMessage = String(directError.message || "").trim();
      if (nestedErrorMessage) return nestedErrorMessage;
    }

    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }
  return "";
}

function hasExplicitRpcFailure(payload) {
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") break;
    if (current.error) return true;
    if (Object.prototype.hasOwnProperty.call(current, "success") && current.success === false) return true;
    if (Object.prototype.hasOwnProperty.call(current, "ok") && current.ok === false) return true;
    const next = current.data;
    if (!next || typeof next !== "object" || next === current) break;
    current = next;
  }
  return false;
}

function resolveAvailabilityValue(payload) {
  if (payload === null || payload === undefined) return null;
  if (typeof payload === "boolean") return payload;
  if (typeof payload === "number") return payload !== 0;
  if (typeof payload === "string") {
    const text = payload.trim().toLowerCase();
    if (!text) return null;
    if (text === "true" || text === "1" || text === "yes" || text === "ok") return true;
    if (text === "false" || text === "0" || text === "no") return false;
    return null;
  }
  if (typeof payload !== "object") return null;

  if (Object.prototype.hasOwnProperty.call(payload, "available")) {
    return Boolean(payload.available);
  }
  if (Object.prototype.hasOwnProperty.call(payload, "is_available")) {
    return Boolean(payload.is_available);
  }
  if (Object.prototype.hasOwnProperty.call(payload, "success")) {
    return Boolean(payload.success);
  }
  if (Object.prototype.hasOwnProperty.call(payload, "ok")) {
    return Boolean(payload.ok);
  }

  if (Object.prototype.hasOwnProperty.call(payload, "data")) {
    const nested = payload.data;
    if (nested === payload) return null;
    return resolveAvailabilityValue(nested);
  }

  return null;
}

Page({
  data: {
    safeTop: 0,
    serviceMissing: false,
    isLoggedIn: false,
    loading: true,
    showLoginPrompt: false,

    tearDots: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],

    bookingTypes: [],
    allowedCities: [],
    allowedCitiesText: "",
    formData: {
      typeId: 0,
      location: "",
      latitude: 0,
      longitude: 0,
      cityName: "",
      phone: "",
      wechat: "",
      notes: "",
    },
    selectedDate: "",
    blockedDates: [],

    showMapPicker: false,
    mapPickerInitialLocation: "",
    mapPickerInitialLatitude: 0,
    mapPickerInitialLongitude: 0,
    mapPickerCenterLatitude: 0,
    mapPickerCenterLongitude: 0,
    mapPickerCityName: "",
    mapPickerInitialProvince: "",
    showSuccess: false,
    isSubmitting: false,
    error: "",
    focusField: "",

    activeBooking: null,
    isCanceling: false,
    showCancelConfirm: false,

    minDate: "",
    maxDate: "",
    pagePresentationMode: "tabbar",
    pageFallbackRoute: "",
    pageFallbackTab: "pages/index/index",
    hasBottomTabbar: true,
  },

  applyPagePresentation() {
    const app = typeof getApp === "function" ? getApp() : null;
    return applyPagePresentationToPage(this, app, "pages/booking/index");
  },

  onLoad() {
    this._bookingPageBootstrapped = false;
    this._lastSeenAppEnterSeq = 0;
    const app = getApp();
    const globalData = app && app.globalData ? app.globalData : {};
    const safeTop = Number(globalData.statusBarHeight || 0);
    const serviceMissing = !String(globalData.cloudRunService || "").trim();

    this.setData({
      safeTop,
      serviceMissing,
      minDate: getDateAfterDaysUTC8(1),
      maxDate: getDateAfterDaysUTC8(30),
    });
    this.applyPagePresentation();
    this._unsubscribePagePresentation = subscribePagePresentation(app, this, "pages/booking/index");
  },

  async onShow() {
    const presentationState = this.applyPagePresentation();
    this.setTabBarVisible(true);
    const app = typeof getApp === "function" ? getApp() : null;
    const appEnterSeq = Math.max(0, Number(app && app.globalData ? app.globalData.appEnterSeq : 0));
    const lastSeenAppEnterSeq = Math.max(0, Number(this._lastSeenAppEnterSeq || 0));
    const hasNewAppEntry = appEnterSeq > lastSeenAppEnterSeq;
    this._lastSeenAppEnterSeq = Math.max(appEnterSeq, lastSeenAppEnterSeq);
    if (app && typeof app.ensureAuditConfig === "function") {
      try {
        await app.ensureAuditConfig();
      } catch (error) {
        // ignore
      }
    }

    if (!this.data.serviceMissing) {
      const accessResult = await guardMiniProgramPageAccess({
        pageKey: "booking",
        presentationMode: presentationState.accessMode || presentationState.mode,
      });
      if (!accessResult.allowed) {
        return;
      }
    }

    this.syncTabBar("pages/booking/index");
    if (!this.data.serviceMissing) {
      if (hasNewAppEntry && this._bookingPageBootstrapped && !this.data.loading) {
        return;
      }
      await this.checkLoginAndLoad();
    }
  },

  onHide() {
    if (this.data.showCancelConfirm) {
      this.setData({ showCancelConfirm: false });
    }
    this.setTabBarVisible(true);
  },

  onUnload() {
    if (this.data.showCancelConfirm) {
      this.setData({ showCancelConfirm: false });
    }
    this.setTabBarVisible(true);
    if (typeof this._unsubscribePagePresentation === "function") {
      this._unsubscribePagePresentation();
    }
    this._unsubscribePagePresentation = null;
  },

  syncTabBar(selectedPath) {
    if (typeof this.getTabBar !== "function") return;
    const tab = this.getTabBar();
    if (tab && typeof tab.setData === "function") {
      tab.setData({
        selectedPath: String(selectedPath || "").trim().replace(/^\/+/, ""),
      });
    }
  },

  setTabBarVisible(visible) {
    if (typeof this.getTabBar !== "function") return;
    const tab = this.getTabBar();
    if (!tab || typeof tab.setData !== "function") return;
    tab.setData({ visible: this.data.hasBottomTabbar && Boolean(visible) });
  },

  noop() {},

  async checkLoginAndLoad() {
    this.setData({
      loading: true,
      error: "",
      showSuccess: false,
    });

    let user = null;
    try {
      const session = await getSession();
      user = extractSessionUser(session);
    } catch (e) {
      user = null;
    }

    const isLoggedIn = Boolean(user && user.id);
    this.setData({
      isLoggedIn,
      showLoginPrompt: !isLoggedIn,
    });

    if (!isLoggedIn) {
      // 对齐 Web 端体验：未登录时不阻塞首屏，直接弹提示；基础数据后台加载。
      this.setData({ loading: false });
      void Promise.all([
        this.loadBookingTypes(),
        this.loadAllowedCities(),
        this.loadBlockedDates({ forceFresh: true }),
      ])
        .catch(() => {})
        .finally(() => {
          this._bookingPageBootstrapped = true;
        });
      return;
    }

    try {
      await Promise.all([
        this.loadBookingTypes(),
        this.loadAllowedCities(),
        this.loadBlockedDates({ forceFresh: true }),
        this.loadUserProfile(),
        this.checkActiveBooking(),
      ]);
    } finally {
      this.setData({ loading: false });
      this._bookingPageBootstrapped = true;
    }
  },

  async loadBookingTypes() {
    try {
      // 与 Web 端一致：直接读取 booking_types 表（后端会强制 is_active = 1）
      let result = await dbQuery({
        table: "booking_types",
        action: "select",
        columns: "id,name",
        filters: [{ column: "is_active", operator: "eq", value: true }],
        orders: [{ column: "id", ascending: true }],
        limit: 200,
      });
      if (result && result.error && isMissingColumnError(result.error, "is_active")) {
        result = await dbQuery({
          table: "booking_types",
          action: "select",
          columns: "id,name",
          orders: [{ column: "id", ascending: true }],
          limit: 200,
        });
      }
      if (result && result.error) return;

      const rows = result && Array.isArray(result.data) ? result.data : [];
      const types = rows
        .map((t) => ({
          value: Number(t.id || 0),
          label: String(t.name || ""),
        }))
        .filter((t) => t.value && t.label);
      this.setData({ bookingTypes: types });
    } catch (e) {
      // ignore
    }
  },

  async loadAllowedCities() {
    try {
      // 与 Web 端一致：直接读取 allowed_cities 表（后端会强制 is_active = 1）
      let result = await dbQuery({
        table: "allowed_cities",
        action: "select",
        columns: "id,city_name,province,latitude,longitude",
        filters: [{ column: "is_active", operator: "eq", value: true }],
        limit: 200,
      });
      if (result && result.error && isMissingColumnError(result.error, "is_active")) {
        result = await dbQuery({
          table: "allowed_cities",
          action: "select",
          columns: "id,city_name,province,latitude,longitude",
          limit: 200,
        });
      }
      if (result && result.error) return;

      const data = result && Array.isArray(result.data) ? result.data : [];
      this.setData({
        allowedCities: data,
        allowedCitiesText: data.map((x) => String(x.city_name || "")).filter(Boolean).join("、"),
      });
    } catch (e) {
      // ignore
    }
  },

  async loadBlockedDates(options) {
    const opts = options && typeof options === "object" ? options : {};
    try {
      const result = await getBlockedDates({ forceFresh: Boolean(opts.forceFresh) });
      const dates = normalizeBlockedDatesPayload(result);
      this.setData({
        blockedDates: dates,
      });
    } catch (e) {
      // ignore
    }
  },

  async loadUserProfile() {
    try {
      const session = await getSession();
      const user = extractSessionUser(session);
      if (!user || !user.id) return;

      const result = await dbQuery({
        table: "profiles",
        action: "select",
        columns: "phone,wechat",
        filters: [{ column: "id", operator: "eq", value: user.id }],
        maybeSingle: true,
      });
      if (result && result.error) return;

      const profile = result ? result.data : null;
      if (profile) {
        this.setData({
          "formData.phone": profile.phone || "",
          "formData.wechat": profile.wechat || "",
        });
      }
    } catch (e) {
      // ignore
    }
  },

  async checkActiveBooking() {
    try {
      const session = await getSession();
      const user = extractSessionUser(session);
      if (!user || !user.id) {
        this.setData({ activeBooking: null });
        return;
      }

      let bookingResult = await dbQuery({
        table: "bookings",
        action: "select",
        columns: "id,type_id,booking_date,location,phone,wechat,status,city_name,notes,created_at",
        filters: [
          { column: "user_id", operator: "eq", value: user.id },
          { column: "status", operator: "in", value: ["pending", "confirmed", "in_progress"] },
        ],
        orders: [{ column: "created_at", ascending: false }],
        maybeSingle: true,
      });
      if (bookingResult && bookingResult.error && isMultiRowMaybeSingleError(bookingResult.error)) {
        bookingResult = await dbQuery({
          table: "bookings",
          action: "select",
          columns: "id,type_id,booking_date,location,phone,wechat,status,city_name,notes,created_at",
          filters: [
            { column: "user_id", operator: "eq", value: user.id },
            { column: "status", operator: "in", value: ["pending", "confirmed", "in_progress"] },
          ],
          orders: [{ column: "created_at", ascending: false }],
          limit: 1,
        });
      }
      if (bookingResult && bookingResult.error) {
        this.setData({ activeBooking: null });
        return;
      }

      const bookingData = bookingResult ? bookingResult.data : null;
      const booking = Array.isArray(bookingData) ? (bookingData.length > 0 ? bookingData[0] : null) : bookingData;
      if (!booking) {
        this.setData({ activeBooking: null });
        return;
      }

      let typeName = "";
      const typeId = Number(booking.type_id || 0);
      if (typeId) {
        const typeResult = await dbQuery({
          table: "booking_types",
          action: "select",
          columns: "name",
          filters: [{ column: "id", operator: "eq", value: typeId }],
          maybeSingle: true,
        });
        if (!typeResult?.error && typeResult?.data?.name) {
          typeName = String(typeResult.data.name);
        }
      }

      const status = String(booking.status || "pending");
      const date = String(booking.booking_date || "").trim();
      const canCancel =
        Boolean(date) &&
        (status === "pending" || status === "confirmed") &&
        date > getTodayUTC8();

      const statusText =
        status === "pending"
          ? "等待确认中"
          : status === "confirmed"
            ? "已确认"
            : status === "in_progress"
              ? "进行中"
              : "已确认";

      const normalized = Object.assign({}, booking, {
        type: typeName,
        date,
        date_text: formatBookingDateCN(date),
        status,
        status_text: statusText,
        can_cancel: canCancel,
        contact_text: String(booking.wechat || booking.phone || "").trim(),
      });

      this.setData({ activeBooking: normalized });
    } catch (e) {
      // ignore
    }
  },

  onTypeChange(e) {
    const value = e && e.detail ? Number(e.detail.value || 0) : 0;
    this.setData({ "formData.typeId": Number.isFinite(value) ? value : 0 });
  },

  onDateChange(e) {
    const value = e && e.detail ? String(e.detail.value || "") : "";
    if (!value) return;

    if ((this.data.blockedDates || []).includes(value)) {
      wx.showToast({ title: "该日期当前不可预约，请选择其他日期", icon: "none" });
      return;
    }

    this.setData({ selectedDate: value });
  },

  onInputChange(e) {
    const { field } = e.currentTarget.dataset;
    const rawValue = e && e.detail ? e.detail.value : "";
    const value = field === "phone" ? clampChinaMobileInput(rawValue) : rawValue;
    this.setData({ [`formData.${field}`]: value });
  },

  onFieldFocus(e) {
    const field =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.field || "")
        : "";
    this.setData({ focusField: field });
  },

  onFieldBlur() {
    this.setData({ focusField: "" });
  },

  showMapPicker() {
    const formData = this.data.formData || {};
    const allowedCities = Array.isArray(this.data.allowedCities) ? this.data.allowedCities : [];
    const hasSelectedCoordinate = isValidCoordinatePair(formData.latitude, formData.longitude);

    let initialLocation = String(formData.location || "").trim();
    let initialLatitude = hasSelectedCoordinate ? Number(formData.latitude) : 0;
    let initialLongitude = hasSelectedCoordinate ? Number(formData.longitude) : 0;
    let centerLatitude = 0;
    let centerLongitude = 0;
    let cityName = String(formData.cityName || "").trim();
    let initialProvince = "";

    const normalizedTargetCity = normalizeCity(cityName);
    const matchedCity = allowedCities.find((city) => {
      const cityLat = Number(city && city.latitude);
      const cityLng = Number(city && city.longitude);
      if (!isValidCoordinatePair(cityLat, cityLng)) return false;

      const allowedName = String((city && city.city_name) || "").trim();
      const normalizedAllowed = normalizeCity(allowedName);
      if (!normalizedTargetCity || !normalizedAllowed) return false;

      return (
        normalizedAllowed === normalizedTargetCity ||
        normalizedAllowed.includes(normalizedTargetCity) ||
        normalizedTargetCity.includes(normalizedAllowed)
      );
    });

    const firstValidCity =
      allowedCities.find((city) =>
        isValidCoordinatePair(Number(city && city.latitude), Number(city && city.longitude))
      ) || null;

    const preferredCity = matchedCity || firstValidCity;
    if (preferredCity) {
      centerLatitude = Number(preferredCity.latitude);
      centerLongitude = Number(preferredCity.longitude);
      if (!hasSelectedCoordinate) {
        initialLatitude = centerLatitude;
        initialLongitude = centerLongitude;
      }
      if (!cityName && allowedCities.length === 1) {
        cityName = String(preferredCity.city_name || "").trim();
      }
      initialProvince = String(preferredCity.province || "").trim();
    }

    if (!isValidCoordinatePair(centerLatitude, centerLongitude) && hasSelectedCoordinate) {
      centerLatitude = initialLatitude;
      centerLongitude = initialLongitude;
    }

    this.setTabBarVisible(false);
    this.setData({
      showMapPicker: true,
      mapPickerInitialLocation: initialLocation,
      mapPickerInitialLatitude: initialLatitude,
      mapPickerInitialLongitude: initialLongitude,
      mapPickerCenterLatitude: centerLatitude,
      mapPickerCenterLongitude: centerLongitude,
      mapPickerCityName: cityName,
      mapPickerInitialProvince: initialProvince,
    });
  },

  onMapSelect(e) {
    const detail = e && e.detail ? e.detail : {};
    const location = String(detail.location || "").trim();
    const latitude = Number(detail.latitude);
    const longitude = Number(detail.longitude);
    const hasCoordinate = isValidCoordinatePair(latitude, longitude);
    const nextLatitude = hasCoordinate ? latitude : this.data.formData.latitude;
    const nextLongitude = hasCoordinate ? longitude : this.data.formData.longitude;
    const metaCityName = String(detail.cityName || "").trim();
    const metaProvince = String(detail.province || "").trim();
    const inferredCityName = inferCityNameFromLocation(location);
    const nearestAllowedCity = hasCoordinate
      ? inferNearestAllowedCityByCoordinates(latitude, longitude, this.data.allowedCities, 120)
      : "";

    this.setData({
      "formData.location": location,
      "formData.latitude": nextLatitude,
      "formData.longitude": nextLongitude,
      "formData.cityName":
        metaCityName ||
        inferredCityName ||
        nearestAllowedCity ||
        metaProvince ||
        this.data.formData.cityName ||
        "",
      showMapPicker: false,
    });
    this.setTabBarVisible(true);
  },

  onMapClose() {
    this.setTabBarVisible(true);
    this.setData({ showMapPicker: false });
  },

  clearSelectedLocation() {
    if (!this.data.formData || !String(this.data.formData.location || "").trim()) return;
    this.setData({
      "formData.location": "",
      "formData.latitude": 0,
      "formData.longitude": 0,
      "formData.cityName": "",
      error: "",
    });
    wx.showToast({ title: "地址已删除", icon: "success" });
  },

  async onSubmit() {
    if (this.data.isSubmitting) return;
    if (!this.data.isLoggedIn) {
      this.setData({ showLoginPrompt: true });
      return;
    }

    const { formData, selectedDate, blockedDates, allowedCities, minDate, maxDate } = this.data;
    if (!formData.typeId) {
      this.setData({ error: "请选择约拍类型" });
      return;
    }
    if (!formData.location || !isValidCoordinatePair(formData.latitude, formData.longitude)) {
      this.setData({ error: "请选择约拍地点" });
      return;
    }
    if (!formData.phone) {
      this.setData({ error: "请填写手机号" });
      return;
    }

    const normalizedPhone = normalizeChinaMobile(formData.phone);
    if (!isValidChinaMobile(normalizedPhone)) {
      this.setData({ error: "请输入有效的手机号" });
      return;
    }

    if (!formData.wechat) {
      this.setData({ error: "请填写微信号" });
      return;
    }

    if (!selectedDate) {
      this.setData({ error: "请选择预约日期" });
      return;
    }

    if (selectedDate < minDate || selectedDate > maxDate) {
      this.setData({ error: "预约日期超出可选范围（最早明天，最晚30天内）" });
      return;
    }

    if (blockedDates.includes(selectedDate)) {
      this.setData({ error: "该日期当前不可预约，请选择其他日期" });
      return;
    }

    const inferredCityByCoordinates = inferNearestAllowedCityByCoordinates(
      Number(formData.latitude),
      Number(formData.longitude),
      allowedCities,
      120
    );
    const resolvedCityName = String(formData.cityName || inferredCityByCoordinates || "").trim();
    if (!resolvedCityName) {
      this.setData({ error: "无法识别城市，请重新选择地点" });
      return;
    }

    const allowedCityRows = Array.isArray(allowedCities) ? allowedCities : [];
    const userCity = normalizeCity(resolvedCityName);
    const isCityAllowed = allowedCityRows.some((city) => {
      const allowedCity = normalizeCity(city.city_name);
      if (userCity === allowedCity || resolvedCityName === city.city_name) {
        return true;
      }
      if (userCity.length >= 2 && allowedCity.length >= 2) {
        return userCity.includes(allowedCity) || allowedCity.includes(userCity);
      }
      return false;
    });

    if (allowedCityRows.length <= 0) {
      this.setData({
        error: "当前暂未开放预约城市，请稍后再试",
      });
      return;
    }

    if (!isCityAllowed) {
      this.setData({
        error: `抱歉，当前仅支持以下城市的预约：${allowedCityRows.map((c) => c.city_name).join("、")}`,
      });
      return;
    }

    this.setData({ isSubmitting: true, error: "" });
    try {
      const availability = await dbRpc("check_date_availability", { target_date: selectedDate });
      const availabilityError = String(
        (availability && availability.error && availability.error.message) || ""
      ).trim();
      if (availabilityError) {
        this.setData({
          error: `预约校验失败：${availabilityError}`,
          isSubmitting: false,
        });
        return;
      }

      const rawAvailabilityData = availability ? availability.data : null;
      const availabilityData =
        rawAvailabilityData === null || rawAvailabilityData === undefined
          ? availability
          : rawAvailabilityData;
      if (availabilityData === null || availabilityData === undefined) {
        this.setData({
          error: "预约校验失败：服务返回异常",
          isSubmitting: false,
        });
        return;
      }
      if (hasExplicitRpcFailure(availabilityData)) {
        const message = readRpcPayloadErrorMessage(availabilityData);
        this.setData({
          error: message ? `预约校验失败：${message}` : "预约校验失败：服务暂不可用",
          isSubmitting: false,
        });
        return;
      }

      const isAvailable = resolveAvailabilityValue(availabilityData);
      if (isAvailable === null) {
        this.setData({
          error: "预约校验失败：服务返回异常",
          isSubmitting: false,
        });
        return;
      }

      if (!isAvailable) {
        this.setData({
          error: "抱歉，该日期不可预约（可能已被锁定或已有预约），请选择其他日期",
          isSubmitting: false,
        });
        return;
      }

      const session = await getSession();
      const user = extractSessionUser(session);
      if (!user || !user.id) {
        this.setData({ error: "请先登录", isSubmitting: false });
        return;
      }

      const insertResult = await dbQuery({
        table: "bookings",
        action: "insert",
        values: {
          user_id: user.id,
          type_id: formData.typeId,
          booking_date: selectedDate,
          location: formData.location,
          latitude: formData.latitude,
          longitude: formData.longitude,
          city_name: resolvedCityName,
          phone: normalizedPhone,
          wechat: formData.wechat,
          notes: formData.notes,
          status: "pending",
        },
        selectAfterWrite: true,
        maybeSingle: true,
        columns: "id,user_id,type_id,booking_date,status",
      });
      if (insertResult && insertResult.error) {
        throw new Error(String(insertResult.error.message || "提交失败，请稍后重试"));
      }
      if (!insertResult || !insertResult.data) {
        throw new Error("提交失败，请稍后重试");
      }

      this.setData({ showSuccess: true, isSubmitting: false });
      setTimeout(() => {
        this.setData({ showSuccess: false });
        this.checkLoginAndLoad();
      }, 3000);
    } catch (e) {
      const msg = String((e && e.message) || "");
      const duplicate =
        msg.includes("duplicate") || msg.includes("23505") || msg.includes("1062");
      if (duplicate) {
        const lowerMessage = msg.toLowerCase();
        const isDateConflict =
          lowerMessage.includes("uk_bookings_active_date") ||
          lowerMessage.includes("active_booking_date");
        const isUserConflict =
          lowerMessage.includes("uk_bookings_active_user") ||
          lowerMessage.includes("active_booking_user_id");

        let duplicateMessage = "预约失败：该日期已被预约或您已有进行中的预约，请稍后重试";
        if (isDateConflict && !isUserConflict) {
          duplicateMessage = "抱歉，该日期已被预约，请选择其他日期";
        } else if (isUserConflict && !isDateConflict) {
          duplicateMessage = "您已有进行中的预约，请先取消或等待完成";
        }

        this.setData({
          error: duplicateMessage,
          isSubmitting: false,
        });
        return;
      }

      this.setData({
        error: msg || "提交失败，请稍后重试",
        isSubmitting: false,
      });
    }
  },

  openCancelConfirm() {
    if (this.data.isCanceling) return;
    const booking = this.data.activeBooking;
    if (!booking || !booking.can_cancel) return;
    this.setData({ showCancelConfirm: true });
  },

  closeCancelConfirm() {
    if (this.data.isCanceling) return;
    this.setData({ showCancelConfirm: false });
  },

  async onCancelBooking() {
    if (this.data.isCanceling) return;
    const { activeBooking } = this.data;
    if (!activeBooking || !activeBooking.can_cancel) return;

    this.setData({ showCancelConfirm: false, isCanceling: true, error: "" });
    try {
      const session = await getSession();
      const user = extractSessionUser(session);
      if (!user || !user.id) {
        this.setData({ showCancelConfirm: false, error: "请先登录后再操作", isCanceling: false });
        return;
      }

      const today = getTodayUTC8();
      const updated = await dbQuery({
        table: "bookings",
        action: "update",
        values: { status: "cancelled" },
        filters: [
          { column: "id", operator: "eq", value: activeBooking.id },
          { column: "user_id", operator: "eq", value: user.id },
          { column: "status", operator: "in", value: ["pending", "confirmed"] },
          { column: "booking_date", operator: "gt", value: today },
        ],
        selectAfterWrite: true,
        maybeSingle: true,
        columns: "id,status,booking_date",
      });
      if (updated && updated.error) {
        this.setData({
          showCancelConfirm: false,
          error: String(updated.error.message || "取消失败，请稍后重试"),
          isCanceling: false,
        });
        return;
      }
      if (!updated || !updated.data) {
        this.setData({
          showCancelConfirm: false,
          error: "当前预约已不可取消，请刷新后查看最新状态",
          isCanceling: false,
        });
        return;
      }

      this.setData({
        showCancelConfirm: false,
        activeBooking: null,
        isCanceling: false,
        blockedDates: (this.data.blockedDates || []).filter(
          (date) => String(date || "") !== String(activeBooking.booking_date || activeBooking.date || "")
        ),
        formData: {
          typeId: 0,
          location: "",
          latitude: 0,
          longitude: 0,
          cityName: "",
          phone: this.data.formData.phone,
          wechat: this.data.formData.wechat,
          notes: "",
        },
        selectedDate: "",
      });

      await this.loadBlockedDates({ forceFresh: true });
      wx.showToast({ title: "已取消预约", icon: "success" });
    } catch (e) {
      this.setData({
        showCancelConfirm: false,
        error: String((e && e.message) || "取消失败，请稍后重试"),
        isCanceling: false,
      });
    }
  },

  goLogin() {
    this.setData({ showLoginPrompt: false });
    wx.navigateTo({ url: "/pages/login/index" });
  },

  closeLoginPrompt() {
    this.setData({ showLoginPrompt: false });
  },
});
