/**
 * store.js — flat-file JSON persistence. Zero dependencies.
 *
 * Layout:  data/store.json = { runs: {id: run}, order: [ids], settings: {...} }
 * Writes are atomic (tmp + rename) so a crash mid-write can't corrupt the pot.
 */

import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* The defaults, the run summary and the revive step are shared with the
 * in-memory and localStorage backends — see lib/store-shared.js. */
import { DEFAULT_SETTINGS, summariseRun, reviveRun } from './store-shared.js';

export { DEFAULT_SETTINGS, summariseRun };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.RE_DATA_DIR || path.resolve(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'store.json');
const TMP = FILE + '.tmp';

const EMPTY = { runs: {}, order: [], settings: {}, lab: [] };

let cache = null;
let cacheMtimeMs = -1;
let writeChain = Promise.resolve();

/* The cache is invalidated by the file's mtime, and that is not a nicety.
 *
 * `npm start` and `node bin/rollover.mjs` are two separate processes over one
 * store.json — the CLI is advertised as sharing runs with the dashboard. With a
 * cache that was only ever filled once, whichever process wrote second would
 * resurrect everything the first had deleted, because it was still holding the
 * old snapshot in memory. Deleting your runs from the CLI while the server ran
 * would silently bring them all back on the server's next write.
 *
 * One stat() per read is the whole cost of not doing that. */
async function load() {
  try {
    if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
    const st = await stat(FILE).catch(() => null);
    const mtime = st ? st.mtimeMs : -1;
    if (cache && mtime === cacheMtimeMs) return cache;

    if (st) {
      const raw = await readFile(FILE, 'utf8');
      cache = { ...EMPTY, ...JSON.parse(raw) };
    } else {
      cache = structuredClone(EMPTY);
    }
    cache.runs = cache.runs || {};
    cache.order = cache.order || [];
    cache.settings = cache.settings || {};
    cache.lab = cache.lab || [];
    cacheMtimeMs = mtime;
  } catch {
    cache = structuredClone(EMPTY);
    cacheMtimeMs = -1;
  }
  return cache;
}

async function persist() {
  if (!cache) return;
  // Serialise writes; last write wins with the full snapshot. The `return` here
  // is the important part and it was missing: assigning the new link to
  // writeChain and then returning it means awaiting persist() resolves
  // immediately, before the file is on disk. Every caller — saveRun, deleteRun,
  // saveSettings — believed the write had landed when it had only been queued.
  // Under a crash, or just a size check one line later, that is a lie.
  writeChain = writeChain.then(async () => {
    try {
      if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
      await writeFile(TMP, JSON.stringify(cache, null, 2), 'utf8');
      await rename(TMP, FILE);
      // Record what we just wrote, so our own write doesn't look like someone
      // else's and force a pointless re-read on the next call.
      const st = await stat(FILE).catch(() => null);
      cacheMtimeMs = st ? st.mtimeMs : -1;
    } catch (err) {
      console.error('[store] persist failed:', err.message);
    }
  });
  return writeChain; // await THIS, so the caller waits for its own write
}

/* ------------------------------ runs ------------------------------ */

export async function saveRun(run) {
  const db = await load();
  db.runs[run.id] = reviveRun(run);
  if (!db.order.includes(run.id)) db.order.unshift(run.id);
  db.order = db.order.slice(0, 200);
  await persist();
  return run;
}

export async function getRun(id) {
  const db = await load();
  const run = db.runs[id];
  return run ? reviveRun(run) : null;
}

export async function listRuns(limit = 50) {
  const db = await load();
  return db.order
    .slice(0, limit)
    .map((id) => db.runs[id])
    .filter(Boolean)
    .map((r) => summariseRun(r));
}

export async function getActiveRun() {
  const db = await load();
  for (const id of db.order) {
    const r = db.runs[id];
    if (r && r.status === 'active') return reviveRun(r);
  }
  return null;
}

export async function deleteRun(id) {
  const db = await load();
  delete db.runs[id];
  db.order = db.order.filter((x) => x !== id);
  await persist();
  return true;
}

/** Re-exported under the old name so existing callers keep working. */
export const revive = reviveRun;

/* ---------------------------- settings ---------------------------- */

export async function getSettings() {
  const db = await load();
  return {
    ...DEFAULT_SETTINGS,
    oddsApi: { key: process.env.ODDS_API_KEY || '', sports: [] },
    ...db.settings,
  };
}

export async function saveSettings(patch) {
  const db = await load();
  db.settings = { ...(db.settings || {}), ...patch };
  await persist();
  return getSettings();
}

/* ------------------------------- lab ------------------------------ */

export async function pushLab(result) {
  const db = await load();
  db.lab = [
    { at: new Date().toISOString(), config: result.config, strategies: result.strategies, headline: result.headline, calibration: result.calibration },
    ...(db.lab || []),
  ].slice(0, 40);
  await persist();
  return db.lab;
}

export async function getLab() {
  const db = await load();
  return db.lab || [];
}

export const DATA_FILE = FILE;
