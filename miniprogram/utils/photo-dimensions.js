const dimensionPromiseCache = Object.create(null);
const DEFAULT_DIMENSION_PROBE_CONCURRENCY = 4;

function normalizePhotoUrl(value) {
  return String(value == null ? "" : value).trim();
}

function resolvePhotoDimensionProbeUrls(photo) {
  const source = photo && typeof photo === "object" ? photo : {};
  const seen = Object.create(null);
  return [
    source.card_url_resolved,
    source.thumbnail_url_resolved,
    source.thumbnail_url,
    source.preview_url_resolved,
    source.preview_url,
    source.original_url_resolved,
    source.original_url,
  ]
    .map((value) => normalizePhotoUrl(value))
    .filter((value) => {
      if (!value || seen[value]) {
        return false;
      }
      seen[value] = true;
      return true;
    });
}

function hasStablePhotoDimensions(photo) {
  const width = Number(photo && photo.width || 0);
  const height = Number(photo && photo.height || 0);
  return width > 0 && height > 0;
}

function photoListHasMissingDimensions(list) {
  return Array.isArray(list) && list.some((photo) => !hasStablePhotoDimensions(photo));
}

function loadImageDimensions(src) {
  const normalizedSrc = normalizePhotoUrl(src);
  if (!normalizedSrc) {
    return Promise.resolve(null);
  }

  if (dimensionPromiseCache[normalizedSrc]) {
    return dimensionPromiseCache[normalizedSrc];
  }

  const task = new Promise((resolve) => {
    wx.getImageInfo({
      src: normalizedSrc,
      success(result) {
        const width = Number(result && result.width || 0);
        const height = Number(result && result.height || 0);
        if (width > 0 && height > 0) {
          resolve({ width, height });
          return;
        }
        delete dimensionPromiseCache[normalizedSrc];
        resolve(null);
      },
      fail() {
        delete dimensionPromiseCache[normalizedSrc];
        resolve(null);
      },
    });
  });

  dimensionPromiseCache[normalizedSrc] = task;
  return task;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const source = Array.isArray(items) ? items : [];
  if (!source.length) {
    return [];
  }

  const normalizedConcurrency = Math.max(
    1,
    Math.min(source.length, Math.floor(Number(concurrency) || 1))
  );
  const results = new Array(source.length);
  let cursor = 0;

  async function worker() {
    while (cursor < source.length) {
      const currentIndex = cursor;
      cursor += 1;
      results[currentIndex] = await mapper(source[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: normalizedConcurrency }, () => worker())
  );

  return results;
}

async function hydratePhotoDimensions(list, options) {
  const source = Array.isArray(list) ? list : [];
  if (!source.length) {
    return source;
  }

  const concurrency = Math.max(
    1,
    Number(options && options.concurrency) || DEFAULT_DIMENSION_PROBE_CONCURRENCY
  );
  let changed = false;
  const nextList = await mapWithConcurrency(source, concurrency, async (photo) => {
    if (hasStablePhotoDimensions(photo)) {
      return photo;
    }

    const probeUrls = resolvePhotoDimensionProbeUrls(photo);
    if (!probeUrls.length) {
      return photo;
    }

    let dimensions = null;
    for (let index = 0; index < probeUrls.length; index += 1) {
      dimensions = await loadImageDimensions(probeUrls[index]);
      if (dimensions) {
        break;
      }
    }
    if (!dimensions) {
      return photo;
    }

    changed = true;
    return Object.assign({}, photo, {
      width: dimensions.width,
      height: dimensions.height,
    });
  });

  return changed ? nextList : source;
}

module.exports = {
  hasStablePhotoDimensions,
  photoListHasMissingDimensions,
  hydratePhotoDimensions,
};
