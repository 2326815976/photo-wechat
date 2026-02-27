function normalizeChinaMobile(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const digits = raw.replace(/\D+/g, "");
  if (!digits) return "";

  if (digits.startsWith("86") && digits.length > 11) {
    return digits.slice(2, 13);
  }

  return digits.slice(0, 11);
}

function clampChinaMobileInput(value) {
  return String(value || "")
    .replace(/\D+/g, "")
    .slice(0, 11);
}

function isValidChinaMobile(value) {
  return /^1[3-9]\d{9}$/.test(String(value || ""));
}

module.exports = {
  normalizeChinaMobile,
  clampChinaMobileInput,
  isValidChinaMobile,
};
