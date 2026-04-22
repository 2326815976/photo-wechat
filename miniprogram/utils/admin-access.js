function normalizeRole(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isAdminRole(value) {
  return normalizeRole(value) === "admin";
}

function hasAdminAccess(user, profile) {
  return isAdminRole(user && user.role) || isAdminRole(profile && profile.role);
}

module.exports = {
  normalizeRole,
  isAdminRole,
  hasAdminAccess,
};
