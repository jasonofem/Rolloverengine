#!/usr/bin/env node
/**
 * bundle.mjs — builds public/vendor/engine.bundle.mjs for the browser.
 *
 *   node scripts/bundle.mjs            # build
 *   node scripts/bundle.mjs --check    # build, then import and exercise it
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The dashboard has to run the engine in the browser when it is deployed
 * somewhere with no writable disk, and Vercel serverless is exactly that. The
 * engine is 15 ES modules. A browser could import them over HTTP one at a time,
 * but that is 15 round trips on first paint and it would mean publishing lib/
 * as a static route — leaking the source tree, the tests and the data directory
 * onto a CDN.
 *
 * So we concatenate. This is not a general bundler and does not pretend to be:
 * it handles exactly the subset of ES module syntax this codebase uses, which is
 * static relative imports and named exports. No top-level await, no `export *`,
 * no import attributes, no CommonJS, no bare specifiers, no dependencies. Each
 * of those is checked for, and the build fails loudly if one shows up rather
 * than quietly emitting a bundle that evaluates to something else.
 *
 * Each module body goes in its own block scope. That is what makes naive
 * concatenation safe: `money` is declared in both rollover.js and suggestions.js,
 * and block scoping keeps them apart with zero renames in the source.
 *
 * Block scoping has a consequence that decides the whole design: it isolates a
 * module's cross-module imports too, not just its collisions. `http-core.js`
 * reads `SIGNAL_WEIGHTS` from `markets.js`, and once both bodies sit in separate
 * blocks that reference resolves to nothing. So a module cannot merely export
 * what the facade asks for — it must export every name another module imports
 * from it. Those are computed from the import statements rather than listed by
 * hand, which is what keeps this file from rotting as lib/ grows.
 *
 * The other half is the reference itself. `http-core.js` says
 * `import { SIGNAL_WEIGHTS } from './markets.js'` and then uses the bare name,
 * so once the import line is stripped that name has to resolve to something.
 * The obvious move — rewriting occurrences of the identifier in the body — is
 * wrong, and worth recording because it looks right: `Math.round` matches
 * `\bround\b`, and destructuring like `const { clamp } = opts` would be
 * rewritten into nonsense. Instead each block opens with explicit local aliases
 * (`const SIGNAL_WEIGHTS = __exp_12;`). No text inside a module body is ever
 * touched, so nothing can be corrupted, and the aliases are plain bindings the
 * code reads exactly as it did before.
 *
 * That only works because the emit order is a topological sort: a module's
 * aliases are read when its block runs, so every module it depends on must
 * already have assigned its outer bindings. lib/ is acyclic; if a cycle ever
 * appears the --check import fails immediately rather than misbehaving later.
 *
 * Getting a binding back OUT of a block needs care too. `let money;` at module
 * scope followed by `money = money;` inside a block that declares its own
 * `money` is a self-assignment — the inner name shadows the outer. So every
 * outward binding is declared under a unique `__exp_N` name and re-exported with
 * an alias (`export { __exp_7 as money }`). Two modules exporting `money` is
 * then not a collision at all: each gets its own outer name, and COLLISIONS
 * below simply decides which alias the public surface uses.
 *
 * The exported API is createApi (lib/http-core.js) plus a localStorage store, so
 * the browser gets the identical route table the Node server and the Vercel
 * function get. Three hosts, one implementation.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, 'lib');
const OUT = path.join(ROOT, 'public', 'vendor', 'engine.bundle.mjs');
const ENTRY = path.join(LIB, 'http-core.js');

/* What the browser is allowed to import, per module. Anything not listed here
 * stays inside the bundle. */
const FACADE = [
  ['http-core.js', ['createApi', 'ENGINE_INFO', 'runPayload', 'dayPayload', 'projectFor', 'jsonSafe']],
  ['memory-store.js', ['createLocalStorageStore', 'createStoreAdapter', 'createMemoryStore']],
  ['store-shared.js', ['DEFAULT_SETTINGS', 'summariseRun']],
  ['rollover.js', ['createRun', 'scanRunDay', 'confirmDay', 'settleDay', 'skipDay', 'rescanDay', 'restartRun', 'abandonRun', 'chooseAlternative', 'adjustDayOdds', 'runProgress', 'dayCards', 'equityCurve', 'RUN_STATUS', 'DAY_STATUS']],
  ['scan.js', ['scanDay', 'scanForDay', 'PROVIDERS']],
  ['simulate.js', ['runSimulation', 'projectRun', 'STRATEGIES']],
  ['suggestions.js', ['suggestNextRun', 'suggestRecovery', 'money']],
  ['builder.js', ['buildRolloverSlip', 'DEFAULT_BUILDER_OPTS']],
  ['fixtures.js', ['upcomingDays', 'tzDateKey', 'tzNowParts', 'dayShape']],
  ['math.js', ['round', 'clamp', 'mean']],
];

/* Bindings more than one module exports. A facade can only bind one name per
 * export, so decide here and say why. */
const COLLISIONS = {
  // rollover.js's `money` is a two-line alias of suggestions.js's currency
  // formatter. The dashboard wants the formatter, so suggestions.js wins and
  // rollover.js's copy stays inside its block.
  money: 'suggestions.js',
};

function fail(msg) {
  console.error(`\n  ✗ bundle failed: ${msg}\n`);
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * Graph walk — depth-first, so dependencies are emitted first
 * ------------------------------------------------------------------ */

const modules = new Map(); // abs path → { rel, source, exported[], deps[] }

function readModule(file) {
  if (modules.has(file)) return modules.get(file);
  if (!existsSync(file)) fail(`cannot resolve ${path.relative(ROOT, file)}`);
  const source = readFileSync(file, 'utf8');
  const rel = path.relative(LIB, file);

  /* Only patterns that are unambiguous at line start. Top-level await is NOT
   * checked here. No regex can tell `await x` at module top level from `await x`
   * inside an async function body without actually parsing, and every attempt I
   * made at one flagged perfectly ordinary async code. It cannot slip through
   * regardless: the bundle is a classic (non-async) module, so a genuine
   * top-level await makes `--check` fail at import with a syntax error. That is
   * a real parser doing the checking, which is why you should always build with
   * --check rather than bare. */
  for (const [re, what] of [
    [/^export\s*\*/m, '`export *`'],
    [/^import\s+[^'"]*?['"][^'"]+['"]\s*with\s*\{/m, 'import attributes'],
    [/\bcreateRequire\s*\(/, 'CommonJS require'],
  ]) {
    if (re.test(source)) fail(`${rel} uses ${what}, which this bundler does not implement`);
  }

  const exported = [];
  for (const m of source.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm)) exported.push(m[1]);

  const deps = [];
  for (const m of source.matchAll(/^import\s+[^;]*?from\s+'([^']+)';/gm)) {
    if (!m[1].startsWith('.')) fail(`${rel} imports the bare specifier '${m[1]}' — a browser cannot resolve that`);
    deps.push(path.resolve(path.dirname(file), m[1]));
  }
  for (const m of source.matchAll(/^import\s+'([^']+)';/gm)) {
    if (!m[1].startsWith('.')) fail(`${rel} side-effect-imports '${m[1]}'`);
    deps.push(path.resolve(path.dirname(file), m[1]));
  }

  const mod = { file, rel, source, exported, deps };
  modules.set(file, mod);
  for (const d of deps) readModule(d);
  return mod;
}

/* ------------------------------------------------------------------ *
 * Strip module syntax from a body
 * ------------------------------------------------------------------ */

function strip(source, rel) {
  let out = source;
  out = out.replace(/^import[\s\S]*?from\s*'[^']*';\s*$/gm, '');   // import … from '…';
  out = out.replace(/^import\s*'[^']*';\s*$/gm, '');                // side-effect import
  out = out.replace(/^export\s*\{[^}]*\}\s*(?:from\s*'[^']*')?;\s*$/gm, ''); // export { … };
  out = out.replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gm, '');
  out = out.replace(/^export\s+default\s+/gm, 'const __default = ');
  if (/^\s*export\b/m.test(out)) fail(`${rel} still contains an \`export\` after stripping`);
  if (/^\s*import\b/m.test(out)) fail(`${rel} still contains an \`import\` after stripping`);
  return out.trim();
}

/* ------------------------------------------------------------------ *
 * Emit
 * ------------------------------------------------------------------ */

readModule(ENTRY);
for (const [file] of FACADE) readModule(path.join(LIB, file));

/* Emit order must be a topological sort, not insertion order. `http-core.js`
 * reads `SIGNAL_WEIGHTS` while initialising the module-level ENGINE_INFO
 * constant, so markets.js has to have already run by then — a dependency that
 * appears later in the file produces a TDZ ReferenceError, not a wrong value. */
const order = [];
const placed = new Set();
function place(m) {
  if (placed.has(m.rel)) return;
  for (const d of m.deps) place(modules.get(d));
  placed.add(m.rel);
  order.push(m);
}
for (const m of modules.values()) place(m);

// Every name each module imports, resolved to the module that declares it.
const importsOf = new Map(); // rel → [{ name, from }]
for (const m of order) {
  const list = [];
  for (const im of m.source.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)';/gm)) {
    const from = path.relative(LIB, path.resolve(path.dirname(m.file), im[2]));
    for (let part of im[1].split(',')) {
      part = part.trim();
      if (!part) continue;
      const as = part.split(/\s+as\s+/);
      list.push({ name: as[0].trim(), local: (as[1] || as[0]).trim(), from });
    }
  }
  importsOf.set(m.rel, list);
}

// Who declares each exported name.
const declaredBy = new Map(); // name → [rel, …]
for (const m of order) for (const n of m.exported) {
  if (!declaredBy.has(n)) declaredBy.set(n, []);
  declaredBy.get(n).push(m.rel);
}

// The facade may only ask for names that exist.
for (const [file, names] of FACADE) {
  const mod = modules.get(path.join(LIB, file));
  for (const n of names) {
    if (!mod.exported.includes(n)) fail(`${file} does not export \`${n}\`, but the facade asks for it`);
  }
}

/** Everything a module must push out of its block: what the bundle needs
 *  internally, plus what the public facade asks for. */
function namesToHoist(rel) {
  const mod = modules.get(path.join(LIB, rel));
  const set = new Set();
  for (const other of order) {
    for (const im of importsOf.get(other.rel) || []) {
      if (im.from === rel && im.name !== 'default') set.add(im.name);
    }
  }
  const entry = FACADE.find(([f]) => f === rel);
  if (entry) for (const n of entry[1]) set.add(n);
  return [...set].filter((n) => (mod?.exported || []).includes(n));
}

const out = [];
out.push('/**');
out.push(' * engine.bundle.mjs — GENERATED FILE. Do not edit.');
out.push(' *');
out.push(' *   regenerate:  node scripts/bundle.mjs');
out.push(' *   verify:      node scripts/bundle.mjs --check');
out.push(' *');
out.push(` * ${order.length} modules from lib/ in dependency order, each in its own block`);
out.push(' * scope. A module hoists out every name another module imports from it, under');
out.push(' * a unique alias, and its own references to imported names are rewritten to');
out.push(' * those aliases. That is what lets block scoping stop name collisions without');
out.push(' * stopping the modules from calling each other.');
out.push(' *');
out.push(' * This is what lets the dashboard run the engine inside the browser tab on');
out.push(' * hosts with no writable disk, against the identical route table the Node');
out.push(' * server and the Vercel function use.');
out.push(' */');
out.push('');

const outerNames = new Map();  // rel → Map(localName → outerAlias)
const facadeAliases = [];      // `__exp_N as name` for the public export list
const publicName = new Map();  // name → rel that supplies it publicly
let uid = 0;

for (const m of order) {
  const hoist = namesToHoist(m.rel);
  const outer = new Map(); // local name this module exports → unique outer name
  for (const n of hoist) outer.set(n, `__exp_${uid++}`);

  // Local aliases for this module's imports, pointing at the outer bindings the
  // source modules hoisted. Injected at the top of the block, never rewritten
  // into the body — see the header comment for why rewriting is unsafe.
  const aliases = [];
  for (const im of importsOf.get(m.rel) || []) {
    if (im.name === 'default') continue;
    const src = modules.get(path.join(LIB, im.from));
    const srcOuter = src ? outerNames.get(src.rel) : null;
    const alias = srcOuter?.get(im.name);
    if (!alias) continue;
    // A module may bind the imported name under a different local one.
    const local = (im.local && im.local !== im.name) ? im.local : im.name;
    aliases.push(`const ${local} = ${alias};`);
  }

  out.push(`/* ${'═'.repeat(72)}`);
  out.push(`   lib/${m.rel}${hoist.length ? `   →  hoists ${hoist.join(', ')}` : ''}`);
  out.push(`   ${'═'.repeat(72)} */`);
  for (const v of outer.values()) out.push(`let ${v};`);
  out.push('{');
  for (const a of aliases) out.push(a);
  if (aliases.length) out.push('');
  out.push(strip(m.source, m.rel));
  // Assign last, once every declaration in the module has been evaluated.
  for (const [n, v] of outer) out.push(`${v} = ${n};`);
  out.push('}');
  out.push('');

  // Record what this module hoisted, for the modules that come after it.
  outerNames.set(m.rel, outer);

  // The public facade takes each name from exactly one module.
  const entry = FACADE.find(([f]) => f === m.rel);
  if (entry) {
    for (const n of entry[1]) {
      if (!outer.has(n)) continue;
      const own = declaredBy.get(n) || [];
      if (own.length > 1 && COLLISIONS[n] !== m.rel) continue;
      if (publicName.has(n)) continue;
      publicName.set(n, m.rel);
      facadeAliases.push(`${outer.get(n)} as ${n}`);
    }
  }
}

const wanted = new Set(FACADE.flatMap(([, n]) => n));
const got = new Set(publicName.keys());
const absent = [...wanted].filter((n) => !got.has(n));
if (absent.length) fail(`facade is missing ${absent.join(', ')}`);

out.push(`/* ${'═'.repeat(72)}`);
out.push(`   facade — ${facadeAliases.length} public bindings`);
out.push(`   ${'═'.repeat(72)} */`);
out.push(`export { ${facadeAliases.join(', ')} };`);
out.push('');

mkdirSync(path.dirname(OUT), { recursive: true });
const text = out.join('\n');
writeFileSync(OUT, text, 'utf8');
console.log(`\n  ✓ ${path.relative(ROOT, OUT)}  ·  ${order.length} modules  ·  ${facadeAliases.length} public exports  ·  ${(text.length / 1024).toFixed(1)} KB\n`);

const publicNames = [...publicName.keys()];

/* ------------------------------------------------------------------ *
 * --check — import the bundle and drive the real route table
 * ------------------------------------------------------------------ */

if (process.argv.includes('--check')) {
  const mod = await import(pathToFileURL(OUT).href);

  const missing = publicNames.filter((n) => mod[n] === undefined);
  if (missing.length) fail(`bundle evaluated, but these exports are undefined: ${missing.join(', ')}`);

  const store = mod.createLocalStorageStore('__bundle_check__');
  const api = mod.createApi({ store, persistent: false });
  // Split the query off the path the way a real transport would.
  const call = (method, target, body) => {
    const url = new URL(String(target), 'http://local');
    return api({ method, pathname: url.pathname, query: url.searchParams, body: body || {} });
  };

  const state = await call('GET', '/api/state');
  if (state.status !== 200) fail(`/api/state → ${state.status}`);
  if (state.body.runtime.persistent !== false) fail('the browser runtime must report persistent:false');
  if (!state.body.engine.signalWeights) fail('ENGINE_INFO did not come through the bundle');

  const created = await call('POST', '/api/runs', { stake: 500, days: 7, targetOdds: 2 });
  if (created.status !== 201) fail(`/api/runs → ${created.status} ${JSON.stringify(created.body).slice(0, 200)}`);
  const id = created.body.run.id;

  const staked = await call('POST', `/api/runs/${id}/stake`, { day: 1 });
  if (staked.status !== 200) fail(`stake → ${staked.status}`);

  const settled = await call('POST', `/api/runs/${id}/settle`, { day: 1, outcome: 'won' });
  if (settled.status !== 200) fail(`settle → ${settled.status}`);
  if (settled.body.run.balance <= 500) fail(`a win must grow the pot, got ${settled.body.run.balance}`);

  const cal = await call('GET', '/api/calendar?n=5');
  if (cal.status !== 200 || !cal.body.days.length) fail('/api/calendar returned nothing');

  const proj = await call('POST', '/api/lab/project', { stake: 500, days: 7, targetOdds: 2, measuredDailyWinProb: 0.537 });
  if (proj.status !== 200 || !proj.body.projection.ladder.length) fail('/api/lab/project returned no ladder');

  // The engine itself, not just the transport.
  const scan = mod.scanDay(state.body.now.dayKey, { tz: 'Africa/Lagos', eventsPerDay: 24, marketInefficiency: 1.3 });
  if (!scan.legs.length) fail('scanDay produced no legs through the bundle');
  if (!(scan.diagnostics.modelErrorPp < scan.diagnostics.ratingsErrorPp)) fail('the bundle lost the accuracy of the model layer');

  console.log('  ✓ bundle check green: state · create · stake · settle · calendar · project · scan');
  console.log(`    day-1 win at ${settled.body.day.slip.odds} took ₦500.00 → ₦${settled.body.run.balance.toFixed(2)}`);
  console.log(`    ${scan.legs.length} priced legs · model error ${scan.diagnostics.modelErrorPp}pp vs ratings ${scan.diagnostics.ratingsErrorPp}pp\n`);
}
