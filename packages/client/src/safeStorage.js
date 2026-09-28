// localStorage, or null where it doesn't exist or access throws (private
// mode, blocked site data, non-browser tests).
export function safeStorage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
