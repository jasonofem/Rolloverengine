/**
 * api/index.js — the RolloverEngine API as a Vercel serverless function.
 *
 * This is the same route table as server/index.js, because it literally is the
 * same code: lib/http-core.js defines the API once and both hosts wrap it. The
 * only thing that differs is the transport (Web Response here, node:http there)
 * and the storage backend.
 *
 * ── On persistence, honestly ────────────────────────────────────────────────
 * A serverless function has no writable disk that outlives the invocation.
 * /tmp exists but is discarded, so a rollover created in one request would be
 * gone by the next — and a rollover is a seven-day object, which is the one
 * thing this deployment genuinely cannot hold.
 *
 * Rather than fake it, this function reports `persistent: false` on
 * /api/state. The dashboard reads that and runs the engine locally in the
 * browser tab, persisting your runs to localStorage. Same engine, same numbers,
 * nothing lost between visits — the state just lives on your device instead of
 * a server. The endpoints below still work for anything stateless: scans, the
 * calendar, the Monte-Carlo Lab and the projection.
 *
 * ── On duration ─────────────────────────────────────────────────────────────
 * Pricing ~42 fixtures across ~8 books takes real CPU, and the Lab runs
 * hundreds of full rollovers. `maxIterations` is capped well below the local
 * server's limit for that reason; http-core enforces it.
 */

import { createApi } from '../lib/http-core.js';
import { createMemoryStore } from '../lib/memory-store.js';

/* The function body must be readable as JSON, and this module is evaluated cold
 * on every new container — so build the API once at module scope and let the
 * in-memory store stay warm across invocations that reuse the container. */
const store = createMemoryStore({ oddsApiKey: process.env.ODDS_API_KEY || '' });

const api = createApi({
  store,
  env: process.env,
  persistent: false,
  maxIterations: 1500,
});

/** Vercel kills a function at this many seconds. Hobby allows 60. */
export const maxDuration = 60;

export default async function handler(req) {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors() });
  }

  let body = {};
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      const raw = await req.text();
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return json(400, { error: 'invalid JSON body' });
    }
  }

  try {
    const out = await api({
      method: req.method,
      pathname: url.pathname,
      query: url.searchParams,
      body,
    });
    return json(out.status, out.body);
  } catch (err) {
    return json(500, { error: err.message || 'internal error' });
  }
}

function json(status, payload) {
  return new Response(JSON.stringify(payload, jsonSafe), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors() },
  });
}

function cors() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}

/** Sets and Maps don't survive JSON.stringify unless you convert them. */
function jsonSafe(key, value) {
  if (value instanceof Set) return [...value];
  if (value instanceof Map) return Object.fromEntries(value);
  return value;
}
