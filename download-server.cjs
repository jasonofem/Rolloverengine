// Minimal static server that hands out the shipping tarball to the user's browser.
// Serves exactly two things: an index page and the tarball itself. Nothing else.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const TARBALL = '/home/user/rolloverengine-live.tar.gz';
const PORT = 8080;

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);

  if (url === '/rolloverengine-live.tar.gz') {
    try {
      const stat = fs.statSync(TARBALL);
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Length': stat.size,
        'Content-Disposition': 'attachment; filename="rolloverengine-live.tar.gz"',
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(TARBALL).pipe(res);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('tarball missing: ' + err.message);
    }
    return;
  }

  // Everything else: simple index page with the download link.
  let size = '?';
  try { size = fs.statSync(TARBALL).size; } catch {}
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>RolloverEngine download</title>
<style>
body{background:#070a0c;color:#e6f2ea;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}
.card{background:#0d161a;border:1px solid #1d2c33;border-radius:14px;padding:36px 44px;max-width:560px;text-align:center}
a.dl{display:inline-block;margin:18px 0;padding:14px 30px;background:#0f8a4d;color:#fff;border-radius:10px;text-decoration:none;font-size:18px;font-weight:600}
a.dl:hover{background:#12a35b}
code{background:#16232a;padding:2px 8px;border-radius:6px;font-size:12px;word-break:break-all}
small{color:#7fa08d}
</style></head>
<body><div class="card">
<h1>RolloverEngine — shipping archive</h1>
<p>Click below. Your browser will save <b>rolloverengine-live.tar.gz</b> (${size} bytes) to your Downloads folder.</p>
<a class="dl" href="/rolloverengine-live.tar.gz">⬇ Download tarball</a>
<p><small>If the link opens a blank page instead of downloading, right-click it → “Save link as…”</small></p>
</div></body></html>`);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('download server listening on 0.0.0.0:' + PORT);
});
