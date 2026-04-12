const STORY_OPENING_DURATION_MS = 280;
const STORY_CLOSING_DURATION_MS = 220;
const STORY_IMAGE_ENTER_DURATION_MS = 220;

function normalizeStoryPhoto(photo) {
  return photo && typeof photo === "object" ? photo : null;
}

function createStoryOpeningState(photo) {
  const current = normalizeStoryPhoto(photo);
  if (!current || !current.has_story) return photo;
  return Object.assign({}, current, {
    story_open: true,
    story_visible: true,
    story_phase: "opening",
    story_image_phase: "",
  });
}

function createStoryOpenedState(photo) {
  const current = normalizeStoryPhoto(photo);
  if (!current || !current.has_story) return photo;
  return Object.assign({}, current, {
    story_open: true,
    story_visible: true,
    story_phase: "open",
    story_image_phase: "",
  });
}

function createStoryClosingState(photo) {
  const current = normalizeStoryPhoto(photo);
  if (!current || !current.has_story) return photo;
  return Object.assign({}, current, {
    story_open: true,
    story_visible: true,
    story_phase: "closing",
    story_image_phase: "",
  });
}

function createStoryClosedState(photo) {
  const current = normalizeStoryPhoto(photo);
  if (!current || !current.has_story) return photo;
  return Object.assign({}, current, {
    story_open: false,
    story_visible: false,
    story_phase: "",
    story_image_phase: "entering",
  });
}

function clearStoryImagePhase(photo) {
  const current = normalizeStoryPhoto(photo);
  if (!current || !current.has_story) return photo;
  if (!current.story_image_phase) return current;
  return Object.assign({}, current, {
    story_image_phase: "",
  });
}

module.exports = {
  STORY_OPENING_DURATION_MS,
  STORY_CLOSING_DURATION_MS,
  STORY_IMAGE_ENTER_DURATION_MS,
  createStoryOpeningState,
  createStoryOpenedState,
  createStoryClosingState,
  createStoryClosedState,
  clearStoryImagePhase,
};
