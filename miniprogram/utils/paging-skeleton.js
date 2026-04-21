const DEFAULT_PAGING_SKELETON_RATIOS = [0.92, 1.18, 0.84, 1.32, 1.04, 1.26, 0.98, 1.4];

function createPagingSkeletonItems(count, options) {
  const safeCount = Math.max(0, Math.floor(Number(count) || 0));
  const prefix = String((options && options.prefix) || "paging").trim() || "paging";
  const seed = Math.max(0, Math.floor(Number((options && options.seed) || Date.now()) || Date.now()));

  return Array.from({ length: safeCount }, (_, index) => {
    const ratio = DEFAULT_PAGING_SKELETON_RATIOS[(seed + index) % DEFAULT_PAGING_SKELETON_RATIOS.length];
    return {
      id: `__${prefix}_skeleton_${seed}_${index}`,
      __skeleton: true,
      __ratio: ratio,
      __media_padding_top: `${ratio * 100}%`,
    };
  });
}

module.exports = {
  createPagingSkeletonItems,
};
