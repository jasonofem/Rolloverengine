/**
 * memory-store.js — a storage adapter with a pluggable backend.
 *
 * lib/store.js persists to data/store.json, which needs a writable disk. Two
 * of the places this engine runs do not have one that outlives a request:
 *
 *   • Vercel serverless — /tmp exists but is thrown away between invocations,
 *     so a run created in one request is gone by the next.
 *   • the browser — no filesystem at all, but localStorage survives reloads.
 *
 * Rather than write two more stores, this module implements the whole
 * lib/store.js contract once against a tiny `{read, write}` backend interface
 * and lets the caller supply it. `createMemoryStore()` gives you an in-process
 * object (the serverless case — honest about being ephemeral);
 * `createLocalStorageStore()` gives you the browser case, which genuinely does
 * persist, just on your device rather than a server.
 *
 * Both share DEFAULT_SETTINGS and summariseRun with the file store, so the
 * dashboard renders identically no matter which backend is underneath.
 */

import { DEFAULT_SETTINGS, summariseRun, reviveRun } from './store-shared.js';

const EMPTY = () => ({ runs: {}, order: [], settings: {}, lab: [] });

/**
 * @param {object} backend           `{ read(): object|null, write(db): void }`
 * @param {object} [opts]
 * @param {string} [opts.oddsApiKey] injected key for live-odds settings
 * @param {number} [opts.labCap]     how many lab results to retain
 * @param {number} [opts.runCap]     how many runs to retain
 */
export function createStoreAdapter(backend, { oddsApiKey = '', labCap = 40, runCap = 200, onQuotaExceeded = null } = {}) {
  function load() {
    let db = null;
    try { db = backend.read(); } catch { db = null; }
    if (!db || typeof db !== 'object') db = EMPTY();
    db.runs = db.runs || {};
    db.order = db.order || [];
    db.settings = db.settings || {};
    db.lab = db.lab || [];
    return db;
  }

  /* localStorage gives you roughly 5 MB and throws when you exceed it. A run
   * here is ~80 KB, so the cap is what normally protects us — but if something
   * else on the origin is eating the quota, silently dropping the write would
   * mean losing a rollover you thought was saved. Instead: evict the oldest
   * finished runs until the write fits, and tell the caller what happened. An
   * ACTIVE run is never evicted, because that is the one with money on it. */
  function persist(db) {
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        backend.write(db);
        return true;
      } catch (err) {
        const victim = db.order
          .map((id) => db.runs[id])
          .filter(Boolean)
          .filter((r) => r.status !== 'active')
          .pop(); // order is newest-first, so the last entry is the oldest
        if (!victim) {
          // Nothing left to give up. Keep going in memory rather than throwing
          // mid-settle, which would leave the run in an inconsistent state.
          if (onQuotaExceeded) onQuotaExceeded({ evicted: 0, error: err.message, fatal: true });
          return false;
        }
        delete db.runs[victim.id];
        db.order = db.order.filter((x) => x !== victim.id);
        if (onQuotaExceeded) onQuotaExceeded({ evictedRun: victim.id, error: err.message });
      }
    }
    return false;
  }

  return {
    /* ------------------------------ runs ------------------------------ */

    async saveRun(run) {
      const db = load();
      // Round-trip through JSON so what we store is exactly what a reload sees.
      db.runs[run.id] = reviveRun(JSON.parse(JSON.stringify(run)));
      if (!db.order.includes(run.id)) db.order.unshift(run.id);
      db.order = db.order.slice(0, runCap);
      persist(db);
      return run;
    },

    async getRun(id) {
      const db = load();
      const run = db.runs[id];
      return run ? reviveRun(run) : null;
    },

    async listRuns(limit = 50) {
      const db = load();
      return db.order
        .slice(0, limit)
        .map((id) => db.runs[id])
        .filter(Boolean)
        .map((r) => summariseRun(r));
    },

    async getActiveRun() {
      const db = load();
      for (const id of db.order) {
        const r = db.runs[id];
        if (r && r.status === 'active') return reviveRun(r);
      }
      return null;
    },

    async deleteRun(id) {
      const db = load();
      delete db.runs[id];
      db.order = db.order.filter((x) => x !== id);
      persist(db);
      return true;
    },

    revive: reviveRun,

    /* ---------------------------- settings ---------------------------- */

    async getSettings() {
      const db = load();
      return {
        ...DEFAULT_SETTINGS,
        oddsApi: { key: oddsApiKey || '', sports: [] },
        ...db.settings,
      };
    },

    async saveSettings(patch) {
      const db = load();
      db.settings = { ...(db.settings || {}), ...patch };
      persist(db);
      return this.getSettings();
    },

    /* ------------------------------- lab ------------------------------ */

    async pushLab(result) {
      const db = load();
      db.lab = [
        { at: new Date().toISOString(), config: result.config, strategies: result.strategies, headline: result.headline, calibration: result.calibration },
        ...(db.lab || []),
      ].slice(0, labCap);
      persist(db);
      return db.lab;
    },

    async getLab() {
      return load().lab || [];
    },
  };
}

/** In-process store. Correct, fast, and gone when the process is. */
export function createMemoryStore(opts) {
  let db = EMPTY();
  return createStoreAdapter({ read: () => db, write: (next) => { db = next; } }, opts);
}

/**
 * localStorage-backed store for the browser build.
 * Falls back to an in-memory object when localStorage is unavailable (private
 * mode, sandboxed iframe, SSR) so the dashboard still works for that session.
 */
export function createLocalStorageStore(key = 'rolloverengine.store.v1', opts) {
  let memoryFallback = null;
  const evictions = [];
  const available = (() => {
    try {
      if (typeof localStorage === 'undefined') return false;
      const probe = '__re_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return true;
    } catch { return false; }
  })();

  const backend = available
    ? {
        read: () => {
          const raw = localStorage.getItem(key);
          return raw ? JSON.parse(raw) : EMPTY();
        },
        write: (db) => localStorage.setItem(key, JSON.stringify(db)),
      }
    : {
        read: () => memoryFallback || EMPTY(),
        write: (db) => { memoryFallback = db; },
      };

  /* A browser store is capped well below the file store's 200: 80 KB a run
   * against a ~5 MB quota shared with everything else on the origin. 25 runs is
   * two years of weekly rollovers and still leaves headroom. */
  const store = createStoreAdapter(backend, {
    runCap: 25,
    labCap: 12,
    onQuotaExceeded: (info) => { evictions.push(info); },
    ...opts,
  });
  store.backend = available ? 'localStorage' : 'memory';
  store.storageKey = key;
  /** Runs this store had to give up to stay inside the quota. Surfaced so the UI
   *  can say so instead of you wondering where a finished run went. */
  store.evictions = evictions;
  return store;
}
