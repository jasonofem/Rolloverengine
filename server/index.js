/**
 * RolloverEngine — local dev/prod server. Zero dependencies: node:http only.
 *
 *   GET  /                      dashboard
 *   GET  /api/state             settings + active run + recent runs
 *   POST /api/runs              create a rollover run
 *   POST /api/runs/:id/scan     (re)scan a day's slip
 *   POST /api/runs/:id/stake    commit the stake
 *   POST /api/runs/:id/settle   settle the open day (won|lost|auto)
 *   POST /api/runs/:id/alt      switch to an alternative slip
 *   POST /api/runs/:id/odds     change the daily odds target
 *   POST /api/runs/:id/skip     skip a day the engine refused to roll
 *   POST /api/runs/:id/restart  go again after a loss or a completion
 *   POST /api/runs/:id/abandon  stop the run
 *   GET  /api/scan?date=        raw market scan + day shape
 *   POST /api/lab/simulate      Monte-Carlo proof
 *   POST /api/lab/project       closed-form projection
 *   GET  /api/calendar          next N days scored for rollover quality
 *
 * The routing itself lives in lib/http-core.js so the exact same API can run
 * here, on Vercel (api/index.js) and inside the browser (public/local-api.js).
 * This file is only the node:http transport plus static file serving.
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApi, jsonSafe } from '../lib/http-core.js';
import * as store from '../lib/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const api = createApi({ store, env: process.env, persistent: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'OPTIONS') return send(res, 204, '');
      const out = await api({
        method: req.method,
        pathname: url.pathname,
        query: url.searchParams,
        body: req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req),
      });
      return json(res, out.status, out.body);
    }
    return await serveStatic(req, res, url);
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) json(res, 500, { error: err.message || 'internal error' });
  }
});

/* ------------------------------------------------------------------ *
 * Static
 * ------------------------------------------------------------------ */

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.resolve(PUBLIC_DIR, '.' + path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const st = await stat(filePath);
    if (st.isDirectory()) return serveStatic(req, res, new URL('/index.html', url));
    const body = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-length': body.length,
    });
    res.end(body);
  } catch {
    // SPA-ish fallback
    try {
      const body = await readFile(path.join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload, jsonSafe));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(body);
}

function send(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 4 * 1024 * 1024) throw new Error('payload too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('invalid JSON body');
  }
}

server.listen(PORT, HOST, () => {
  console.log(`
  ╔══════════════════════════════════════════════════════════════╗
  ║  ROLLOVERENGINE  ·  edge-aware multi-day rollover system     ║
  ╠══════════════════════════════════════════════════════════════╣
  ║  dashboard   http://localhost:${PORT}                            ║
  ║  api health  http://localhost:${PORT}/api/health                 ║
  ║  cli         node bin/rollover.mjs help                      ║
  ╚══════════════════════════════════════════════════════════════╝
  store: ${store.DATA_FILE}  (persistent)
`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
