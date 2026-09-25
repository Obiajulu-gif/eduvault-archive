/**
 * Build a URLSearchParams from a params object, skipping entries whose value
 * is undefined, null, or an empty string.
 *
 * `new URLSearchParams(object)` stringifies every value, so an unset optional
 * filter like `{ subject: undefined }` becomes `subject=undefined` on the
 * wire and the backend then filters on the literal string "undefined".
 */
export function buildQueryParams(params = {}) {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    searchParams.set(key, String(value));
  }
  return searchParams;
}
