#!/usr/bin/env node
/**
 * vercel-dist.mjs — assemble the static payload Vercel should publish.
 *
 * vercel.json sets outputDirectory to dist/, and Vercel only publishes what is
 * inside it. The dashboard lives in public/ and imports one generated file from
 * public/vendor/, so on the face of it there is nothing to assemble. This script
 * exists for two reasons that are not obvious from the config:
 *
 *   1. It fails the build if public/vendor/engine.bundle.mjs is missing or stale
 *      relative to lib/. Without that, editing lib/ and deploying would publish
 *      a dashboard whose in-browser engine is quietly the previous version — the
 *      worst kind of bug for a system whose entire pitch is that its numbers can
 *      be trusted.
 *   2. It writes dist/VERSION so the deployed build can be identified from the
 *      browser, which makes "is this the fix I just pushed?" answerable.
 *
 * Run via `npm run build` locally or automatically by Vercel's buildCommand.
 */

import { cpSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const LIB = path.join(ROOT, 'lib');
const DIST = path.join(ROOT, 'dist');
const BUNDLE = path.join(PUB, 'vendor', 'engine.bundle.mjs');

function fail(msg) {
  console.error(`\n  ✗ vercel-dist: ${msg}\n`);
  process.exit(1);
}

if (!statSync(PUB).isDirectory()) fail('public/ is missing');

/* ── 1. the bundle must exist and be newer than every lib/ module ───────── */

let bundleMtime;
try {
  bundleMtime = statSync(BUNDLE).mtimeMs;
} catch {
  fail('public/vendor/engine.bundle.mjs is missing — run `npm run bundle` first');
}

const stale = [];
for (const f of readdirSync(LIB)) {
  if (!f.endsWith('.js')) continue;
  const m = statSync(path.join(LIB, f)).mtimeMs;
  // One second of slack: a checkout can flatten mtimes to the same instant.
  if (m > bundleMtime + 1000) stale.push(f);
}
if (stale.length) {
  fail(`the browser bundle is older than ${stale.join(', ')} — run \`npm run bundle\` and commit the result`);
}

/* ── 2. copy public/ → dist/ ────────────────────────────────────────────── */

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
cpSync(PUB, DIST, { recursive: true });

/* ── 3. stamp the build ─────────────────────────────────────────────────── */

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
let commit = 'unknown';
try {
  commit = readFileSync(path.join(ROOT, '.git', 'HEAD'), 'utf8').trim();
  if (commit.startsWith('ref: ')) {
    const ref = commit.slice(5);
    commit = readFileSync(path.join(ROOT, '.git', ref), 'utf8').trim().slice(0, 12);
  } else {
    commit = commit.slice(0, 12);
  }
} catch { /* shallow or absent .git — leave it as 'unknown' */ }

writeFileSync(
  path.join(DIST, 'VERSION.json'),
  JSON.stringify(
    { name: pkg.name, version: pkg.version, commit, builtAt: new Date().toISOString(), bundleBytes: statSync(BUNDLE).size },
    null,
    2,
  ) + '\n',
);

const files = readdirSync(DIST).length;
console.log(`\n  ✓ dist/  ·  ${files} top-level entries  ·  bundle ${(statSync(BUNDLE).size / 1024).toFixed(1)} KB  ·  ${pkg.version} @ ${commit}\n`);
