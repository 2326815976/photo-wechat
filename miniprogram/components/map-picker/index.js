const config = require("../../config.js");
const { requestJson } = require("../../services/photo-api");

const DEFAULT_LAT = 25.2387;
const DEFAULT_LNG = 110.2124;
const ADDRESS_LINE_SIZE = 25;
const TITLE_MAX_CHARS = 20;

function isValidCoordinate(latitude, longitude) {
  const lat = Number(latitude || 0);
  const lng = Number(longitude || 0);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return !(Math.abs(lat) < 0.000001 && Math.abs(lng) < 0.000001);
}

function wrapAddressByLine(address, lineSize) {
  const value = String(address || "").trim();
  if (!value) return "";
  const size = Math.max(1, Math.floor(Number(lineSize || ADDRESS_LINE_SIZE) || ADDRESS_LINE_SIZE));
  const chars = Array.from(value);
  if (chars.length <= size) return value;

  const lines = [];
  for (let i = 0; i < chars.length; i += size) {
    lines.push(chars.slice(i, i + size).join(""));
  }
  return lines.join("\n");
}

function splitAddressLines(address, lineSize) {
  const wrapped = wrapAddressByLine(address, lineSize);
  if (!wrapped) return [];
  return wrapped.split("\n");
}

function splitTitleLines(title, lineSize) {
  return splitAddressLines(title, lineSize || TITLE_MAX_CHARS);
}

function pickCity(addressComponent) {
  const data = addressComponent || {};
  return String(data.city || data.district || data.province || "").trim();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function hasExplicitPayloadFailure(payload) {
  if (payload === false) return true;
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

function readArrayFromPayloadChain(payload, fields) {
  const keys = Array.isArray(fields) ? fields : [fields];
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (Array.isArray(current)) return current;
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

function readObjectFromPayloadChain(payload, fields) {
  const keys = Array.isArray(fields) ? fields : [fields];
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) break;
    for (let i = 0; i < keys.length; i += 1) {
      const key = String(keys[i] || "").trim();
      if (!key || !Object.prototype.hasOwnProperty.call(current, key)) continue;
      const value = current[key];
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
      }
    }
    const next = current.data;
    if (!next || typeof next !== "object" || Array.isArray(next) || next === current) break;
    current = next;
  }
  return null;
}

function pickBestReverseAddress(source) {
  const data = source && typeof source === "object" ? source : {};
  const component =
    data.address_component && typeof data.address_component === "object"
      ? data.address_component
      : data.addressComponent && typeof data.addressComponent === "object"
        ? data.addressComponent
        : {};
  const formattedAddresses =
    data.formatted_addresses && typeof data.formatted_addresses === "object"
      ? data.formatted_addresses
      : data.formattedAddresses && typeof data.formattedAddresses === "object"
        ? data.formattedAddresses
        : {};
  const addressReference =
    data.address_reference && typeof data.address_reference === "object"
      ? data.address_reference
      : data.addressReference && typeof data.addressReference === "object"
        ? data.addressReference
        : {};
  const pois = readArrayFromPayloadChain(data, ["pois", "poi_list", "poiList"]);

  const recommend = normalizeText(formattedAddresses.recommend);
  const rough = normalizeText(formattedAddresses.rough);
  const formattedAddress = normalizeText(data.formattedAddress || data.formatted_address);
  const rawAddress = normalizeText(data.rawAddress);
  const address = normalizeText(data.address);
  const province = normalizeText(component.province || data.province);
  const city = normalizeText(component.city || data.city);
  const district = normalizeText(component.district || data.district);
  const town = normalizeText(component.town || component.street_name || data.town);
  const street = normalizeText(component.street || data.street);
  const streetNumber = normalizeText(
    component.street_number || component.streetNumber || data.street_number || data.streetNumber
  );
  const landmark = normalizeText(
    (addressReference.landmark_l2 && addressReference.landmark_l2.title) ||
      (addressReference.landmark_l1 && addressReference.landmark_l1.title)
  );
  const poiAddress = pois
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const title = normalizeText(item.title || item.name);
      const addressText = normalizeText(item.address || item.addr);
      if (title && addressText && !addressText.includes(title)) {
        return `${title}（${addressText}）`;
      }
      return title || addressText;
    })
    .find(Boolean);

  const regionParts = [];
  [province, city, district, town].forEach((part) => {
    if (!part) return;
    if (regionParts.length > 0 && regionParts[regionParts.length - 1] === part) return;
    regionParts.push(part);
  });
  const componentAddress = `${regionParts.join("")}${street}${streetNumber}`.trim();

  let detailAddress =
    recommend || poiAddress || formattedAddress || address || rawAddress || rough || componentAddress;
  const streetDetail = `${street}${streetNumber}`.trim();

  if (!detailAddress) {
    detailAddress = streetDetail || landmark;
  }

  if (detailAddress && streetDetail && !detailAddress.includes(streetDetail)) {
    detailAddress = `${detailAddress}${streetDetail}`;
  }
  if (detailAddress && landmark && !detailAddress.includes(landmark)) {
    detailAddress = `${detailAddress}（${landmark}）`;
  }

  return detailAddress.trim();
}

function normalizeMeta(input) {
  const data = input && typeof input === "object" ? input : {};
  const adInfo = data.ad_info && typeof data.ad_info === "object" ? data.ad_info : {};
  const addressComponent =
    data.address_component && typeof data.address_component === "object"
      ? data.address_component
      : data.addressComponent && typeof data.addressComponent === "object"
        ? data.addressComponent
        : {};
  const cityName = String(data.cityName || data.city || "").trim();
  const province = String(data.province || "").trim();
  const district = String(data.district || "").trim();
  const adcode = String(
    data.adcode ||
      data.cityCode ||
      data.citycode ||
      adInfo.adcode ||
      adInfo.citycode ||
      addressComponent.adcode ||
      addressComponent.citycode ||
      ""
  ).trim();

  return {
    cityName,
    province,
    district,
    adcode,
  };
}

function buildMarker(latitude, longitude) {
  return {
    id: 1,
    latitude,
    longitude,
    width: 25,
    height: 35,
    // 对齐 Web：可拖动标记选择位置
    draggable: true,
  };
}

Component({
  properties: {
    show: {
      type: Boolean,
      value: false,
      observer(next) {
        if (next) {
          this.onPanelOpen();
        }
      },
    },
    cityName: {
      type: String,
      value: "",
    },
    initialLocation: {
      type: String,
      value: "",
    },
    initialLatitude: {
      type: Number,
      value: 0,
    },
    initialLongitude: {
      type: Number,
      value: 0,
    },
    centerLatitude: {
      type: Number,
      value: 0,
    },
    centerLongitude: {
      type: Number,
      value: 0,
    },
    initialProvince: {
      type: String,
      value: "",
    },
    initialDistrict: {
      type: String,
      value: "",
    },
    initialAdcode: {
      type: String,
      value: "",
    },
  },

  data: {
    latitude: DEFAULT_LAT,
    longitude: DEFAULT_LNG,
    markers: [buildMarker(DEFAULT_LAT, DEFAULT_LNG)],

    loading: false,
    selectedAddress: "",
    resolvingAddress: false,
    addressResolveFailed: false,
    selectedCity: "",
    selectedProvince: "",
    selectedDistrict: "",
    selectedAdcode: "",

    searchKeyword: "",
    searching: false,
    searchResults: [],
    showResults: false,
    searchFocused: false,
    locating: false,
  },

  lifetimes: {
    attached() {
      this.reverseTimer = null;
      this.searchTimer = null;
      this.searchTask = null;
      this.pendingSearchKeyword = "";
      this.mapKeyHintShown = false;
      this.suppressMapTapUntil = 0;
      this.userHasSelectedPoint = false;
      this.locationRequestId = 0;
    },
    detached() {
      this.clearTimers();
      this.abortSearchTask();
      this.suppressMapTapUntil = 0;
      this.userHasSelectedPoint = false;
    },
  },

  methods: {
    noop() {},

    markMapTapSuppressed(durationMs) {
      const ms = Math.max(Number(durationMs || 0), 0);
      this.suppressMapTapUntil = Date.now() + ms;
    },

    isMapTapSuppressed() {
      return Date.now() < Number(this.suppressMapTapUntil || 0);
    },

    showMapKeyHintOnce(status, message) {
      const code = Number(status || 0);
      if (this.mapKeyHintShown) return;
      if (![110, 111, 112, 199].includes(code)) return;

      this.mapKeyHintShown = true;
      const msg = String(message || "").trim();
      const hint =
        code === 199
          ? "腾讯地图Key未开启WebServiceAPI，请在腾讯位置服务控制台勾选“WebServiceAPI”后重试"
          : "腾讯地图Key配置无效，请检查 Key 与小程序授权 APPID 配置";
      try {
        wx.showToast({
          title: "地图Key配置需调整",
          icon: "none",
          duration: 2600,
        });
      } catch (_) {
        // ignore
      }
      try {
        console.warn("[map-picker] tencent map key issue", {
          status: code,
          message: msg,
          hint,
        });
      } catch (_) {
        // ignore
      }
    },

    resolveInitialSelection() {
      const propLocation = String(this.properties.initialLocation || "").trim();
      const propLatitude = Number(this.properties.initialLatitude || 0);
      const propLongitude = Number(this.properties.initialLongitude || 0);
      if (propLocation && isValidCoordinate(propLatitude, propLongitude)) {
        return {
          location: propLocation,
          latitude: propLatitude,
          longitude: propLongitude,
          cityName: String(this.properties.cityName || "").trim(),
          province: String(this.properties.initialProvince || "").trim(),
          district: String(this.properties.initialDistrict || "").trim(),
          adcode: String(this.properties.initialAdcode || "").trim(),
        };
      }
      return null;
    },

    resolvePreferredCenter() {
      const centerLatitude = Number(this.properties.centerLatitude || 0);
      const centerLongitude = Number(this.properties.centerLongitude || 0);
      if (isValidCoordinate(centerLatitude, centerLongitude)) {
        return {
          latitude: centerLatitude,
          longitude: centerLongitude,
        };
      }

      const propLatitude = Number(this.properties.initialLatitude || 0);
      const propLongitude = Number(this.properties.initialLongitude || 0);
      if (isValidCoordinate(propLatitude, propLongitude)) {
        return {
          latitude: propLatitude,
          longitude: propLongitude,
        };
      }
      return {
        latitude: DEFAULT_LAT,
        longitude: DEFAULT_LNG,
      };
    },

    onPanelOpen() {
      this.clearSearchPanel();
      const initialSelection = this.resolveInitialSelection();

      if (initialSelection) {
        this.userHasSelectedPoint = true;
        this.locationRequestId = Number(this.locationRequestId || 0) + 1;
        this.setData({
          loading: false,
          locating: false,
          selectedAddress: initialSelection.location,
          selectedCity: initialSelection.cityName || String(this.properties.cityName || "").trim(),
          selectedProvince: initialSelection.province,
          selectedDistrict: initialSelection.district,
          selectedAdcode: initialSelection.adcode,
          searchFocused: false,
        });
        this.setMapPoint(initialSelection.latitude, initialSelection.longitude, {
          reverseImmediate: !initialSelection.location,
          skipReverse: Boolean(initialSelection.location),
          preserveAddress: Boolean(initialSelection.location),
        });
        return;
      }

      this.userHasSelectedPoint = false;
      this.setData({
        locating: false,
        selectedAddress: "",
        selectedCity: String(this.properties.cityName || "").trim(),
        selectedProvince: String(this.properties.initialProvince || "").trim(),
        selectedDistrict: String(this.properties.initialDistrict || "").trim(),
        selectedAdcode: String(this.properties.initialAdcode || "").trim(),
        searchFocused: false,
      }, () => {
        this.initDefaultCenter();
      });
    },

    clearTimers() {
      if (this.reverseTimer) {
        clearTimeout(this.reverseTimer);
        this.reverseTimer = null;
      }
      if (this.searchTimer) {
        clearTimeout(this.searchTimer);
        this.searchTimer = null;
      }
    },

    abortSearchTask() {
      if (this.searchTask && typeof this.searchTask.abort === "function") {
        this.searchTask.abort();
      }
      this.searchTask = null;
    },

    clearSearchPanel() {
      this.clearTimers();
      this.abortSearchTask();
      this.pendingSearchKeyword = "";
      this.suppressMapTapUntil = 0;
      this.setData({
        searchKeyword: "",
        searching: false,
        searchResults: [],
        showResults: false,
        searchFocused: false,
      });
    },

    initDefaultCenter() {
      const center = this.resolvePreferredCenter();
      this.setData({ loading: false }, () => {
        this.setMapPoint(center.latitude, center.longitude, {
          skipReverse: true,
          preserveAddress: true,
        });
      });
    },

    setMapPoint(latitude, longitude, opts) {
      const lat = Number(latitude || 0);
      const lng = Number(longitude || 0);
      if (!isValidCoordinate(lat, lng)) return;
      const preserveAddress = Boolean(opts && opts.preserveAddress);
      const skipReverse = Boolean(opts && opts.skipReverse);
      const shouldResolveAddress = !skipReverse && !preserveAddress;

      this.setData({
        latitude: lat,
        longitude: lng,
        markers: [buildMarker(lat, lng)],
        selectedAddress: preserveAddress ? this.data.selectedAddress : "",
        resolvingAddress: shouldResolveAddress,
        addressResolveFailed: false,
      });

      if (skipReverse) return;
      this.scheduleReverseGeocode(
        lat,
        lng,
        Boolean(opts && opts.reverseImmediate),
        preserveAddress
      );
    },

    scheduleReverseGeocode(latitude, longitude, immediate, preserveAddress) {
      if (this.reverseTimer) {
        clearTimeout(this.reverseTimer);
        this.reverseTimer = null;
      }

      if (immediate) {
        this.reverseGeocode(latitude, longitude, preserveAddress);
        return;
      }

      this.reverseTimer = setTimeout(() => {
        this.reverseGeocode(latitude, longitude, preserveAddress);
      }, 350);
    },

    normalizeSearchResultItems(payload) {
      const rows = readArrayFromPayloadChain(payload, ["results", "rows", "list", "items", "data"]);
      return rows
        .map((item, index) => {
          if (!item || typeof item !== "object") return null;

          const location = item.location && typeof item.location === "object" ? item.location : {};
          const lat = Number(location.lat || item.latitude || 0);
          const lng = Number(location.lng || item.longitude || 0);
          if (!isValidCoordinate(lat, lng)) return null;

          const title = String(item.name || item.title || item.address || "").trim();
          if (!title) return null;

          const address = String(item.address || "").trim();
          const meta = normalizeMeta(item);

          return {
            id: Number(item.id) || index + 1,
            title,
            titleLines: splitTitleLines(title, TITLE_MAX_CHARS),
            address,
            addressDisplay: wrapAddressByLine(address),
            addressLines: splitAddressLines(address),
            latitude: lat,
            longitude: lng,
            cityName: meta.cityName,
            province: meta.province,
            district: meta.district,
            adcode: meta.adcode,
          };
        })
        .filter(Boolean);
    },

    isCurrentSelectedPoint(latitude, longitude) {
      const currentLat = Number(this.data.latitude || 0);
      const currentLng = Number(this.data.longitude || 0);
      if (Math.abs(currentLat - Number(latitude || 0)) > 1e-7) return false;
      if (Math.abs(currentLng - Number(longitude || 0)) > 1e-7) return false;
      return true;
    },

    applyAddressResult(latitude, longitude, addressText, meta) {
      if (!this.isCurrentSelectedPoint(latitude, longitude)) return;

      const details = normalizeMeta(meta);
      this.setData({
        selectedAddress: String(addressText || "").trim() || this.data.selectedAddress,
        resolvingAddress: false,
        addressResolveFailed: false,
        selectedCity:
          details.cityName || this.data.selectedCity || String(this.properties.cityName || "").trim(),
        selectedProvince: details.province || this.data.selectedProvince,
        selectedDistrict: details.district || this.data.selectedDistrict,
        selectedAdcode: details.adcode || this.data.selectedAdcode,
      });
    },

    applyAddressResolveFailure(latitude, longitude, preserveAddress) {
      if (!this.isCurrentSelectedPoint(latitude, longitude)) return;
      this.setData({
        resolvingAddress: false,
        addressResolveFailed: !preserveAddress,
        selectedAddress: preserveAddress ? this.data.selectedAddress : "",
      });
    },

    async reverseGeocodeByCloud(latitude, longitude) {
      try {
        const payload = await requestJson("/api/tencent-map/reverse-geocode", {
          method: "POST",
          data: {
            lat: latitude,
            lng: longitude,
          },
        });
        if (!payload || typeof payload !== "object" || hasExplicitPayloadFailure(payload)) return null;

        const resultData =
          readObjectFromPayloadChain(payload, "result") ||
          (payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null);
        if (!resultData) return null;
        const formattedAddress = pickBestReverseAddress(resultData);
        const meta = normalizeMeta({
          ...(resultData && typeof resultData === "object" ? resultData : {}),
          ...(resultData.addressComponent && typeof resultData.addressComponent === "object"
            ? resultData.addressComponent
            : {}),
          ...(resultData.address_component && typeof resultData.address_component === "object"
            ? resultData.address_component
            : {}),
          ...(resultData.ad_info && typeof resultData.ad_info === "object" ? resultData.ad_info : {}),
        });

        if (!formattedAddress && !meta.cityName && !meta.province && !meta.district) {
          return null;
        }

        return {
          address: formattedAddress,
          meta,
        };
      } catch (error) {
        return null;
      }
    },

    reverseGeocodeByTencentApi(latitude, longitude) {
      const key = String(config.tencentMapKey || "").trim();
      if (!key) {
        return Promise.resolve(null);
      }

      return new Promise((resolve) => {
        wx.request({
          url: "https://apis.map.qq.com/ws/geocoder/v1/",
          data: {
            location: `${latitude},${longitude}`,
            key,
            get_poi: 1,
          },
          success: (res) => {
            const body = (res && res.data) || {};
            if (Number(body.status) !== 0 || !body.result) {
              this.showMapKeyHintOnce(body.status, body.message);
              try {
                console.warn("[map-picker] reverse geocode fallback miss", {
                  status: Number(body.status || 0) || undefined,
                  message: String(body.message || ""),
                });
              } catch (_) {
                // ignore
              }
              resolve(null);
              return;
            }

            const result = body.result || {};
            const address = pickBestReverseAddress(result);
            const addressComponent = result.address_component || {};
            const adInfo = result.ad_info || {};
            const city = pickCity(addressComponent) || pickCity(adInfo);

            resolve({
              address,
              meta: {
                cityName: city,
                province: String(addressComponent.province || adInfo.province || "").trim(),
                district: String(addressComponent.district || adInfo.district || "").trim(),
                adcode: String(
                  addressComponent.adcode || adInfo.adcode || adInfo.citycode || ""
                ).trim(),
              },
            });
          },
          fail: () => {
            resolve(null);
          },
        });
      });
    },

    async reverseGeocode(latitude, longitude, preserveAddress) {
      // 优先走云托管后端（callContainer 链路）；直连腾讯地图仅作兜底。
      const cloudResult = await this.reverseGeocodeByCloud(latitude, longitude);
      if (cloudResult && cloudResult.address) {
        this.applyAddressResult(
          latitude,
          longitude,
          cloudResult.address,
          cloudResult.meta
        );
        return;
      }

      const tencentResult = await this.reverseGeocodeByTencentApi(latitude, longitude);
      if (tencentResult && tencentResult.address) {
        this.applyAddressResult(
          latitude,
          longitude,
          tencentResult.address,
          tencentResult.meta
        );
        return;
      }

      this.applyAddressResolveFailure(latitude, longitude, preserveAddress);
    },

    onKeywordInput(e) {
      const value = e && e.detail ? String(e.detail.value || "") : "";
      this.setData({ searchKeyword: value });

      if (this.searchTimer) {
        clearTimeout(this.searchTimer);
        this.searchTimer = null;
      }

      if (!value.trim()) {
        this.abortSearchTask();
        this.pendingSearchKeyword = "";
        this.setData({
          searching: false,
          searchResults: [],
          showResults: false,
        });
        return;
      }

      this.searchTimer = setTimeout(() => {
        this.searchPlaces(value.trim());
      }, 500);
    },

    onClearKeyword() {
      if (this.searchTimer) {
        clearTimeout(this.searchTimer);
        this.searchTimer = null;
      }
      this.abortSearchTask();
      this.pendingSearchKeyword = "";
      this.setData({
        searchKeyword: "",
        searching: false,
        searchResults: [],
        showResults: false,
      });
    },

    onInputFocus() {
      this.setData({ searchFocused: true });
    },

    onInputBlur() {
      if (!this.data.searchFocused) return;
      this.setData({ searchFocused: false });
    },

    onInputConfirm() {
      const keyword = String(this.data.searchKeyword || "").trim();
      if (!keyword) return;

      if (this.searchTimer) {
        clearTimeout(this.searchTimer);
        this.searchTimer = null;
      }
      this.searchPlaces(keyword);
    },

    searchByTencentApi(keyword, normalizedCity) {
      const key = String(config.tencentMapKey || "").trim();
      if (!key) return Promise.resolve([]);

      return new Promise((resolve) => {
        const requestData = {
          key,
          keyword,
          page_size: 10,
        };
        if (normalizedCity) {
          requestData.boundary = `region(${normalizedCity},0)`;
        }

        this.searchTask = wx.request({
          url: "https://apis.map.qq.com/ws/place/v1/search",
          data: requestData,
          success: (res) => {
            const body = (res && res.data) || {};
            const rows = Array.isArray(body.data) ? body.data : [];
            if (!rows.length && Number(body.status || 0) !== 0) {
              this.showMapKeyHintOnce(body.status, body.message);
              try {
                console.warn("[map-picker] search fallback miss", {
                  status: Number(body.status || 0) || undefined,
                  message: String(body.message || ""),
                });
              } catch (_) {
                // ignore
              }
            }

            const searchResults = rows
              .map((item, index) => {
                const location = item && item.location ? item.location : {};
                const lat = Number(location.lat || 0);
                const lng = Number(location.lng || 0);
                if (!isValidCoordinate(lat, lng)) return null;

                const title = String((item && item.title) || (item && item.address) || "").trim();
                if (!title) return null;

                const address = String((item && item.address) || "").trim();
                const cityName = String(
                  (item && item.ad_info && item.ad_info.city) ||
                    (item && item.ad_info && item.ad_info.province) ||
                    ""
                ).trim();
                const province = String((item && item.ad_info && item.ad_info.province) || "").trim();
                const district = String((item && item.ad_info && item.ad_info.district) || "").trim();
                const adcode = String((item && item.ad_info && item.ad_info.adcode) || "").trim();

                return {
                  id: Number(item && item.id) || index + 1,
                  title,
                  titleLines: splitTitleLines(title, TITLE_MAX_CHARS),
                  address,
                  addressDisplay: wrapAddressByLine(address),
                  addressLines: splitAddressLines(address),
                  latitude: lat,
                  longitude: lng,
                  cityName,
                  province,
                  district,
                  adcode,
                };
              })
              .filter(Boolean);

            resolve(searchResults);
          },
          fail: () => {
            resolve([]);
          },
          complete: () => {
            this.searchTask = null;
          },
        });
      });
    },

    async searchByCloud(keyword, cityName) {
      try {
        const payload = await requestJson("/api/tencent-map/search", {
          method: "POST",
          data: {
            keyword,
            cityName: cityName || undefined,
          },
        });
        if (!payload || typeof payload !== "object" || hasExplicitPayloadFailure(payload)) {
          return null;
        }
        return this.normalizeSearchResultItems(payload);
      } catch (error) {
        return null;
      }
    },

    async searchPlaces(keyword) {
      const normalizedKeyword = String(keyword || "").trim();
      if (!normalizedKeyword) {
        this.setData({
          searching: false,
          searchResults: [],
          showResults: false,
        });
        return;
      }

      this.abortSearchTask();
      this.pendingSearchKeyword = normalizedKeyword;
      this.setData({ searching: true });

      const normalizedCity = String(this.properties.cityName || this.data.selectedCity || "").trim();

      const applyResults = (results) => {
        if (this.pendingSearchKeyword !== normalizedKeyword) return;
        const rows = Array.isArray(results) ? results : [];
        this.setData({
          searchResults: rows,
          showResults: rows.length > 0,
        });
      };

      try {
        // 优先走云托管后端（callContainer 链路）；直连腾讯地图仅作兜底。
        const cloudResults = await this.searchByCloud(normalizedKeyword, normalizedCity);
        if (Array.isArray(cloudResults) && cloudResults.length > 0) {
          applyResults(cloudResults);
          return;
        }

        const tencentResults = await this.searchByTencentApi(normalizedKeyword, normalizedCity);
        applyResults(tencentResults);
      } finally {
        if (this.pendingSearchKeyword === normalizedKeyword) {
          this.setData({ searching: false });
        }
      }
    },

    onSelectResult(e) {
      this.markMapTapSuppressed(220);
      this.userHasSelectedPoint = true;
      const dataset = e && e.currentTarget && e.currentTarget.dataset
        ? e.currentTarget.dataset
        : {};
      const dsLatitude = Number(dataset.latitude || 0);
      const dsLongitude = Number(dataset.longitude || 0);
      const hasDatasetCoordinate = isValidCoordinate(dsLatitude, dsLongitude);

      let item = null;
      if (hasDatasetCoordinate) {
        item = {
          title: String(dataset.title || "").trim(),
          address: String(dataset.address || "").trim(),
          latitude: dsLatitude,
          longitude: dsLongitude,
          cityName: String(dataset.cityname || "").trim(),
          province: String(dataset.province || "").trim(),
          district: String(dataset.district || "").trim(),
          adcode: String(dataset.adcode || "").trim(),
        };
      } else {
        const rawIndex = dataset.index;
        const index = Number(rawIndex);
        if (!Number.isInteger(index) || index < 0) return;
        item = this.data.searchResults[index];
      }
      if (!item) return;

      const title = String(item.title || "").trim();
      const address = String(item.address || "").trim();
      const locationText = address || title;

      this.setData({
        searchKeyword: title,
        searchResults: [],
        showResults: false,
        searchFocused: false,
        selectedAddress: locationText,
        selectedCity: item.cityName || this.data.selectedCity,
        selectedProvince: item.province || this.data.selectedProvince,
        selectedDistrict: item.district || this.data.selectedDistrict,
        selectedAdcode: item.adcode || this.data.selectedAdcode,
      });

      this.setMapPoint(item.latitude, item.longitude, {
        reverseImmediate: true,
        preserveAddress: true,
      });
    },

    onMapTap(e) {
      if (this.isMapTapSuppressed()) return;
      const detail = e && e.detail ? e.detail : {};
      const latitude = Number(detail.latitude || 0);
      const longitude = Number(detail.longitude || 0);
      if (!isValidCoordinate(latitude, longitude)) return;
      this.userHasSelectedPoint = true;

      if (this.data.showResults || this.data.searchFocused) {
        this.setData({
          showResults: false,
          searchFocused: false,
        });
      }

      this.setMapPoint(latitude, longitude, { reverseImmediate: true });
    },

    onPoiTap(e) {
      if (this.isMapTapSuppressed()) return;
      const detail = e && e.detail ? e.detail : {};
      const latitude = Number(detail.latitude || 0);
      const longitude = Number(detail.longitude || 0);
      if (!isValidCoordinate(latitude, longitude)) return;
      this.userHasSelectedPoint = true;

      const poiName = String(detail.name || "").trim();
      if (this.data.showResults || this.data.searchFocused) {
        this.setData({
          showResults: false,
          searchFocused: false,
        });
      }

      if (poiName) {
        this.setData({ selectedAddress: poiName });
      }

      this.setMapPoint(latitude, longitude, {
        reverseImmediate: true,
        preserveAddress: Boolean(poiName),
      });
    },

    onMarkerDragEnd(e) {
      if (this.isMapTapSuppressed()) return;
      const detail = e && e.detail ? e.detail : {};
      const latitude = Number(detail.latitude || 0);
      const longitude = Number(detail.longitude || 0);
      if (!isValidCoordinate(latitude, longitude)) return;
      this.userHasSelectedPoint = true;

      if (this.data.showResults || this.data.searchFocused) {
        this.setData({
          showResults: false,
          searchFocused: false,
        });
      }

      this.setMapPoint(latitude, longitude, { reverseImmediate: true });
    },

    onLocateCurrent() {
      if (this.data.locating) return;
      this.markMapTapSuppressed(220);
      this.setData({ locating: true });
      const center = this.resolvePreferredCenter();

      if (this.data.showResults || this.data.searchFocused) {
        this.setData({
          showResults: false,
          searchFocused: false,
        });
      }

      this.setMapPoint(center.latitude, center.longitude, {
        reverseImmediate: true,
      });
      this.setData({ locating: false });
    },

    onConfirm() {
      if (this.data.resolvingAddress) {
        wx.showToast({ title: "正在解析位置，请稍候", icon: "none" });
        return;
      }
      const address = String(this.data.selectedAddress || "").trim();
      if (!address) {
        wx.showToast({ title: "未解析到具体位置，请重试或搜索地点", icon: "none" });
        return;
      }

      this.triggerEvent("select", {
        location: address,
        latitude: this.data.latitude,
        longitude: this.data.longitude,
        cityName: this.data.selectedCity || String(this.properties.cityName || "").trim(),
        province: this.data.selectedProvince,
        district: this.data.selectedDistrict,
        adcode: this.data.selectedAdcode,
      });
    },

    onCancel() {
      this.locationRequestId = Number(this.locationRequestId || 0) + 1;
      this.clearSearchPanel();
      this.setData({ locating: false });
      this.triggerEvent("close");
    },
  },
});
