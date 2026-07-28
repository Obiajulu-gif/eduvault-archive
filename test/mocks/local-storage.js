/**
 * Installs a spec-compliant in-memory localStorage on `window`.
 *
 * Newer Node versions (v22+ with WebStorage, and v25 by default) expose a
 * global `localStorage` that shadows jsdom's implementation inside Vitest
 * and, when no `--localstorage-file` is configured, has no working methods.
 * Tests that exercise localStorage-backed features install this stub so
 * they behave identically on every Node version and in CI.
 */
export function installLocalStorageStub() {
  const store = new Map();
  const stub = {
    getItem: (key) => (store.has(String(key)) ? store.get(String(key)) : null),
    setItem: (key, value) => {
      store.set(String(key), String(value));
    },
    removeItem: (key) => {
      store.delete(String(key));
    },
    clear: () => {
      store.clear();
    },
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(window, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
  return stub;
}
