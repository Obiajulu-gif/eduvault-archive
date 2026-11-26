/** Deterministic dedupe key helpers for notification producers. */
export function notificationDedupeKey(parts) {
  return parts.filter((p) => p !== undefined && p !== null && p !== '').map(String).join(':');
}
