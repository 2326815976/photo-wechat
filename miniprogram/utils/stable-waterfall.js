function normalizeList(list) {
  return Array.isArray(list) ? list : [];
}

function readItemId(item) {
  if (!item || item.id === undefined || item.id === null) return "";
  return String(item.id);
}

function shouldResetStableColumnMap(currentList, nextList) {
  const current = normalizeList(currentList);
  const next = normalizeList(nextList);

  if (next.length === 0) {
    return current.length > 0;
  }
  if (current.length === 0) {
    return false;
  }
  if (next.length < current.length) {
    return true;
  }

  for (let index = 0; index < current.length; index += 1) {
    if (readItemId(current[index]) !== readItemId(next[index])) {
      return true;
    }
  }

  return false;
}

function buildStableWaterfallColumns(list, options) {
  const items = normalizeList(list);
  const estimateHeight =
    options && typeof options.estimateHeight === "function"
      ? options.estimateHeight
      : (() => 1);
  const activeMap =
    options && options.columnMap && typeof options.columnMap === "object"
      ? options.columnMap
      : Object.create(null);

  const nextMap = Object.create(null);
  const left = normalizeList(options && options.left).slice();
  const right = normalizeList(options && options.right).slice();
  let leftHeight = Number(options && options.leftHeight);
  let rightHeight = Number(options && options.rightHeight);

  if (!(leftHeight >= 0)) {
    leftHeight = left.reduce((total, item) => total + Math.max(0, Number(estimateHeight(item)) || 0), 0);
  }
  if (!(rightHeight >= 0)) {
    rightHeight = right.reduce((total, item) => total + Math.max(0, Number(estimateHeight(item)) || 0), 0);
  }

  left.forEach((item) => {
    const id = readItemId(item);
    if (id) nextMap[id] = "left";
  });
  right.forEach((item) => {
    const id = readItemId(item);
    if (id) nextMap[id] = "right";
  });

  items.forEach((item) => {
    const id = readItemId(item);
    const rememberedColumn = id ? String(activeMap[id] || "") : "";
    const estimatedHeight = Math.max(0, Number(estimateHeight(item)) || 0);
    const targetColumn = rememberedColumn === "left" || rememberedColumn === "right"
      ? rememberedColumn
      : (leftHeight <= rightHeight ? "left" : "right");

    if (targetColumn === "right") {
      right.push(item);
      rightHeight += estimatedHeight;
      if (id) nextMap[id] = "right";
      return;
    }

    left.push(item);
    leftHeight += estimatedHeight;
    if (id) nextMap[id] = "left";
  });

  if (left.length === 0 && right.length > 0) {
    const mergedLeft = right.slice();
    mergedLeft.forEach((item) => {
      const id = readItemId(item);
      if (id) nextMap[id] = "left";
    });
    return {
      left: mergedLeft,
      right: [],
      leftHeight: rightHeight,
      rightHeight: 0,
      columnMap: nextMap,
    };
  }

  return {
    left,
    right,
    leftHeight,
    rightHeight,
    columnMap: nextMap,
  };
}

module.exports = {
  buildStableWaterfallColumns,
  shouldResetStableColumnMap,
};
