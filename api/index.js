/**
 * api/index.js — the RolloverEngine API as a Vercel serverless function.
 *
 * This is the same route table as server/index.js, because it literally is the
 * same code: lib/http-core.js defines the API once and both hosts wrap it. The
 * only things that differ are the transport and the storage backend.
 *
 * ── Handler signature, and why it is the old-fashioned one ──────────────────
 * The default export is a CLASSIC Node handler, `(req, res)`. An earlier
 * version exported the wintercg style, `(request) => Response`, which works
 * beautifully when you call it directly and, on some Vercel Node bridges,
 * hangs forever in production: the bridge waits for `res.end()` that never
 * comes, the invocation burns its whole maxDuration, and every single route
 * answers 504 while the identical code answers in milliseconds locally. The
 * classic signature is the one every @vercel/node generation has honoured, so
 * it is the one the deployment gets. scripts/preview-static.mjs uses the
 * exported `webHandler` wrapper instead, so one route table still serves both
 * host shapes.
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
 * a server. It also means a function that is slow or unreachable can never
 * block the dashboard: boot falls back to the in-browser engine either way.
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

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

/** Sets and Maps don't survive JSON.stringify unless you convert them. */
function jsonSafe(key, value) {
  if (value instanceof Set) return [...value];
  if (value instanceof Map) return Object.fromEntries(value);
  return value;
}

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  res.end(JSON.stringify(payload, jsonSafe));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/** The classic Node serverless handler — the one Vercel always honours. */
export default async function handler(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers?.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
    return res.end();
  }

  let body = {};
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return send(res, 400, { error: 'invalid JSON body' });
    }
  }

  try {
    const out = await api({
      method: req.method,
      pathname: url.pathname,
      query: url.searchParams,
      body,
    });
    return send(res, out.status, out.body);
  } catch (err) {
    return send(res, 500, { error: err.message || 'internal error' });
  }
}

/** Web Request/Response wrapper for hosts that speak wintercg (local preview). */
export async function webHandler(request) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  let body = {};
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    try {
      const raw = await request.text();
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
        status: 400,
        headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
      });
    }
  }

  try {
    const out = await api({
      method: request.method,
      pathname: url.pathname,
      query: url.searchParams,
      body,
    });
    return new Response(JSON.stringify(out.body, jsonSafe), {
      status: out.status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'internal error' }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
    });
  }
}
