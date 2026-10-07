/**
 * local-api.js — the RolloverEngine API, running inside the browser tab.
 *
 * Same route table as the server, because it is the same code: lib/http-core.js
 * defines the API once, and this file is a six-line binding of it to a
 * localStorage-backed store. When the dashboard is served from a Vercel
 * deployment — which has no disk that survives a request — it loads this module
 * and stops making network calls entirely. Your runs persist in your browser
 * instead of on a server.
 *
 * `package.json` also exports it as `rollover-engine/local-api` for Node.
 */

/* Imports the generated bundle, not lib/ directly, and that is deliberate. On a
 * zero-build Vercel deployment only public/ is served, so ../lib/http-core.js
 * would 404 in the browser. Everything the engine needs is concatenated into
 * ./vendor/engine.bundle.mjs by scripts/bundle.mjs.
 *
 * Relative rather than bare specifiers for the same reason: this file reaches
 * the browser exactly as it sits on disk, with no bundler and no import map to
 * give 'rollover-engine/http-core' a meaning. If you do build this with Vite,
 * add an alias for './vendor/engine.bundle.mjs'.
 *
 * Regenerate the bundle after touching lib/:   node scripts/bundle.mjs --check */
import { createApi, createLocalStorageStore } from './vendor/engine.bundle.mjs';

export const STORAGE_KEY = 'rolloverengine.store.v1';

export const localStore = createLocalStorageStore(STORAGE_KEY);

export const localApi = createApi({
  store: localStore,
  env: {},
  persistent: false,
  maxIterations: 1500,
});

/**
 * Where your runs actually live, so the UI can say so plainly.
 * A function, not an object: `evictions` changes over the life of the tab as the
 * store gives up finished runs to stay inside the quota.
 */
export function storageInfo() {
  return {
    backend: localStore.backend, // 'localStorage', or 'memory' if storage is blocked
    key: STORAGE_KEY,
    persistent: localStore.backend === 'localStorage',
    evictions: (localStore.evictions || []).map((e) => e.evictedRun).filter(Boolean),
    quotaExhausted: (localStore.evictions || []).some((e) => e.fatal),
    /* Roughly what one rollover costs you in storage, so the number in the UI is
     * grounded rather than abstract. */
    bytes: (() => { try { return (localStorage.getItem(STORAGE_KEY) || '').length; } catch { return 0; } })(),
  };
}

/**
 * Drop-in replacement for `fetch('/api/…')`. Accepts the same (path, opts) the
 * dashboard already uses and resolves to a Response-like object, so callers can
 * keep doing `await res.json()` and `res.ok`.
 */
export async function localFetch(path, opts = {}) {
  const url = new URL(String(path), 'http://local');
  let body = {};
  if (opts.body) {
    try { body = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body; }
    catch { body = {}; }
  }
  try {
    const out = await localApi({
      method: (opts.method || 'GET').toUpperCase(),
      pathname: url.pathname,
      query: url.searchParams,
      body,
    });
    return respond(out.status, out.body);
  } catch (err) {
    return respond(500, { error: err.message || 'local engine error' });
  }
}

function respond(status, body) {
  const text = JSON.stringify(body, jsonSafe);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 201 ? 'Created' : status === 404 ? 'Not Found' : 'Error',
    headers: { get: () => 'application/json' },
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

function jsonSafe(key, value) {
  if (value instanceof Set) return [...value];
  if (value instanceof Map) return Object.fromEntries(value);
  return value;
}

export default localFetch;
