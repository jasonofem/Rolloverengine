#!/usr/bin/env node
/**
 * preview-static.mjs — reproduce the Vercel deployment on your own machine.
 *
 *   npm run build && npm run preview:static
 *
 * `npm start` gives you the real server: node:http, static files out of public/,
 * state in data/store.json. That is not what Vercel runs. On Vercel there is no
 * long-lived process and no disk that survives a request, so api/index.js reports
 * `persistent: false` and the dashboard switches to running the engine in the
 * browser against localStorage. You cannot test that behaviour against the real
 * server, because the real server answers honestly that it does persist.
 *
 * This script is the missing third host. It serves dist/ exactly as Vercel would,
 * and routes /api/* through the very same api/index.js module the deployment
 * uses, memory store and all. So if the browser-local path is broken, it is
 * broken here too — which is the point of running it before you deploy rather
 * than after.
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { webHandler as handler } from '../api/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '': 'text/plain; charset=utf-8',
};

try {
  const st = await stat(DIST);
  if (!st.isDirectory()) throw new Error('not a directory');
} catch {
  console.error('\n  ✗ dist/ does not exist. Run `npm run build` first.\n');
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  /* /api/* → the serverless function, unchanged. Build a Web Request so the
   * module cannot tell it is not running on Vercel. */
  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    const webReq = new Request(`http://${req.headers.host || 'localhost'}${req.url}`, {
      method: req.method,
      headers: Object.entries(req.headers).filter(([, v]) => typeof v === 'string'),
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
    const out = await handler(webReq);
    res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
    res.end(await out.text());
    return;
  }

  /* Everything else is a static file out of dist/, with the SPA fallback
   * vercel.json describes. */
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.resolve(DIST, '.' + path.normalize(rel));
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const st = await stat(filePath);
    if (st.isDirectory()) throw new Error('directory');
    const buf = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'content-length': buf.length,
      'cache-control': 'no-cache',
    });
    res.end(buf);
  } catch {
    const buf = await readFile(path.join(DIST, 'index.html'));
    res.writeHead(200, { 'content-type': MIME['.html'], 'content-length': buf.length });
    res.end(buf);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`
  ╔══════════════════════════════════════════════════════════════╗
  ║  ROLLOVERENGINE  ·  static / serverless preview              ║
  ╠══════════════════════════════════════════════════════════════╣
  ║  dashboard   http://localhost:${PORT}                            ║
  ║  api state   http://localhost:${PORT}/api/state                  ║
  ╚══════════════════════════════════════════════════════════════╝
  serving: dist/   api: api/index.js (memory store, persistent:false)

  This is what Vercel runs. /api/state reports persistent:false, so the
  dashboard should show "⚡ running locally" and keep your runs in
  localStorage. Compare with \`npm start\`, which persists to data/store.json.
`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
