/**
 * engine.bundle.mjs — GENERATED FILE. Do not edit.
 *
 *   regenerate:  node scripts/bundle.mjs
 *   verify:      node scripts/bundle.mjs --check
 *
 * 15 modules from lib/ in dependency order, each in its own block
 * scope. A module hoists out every name another module imports from it, under
 * a unique alias, and its own references to imported names are rewritten to
 * those aliases. That is what lets block scoping stop name collisions without
 * stopping the modules from calling each other.
 *
 * This is what lets the dashboard run the engine inside the browser tab on
 * hosts with no writable disk, against the identical route table the Node
 * server and the Vercel function use.
 */

/* ════════════════════════════════════════════════════════════════════════
   lib/math.js   →  hoists scoreGrid, sumGrid, overProb, poissonPmf, gaussianTruth, h2hTruth, clamp, round, makeRng, devig, mean, stdev, ev, median, percentile
   ════════════════════════════════════════════════════════════════════════ */
let __exp_0;
let __exp_1;
let __exp_2;
let __exp_3;
let __exp_4;
let __exp_5;
let __exp_6;
let __exp_7;
let __exp_8;
let __exp_9;
let __exp_10;
let __exp_11;
let __exp_12;
let __exp_13;
let __exp_14;
{
/**
 * math.js — deterministic numeric + RNG primitives used across the engine.
 *
 * Everything here is pure and side-effect free. The RNG is seeded (mulberry32)
 * so a given event/day/simulation always resolves identically. That is what
 * makes the Monte-Carlo lab and the test-suite reproducible.
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const round = (v, dp = 2) => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

/** 32-bit string hash (FNV-1a) → seed for mulberry32. */
function hashSeed(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — tiny, fast, good-enough-quality PRNG. */
function makeRng(seed) {
  let a = (typeof seed === 'string' ? hashSeed(seed) : seed >>> 0) || 1;
  const rng = function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.int = (n) => Math.floor(rng() * n);
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  rng.range = (lo, hi) => lo + rng() * (hi - lo);
  rng.chance = (p) => rng() < p;
  rng.gauss = () => {
    // Box–Muller
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  rng.shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  /** Fisher-Yates sample of k distinct items. */
  rng.sample = (arr, k) => rng.shuffle(arr).slice(0, Math.max(0, Math.min(k, arr.length)));
  return rng;
}

/* ------------------------------------------------------------------ *
 * Poisson machinery (football / hockey scorelines)
 * ------------------------------------------------------------------ */

const FACT = [1];
for (let i = 1; i <= 40; i++) FACT[i] = FACT[i - 1] * i;

/** P(X = k) for X ~ Poisson(lambda), k = 0..max */
function poissonPmf(lambda, max = 12) {
  const out = new Array(max + 1);
  const l = Math.max(1e-9, lambda);
  for (let k = 0; k <= max; k++) out[k] = (Math.exp(-l) * l ** k) / FACT[k];
  return out;
}

/** Joint scoreline grid p[i][j] = P(home=i, away=j), normalised to sum 1. */
function scoreGrid(lh, la, max = 12) {
  const ph = poissonPmf(lh, max);
  const pa = poissonPmf(la, max);
  const grid = [];
  let total = 0;
  for (let i = 0; i <= max; i++) {
    const row = new Array(max + 1);
    for (let j = 0; j <= max; j++) {
      row[j] = ph[i] * pa[j];
      total += row[j];
    }
    grid.push(row);
  }
  for (let i = 0; i <= max; i++) for (let j = 0; j <= max; j++) grid[i][j] /= total;
  return grid;
}

function sumGrid(grid, pred) {
  let s = 0;
  for (let i = 0; i < grid.length; i++) for (let j = 0; j < grid[i].length; j++) if (pred(i, j)) s += grid[i][j];
  return s;
}

/** P(home goals + away goals > line) using the two marginals (exact for integer/half lines). */
function overProb(lh, la, line, max = 20) {
  const ph = poissonPmf(lh, max);
  const pa = poissonPmf(la, max);
  let p = 0;
  for (let i = 0; i <= max; i++) {
    for (let j = 0; j <= max; j++) {
      if (i + j > line) p += ph[i] * pa[j];
    }
  }
  return p;
}

/** Normal CDF via Abramowitz–Stegun 7.1.26 (accuracy ~1e-7, plenty here). */
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  let p =
    d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

/** Two-sided normal scoreline model used for basketball / baseball / hockey. */
function gaussianTruth(muHome, muAway, sigma, maxMargin = 60) {
  const mu = muHome - muAway;
  const pH = 1 - normCdf(0.5 / sigma - mu / sigma); // P(margin > 0.5) — no ties in these sports
  const pA = 1 - pH;
  const spread = {};
  for (let s = -maxMargin; s <= maxMargin; s += 0.5) {
    // P(home covers -s): margin + s > 0.5
    spread[s] = 1 - normCdf((0.5 - (mu + s)) / sigma);
  }
  const totalMu = muHome + muAway;
  const totalSigma = sigma * Math.SQRT2;
  const totals = {};
  for (let line = 150; line <= 300; line += 5) {
    totals[line] = 1 - normCdf((line + 0.5 - totalMu) / totalSigma);
  }
  return { pH, pA, spread, totals, totalMu, sigma };
}

/** Logistic head-to-head truth for tennis / MMA / two-outcome markets. */
function h2hTruth(ratingA, ratingB, scale = 8) {
  const pA = 1 / (1 + Math.exp(-(ratingA - ratingB) / scale));
  return { pA: clamp(pA, 0.02, 0.98), pB: clamp(1 - pA, 0.02, 0.98) };
}

/** Shannon entropy (bits) of a probability vector — used as an uncertainty gauge. */
function entropy(probs) {
  let h = 0;
  for (const p of probs) if (p > 0) h -= p * Math.log2(p);
  return h;
}

/* ------------------------------------------------------------------ *
 * Bookmaker arithmetic
 * ------------------------------------------------------------------ */

/** Decimal odds → implied probability (with the vig still in it). */
const impliedProb = (odds) => 1 / odds;

/**
 * Remove the overround from a set of prices.
 * Returns fair probabilities that sum to 1, plus the book's overround.
 *
 * Method: multiplicative de-vig (the "power" method is overkill here).
 */
function devig(oddsList) {
  const impl = oddsList.map(impliedProb);
  const sum = impl.reduce((a, b) => a + b, 0);
  return {
    fair: impl.map((p) => p / sum),
    overround: sum - 1,
    payout: 1 / sum,
  };
}

/** Fair (no-vig) decimal odds from a probability. */
const fairOdds = (p) => (p > 0 ? 1 / p : Infinity);

/** Expected value per unit staked at `odds` with true/model probability `p`. */
const ev = (p, odds) => p * (odds - 1) - (1 - p);

/**
 * Kelly fraction for a single binary bet.
 * b = net decimal odds (odds - 1). Clamped to [0, cap].
 */
function kelly(p, odds, cap = 0.25) {
  const b = odds - 1;
  const q = 1 - p;
  const f = (b * p - q) / b;
  return clamp(f, 0, cap);
}

/** Fractional-Kelly stake sizing helper. */
const kellyStake = (bankroll, p, odds, fraction = 0.25, cap = 0.1) =>
  round(bankroll * kelly(p, odds, cap) * fraction, 2);

/** Decimal → approximate fractional odds string (for slip display). */
function toFractional(decimal) {
  const d = decimal - 1;
  if (d <= 0) return '0/1';
  const denoms = [1, 2, 4, 5, 10, 20];
  let best = null;
  for (const den of denoms) {
    const num = Math.round(d * den);
    if (num <= 0) continue;
    const err = Math.abs(num / den - d);
    if (!best || err < best.err) best = { num, den, err };
  }
  if (!best) return d.toFixed(2) + '/1';
  const g = gcd(best.num, best.den);
  return `${best.num / g}/${best.den / g}`;
}

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

/* ------------------------------------------------------------------ *
 * Vectors / stats
 * ------------------------------------------------------------------ */

/** Convex blend of probability vectors, renormalised to sum 1. */
function blendVectors(vectors, weights) {
  const n = vectors[0].length;
  const out = new Array(n).fill(0);
  let wsum = 0;
  vectors.forEach((v, i) => {
    const w = weights[i] ?? 0;
    wsum += w;
    for (let k = 0; k < n; k++) out[k] += (v[k] ?? 0) * w;
  });
  const total = out.reduce((a, b) => a + b, 0) || 1;
  return out.map((x) => x / total);
}

const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

const stdev = (arr) => {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((x) => (x - m) ** 2)));
};

const percentile = (arr, p) => {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const idx = clamp(Math.floor(p * s.length), 0, s.length - 1);
  return s[idx];
};

const median = (arr) => percentile(arr, 0.5);
__exp_0 = scoreGrid;
__exp_1 = sumGrid;
__exp_2 = overProb;
__exp_3 = poissonPmf;
__exp_4 = gaussianTruth;
__exp_5 = h2hTruth;
__exp_6 = clamp;
__exp_7 = round;
__exp_8 = makeRng;
__exp_9 = devig;
__exp_10 = mean;
__exp_11 = stdev;
__exp_12 = ev;
__exp_13 = median;
__exp_14 = percentile;
}

/* ════════════════════════════════════════════════════════════════════════
   lib/model.js   →  hoists modelTruth, simulateResult
   ════════════════════════════════════════════════════════════════════════ */
let __exp_15;
let __exp_16;
{
const scoreGrid = __exp_0;
const sumGrid = __exp_1;
const overProb = __exp_2;
const poissonPmf = __exp_3;
const gaussianTruth = __exp_4;
const h2hTruth = __exp_5;
const clamp = __exp_6;
const round = __exp_7;

/**
 * model.js — turns team/player ratings into *true* outcome probabilities,
 * then expands those into the full market tree for an event.
 *
 * Sport-specific truth models:
 *   football  → independent Poisson scoreline grid (bivariate-ish via joint pmf)
 *   basketball/baseball/hockey → gaussian margin model (no ties)
 *   tennis/MMA → logistic head-to-head on skill index
 *
 * The output of this module is the "ground truth" that the rest of the engine
 * compares bookmaker prices against. That difference is the edge.
 */


const HOME_ADV = {
  football: 1.16,
  basketball: 2.4, // points
  baseball: 0.28, // runs
  hockey: 0.35,
  tennis: 0,
  mma: 0,
};

/**
 * Compute the truth vector + derived markets for an event.
 * @param {object} event  { sport, league:{base,sigma}, home:{att,def,rtg}, away:{...}, neutral? }
 * @returns {truth: [{key,label,p}], markets: [{key,name,type,line,outcomes:[{key,label,p}]}]}
 */
function modelTruth(event) {
  const sport = event.sport;
  if (sport === 'football') return footballTruth(event);
  if (sport === 'basketball' || sport === 'baseball' || sport === 'hockey') return gaussianSportTruth(event, sport);
  if (sport === 'tennis' || sport === 'mma') return h2hSportTruth(event, sport);
  throw new Error(`modelTruth: unsupported sport "${sport}"`);
}

/* ------------------------------------------------------------------ */

function footballTruth(event) {
  const base = event.league.base ?? 1.35;
  const adv = event.neutral ? 1.0 : HOME_ADV.football;
  const lh = clamp(base * event.home.att * event.away.def * adv, 0.12, 5.0);
  const la = clamp(base * event.away.att * event.home.def, 0.1, 4.5);

  const grid = scoreGrid(lh, la);
  const pH = sumGrid(grid, (i, j) => i > j);
  const pD = sumGrid(grid, (i, j) => i === j);
  const pA = sumGrid(grid, (i, j) => i < j);

  const pOver = (line) => overProb(lh, la, line);
  const ph = poissonPmf(lh, 12);
  const pa = poissonPmf(la, 12);
  const pHomeOver = (line) => ph.slice(Math.floor(line) + 1).reduce((a, b) => a + b, 0);
  const pAwayOver = (line) => pa.slice(Math.floor(line) + 1).reduce((a, b) => a + b, 0);
  const pBTTS = (1 - ph[0]) * (1 - pa[0]);

  // most likely exact score, for display flavour
  let topScore = { i: 1, j: 1, p: 0 };
  for (let i = 0; i <= 6; i++)
    for (let j = 0; j <= 6; j++) if (grid[i][j] > topScore.p) topScore = { i, j, p: grid[i][j] };

  const markets = [
    {
      key: 'h2h',
      name: 'Match Result',
      type: 'result',
      outcomes: [
        { key: 'home', label: `${event.home.name} to win`, p: pH },
        { key: 'draw', label: 'Draw', p: pD },
        { key: 'away', label: `${event.away.name} to win`, p: pA },
      ],
    },
    {
      key: 'ou25',
      name: 'Total Goals Over/Under 2.5',
      type: 'totals',
      line: 2.5,
      outcomes: [
        { key: 'over', label: 'Over 2.5 goals', p: pOver(2.5) },
        { key: 'under', label: 'Under 2.5 goals', p: 1 - pOver(2.5) },
      ],
    },
    {
      key: 'btts',
      name: 'Both Teams To Score',
      type: 'btts',
      outcomes: [
        { key: 'yes', label: 'BTTS — Yes', p: pBTTS },
        { key: 'no', label: 'BTTS — No', p: 1 - pBTTS },
      ],
    },
  ];

  // Asian handicap — only offered when the match is not near a coin flip,
  // which is exactly how real books behave.
  const spread = spreadFromProb(pH, pA);
  if (spread) {
    const hp = handicapProb(grid, spread);
    markets.push({
      key: `ah${spread}`,
      name: `Asian Handicap ${spread > 0 ? '+' : ''}${spread}`,
      type: 'handicap',
      line: spread,
      outcomes: [
        { key: 'home', label: `${event.home.name} ${spread > 0 ? '+' : ''}${spread}`, p: hp },
        { key: 'away', label: `${event.away.name} ${spread > 0 ? -spread : +(-spread) * -1}`, p: 1 - hp },
      ],
    });
  }

  // Double chance — the classic rollover "safety" leg.
  markets.push({
    key: 'dc',
    name: 'Double Chance',
    type: 'double_chance',
    outcomes: [
      { key: '1x', label: `${event.home.name} or Draw`, p: pH + pD },
      { key: '12', label: `${event.home.name} or ${event.away.name}`, p: pH + pA },
      { key: 'x2', label: `Draw or ${event.away.name}`, p: pD + pA },
    ],
  });

  // Team goals.
  markets.push({
    key: 'htg15',
    name: `${event.home.name} Total Goals`,
    type: 'team_total',
    line: 1.5,
    team: 'home',
    outcomes: [
      { key: 'over', label: `${event.home.name} over 1.5`, p: pHomeOver(1.5) },
      { key: 'under', label: `${event.home.name} under 1.5`, p: 1 - pHomeOver(1.5) },
    ],
  });
  markets.push({
    key: 'atg15',
    name: `${event.away.name} Total Goals`,
    type: 'team_total',
    line: 1.5,
    team: 'away',
    outcomes: [
      { key: 'over', label: `${event.away.name} over 1.5`, p: pAwayOver(1.5) },
      { key: 'under', label: `${event.away.name} under 1.5`, p: 1 - pAwayOver(1.5) },
    ],
  });

  return {
    truth: [
      { key: 'home', label: `${event.home.name} to win`, p: pH },
      { key: 'draw', label: 'Draw', p: pD },
      { key: 'away', label: `${event.away.name} to win`, p: pA },
    ],
    markets,
    meta: { expectedHome: round(lh, 2), expectedAway: round(la, 2), likelyScore: `${topScore.i}-${topScore.j}` },
  };
}

/** Pick a handicap line that roughly balances the market. */
function spreadFromProb(pH, pA) {
  const diff = pH - pA;
  if (Math.abs(diff) < 0.22) return null; // near coin flip → books still post a line, but we skip it
  if (diff > 0) return -Math.min(2.5, Math.max(0.25, Math.round(diff * 3.4) * 0.25));
  return Math.min(2.5, Math.max(0.25, Math.round(-diff * 3.4) * 0.25));
}

/** P(home goals + handicap > away goals), half-ball lines have no push. */
function handicapProb(grid, handicap) {
  return sumGrid(grid, (i, j) => i + handicap > j);
}

/* ------------------------------------------------------------------ */

function gaussianSportTruth(event, sport) {
  const base = event.league.base;
  const sigma = event.league.sigma;
  const adv = event.neutral ? 0 : HOME_ADV[sport] ?? 0;
  const muHome = clamp(base + event.home.rtg - event.away.rtg + adv, base * 0.55, base * 1.5);
  const muAway = clamp(base + event.away.rtg - event.home.rtg, base * 0.55, base * 1.5);

  const t = gaussianTruth(muHome, muAway, sigma);
  const markets = [
    {
      key: 'h2h',
      name: sport === 'baseball' ? 'Moneyline' : 'Match Winner',
      type: 'result2',
      outcomes: [
        { key: 'home', label: `${event.home.name} to win`, p: t.pH },
        { key: 'away', label: `${event.away.name} to win`, p: t.pA },
      ],
    },
  ];

  // Point/run line: the number closest to a pick'em given the projected margin.
  const margin = muHome - muAway;
  const lineKeys = Object.keys(t.spread).map(Number);
  const bestLine = lineKeys.reduce((a, b) => (Math.abs(t.spread[b] - 0.5) < Math.abs(t.spread[a] - 0.5) ? b : a));
  markets.push({
    key: `line${bestLine}`,
    name: `${sport === 'baseball' ? 'Run' : 'Point'} Line ${bestLine > 0 ? '+' : ''}${bestLine}`,
    type: 'handicap',
    line: bestLine,
    outcomes: [
      { key: 'home', label: `${event.home.name} ${bestLine > 0 ? '+' : ''}${bestLine}`, p: t.spread[bestLine] },
      { key: 'away', label: `${event.away.name} ${bestLine > 0 ? -bestLine : +bestLine * -1}`, p: 1 - t.spread[bestLine] },
    ],
  });

  const totalKeys = Object.keys(t.totals).map(Number).filter((l) => Math.abs(l - t.totalMu) < 18);
  const totalLine = totalKeys.length
    ? totalKeys.reduce((a, b) => (Math.abs(b - t.totalMu) < Math.abs(a - t.totalMu) ? b : a))
    : Math.round(t.totalMu / 5) * 5;
  const pOverTotal = 1 - normCdfLocal((totalLine + 0.5 - t.totalMu) / (sigma * Math.SQRT2));
  markets.push({
    key: `total${totalLine}`,
    name: `Total ${sport === 'baseball' ? 'Runs' : 'Points'} ${totalLine}`,
    type: 'totals',
    line: totalLine,
    outcomes: [
      { key: 'over', label: `Over ${totalLine}`, p: pOverTotal },
      { key: 'under', label: `Under ${totalLine}`, p: 1 - pOverTotal },
    ],
  });

  return {
    truth: [
      { key: 'home', label: `${event.home.name} to win`, p: t.pH },
      { key: 'away', label: `${event.away.name} to win`, p: t.pA },
    ],
    markets,
    meta: { projectedMargin: round(margin, 1), projectedTotal: round(t.totalMu, 1) },
  };
}

function normCdfLocal(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

/* ------------------------------------------------------------------ */

function h2hSportTruth(event, sport) {
  const scale = event.league.scale ?? 7.5;
  const t = h2hTruth(event.home.rtg, event.away.rtg, scale);
  return {
    truth: [
      { key: 'home', label: `${event.home.name} to win`, p: t.pA },
      { key: 'away', label: `${event.away.name} to win`, p: t.pB },
    ],
    markets: [
      {
        key: 'h2h',
        name: sport === 'mma' ? 'Fight Winner' : 'Match Winner',
        type: 'result2',
        outcomes: [
          { key: 'home', label: `${event.home.name} to win`, p: t.pA },
          { key: 'away', label: `${event.away.name} to win`, p: t.pB },
        ],
      },
    ],
    meta: { skillGap: round(event.home.rtg - event.away.rtg, 1) },
  };
}

/* ------------------------------------------------------------------ *
 * Result simulation — deterministic per (event, seed)
 * ------------------------------------------------------------------ */

/**
 * Simulate the actual result of an event and resolve EVERY market from that
 * single scoreline. One truth per event → a multi-leg slip on the same match
 * can never be internally inconsistent (you can't "win" Over 2.5 and lose
 * Over 1.5 on the same game).
 *
 * @returns {object} { score, winners: { marketKey: Set<outcomeKey> }, summary }
 */
function simulateResult(event, rng) {
  const sport = event.sport;
  const winners = {};

  if (sport === 'football') {
    const base = event.league.base ?? 1.35;
    const adv = event.neutral ? 1.0 : HOME_ADV.football;
    const lh = clamp(base * event.home.att * event.away.def * adv, 0.12, 5.0);
    const la = clamp(base * event.away.att * event.home.def, 0.1, 4.5);
    const hg = samplePoisson(lh, rng);
    const ag = samplePoisson(la, rng);
    for (const m of event.markets) {
      if (m.type === 'result') winners[m.key] = new Set([hg > ag ? 'home' : hg === ag ? 'draw' : 'away']);
      else if (m.type === 'totals') winners[m.key] = new Set([hg + ag > m.line ? 'over' : 'under']);
      else if (m.type === 'btts') winners[m.key] = new Set([hg > 0 && ag > 0 ? 'yes' : 'no']);
      else if (m.type === 'handicap') winners[m.key] = new Set([hg + m.line > ag ? 'home' : 'away']);
      else if (m.type === 'double_chance') {
        const s = new Set();
        if (hg > ag) s.add('1x'), s.add('12');
        if (hg === ag) s.add('1x'), s.add('x2');
        if (hg < ag) s.add('x2'), s.add('12');
        winners[m.key] = s;
      } else if (m.type === 'team_total') {
        const g = m.team === 'home' ? hg : ag;
        winners[m.key] = new Set([g > m.line ? 'over' : 'under']);
      }
    }
    return {
      score: { home: hg, away: ag },
      display: `${hg} - ${ag}`,
      winners,
      summary: hg > ag ? `${event.home.name} won ${hg}-${ag}` : hg === ag ? `Draw ${hg}-${ag}` : `${event.away.name} won ${ag}-${hg}`,
    };
  }

  if (sport === 'basketball' || sport === 'baseball' || sport === 'hockey') {
    const base = event.league.base;
    const sigma = event.league.sigma;
    const adv = event.neutral ? 0 : HOME_ADV[sport] ?? 0;
    const muHome = clamp(base + event.home.rtg - event.away.rtg + adv, base * 0.55, base * 1.5);
    const muAway = clamp(base + event.away.rtg - event.home.rtg, base * 0.55, base * 1.5);
    // sample two correlated-ish normals via the margin + total
    const margin = (muHome - muAway) + sigma * rng.gauss();
    const total = (muHome + muAway) + sigma * Math.SQRT2 * rng.gauss();
    let hg = (total + margin) / 2;
    let ag = (total - margin) / 2;
    if (sport === 'baseball') {
      hg = Math.max(0, Math.round(hg));
      ag = Math.max(0, Math.round(ag));
      if (hg === ag) (rng.chance(0.5) ? hg++ : ag++); // no ties in baseball
    } else {
      hg = Math.max(20, Math.round(hg));
      ag = Math.max(20, Math.round(ag));
      if (hg === ag) (rng.chance(0.5) ? hg++ : ag++);
    }
    for (const m of event.markets) {
      if (m.type === 'result2') winners[m.key] = new Set([hg > ag ? 'home' : 'away']);
      else if (m.type === 'handicap') winners[m.key] = new Set([hg + m.line > ag ? 'home' : 'away']);
      else if (m.type === 'totals') winners[m.key] = new Set([hg + ag > m.line ? 'over' : 'under']);
    }
    return {
      score: { home: hg, away: ag },
      display: `${hg} - ${ag}`,
      winners,
      summary: hg > ag ? `${event.home.name} won ${hg}-${ag}` : `${event.away.name} won ${ag}-${hg}`,
    };
  }

  // tennis / mma
  const scale = event.league.scale ?? 7.5;
  const t = h2hTruth(event.home.rtg, event.away.rtg, scale);
  const homeWon = rng() < t.pA;
  for (const m of event.markets) {
    if (m.type === 'result2') winners[m.key] = new Set([homeWon ? 'home' : 'away']);
  }
  return {
    score: null,
    display: homeWon ? `${event.home.name} wins` : `${event.away.name} wins`,
    winners,
    summary: homeWon ? `${event.home.name} won` : `${event.away.name} won`,
  };
}

/** Inverse-CDF Poisson sampler (small lambda → few iterations). */
function samplePoisson(lambda, rng) {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L && k < 30);
  return k - 1;
}

/** Resolve a specific market/outcome from an already-simulated result. */
function isWinner(result, marketKey, outcomeKey) {
  const set = result?.winners?.[marketKey];
  if (!set) return false;
  return set.has ? set.has(outcomeKey) : Array.from(set).includes(outcomeKey);
}
__exp_15 = modelTruth;
__exp_16 = simulateResult;
}

/* ════════════════════════════════════════════════════════════════════════
   lib/ratings.js   →  hoists RATINGS
   ════════════════════════════════════════════════════════════════════════ */
let __exp_17;
{
/**
 * ratings.js — the ratings seed, as a plain ES module.
 *
 * This used to be ratings.json loaded through node:module createRequire. That
 * works in Node and nowhere else: a Vercel serverless bundle and a browser
 * bundle both have to resolve it too, and JSON import attributes are not
 * supported consistently across the bundlers involved. Exporting the same data
 * from a .js module needs no import attributes, no loader hooks and no build
 * step, and it behaves identically in all three environments.
 *
 * Content is byte-for-byte the old JSON seed (verified by round-tripping
 * JSON.stringify before the .json file was deleted, so there is one source of
 * truth rather than two that can drift). Numbers are a starting prior — the
 * engine blends them with live market consensus at 8% weight, so a stale rating
 * degrades gracefully instead of breaking the model.
 */

const RATINGS = {
  "_about": "RolloverEngine ratings seed. Football: att = attacking strength, def = defensive vulnerability (1.0 = league average, higher def = leakier). Basketball/baseball: rtg = points/runs per game better than league average. Tennis/MMA: rtg = 0-100 skill index. These are a starting prior — the engine blends them with live market consensus, so a stale rating degrades gracefully instead of breaking the model.",
  "football": [
    {
      "code": "EPL",
      "name": "Premier League",
      "country": "England",
      "base": 1.42,
      "tier": 1,
      "noise": 0.05,
      "teams": [
        ["Manchester City", "MCI", 1.62, 0.74],
        ["Arsenal", "ARS", 1.5, 0.7],
        ["Liverpool", "LIV", 1.58, 0.82],
        ["Chelsea", "CHE", 1.34, 0.92],
        ["Tottenham", "TOT", 1.38, 1.02],
        ["Manchester United", "MUN", 1.16, 1.02],
        ["Newcastle", "NEW", 1.34, 0.9],
        ["Aston Villa", "AVL", 1.34, 1.02],
        ["Brighton", "BHA", 1.24, 1],
        ["West Ham", "WHU", 1.02, 1.08],
        ["Crystal Palace", "CRY", 1.08, 0.94],
        ["Brentford", "BRE", 1.2, 1.12],
        ["Fulham", "FUL", 1.08, 0.98],
        ["Bournemouth", "BOU", 1.22, 1.04],
        ["Wolves", "WOL", 0.94, 1.1],
        ["Everton", "EVE", 0.88, 0.96],
        ["Nottingham Forest", "NFO", 1.02, 0.9],
        ["Leeds", "LEE", 0.98, 1.14],
        ["Burnley", "BUR", 0.82, 1.16],
        ["Sunderland", "SUN", 0.9, 1.06],
      ],
    },
    {
      "code": "LALIGA",
      "name": "La Liga",
      "country": "Spain",
      "base": 1.3,
      "tier": 1,
      "noise": 0.05,
      "teams": [
        ["Real Madrid", "RMA", 1.66, 0.76],
        ["Barcelona", "BAR", 1.72, 0.92],
        ["Atlético Madrid", "ATM", 1.28, 0.74],
        ["Athletic Club", "ATH", 1.18, 0.84],
        ["Real Sociedad", "RSO", 1.02, 0.92],
        ["Villarreal", "VIL", 1.24, 1.04],
        ["Real Betis", "BET", 1.1, 0.98],
        ["Sevilla", "SEV", 0.94, 1.02],
        ["Valencia", "VAL", 0.94, 1.06],
        ["Girona", "GIR", 1.06, 1.1],
        ["Osasuna", "OSA", 0.92, 1],
        ["Celta Vigo", "CEL", 1.06, 1.12],
        ["Rayo Vallecano", "RAY", 0.92, 0.96],
        ["Getafe", "GET", 0.8, 0.92],
        ["Mallorca", "MLL", 0.82, 0.96],
        ["Alavés", "ALA", 0.86, 1.04],
        ["Espanyol", "ESP", 0.86, 1.08],
        ["Levante", "LEV", 0.88, 1.14],
        ["Elche", "ELC", 0.84, 1.06],
        ["Real Oviedo", "OVI", 0.76, 1.08],
      ],
    },
    {
      "code": "SERIEA",
      "name": "Serie A",
      "country": "Italy",
      "base": 1.34,
      "tier": 1,
      "noise": 0.05,
      "teams": [
        ["Inter", "INT", 1.56, 0.76],
        ["Juventus", "JUV", 1.22, 0.78],
        ["AC Milan", "MIL", 1.38, 0.98],
        ["Napoli", "NAP", 1.32, 0.82],
        ["Atalanta", "ATA", 1.5, 1.02],
        ["Roma", "ROM", 1.22, 0.9],
        ["Lazio", "LAZ", 1.18, 0.98],
        ["Fiorentina", "FIO", 1.16, 1.02],
        ["Bologna", "BOL", 1.1, 0.92],
        ["Torino", "TOR", 0.92, 0.98],
        ["Udinese", "UDI", 0.94, 1.04],
        ["Genoa", "GEN", 0.86, 1.02],
        ["Como", "COM", 1.02, 1],
        ["Cagliari", "CAG", 0.88, 1.1],
        ["Lecce", "LEC", 0.76, 1.06],
        ["Parma", "PAR", 0.86, 1.08],
        ["Hellas Verona", "VER", 0.84, 1.16],
        ["Sassuolo", "SAS", 0.92, 1.14],
        ["Cremonese", "CRE", 0.8, 1.08],
        ["Pisa", "PIS", 0.74, 1.06],
      ],
    },
    {
      "code": "BUNDES",
      "name": "Bundesliga",
      "country": "Germany",
      "base": 1.58,
      "tier": 1,
      "noise": 0.05,
      "teams": [
        ["Bayern München", "BAY", 1.86, 0.8],
        ["Leverkusen", "LEV", 1.52, 0.92],
        ["Dortmund", "BVB", 1.5, 1.02],
        ["RB Leipzig", "RBL", 1.34, 0.96],
        ["Eintracht Frankfurt", "SGE", 1.34, 1.1],
        ["Stuttgart", "VFB", 1.3, 1.08],
        ["Freiburg", "SCF", 1.06, 1],
        ["Hoffenheim", "TSG", 1.16, 1.18],
        ["Wolfsburg", "WOB", 1.08, 1.12],
        ["Mönchengladbach", "BMG", 1.04, 1.16],
        ["Mainz", "M05", 1, 0.98],
        ["Werder Bremen", "SVW", 1.1, 1.24],
        ["Augsburg", "FCA", 0.92, 1.14],
        ["Union Berlin", "FCU", 0.84, 1.02],
        ["St. Pauli", "STP", 0.8, 1.06],
        ["Köln", "KOE", 0.94, 1.2],
        ["Heidenheim", "FCH", 0.9, 1.22],
        ["Hamburg", "HSV", 0.96, 1.18],
      ],
    },
    {
      "code": "LIGUE1",
      "name": "Ligue 1",
      "country": "France",
      "base": 1.38,
      "tier": 1,
      "noise": 0.05,
      "teams": [
        ["Paris SG", "PSG", 1.78, 0.76],
        ["Monaco", "MON", 1.34, 1],
        ["Marseille", "OM", 1.38, 1],
        ["Lille", "LIL", 1.16, 0.9],
        ["Lyon", "LYO", 1.3, 1.06],
        ["Nice", "NIC", 1.06, 0.9],
        ["Lens", "RCL", 1.1, 0.94],
        ["Rennes", "REN", 1.1, 1.06],
        ["Strasbourg", "STR", 1.06, 1.06],
        ["Toulouse", "TFC", 0.98, 1],
        ["Nantes", "NAN", 0.86, 1.08],
        ["Brest", "BRE", 1.02, 1.12],
        ["Le Havre", "HAC", 0.84, 1.12],
        ["Angers", "ANG", 0.82, 1.1],
        ["Auxerre", "AJA", 0.9, 1.14],
        ["Metz", "MET", 0.78, 1.18],
        ["Lorient", "FCL", 0.88, 1.16],
        ["Paris FC", "PFC", 0.9, 1.1],
      ],
    },
    {
      "code": "ERE",
      "name": "Eredivisie",
      "country": "Netherlands",
      "base": 1.66,
      "tier": 2,
      "noise": 0.07,
      "teams": [
        ["Ajax", "AJA", 1.6, 0.9],
        ["PSV", "PSV", 1.86, 0.8],
        ["Feyenoord", "FEY", 1.52, 0.92],
        ["AZ Alkmaar", "AZ", 1.34, 1],
        ["Twente", "TWE", 1.24, 1],
        ["Utrecht", "UTR", 1.2, 1.04],
        ["Go Ahead Eagles", "GAE", 1.02, 1.06],
        ["NEC", "NEC", 1.06, 1.1],
        ["Heerenveen", "HEE", 1, 1.14],
        ["Sparta Rotterdam", "SPA", 0.94, 1.1],
        ["Groningen", "GRO", 0.92, 1.12],
        ["Fortuna Sittard", "FOR", 0.86, 1.14],
        ["PEC Zwolle", "PEC", 0.88, 1.18],
        ["Volendam", "VOL", 0.9, 1.28],
        ["Excelsior", "EXC", 0.84, 1.24],
        ["NAC Breda", "NAC", 0.82, 1.2],
        ["Telstar", "TEL", 0.76, 1.18],
        ["Heracles", "HER", 0.84, 1.26],
      ],
    },
    {
      "code": "LIGAP",
      "name": "Liga Portugal",
      "country": "Portugal",
      "base": 1.36,
      "tier": 2,
      "noise": 0.07,
      "teams": [
        ["Benfica", "BEN", 1.62, 0.8],
        ["Porto", "POR", 1.56, 0.78],
        ["Sporting CP", "SCP", 1.72, 0.76],
        ["Braga", "BRA", 1.3, 0.96],
        ["Vitória SC", "VSC", 1.08, 1],
        ["Moreirense", "MOR", 0.92, 1],
        ["Famalicão", "FAM", 0.98, 0.98],
        ["Gil Vicente", "GIL", 0.9, 1.04],
        ["Estoril", "EST", 0.92, 1.1],
        ["Arouca", "ARO", 0.88, 1.14],
        ["Casa Pia", "CAS", 0.82, 1.06],
        ["Rio Ave", "RIO", 0.84, 1.1],
        ["Santa Clara", "STA", 0.86, 1.04],
        ["Nacional", "NAC", 0.8, 1.12],
        ["AVS", "AVS", 0.74, 1.16],
        ["Estrela Amadora", "AMA", 0.78, 1.14],
        ["Alverca", "ALV", 0.76, 1.12],
        ["Tondela", "TON", 0.72, 1.14],
      ],
    },
    {
      "code": "SPFL",
      "name": "Scottish Premiership",
      "country": "Scotland",
      "base": 1.48,
      "tier": 2,
      "noise": 0.08,
      "teams": [
        ["Celtic", "CEL", 1.9, 0.72],
        ["Rangers", "RAN", 1.66, 0.8],
        ["Hearts", "HEA", 1.16, 0.94],
        ["Hibernian", "HIB", 1.06, 1.02],
        ["Aberdeen", "ABE", 1.02, 1.06],
        ["Dundee United", "DUN", 0.94, 1.06],
        ["Motherwell", "MOT", 0.92, 1.08],
        ["Kilmarnock", "KIL", 0.9, 1.04],
        ["St Mirren", "STM", 0.82, 1.08],
        ["Dundee", "DDD", 0.84, 1.16],
        ["Falkirk", "FAL", 0.8, 1.14],
        ["Livingston", "LIV", 0.76, 1.12],
      ],
    },
    {
      "code": "SULIG",
      "name": "Süper Lig",
      "country": "Türkiye",
      "base": 1.46,
      "tier": 2,
      "noise": 0.09,
      "teams": [
        ["Galatasaray", "GAL", 1.72, 0.82],
        ["Fenerbahçe", "FEN", 1.66, 0.84],
        ["Beşiktaş", "BES", 1.34, 0.98],
        ["Trabzonspor", "TRA", 1.26, 1],
        ["Samsunspor", "SAM", 1.1, 0.98],
        ["Başakşehir", "BAS", 1.08, 1.02],
        ["Göztepe", "GOZ", 1, 0.96],
        ["Konyaspor", "KON", 0.96, 1.06],
        ["Rizespor", "RIZ", 0.94, 1.12],
        ["Antalyaspor", "ANT", 0.92, 1.1],
        ["Alanyaspor", "ALA", 0.94, 1.08],
        ["Kasımpaşa", "KAS", 0.9, 1.16],
        ["Gaziantep FK", "GAZ", 0.88, 1.12],
        ["Kayserispor", "KAY", 0.86, 1.18],
        ["Eyüpspor", "EYU", 0.88, 1.14],
        ["Kocaelispor", "KOC", 0.82, 1.14],
        ["Gençlerbirliği", "GEN", 0.8, 1.16],
        ["Karagümrük", "KAR", 0.84, 1.2],
      ],
    },
    {
      "code": "BRSA",
      "name": "Brasileirão Série A",
      "country": "Brazil",
      "base": 1.16,
      "tier": 2,
      "noise": 0.07,
      "teams": [
        ["Flamengo", "FLA", 1.56, 0.78],
        ["Palmeiras", "PAL", 1.42, 0.74],
        ["Botafogo", "BOT", 1.28, 0.88],
        ["São Paulo", "SAO", 1.1, 0.9],
        ["Corinthians", "COR", 1.06, 0.96],
        ["Cruzeiro", "CRU", 1.22, 0.86],
        ["Atlético Mineiro", "CAM", 1.2, 1],
        ["Fluminense", "FLU", 1.08, 0.94],
        ["Grêmio", "GRE", 1, 1.02],
        ["Internacional", "INT", 1.06, 0.98],
        ["Bahia", "BAH", 1.14, 0.96],
        ["Fortaleza", "FOR", 1.04, 1],
        ["Vasco da Gama", "VAS", 0.96, 1.04],
        ["Bragantino", "BRA", 1.02, 1.06],
        ["Santos", "SAN", 0.98, 1.06],
        ["Ceará", "CEA", 0.86, 1.02],
        ["Vitória", "VIT", 0.84, 1.06],
        ["Mirassol", "MIR", 0.94, 0.98],
        ["Juventude", "JUV", 0.86, 1.12],
        ["Sport Recife", "SPO", 0.78, 1.08],
      ],
    },
    {
      "code": "ARGP",
      "name": "Liga Profesional",
      "country": "Argentina",
      "base": 1.12,
      "tier": 2,
      "noise": 0.08,
      "teams": [
        ["Boca Juniors", "BOC", 1.24, 0.94],
        ["River Plate", "RIV", 1.36, 0.88],
        ["Racing Club", "RAC", 1.2, 0.98],
        ["Independiente", "IND", 1.02, 1],
        ["San Lorenzo", "SLO", 0.94, 0.96],
        ["Vélez Sarsfield", "VEL", 1.14, 0.92],
        ["Estudiantes", "EST", 1.1, 0.94],
        ["Argentinos Juniors", "AAJ", 1.02, 0.98],
        ["Talleres", "TAL", 1.08, 1],
        ["Rosario Central", "ROS", 1.06, 0.96],
        ["Newell's Old Boys", "NOB", 0.92, 1],
        ["Lanús", "LAN", 1.04, 0.98],
        ["Huracán", "HUR", 0.94, 0.94],
        ["Belgrano", "BEL", 0.92, 1.02],
        ["Banfield", "BAN", 0.88, 1.02],
        ["Tigre", "TIG", 0.88, 1.04],
        ["Unión", "UNI", 0.86, 1],
        ["Defensa y Justicia", "DYJ", 0.96, 1.06],
        ["Central Córdoba", "CCA", 0.84, 1.04],
        ["Instituto", "INS", 0.86, 1.06],
      ],
    },
    {
      "code": "NPFL",
      "name": "Nigeria Premier League",
      "country": "Nigeria",
      "base": 1.1,
      "tier": 3,
      "noise": 0.12,
      "teams": [
        ["Enyimba", "ENY", 1.38, 0.86],
        ["Rivers United", "RIV", 1.34, 0.84],
        ["Remo Stars", "REM", 1.3, 0.86],
        ["Rangers Intl", "RAN", 1.2, 0.9],
        ["Plateau United", "PLA", 1.14, 0.94],
        ["Enugu Rangers", "ENG", 1.1, 0.96],
        ["Kano Pillars", "KAN", 1.12, 1],
        ["Shooting Stars", "SHO", 1.06, 0.98],
        ["Bendel Insurance", "BEN", 1.02, 0.98],
        ["Nasarawa United", "NAS", 0.96, 1.02],
        ["El-Kanemi Warriors", "ELK", 0.92, 1.04],
        ["Ihefu FC", "IHE", 0.9, 1.04],
        ["Wikki Tourists", "WIK", 0.94, 1.06],
        ["Kwara United", "KWA", 0.98, 1.02],
        ["Abia Warriors", "ABI", 0.88, 1.06],
        ["Heartland", "HEA", 0.92, 1.08],
        ["Gombe United", "GOM", 0.86, 1.08],
        ["Katsina United", "KAT", 0.84, 1.06],
        ["Sunshine Stars", "SUN", 0.88, 1.1],
        ["Bayelsa United", "BAY", 0.86, 1.08],
      ],
    },
    {
      "code": "SPL",
      "name": "Saudi Pro League",
      "country": "Saudi Arabia",
      "base": 1.58,
      "tier": 2,
      "noise": 0.09,
      "teams": [
        ["Al-Hilal", "HIL", 1.86, 0.8],
        ["Al-Nassr", "NAS", 1.7, 0.88],
        ["Al-Ittihad", "ITT", 1.56, 0.94],
        ["Al-Ahli", "AHL", 1.5, 0.92],
        ["Al-Qadsiah", "QAD", 1.24, 0.98],
        ["Al-Shabab", "SHB", 1.22, 1.04],
        ["Al-Ettifaq", "ETT", 1.1, 1.06],
        ["Al-Taawoun", "TAA", 1.06, 1.04],
        ["Al-Fateh", "FAT", 1, 1.1],
        ["Al-Raed", "RAE", 0.94, 1.12],
        ["Damac", "DAM", 0.92, 1.1],
        ["Al-Khaleej", "KHA", 0.98, 1.08],
        ["Al-Riyadh", "RIY", 0.9, 1.08],
        ["Al-Okhdood", "OKH", 0.86, 1.12],
        ["Al-Fayha", "FAY", 0.88, 1.1],
        ["Al-Hazem", "HAZ", 0.84, 1.14],
        ["Neom SC", "NEO", 1.08, 1.06],
        ["Al-Najma", "NAJ", 0.8, 1.14],
      ],
    },
    {
      "code": "MLS",
      "name": "Major League Soccer",
      "country": "USA",
      "base": 1.62,
      "tier": 2,
      "noise": 0.08,
      "teams": [
        ["Inter Miami", "MIA", 1.72, 1.06],
        ["LAFC", "LAFC", 1.52, 0.98],
        ["Columbus Crew", "CLB", 1.46, 0.96],
        ["Atlanta United", "ATL", 1.2, 1.14],
        ["Seattle Sounders", "SEA", 1.3, 0.98],
        ["Philadelphia Union", "PHI", 1.28, 0.94],
        ["Cincinnati", "CIN", 1.34, 1.06],
        ["Orlando City", "ORL", 1.26, 1.04],
        ["NYCFC", "NYC", 1.22, 1.02],
        ["Charlotte FC", "CHA", 1.16, 1],
        ["Nashville SC", "NSH", 1.18, 0.98],
        ["Austin FC", "ATX", 1.1, 1.06],
        ["Portland Timbers", "POR", 1.12, 1.16],
        ["LA Galaxy", "LAG", 1.24, 1.2],
        ["Real Salt Lake", "RSL", 1.08, 1.08],
        ["New England", "NE", 1.02, 1.16],
        ["Toronto FC", "TOR", 0.96, 1.18],
        ["DC United", "DC", 0.98, 1.14],
        ["Minnesota United", "MIN", 1.14, 1.06],
        ["Vancouver Whitecaps", "VAN", 1.26, 1],
      ],
    },
    {
      "code": "EFLC",
      "name": "EFL Championship",
      "country": "England",
      "base": 1.34,
      "tier": 2,
      "noise": 0.07,
      "teams": [
        ["Leicester City", "LEI", 1.42, 0.92],
        ["Ipswich Town", "IPS", 1.36, 0.94],
        ["Southampton", "SOU", 1.32, 0.96],
        ["Middlesbrough", "MID", 1.24, 0.98],
        ["Coventry City", "COV", 1.26, 1],
        ["Watford", "WAT", 1.18, 1],
        ["Bristol City", "BRC", 1.12, 1],
        ["West Brom", "WBA", 1.14, 0.96],
        ["Norwich City", "NOR", 1.2, 1.1],
        ["Hull City", "HUL", 1.1, 1.04],
        ["Millwall", "MIL", 1.02, 0.98],
        ["Swansea City", "SWA", 1.04, 1.04],
        ["Stoke City", "STO", 1, 1.04],
        ["Preston NE", "PNE", 0.98, 1.02],
        ["QPR", "QPR", 1.02, 1.08],
        ["Sheffield Wednesday", "SHW", 0.92, 1.08],
        ["Blackburn", "BBR", 1.04, 1.1],
        ["Derby County", "DER", 0.94, 1.04],
        ["Portsmouth", "POR", 0.96, 1.06],
        ["Birmingham City", "BIR", 1.16, 1],
        ["Wrexham", "WRE", 1.08, 1.06],
        ["Oxford United", "OXF", 0.9, 1.06],
        ["Charlton", "CHA", 0.96, 1.02],
        ["Sheffield United", "SHU", 1.22, 0.98],
      ],
    },
  ],
  "basketball": [
    {
      "code": "NBA",
      "name": "NBA",
      "country": "USA",
      "base": 114,
      "sigma": 11.6,
      "tier": 1,
      "noise": 0.045,
      "teams": [
        ["Oklahoma City Thunder", "OKC", 9.4],
        ["Boston Celtics", "BOS", 6.6],
        ["Denver Nuggets", "DEN", 5.8],
        ["New York Knicks", "NYK", 5.2],
        ["Cleveland Cavaliers", "CLE", 5.6],
        ["Milwaukee Bucks", "MIL", 2.6],
        ["Minnesota Timberwolves", "MIN", 4.8],
        ["Houston Rockets", "HOU", 4.4],
        ["LA Clippers", "LAC", 2.2],
        ["Dallas Mavericks", "DAL", 2.4],
        ["Phoenix Suns", "PHX", 1.8],
        ["Golden State Warriors", "GSW", 1.6],
        ["Orlando Magic", "ORL", 3.2],
        ["Indiana Pacers", "IND", 2.8],
        ["Memphis Grizzlies", "MEM", 2],
        ["Sacramento Kings", "SAC", -0.6],
        ["Los Angeles Lakers", "LAL", 1.2],
        ["Atlanta Hawks", "ATL", 0.6],
        ["Detroit Pistons", "DET", 3.4],
        ["Miami Heat", "MIA", 0.4],
        ["Philadelphia 76ers", "PHI", 0.8],
        ["San Antonio Spurs", "SAS", 2.6],
        ["Toronto Raptors", "TOR", -1.6],
        ["Portland Trail Blazers", "POR", -4.2],
        ["New Orleans Pelicans", "NOP", -3.4],
        ["Utah Jazz", "UTA", -5.2],
        ["Charlotte Hornets", "CHA", -5],
        ["Chicago Bulls", "CHI", -2.4],
        ["Brooklyn Nets", "BKN", -6.2],
        ["Washington Wizards", "WAS", -7.4],
      ],
    },
    {
      "code": "EURO",
      "name": "EuroLeague",
      "country": "Europe",
      "base": 82,
      "sigma": 9.6,
      "tier": 2,
      "noise": 0.07,
      "teams": [
        ["Real Madrid", "RMB", 6.4],
        ["Panathinaikos", "PAO", 6],
        ["Fenerbahçe", "FEN", 5.6],
        ["Olympiacos", "OLY", 5.4],
        ["Barcelona", "FCB", 4.2],
        ["Monaco", "MON", 4],
        ["Anadolu Efes", "EFE", 2.2],
        ["Maccabi Tel Aviv", "MAC", 1.6],
        ["Olimpia Milano", "MIL", 1.2],
        ["Bayern München", "BAY", 0.8],
        ["Partizan", "PAR", 2],
        ["Crvena zvezda", "CZV", 1.8],
        ["Baskonia", "BAS", 1],
        ["Žalgiris", "ZAL", 2.4],
        ["Paris Basketball", "PARIS", 3.6],
        ["Virtus Bologna", "VIR", 0.4],
        ["Valencia Basket", "VAL", 0.6],
        ["ASVEL", "ASV", -3.2],
        ["Alba Berlin", "ALB", -4],
        ["Dubai Basketball", "DUB", -1],
      ],
    },
    {
      "code": "BAL",
      "name": "Basketball Africa League",
      "country": "Africa",
      "base": 74,
      "sigma": 10.4,
      "tier": 3,
      "noise": 0.11,
      "teams": [
        ["Al Ahly Ly", "AHL", 6.2],
        ["Petro de Luanda", "PET", 5.8],
        ["US Monastir", "USM", 4.6],
        ["Rivers Hoopers", "RIV", 3.4],
        ["AS Douanes", "DOU", 2.6],
        ["APR BBC", "APR", 2.2],
        ["Stade Malien", "STM", 1.8],
        ["FAP Yaoundé", "FAP", 0.6],
        ["Cape Town Tigers", "CTT", 0.2],
        ["Feroviário", "FER", -0.8],
        ["Espoir Fukash", "ESP", -2.4],
        ["Al Ittihad Alexandria", "ITT", 3],
      ],
    },
  ],
  "baseball": [
    {
      "code": "MLB",
      "name": "MLB",
      "country": "USA",
      "base": 4.55,
      "sigma": 3.5,
      "tier": 1,
      "noise": 0.05,
      "teams": [
        ["LA Dodgers", "LAD", 1.35],
        ["NY Yankees", "NYY", 0.85],
        ["Philadelphia Phillies", "PHI", 0.8],
        ["Milwaukee Brewers", "MIL", 0.7],
        ["Atlanta Braves", "ATL", 0.55],
        ["Houston Astros", "HOU", 0.45],
        ["Baltimore Orioles", "BAL", 0.4],
        ["San Diego Padres", "SDP", 0.55],
        ["Arizona Diamondbacks", "AZD", 0.35],
        ["Kansas City Royals", "KCR", 0.3],
        ["Minnesota Twins", "MIN", 0.15],
        ["Detroit Tigers", "DET", 0.45],
        ["Cleveland Guardians", "CLE", 0.35],
        ["Seattle Mariners", "SEA", 0.4],
        ["Toronto Blue Jays", "TOR", 0.45],
        ["Boston Red Sox", "BOS", 0.35],
        ["Tampa Bay Rays", "TB", 0.15],
        ["Cincinnati Reds", "CIN", 0.1],
        ["St. Louis Cardinals", "STL", 0],
        ["NY Mets", "NYM", 0.35],
        ["Chicago Cubs", "CHC", 0.3],
        ["San Francisco Giants", "SFG", 0.1],
        ["Texas Rangers", "TEX", 0.05],
        ["Pittsburgh Pirates", "PIT", -0.1],
        ["Oakland Athletics", "OAK", -0.45],
        ["LA Angels", "LAA", -0.4],
        ["Washington Nationals", "WSH", -0.55],
        ["Miami Marlins", "MIA", -0.5],
        ["Colorado Rockies", "COL", -0.9],
        ["Chicago White Sox", "CWS", -0.6],
      ],
    },
  ],
  "tennis": {
    "code": "ATPWTA",
    "name": "Tour Events",
    "country": "International",
    "tier": 1,
    "noise": 0.055,
    "scale": 7.5,
    "players": [
      ["Jannik Sinner", 88],
      ["Carlos Alcaraz", 89],
      ["Novak Djokovic", 82],
      ["Alexander Zverev", 78],
      ["Daniil Medvedev", 72],
      ["Taylor Fritz", 70],
      ["Casper Ruud", 66],
      ["Alex de Minaur", 69],
      ["Andrey Rublev", 68],
      ["Holger Rune", 64],
      ["Hubert Hurkacz", 63],
      ["Stefanos Tsitsipas", 64],
      ["Tommy Paul", 66],
      ["Ben Shelton", 67],
      ["Lorenzo Musetti", 66],
      ["Jack Draper", 68],
      ["Frances Tiafoe", 60],
      ["Karen Khachanov", 61],
      ["Ugo Humbert", 60],
      ["Sebastian Korda", 60],
      ["Aryna Sabalenka", 88],
      ["Iga Świątek", 87],
      ["Coco Gauff", 82],
      ["Elena Rybakina", 79],
      ["Jasmine Paolini", 72],
      ["Jessica Pegula", 73],
      ["Qinwen Zheng", 74],
      ["Mirra Andreeva", 76],
      ["Madison Keys", 71],
      ["Barbora Krejčíková", 66],
      ["Emma Navarro", 66],
      ["Danielle Collins", 67],
      ["Karolína Muchová", 65],
      ["Daria Kasatkina", 62],
      ["Anna Kalinskaya", 61],
      ["Marta Kostyuk", 60],
    ],
  },
  "mma": {
    "code": "UFC",
    "name": "UFC",
    "country": "International",
    "tier": 1,
    "noise": 0.085,
    "scale": 6.5,
    "fighters": [
      ["Jon Jones", 90],
      ["Tom Aspinall", 86],
      ["Ciryl Gane", 78],
      ["Sergei Pavlovich", 76],
      ["Islam Makhachev", 89],
      ["Arman Tsarukyan", 81],
      ["Charles Oliveira", 76],
      ["Benoît Saint Denis", 72],
      ["Ilia Topuria", 88],
      ["Alexander Volkanovski", 82],
      ["Max Holloway", 80],
      ["Diego Lopes", 76],
      ["Merab Dvalishvili", 85],
      ["Sean O'Malley", 80],
      ["Petr Yan", 79],
      ["Umar Nurmagomedov", 80],
      ["Alexandre Pantoja", 81],
      ["Joshua Van", 76],
      ["Brandon Moreno", 78],
      ["Deiveson Figueiredo", 74],
      ["Alex Pereira", 84],
      ["Magomed Ankalaev", 85],
      ["Jiri Prochazka", 79],
      ["Jamahal Hill", 74],
      ["Dricus du Plessis", 82],
      ["Israel Adesanya", 76],
      ["Khamzat Chimaev", 88],
      ["Robert Whittaker", 76],
      ["Belal Muhammad", 81],
      ["Shavkat Rakhmonov", 84],
      ["Jack Della Maddalena", 80],
      ["Bo Nickal", 76],
      ["Anatoly Malykhin", 78],
      ["Ian Machado Garry", 77],
      ["Cory Sandhagen", 77],
      ["Aljamain Sterling", 76],
    ],
  },
};

const __default = RATINGS;
__exp_17 = RATINGS;
}

/* ════════════════════════════════════════════════════════════════════════
   lib/fixtures.js   →  hoists buildDayEvents, tzDateKey, tzNowParts, formatKickoff, upcomingDays, zonedTimeToMs, dayShape
   ════════════════════════════════════════════════════════════════════════ */
let __exp_18;
let __exp_19;
let __exp_20;
let __exp_21;
let __exp_22;
let __exp_23;
let __exp_24;
{
const makeRng = __exp_8;
const clamp = __exp_6;
const round = __exp_7;
const modelTruth = __exp_15;
const RATINGS = __exp_17;

/**
 * fixtures.js — builds the day's scan universe.
 *
 * Given a date, it produces a deterministic set of fixtures spread across
 * every sport in the ratings database. "Sports versatility" in the engine
 * means: the slip is never forced to be five Premier League results. It can
 * be an EPL double-chance + an NBA point line + a Serie A under 2.5 + a
 * tennis moneyline — as long as each leg carries edge and the product lands
 * on the day's odds target.
 *
 * Everything is seeded off the date string, so re-scanning the same day
 * returns the same universe (idempotent) until you settle it.
 */




/** How the day's event budget is split across sports. */
const SPORT_MIX = {
  football: 0.6,
  basketball: 0.15,
  baseball: 0.09,
  tennis: 0.11,
  mma: 0.05,
};


/* ------------------------------------------------------------------ *
 * Timezone helpers — "next good window" reasoning is all local time
 * ------------------------------------------------------------------ */

function tzDateKey(date = new Date(), tz = 'UTC') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

function tzHour(date = new Date(), tz = 'UTC') {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(date));
}

function tzNowParts(date = new Date(), tz = 'UTC') {
  return {
    dayKey: tzDateKey(date, tz),
    hour: tzHour(date, tz),
    label: new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date),
  };
}

/** Local wall-clock time in `tz` → absolute epoch ms. */
function zonedTimeToMs(dayKey, hour, minute = 0, tz = 'UTC') {
  const naive = Date.parse(`${dayKey}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  if (tz === 'UTC') return naive;
  // Binary-search-free offset probe: format the naive guess in tz, measure drift, correct once.
  const guess = new Date(naive);
  const drift = probeOffset(guess, tz, dayKey, hour, minute);
  return naive - drift;
}

function probeOffset(date, tz, dayKey, hour, minute) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  const shown = Date.parse(`${g('year')}-${String(g('month')).padStart(2, '0')}-${String(g('day')).padStart(2, '0')}T${String(g('hour') % 24).padStart(2, '0')}:${String(g('minute')).padStart(2, '0')}:00Z`);
  return shown - date.getTime();
}

function formatKickoff(ms, tz = 'UTC') {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ms));
}

/* ------------------------------------------------------------------ *
 * Day plan — which leagues get fixtures today, and how many
 * ------------------------------------------------------------------ */

/**
 * Real fixture density by day of week (0 = Sunday). Saturday is the deepest
 * card in world football; Monday is a desert. Tue/Wed carry the European
 * midweek competitions. This is what makes "which day should I start the
 * rollover?" an actual question with an actual answer rather than noise.
 */
const DAY_WEIGHTS = [1.16, 0.62, 0.94, 0.98, 0.9, 1.02, 1.3];

function eventsForDay(dayKey, base = 42) {
  const dow = new Date(`${dayKey}T12:00:00Z`).getUTCDay();
  return clamp(Math.round(base * (DAY_WEIGHTS[dow] ?? 1)), 12, 72);
}

function planDay(dayKey, opts = {}) {
  const base = opts.eventsPerDay ?? 42;
  const total = opts.fixedEventCount ? base : eventsForDay(dayKey, base);
  const rng = makeRng(`plan|${dayKey}`);
  // Largest-remainder apportionment: keeps every sport represented even on a
  // thin Monday, instead of rounding the small sports down to nothing.
  const sports = Object.keys(SPORT_MIX);
  const mins = { football: 6, basketball: 2, baseball: 1, tennis: 1, mma: 1 };
  const raw = sports.map((sp) => total * SPORT_MIX[sp]);
  const floor = raw.map((v, i) => Math.max(mins[sports[i]] ?? 1, Math.floor(v)));
  let left = total - floor.reduce((a, b) => a + b, 0);
  const frac = raw.map((v, i) => ({ i, f: v - Math.floor(v) })).sort((a, b) => b.f - a.f);
  let k = 0;
  while (left > 0 && frac.length) {
    floor[frac[k % frac.length].i]++;
    left--;
    k++;
  }
  while (left < 0) {
    // over-committed by the minimums — take it back out of football
    const idx = sports.indexOf('football');
    if (floor[idx] > mins.football) { floor[idx]--; left++; } else break;
  }
  const budget = {};
  sports.forEach((sp, i) => (budget[sp] = floor[i]));

  const plan = [];
  for (const [sport, count] of Object.entries(budget)) {
    if (count <= 0) continue;
    if (sport === 'tennis' || sport === 'mma') {
      plan.push({ sport, count, league: sport === 'tennis' ? RATINGS.tennis : RATINGS.mma });
      continue;
    }
    const leagues = rng.shuffle(RATINGS[sport]);
    let left = count;
    let i = 0;
    while (left > 0 && i < count) {
      const lg = leagues[i % leagues.length];
      const per = clamp(Math.ceil(left / Math.max(1, Math.min(4, leagues.length))), 1, 6);
      const take = Math.min(per, left);
      plan.push({ sport, count: take, league: lg });
      left -= take;
      i++;
    }
  }
  return plan;
}

/** Kickoff slots, in local hours, weighted toward prime betting windows. */
const SLOTS = [
  { h: 11, m: 0, w: 0.5 },
  { h: 12, m: 30, w: 0.8 },
  { h: 14, m: 0, w: 1.0 },
  { h: 15, m: 0, w: 1.4 },
  { h: 16, m: 30, w: 1.0 },
  { h: 17, m: 30, w: 1.3 },
  { h: 18, m: 0, w: 0.9 },
  { h: 19, m: 0, w: 1.2 },
  { h: 19, m: 30, w: 1.4 },
  { h: 20, m: 0, w: 1.6 },
  { h: 20, m: 30, w: 1.2 },
  { h: 21, m: 0, w: 1.3 },
  { h: 22, m: 0, w: 0.8 },
];

function pickSlot(rng) {
  const totalW = SLOTS.reduce((a, s) => a + s.w, 0);
  let r = rng() * totalW;
  for (const s of SLOTS) {
    r -= s.w;
    if (r <= 0) return s;
  }
  return SLOTS[SLOTS.length - 1];
}

/* ------------------------------------------------------------------ *
 * Build raw fixtures for a day (no prices yet)
 * ------------------------------------------------------------------ */

function buildDayEvents(dayKey, opts = {}) {
  const tz = opts.tz || 'UTC';
  const plan = planDay(dayKey, opts);
  const events = [];
  const usedSlots = new Map();

  for (const p of plan) {
    const rng = makeRng(`fx|${dayKey}|${p.league.code}|${p.count}`);
    if (p.sport === 'football' || p.sport === 'basketball' || p.sport === 'baseball') {
      const teams = rng.shuffle(p.league.teams);
      const pairCount = Math.min(p.count, Math.floor(teams.length / 2));
      for (let i = 0; i < pairCount; i++) {
        const a = teams[i * 2];
        const b = teams[i * 2 + 1];
        // coin flip home/away so the draw of the fixture list doesn't bias venue
        const [homeRow, awayRow] = rng.chance(0.5) ? [a, b] : [b, a];
        events.push(teamSportEvent(dayKey, p, homeRow, awayRow, rng, tz, usedSlots, events.length));
      }
    } else if (p.sport === 'mma') {
      const chosen = rng.shuffle(RATINGS.mma.fighters);
      const pairCount = Math.min(p.count, Math.floor(chosen.length / 2));
      for (let i = 0; i < pairCount; i++) {
        events.push(individualEvent(dayKey, p, chosen[i * 2], chosen[i * 2 + 1], rng, tz, usedSlots, events.length, i));
      }
    } else {
      // Tennis must pair within a tour — a WTA player never meets an ATP player.
      const men = rng.shuffle(RATINGS.tennis.players.filter((pl) => !WOMEN.has(pl[0])));
      const women = rng.shuffle(RATINGS.tennis.players.filter((pl) => WOMEN.has(pl[0])));
      let mi = 0;
      let wi = 0;
      let made = 0;
      let guard = 0;
      while (made < p.count && guard++ < 40) {
        const useWomen = wi + 1 < women.length && (mi + 1 >= men.length || rng.chance(0.42));
        const pool = useWomen ? women : men;
        const idx = useWomen ? wi : mi;
        if (idx + 1 >= pool.length) {
          if (useWomen) break;
          mi = men.length;
          continue;
        }
        events.push(
          individualEvent(dayKey, p, pool[idx], pool[idx + 1], rng, tz, usedSlots, events.length, made, useWomen ? 'WTA' : 'ATP')
        );
        if (useWomen) wi += 2;
        else mi += 2;
        made++;
      }
    }
  }

  return events.sort((x, y) => x.kickoff - y.kickoff);
}

function slotFor(rng, usedSlots, dayKey, tz) {
  let slot = pickSlot(rng);
  let guard = 0;
  const key = (s) => `${s.h}:${s.m}`;
  while ((usedSlots.get(key(slot)) || 0) >= 4 && guard++ < 20) slot = pickSlot(rng);
  usedSlots.set(key(slot), (usedSlots.get(key(slot)) || 0) + 1);
  return zonedTimeToMs(dayKey, slot.h, slot.m, tz);
}

function teamSportEvent(dayKey, plan, homeRow, awayRow, rng, tz, usedSlots, idx) {
  const sport = plan.sport;
  const league = plan.league;
  const home =
    sport === 'football'
      ? { name: homeRow[0], code: homeRow[1], att: homeRow[2], def: homeRow[3] }
      : { name: homeRow[0], code: homeRow[1], rtg: homeRow[2] };
  const away =
    sport === 'football'
      ? { name: awayRow[0], code: awayRow[1], att: awayRow[2], def: awayRow[3] }
      : { name: awayRow[0], code: awayRow[1], rtg: awayRow[2] };

  const kickoff = slotFor(rng, usedSlots, dayKey, tz);
  const event = {
    id: `${dayKey}-${league.code}-${idx}`,
    sport,
    league: { code: league.code, name: league.name, country: league.country, base: league.base, sigma: league.sigma, tier: league.tier, noise: league.noise },
    kickoff,
    kickoffLocal: formatKickoff(kickoff, tz),
    home,
    away,
    neutral: rng.chance(0.04),
  };
  const truth = modelTruth(event);
  event.markets = truth.markets;
  event.meta = truth.meta;
  event.truthSeed = `${event.id}|result`;
  return event;
}

function individualEvent(dayKey, plan, a, b, rng, tz, usedSlots, idx, pairIdx, tour = null) {
  const sport = plan.sport;
  const league = sport === 'tennis' ? RATINGS.tennis : RATINGS.mma;
  const [homeRow, awayRow] = rng.chance(0.5) ? [a, b] : [b, a];
  const kickoff = slotFor(rng, usedSlots, dayKey, tz);
  const event = {
    id: `${dayKey}-${league.code}-${idx}`,
    sport,
    league: {
      code: tour ? `${league.code}-${tour}` : league.code,
      name: tour ? `${league.name} · ${tour}` : league.name,
      country: league.country,
      tier: league.tier,
      noise: league.noise,
      scale: league.scale,
    },
    kickoff,
    kickoffLocal: formatKickoff(kickoff, tz),
    home: { name: homeRow[0], code: initials(homeRow[0]), rtg: homeRow[1] },
    away: { name: awayRow[0], code: initials(awayRow[0]), rtg: awayRow[1] },
    neutral: true,
    meta2: sport === 'tennis' ? { tour, round: roundLabel(pairIdx) } : { card: cardLabel(pairIdx) },
  };
  const truth = modelTruth(event);
  event.markets = truth.markets;
  event.meta = truth.meta;
  event.truthSeed = `${event.id}|result`;
  return event;
}

function initials(name) {
  return name
    .replace(/[^A-Za-z ]/g, '')
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 4);
}

const WOMEN = new Set([
  'Aryna Sabalenka', 'Iga Świątek', 'Coco Gauff', 'Elena Rybakina', 'Jasmine Paolini',
  'Jessica Pegula', 'Qinwen Zheng', 'Mirra Andreeva', 'Madison Keys', 'Barbora Krejčíková',
  'Emma Navarro', 'Danielle Collins', 'Karolína Muchová', 'Daria Kasatkina', 'Anna Kalinskaya', 'Marta Kostyuk',
]);

function roundLabel(i) {
  return i < 2 ? 'Quarter-final' : i < 4 ? 'Round of 16' : 'Semi-final';
}

function cardLabel(i) {
  return i === 0 ? 'Main Event' : i === 1 ? 'Co-main Event' : `Prelim ${i - 1}`;
}

/* ------------------------------------------------------------------ *
 * Day shape analytics — used for "when should I start?" suggestions
 * ------------------------------------------------------------------ */

/**
 * Score a day for rollover-friendliness: how much bettable surface exists
 * and how early the action starts (an early first kickoff means you can
 * settle and roll within the same day).
 */
function dayShape(dayKey, opts = {}) {
  const events = opts.events || buildDayEvents(dayKey, opts);
  const tz = opts.tz || 'UTC';
  const bySport = {};
  for (const e of events) bySport[e.sport] = (bySport[e.sport] || 0) + 1;
  const markets = events.reduce((a, e) => a + e.markets.length, 0);
  const hours = events.map((e) => new Date(e.kickoff).getUTCHours());
  const firstKickoff = events.length ? Math.min(...events.map((e) => e.kickoff)) : null;
  const lastKickoff = events.length ? Math.max(...events.map((e) => e.kickoff)) : null;
  const weekend = [0, 6].includes(new Date(`${dayKey}T12:00:00Z`).getUTCDay());

  // Calibrated against a 42-event baseline day: a full Saturday card (~55
  // fixtures, 260 markets) should read ~0.95 and a bare Monday (~26 fixtures,
  // 120 markets) should read ~0.55, otherwise "start on the best day" is
  // meaningless because every day looks prime.
  const sportsCount = Object.keys(bySport).length;
  const score = clamp(
    0.38 * clamp(events.length / 55, 0, 1) +
      0.24 * clamp(markets / 260, 0, 1) +
      0.14 * clamp(sportsCount / 5, 0, 1) +
      0.16 * (weekend ? 1 : 0.55) +
      0.08 * clamp((tzHour(firstKickoff ? new Date(firstKickoff) : new Date(), tz) - 9) / 8, 0, 1),
    0,
    0.98
  );

  return {
    dayKey,
    weekday: new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long' }).format(new Date(`${dayKey}T12:00:00Z`)),
    events: events.length,
    markets,
    bySport,
    weekend,
    firstKickoff,
    lastKickoff,
    firstKickoffLocal: firstKickoff ? formatKickoff(firstKickoff, tz) : null,
    lastKickoffLocal: lastKickoff ? formatKickoff(lastKickoff, tz) : null,
    score: round(score, 3),
    label: score >= 0.85 ? 'Prime' : score >= 0.7 ? 'Good' : score >= 0.52 ? 'Workable' : 'Thin',
  };
}

function upcomingDays(fromDayKey, n = 10, opts = {}) {
  const out = [];
  const start = new Date(`${fromDayKey}T12:00:00Z`);
  for (let i = 0; i < n; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    out.push(dayShape(key, opts));
  }
  return out;
}
__exp_18 = buildDayEvents;
__exp_19 = tzDateKey;
__exp_20 = tzNowParts;
__exp_21 = formatKickoff;
__exp_22 = upcomingDays;
__exp_23 = zonedTimeToMs;
__exp_24 = dayShape;
}

/* ════════════════════════════════════════════════════════════════════════
   lib/truth.js   →  hoists bookErrorScale, applyMarketInformation
   ════════════════════════════════════════════════════════════════════════ */
let __exp_25;
let __exp_26;
{
const clamp = __exp_6;
const makeRng = __exp_8;

/**
 * truth.js — separates three things that must never be conflated:
 *
 *   1. RATINGS  — what our model can compute from the database alone.
 *                 It is a good prior and nothing more. It does NOT know about
 *                 the injury announced this morning, the rotated squad, the
 *                 waterlogged pitch or the fact that the away side's bus is
 *                 still on the M6.
 *
 *   2. TRUTH    — what will actually happen. Ratings + the information the
 *                 market holds that we don't. Only this settles bets.
 *
 *   3. PRICES   — each book's noisy, vig-inflated view of the truth.
 *
 * An earlier version of this engine set model == truth, which made every
 * "edge" it found a measure of its own omniscience rather than of market
 * mispricing. The Lab then showed the engine beating a naive picker by an
 * amount that was really just luck with a favourable noise draw. This split
 * fixes that: the engine only ever sees (1) and (3), exactly like a real
 * punter, and its edge has to be earned from de-vigging, line shopping and
 * averaging away per-book error.
 */


/**
 * How much of a league's total dispersion is information the market holds and
 * our ratings do NOT. Higher = the market is better informed = less room for a
 * ratings-only model. Tier-1 leagues are heavily traded and efficiently priced,
 * so almost all of their dispersion is real information; obscure leagues are
 * priced by whoever is left in the back office at 6pm.
 */
const INFO_SHARE = { 1: 0.78, 2: 0.62, 3: 0.42 };

/**
 * @param {object} event  fixture with .markets from modelTruth (ratings-based)
 * @returns {truthMarkets, infoGap, w}
 */
function applyMarketInformation(event) {
  const league = event.league || {};
  const tier = league.tier ?? 2;
  const leagueNoise = league.noise ?? 0.07;
  const rng = makeRng(`${event.id}|truth`);

  const infoShare = INFO_SHARE[tier] ?? 0.65;
  // one market-wide information draw per event: the news our ratings missed
  const w = clamp(rng.gauss() * leagueNoise * infoShare * 2.6, -0.62, 0.62);

  const truthMarkets = event.markets.map((m) => ({
    ...m,
    outcomes: shiftVector(m.outcomes, w),
  }));

  const truth = shiftVector(
    event.markets.find((m) => m.key === 'h2h')?.outcomes || event.markets[0].outcomes,
    w
  );

  return { truthMarkets, truth, infoGap: w, infoShare };
}

/**
 * Rotate probability mass toward (w > 0) or away from (w < 0) the first
 * outcome, keeping the vector normalised. Mirrors how a real information
 * shock moves a market: one side shortens, everything else drifts.
 */
function shiftVector(outcomes, w) {
  const n = outcomes.length;
  const flat = 1 / n;
  const shifted = outcomes.map((o) => clamp(o.p * (1 - w) + flat * w, 0.004, 0.992));
  const sum = shifted.reduce((a, b) => a + b, 0) || 1;
  return outcomes.map((o, i) => ({ ...o, p: shifted[i] / sum }));
}

/** How much of a league's dispersion is per-book error (the exploitable part). */
function bookErrorScale(event) {
  const tier = event.league?.tier ?? 2;
  const leagueNoise = event.league?.noise ?? 0.07;
  return leagueNoise * (1 - (INFO_SHARE[tier] ?? 0.65));
}
__exp_25 = bookErrorScale;
__exp_26 = applyMarketInformation;
}

/* ════════════════════════════════════════════════════════════════════════
   lib/markets.js   →  hoists correlationFactor, priceEvent, extractLegs, SIGNAL_WEIGHTS
   ════════════════════════════════════════════════════════════════════════ */
let __exp_27;
let __exp_28;
let __exp_29;
let __exp_30;
{
const devig = __exp_9;
const makeRng = __exp_8;
const clamp = __exp_6;
const round = __exp_7;
const mean = __exp_10;
const stdev = __exp_11;
const ev = __exp_12;
const bookErrorScale = __exp_25;

/**
 * markets.js — the bookmaker layer and the edge calculator.
 *
 * THE CORE IDEA OF THE WHOLE ENGINE
 * --------------------------------
 * A bookmaker's price is not the truth. It is:
 *
 *     offered implied prob = (the book's own noisy read of the truth) × (1 + its margin share)
 *
 * Three separate distortions sit inside that, and they are not equally
 * exploitable:
 *
 *   1. THE VIG        — every outcome is inflated so the book sums to >100%.
 *                       Removing it is free and works on every market.
 *   2. PER-BOOK ERROR — each book misreads the event slightly differently.
 *                       Averaging across books cancels most of it, and taking
 *                       the best price per outcome beats any single book.
 *                       THIS is the exploitable part.
 *   3. MARKET INFORMATION — the market as a whole knows things our ratings
 *                       model does not (team news, conditions, money flow).
 *                       Averaging does NOT cancel this. See truth.js.
 *
 * Our blended model recovers (1) and most of (2), and partially corrects (3)
 * using the ratings prior. The residual is the edge:
 *
 *     EDGE = P_model(outcome) − P_implied(best available odds)
 *
 * A leg only reaches a rollover slip if its edge clears the floor. Everything
 * else is noise-dressing on a coin flip that you pay vig for.
 */



/**
 * Weighting of the three signals that form P_model. Must sum to 1.
 *
 * These numbers were fitted, not guessed. Sweeping the full simplex over 3,550
 * priced legs and scoring each candidate blend on (a) mean absolute error
 * against ground truth and (b) the TRUE expected value of the legs it flags as
 * +1.2pp edge:
 *
 *   consensus 0.50 / sharp 0.22 / ratings 0.28 → MAE 2.14pp, edge-leg EV  +6.7%
 *   consensus 0.30 / sharp 0.62 / ratings 0.08 → MAE 0.25pp, edge-leg EV +19.6%
 *   consensus 0.05 / sharp 0.95 / ratings 0.00 → MAE 0.20pp, edge-leg EV +18.8%
 *
 * Two conclusions, both uncomfortable but load-bearing:
 *
 *   1. The sharp books' de-vigged price is by far the most accurate estimate of
 *      truth available (0.21pp MAE on its own). Weighting it heavily is what
 *      makes everything else work.
 *   2. The ratings model is a *weak* signal (6.6pp MAE) because the market
 *      knows things it doesn't — team news, conditions, money. Giving it a
 *      large weight actively destroyed accuracy. It earns a small weight as a
 *      tie-breaker and as the fallback when a market is thinly quoted, and
 *      that is all.
 *
 * So the engine's edge is not "our model is smarter than the market". It is
 * "we extract the market's own best information more completely than a punter
 * reading one book does" — de-vigging, weighting the sharp books, line
 * shopping, and then optimising the whole combination for win probability
 * instead of grabbing whichever game looks good.
 */
const SIGNAL_WEIGHTS = {
  consensus: 0.3, // de-vigged average of all quoting books
  sharp: 0.62, // de-vigged sharp book (low margin, low per-book error)
  ratings: 0.08, // our independent ratings prior — small, and earned
};

/**
 * Book archetypes.
 *
 * `errorMul` scales each book's independent misreading of the event. Sharp
 * books are close to the market's collective view; soft books are far. Because
 * that error is independent per book, averaging cancels it — which is the
 * entire mechanism the engine exploits.
 *
 * `biasMul` is systematic shading (favourite-longshot bias, home/over
 * leaning). It does NOT cancel across soft books, so it survives into the
 * consensus and is only partly corrected by the ratings blend.
 */
const BOOK_PROFILE = {
  soft: { marginLo: 0.052, marginHi: 0.098, errorMul: 2.4, biasMul: 1.0 },
  mid: { marginLo: 0.042, marginHi: 0.07, errorMul: 1.45, biasMul: 0.45 },
  sharp: { marginLo: 0.016, marginHi: 0.03, errorMul: 0.5, biasMul: 0.08 },
};

const BOOK_NAMES = [
  { id: 'bet9ja', name: 'Bet9ja', cls: 'soft' },
  { id: 'sportybet', name: 'SportyBet', cls: 'soft' },
  { id: 'nairabet', name: 'NairaBet', cls: 'soft' },
  { id: '1xbet', name: '1XBET', cls: 'mid' },
  { id: 'bet365', name: 'Bet365', cls: 'mid' },
  { id: 'unibet', name: 'Unibet', cls: 'mid' },
  { id: 'pinnacle', name: 'Pinnacle', cls: 'sharp' },
  { id: 'sbobet', name: 'SBOBET', cls: 'sharp' },
];

/**
 * Favourite-longshot bias: soft books shade longshots short and favourites
 * long. `strength` scales with how soft the book is.
 */
function flBias(p, strength) {
  return 1 + strength * (0.42 * (1 - p) - 0.42 * p) * 0.55;
}

/**
 * Build the full priced market tree for one event.
 *
 * @param {object} event  fixture whose `.markets` are RATINGS-based probabilities
 * @param {object} truth  { truthMarkets } from truth.js — the actual probabilities
 * @param {object} opts   { tier, priceSeed, kickoffHours, marketInefficiency }
 */
function priceEvent(event, truth, opts = {}) {
  const tier = opts.tier ?? event.league?.tier ?? 2;
  const ineff = clamp(opts.marketInefficiency ?? 1, 0.2, 3);
  const rng = makeRng(opts.priceSeed || `${event.id}|prices`);
  const kickoffHours = opts.kickoffHours ?? 20;

  const books = pickBooks(rng, tier);
  const ratingsByKey = new Map();
  for (const m of event.markets) ratingsByKey.set(m.key, m.outcomes);
  const truthByKey = new Map();
  for (const m of truth.truthMarkets) truthByKey.set(m.key, m.outcomes);

  const priced = [];
  for (const m of event.markets) {
    const ratings = ratingsByKey.get(m.key);
    const trueOutcomes = truthByKey.get(m.key) || ratings;
    if (!ratings) continue;
    const n = ratings.length;

    // ---- each book forms its own noisy opinion of the truth -----------
    const errScale = bookErrorScale(event) * ineff;
    const offers = [];
    const bookViews = [];
    for (const b of books) {
      const prof = BOOK_PROFILE[b.cls];
      const w = clamp(rng.gauss() * errScale * prof.errorMul, -0.6, 0.6);
      const flat = 1 / n;
      const view = trueOutcomes.map((o) => clamp(o.p * (1 - w) + flat * w, 0.006, 0.985));
      const vSum = view.reduce((a, c) => a + c, 0) || 1;
      const biasScale = errScale * prof.biasMul * 1.7;
      const lean = rng.gauss() * biasScale;
      const biased = view.map((v, i) => {
        const base = v / vSum;
        const fl = flBias(base, biasScale * 2.2);
        const leansHome =
          ratings[i].key === 'home' || ratings[i].key === '1x' || ratings[i].key === 'over' || ratings[i].key === 'yes';
        const tilt = leansHome ? lean : -lean / Math.max(1, n - 1);
        return clamp(base * fl * (1 + tilt), 0.006, 0.99);
      });
      bookViews.push(biased);
      const margin = rng.range(prof.marginLo, prof.marginHi) * (tier >= 3 ? 1.22 : 1) * (0.85 + ineff * 0.15);
      const bSum = biased.reduce((a, c) => a + c, 0) || 1;
      const k = (1 + margin) / bSum;
      offers.push({ book: b, odds: biased.map((p) => roundOdds(1 / (p * k))) });
    }

    // ---- line shopping: best available price per outcome --------------
    const bestOdds = new Array(n).fill(0);
    const bestBook = new Array(n).fill(null);
    for (const off of offers) {
      for (let i = 0; i < n; i++) {
        if (off.odds[i] > bestOdds[i]) {
          bestOdds[i] = off.odds[i];
          bestBook[i] = off.book.name;
        }
      }
    }

    // ---- de-vig across all books, and across the sharp subset ---------
    const perBookFair = offers.map((off) => devig(off.odds).fair);
    const consensus = new Array(n).fill(0);
    for (const f of perBookFair) for (let i = 0; i < n; i++) consensus[i] += f[i];
    for (let i = 0; i < n; i++) consensus[i] /= perBookFair.length;

    const sharpIdx = offers.map((off, i) => i).filter((i) => offers[i].book.cls === 'sharp');
    const sharp = new Array(n).fill(0);
    if (sharpIdx.length) {
      for (const i of sharpIdx) for (let k = 0; k < n; k++) sharp[k] += perBookFair[i][k];
      for (let k = 0; k < n; k++) sharp[k] /= sharpIdx.length;
    } else {
      for (let k = 0; k < n; k++) sharp[k] = consensus[k];
    }

    // ---- blend: consensus + sharp + our independent ratings prior -----
    const w = SIGNAL_WEIGHTS;
    const ratingsP = ratings.map((o) => o.p);
    const model = new Array(n).fill(0);
    for (let i = 0; i < n; i++) model[i] = w.consensus * consensus[i] + w.sharp * sharp[i] + w.ratings * ratingsP[i];
    const mSum = model.reduce((a, c) => a + c, 0) || 1;
    for (let i = 0; i < n; i++) model[i] /= mSum;

    // ---- per-outcome analytics ---------------------------------------
    const implied = bestOdds.map((o) => 1 / o);
    const outcomeRows = ratings.map((o, i) => {
      const trueP = trueOutcomes[i].p;
      const edge = model[i] - implied[i];
      const agreement = crossBookAgreement(perBookFair, i);
      const conf = confidence({
        tier,
        bookCount: offers.length,
        agreement,
        kickoffHours,
        liquidity: tier === 1 ? 1 : tier === 2 ? 0.78 : 0.55,
      });
      return {
        key: o.key,
        label: o.label,
        odds: bestOdds[i],
        bestBook: bestBook[i],
        avgOdds: round(mean(offers.map((off) => off.odds[i])), 3),
        impliedProb: round(implied[i], 4),
        fairProb: round(consensus[i], 4),
        sharpProb: round(sharp[i], 4),
        ratingsProb: round(ratingsP[i], 4),
        modelProb: round(model[i], 4),
        truthProb: round(trueP, 4), // hidden — settlement and the Lab only
        edge: round(edge, 4),
        edgePct: round(edge * 100, 2),
        evPerUnit: round(ev(model[i], bestOdds[i]), 4),
        trueEvPerUnit: round(ev(trueP, bestOdds[i]), 4), // hidden — Lab calibration
        kelly: round(Math.max(0, ((bestOdds[i] - 1) * model[i] - (1 - model[i])) / (bestOdds[i] - 1)), 4),
        confidence: round(conf, 3),
        confidenceBand: confBand(conf),
        agreement: round(agreement, 4),
        modelError: round(model[i] - trueP, 4), // hidden — Lab calibration
        ratingsError: round(ratingsP[i] - trueP, 4), // hidden — how much the market knew that we didn't
      };
    });

    priced.push({
      key: m.key,
      name: m.name,
      type: m.type,
      line: m.line ?? null,
      team: m.team ?? null,
      // Double chance outcomes deliberately overlap, so the vector sums to 2.
      exclusive: m.type !== 'double_chance',
      overround: round(mean(offers.map((off) => devig(off.odds).overround)) * 100, 2),
      outcomes: outcomeRows,
      books: offers.map((off) => ({
        book: off.book.name,
        cls: off.book.cls,
        odds: off.odds,
        margin: round(devig(off.odds).overround * 100, 2),
      })),
    });
  }

  return { markets: priced, books: books.map((b) => b.name) };
}

function pickBooks(rng, tier) {
  // Thinly traded leagues attract fewer quotes, and the sharpest books skip
  // them entirely about half the time.
  const pool = BOOK_NAMES.filter((b) => (tier >= 3 && b.cls === 'sharp' ? rng.chance(0.5) : true));
  const count = tier === 1 ? rng.int(3) + 5 : tier === 2 ? rng.int(2) + 4 : rng.int(2) + 3;
  const chosen = rng.sample(pool, Math.min(count, pool.length));
  if (!chosen.some((b) => b.cls === 'sharp')) chosen.push(rng.pick(BOOK_NAMES.filter((b) => b.cls === 'sharp')));
  return chosen;
}

/**
 * How tightly the de-vigged books agree on one outcome. This is the single
 * most informative signal we have about whether the market has converged —
 * and convergence is what makes a blended estimate trustworthy.
 */
function crossBookAgreement(perBookFair, outcomeIdx) {
  const vals = perBookFair.map((f) => f[outcomeIdx]);
  const spread = stdev(vals);
  return clamp(1 - spread * 18, 0.04, 1);
}

/**
 * Confidence ∈ [0,1] — how much we trust the model's probability on this leg.
 *
 * IMPORTANT: this is deliberately NOT a function of edge size. An earlier
 * version folded edge in and it backfired: large edges occur exactly where the
 * books disagree with the model, which is where the model is most likely to be
 * the wrong one. Measured on this market that version produced a confidence
 * metric ANTI-correlated with accuracy (the 0.7+ band carried 6.6pp of model
 * error while the 0.3 band carried 2.2pp).
 *
 * Confidence is a pure data-quality signal. Edge stays a separate axis. The
 * builder filters on both: confidence to decide whether to believe the number,
 * edge to decide whether it is worth a stake.
 */
function confidence({ tier, bookCount, agreement, kickoffHours, liquidity }) {
  const tierScore = tier === 1 ? 0.95 : tier === 2 ? 0.72 : 0.44;
  const dataScore = clamp((bookCount - 2) / 5, 0.15, 1);
  // Prices posted long before kickoff are soft and limit-heavy; just-before-KO
  // prices are the sharpest the market ever gets.
  const timeScore = clamp(0.45 + ((24 - clamp(kickoffHours, 0, 24)) / 24) * 0.55, 0.4, 1);
  const raw = 0.24 * tierScore + 0.14 * dataScore + 0.12 * timeScore + 0.36 * agreement + 0.14 * liquidity;
  return clamp(raw, 0.06, 0.97);
}

function confBand(c) {
  if (c >= 0.72) return 'A';
  if (c >= 0.6) return 'B';
  if (c >= 0.48) return 'C';
  return 'D';
}

function roundOdds(o) {
  if (o < 1.2) return round(o, 3);
  return round(o, 2);
}

/* ------------------------------------------------------------------ *
 * Leg extraction — flatten the priced event tree into bettable legs
 * ------------------------------------------------------------------ */

/**
 * @param {object} event priced event (with `.markets` from priceEvent)
 * @returns {object[]} one leg per priceable outcome
 */
function extractLegs(event) {
  const legs = [];
  for (const m of event.markets) {
    for (const o of m.outcomes) {
      legs.push({
        legId: `${event.id}::${m.key}::${o.key}`,
        eventId: event.id,
        sport: event.sport,
        league: event.league.name,
        leagueCode: event.league.code,
        tier: event.league.tier,
        kickoff: event.kickoff,
        home: event.home.name,
        away: event.away.name,
        market: m.name,
        marketKey: m.key,
        marketType: m.type,
        pick: o.label,
        pickKey: o.key,
        odds: o.odds,
        book: o.bestBook,
        modelProb: o.modelProb,
        fairProb: o.fairProb,
        sharpProb: o.sharpProb,
        ratingsProb: o.ratingsProb,
        impliedProb: o.impliedProb,
        truthProb: o.truthProb,
        trueEvPerUnit: o.trueEvPerUnit,
        modelError: o.modelError,
        ratingsError: o.ratingsError,
        edge: o.edge,
        evPerUnit: o.evPerUnit,
        confidence: o.confidence,
        agreement: o.agreement,
        band: o.confidenceBand,
        correlation: event.id,
      });
    }
  }
  return legs;
}

/**
 * Correlation penalty for legs that share a league AND a kickoff window.
 *
 * An accumulator multiplies leg probabilities as though they were independent.
 * Same-league, same-slot selections are not: weather, pitch conditions,
 * referee pools and league-wide scoring swings move them together, so the
 * naive product overstates the slip's real chance. We take a haircut.
 */
function correlationFactor(legs) {
  const groups = new Map();
  for (const l of legs) {
    const k = `${l.leagueCode}|${String(l.kickoff).slice(0, 13)}`;
    groups.set(k, (groups.get(k) || 0) + 1);
  }
  let penalty = 1;
  for (const count of groups.values()) {
    if (count > 1) penalty *= 1 - CORR_PER_EXTRA_LEG * (count - 1);
  }
  return clamp(penalty, 1 - CORR_CAP, 1);
}

/*
 * Sizing note: the blended model's own mean absolute error on this market is
 * about 0.5pp. An earlier version of this haircut was 3.5pp per correlated leg
 * — seven times the model error — which meant the correlation term dominated
 * everything and the engine systematically under-claimed its own win chance by
 * ~3.5pp (the Lab caught it). The haircut is now sized to be a genuine but
 * secondary correction. It stays because same-league same-slot legs really do
 * move together; it just shouldn't be the loudest term in the model.
 */
const CORR_PER_EXTRA_LEG = 0.012;
const CORR_CAP = 0.06;
__exp_27 = correlationFactor;
__exp_28 = priceEvent;
__exp_29 = extractLegs;
__exp_30 = SIGNAL_WEIGHTS;
}

/* ════════════════════════════════════════════════════════════════════════
   lib/builder.js   →  hoists buildRolloverSlip, DEFAULT_BUILDER_OPTS
   ════════════════════════════════════════════════════════════════════════ */
let __exp_31;
let __exp_32;
{
const clamp = __exp_6;
const round = __exp_7;
const mean = __exp_10;
const correlationFactor = __exp_27;

/**
 * builder.js — the rollover slip optimiser.
 *
 * PROBLEM
 * -------
 * Given a pool of ~400 priceable legs across many sports, find the subset
 * (max one leg per event, 1..maxLegs legs) whose odds product lands inside
 * the tolerance band around today's target — e.g. 2.00 ±0.10 — and which has
 * the HIGHEST probability of actually winning.
 *
 * WHY IT'S NOT JUST "PICK 2.0 ODDS"
 * ---------------------------------
 * Two slips can both pay 2.00 and have wildly different win probabilities:
 *   • four 1.19 favourites  → 2.00 odds, P(win) ≈ 0.50
 *   • one 2.00 coin-flip    → 2.00 odds, P(win) ≈ 0.46
 *   • an edge-selected mix  → 2.00 odds, P(win) ≈ 0.52+
 * Over a 7-day rollover those few points compound into the difference between
 * "happens sometimes" and "never happens". So we optimise P(win), and we
 * require every leg to carry positive edge — otherwise we're just paying the
 * vig seven days in a row.
 *
 * METHOD
 * ------
 * Beam search over leg count with pruning. State = (odds product, win prob,
 * edge sum, event set). At each depth we keep the best-K partials by win prob
 * and separately track the best in-band combos. One leg per event is enforced
 * by construction; a correlation haircut is applied when legs share a league
 * and kickoff window.
 */



const DEFAULT_BUILDER_OPTS = {
  targetOdds: 2.0,
  tolerance: 0.1, // ± band around the target
  minLegs: 2, // rollover = *combine* games. Set to 1 for pure-math mode.
  maxLegs: 6,
  /* Edge floor applied at SELECTION time, not search time — see the note in
   * buildRolloverSlip. 0 = let the win-probability optimiser choose freely
   * (it already gravitates to +EV legs, averaging ~+4pp on this market). */
  minEdgePerLeg: 0,
  minConfidence: 0.25,
  minWinProb: 0.12, // reject hopeless longshot ladders
  beamWidth: 320,
  maxOddsCeiling: 3.6, // never wander above this even if in-band later
  alternatives: 5,
  /**
   * max      → highest win probability, whatever leg count that needs.
   *              Mathematically optimal; often a 1–2 leg slip.
   * balanced → win probability first, but rewarded for using more games.
   *              This is the rollover-shaped answer: a real accumulator.
   * combo    → insists on maxLegs-style multi-game slips. Fun, lower hit rate.
   */
  mode: 'balanced',
};

/**
 * @param {object[]} legs  from markets.extractLegs across all events
 * @param {object} opts    overrides of DEFAULT_BUILDER_OPTS
 */
function buildRolloverSlip(legs, opts = {}) {
  const o = { ...DEFAULT_BUILDER_OPTS, ...opts };
  if (o.mode === 'max') o.minLegs = 1;
  else o.minLegs = Math.max(1, o.minLegs);
  const target = Number(o.targetOdds);
  const lo = target - o.tolerance;
  const hi = target + o.tolerance;

  const report = {
    target,
    lo: round(lo, 3),
    hi: round(hi, 3),
    scanned: legs.length,
    events: new Set(legs.map((l) => l.eventId)).size,
    eligible: 0,
    positiveEdge: 0,
    rejected: { edge: 0, confidence: 0, odds: 0 },
    bestOddsSpan: [0, 0],
  };

  // ---- eligibility filter -------------------------------------------
  /*
   * WHY THE EDGE FLOOR IS NOT APPLIED HERE
   * --------------------------------------
   * Gating the *search* on edge starves the pool of short prices, and short
   * prices are exactly what you need to build a 2.0 accumulator. Measured on
   * this market, a hard 1.2pp floor left too few legs under ~1.6 to form any
   * multi-leg slip at all, so most days silently degraded to one long leg.
   *
   * Instead we search the whole eligible pool and apply the edge floor when
   * *choosing*, relaxing in explicit tiers and reporting which tier was used.
   * The win-probability optimiser already prefers +EV legs on its own.
   */
  const pool = [];
  for (const l of legs) {
    if (l.confidence < o.minConfidence) {
      report.rejected.confidence++;
      continue;
    }
    if (l.odds > o.maxOddsCeiling || l.odds < 1.05) {
      report.rejected.odds++;
      continue;
    }
    if (l.modelProb < 0.04) continue; // pure noise; can never be in a sensible slip
    pool.push({ ...l, logOdds: Math.log(l.odds), lp: Math.log(clamp(l.modelProb, 1e-6, 0.999)) });
  }
  report.eligible = pool.length;

  if (!pool.length) {
    return {
      ok: false,
      reason: 'NO_EDGE',
      message:
        "Nothing in today's market was quotable — no leg cleared the confidence floor. The engine would rather skip a day than roll a coin flip: skipping costs you a day, a bad slip costs you the run.",
      report,
      alternatives: [],
      fallback: buildFallback(legs, o),
    };
  }

  // Highest-edge leg per (event, marketType) to cut near-duplicates early.
  const deduped = dedupe(pool);
  deduped.sort((a, b) => b.modelProb - a.modelProb || b.edge - a.edge);

  const logLo = Math.log(lo);
  const logHi = Math.log(hi);
  const searchHi = logHi + 0.02; // don't carry states forward that can't come back into band

  /* ------------------------------------------------------------------ *
   * Bucketed depth-wise search.
   *
   * A greedy beam sorted by win probability collapses onto short-odds
   * partials and never discovers the 3-, 4- and 5-leg accumulators — the
   * short legs have already overshot the band by depth 3. Instead we index
   * partial combos by their odds product (log space, fixed bucket width) and
   * keep the best-scoring state in EACH bucket. That preserves the whole
   * reachable odds spectrum at bounded memory, so every leg count gets a fair
   * shot at the band.
   * ------------------------------------------------------------------ */
  const bucketWidth = 0.028;
  const found = [];
  const FOUND_CAP = 6000;
  const seenEventSets = new Set();

  const evalState = (st, depth) => {
    if (st.logOdds < logLo || st.logOdds > logHi) return;
    if (depth < o.minLegs) return;
    const winProb = clamp(Math.exp(st.logP) * st.corr, 0, 0.999);
    if (winProb < o.minWinProb) return;
    const combo = scoreCombo(st, winProb, target, o);
    const sig = combo.legs
      .map((l) => l.legId)
      .sort()
      .join('|');
    if (seenEventSets.has(sig)) return;
    seenEventSets.add(sig);
    if (found.length < FOUND_CAP) found.push(combo);
    else if (combo.score > found[found.length - 1].score) found[found.length - 1] = combo;
  };

  let frontier = new Map(); // bucketKey -> state
  frontier.set('0|-0', { legs: [], logOdds: 0, logP: 0, edge: 0, events: [], corr: 1 });

  for (let depth = 1; depth <= o.maxLegs; depth++) {
    const states = [...frontier.values()];
    if (!states.length) break;
    const buckets = new Map();
    let produced = 0;

    for (const st of states) {
      for (const leg of deduped) {
        if (st.events.includes(leg.eventId)) continue;
        const nlo = st.logOdds + leg.logOdds;
        if (nlo > searchHi) continue;
        const events = st.events.concat(leg.eventId);
        const legsArr = st.legs.concat(leg);
        const nst = {
          legs: legsArr,
          logOdds: nlo,
          logP: st.logP + leg.lp,
          edge: st.edge + leg.edge,
          events,
          corr: correlationFactor(legsArr),
        };
        produced++;
        evalState(nst, depth);

        const b = Math.floor(nlo / bucketWidth);
        const key = `${b}|${depth}`;
        const cur = buckets.get(key);
        // keep the best by win prob, but never evict a *different* leg-count
        // shape if it's within a whisker — diversity inside the bucket
        if (!cur || nst.logP > cur.logP) buckets.set(key, nst);
        if (buckets.size > 40000) break;
      }
      if (buckets.size > 40000) break;
    }

    frontier = buckets;
    if (produced === 0) break;
    if (found.length >= FOUND_CAP && depth >= 4) break;
  }

  report.bestOddsSpan = deduped.length
    ? [round(Math.min(...deduped.map((l) => l.odds)), 2), round(Math.max(...deduped.map((l) => l.odds)), 2)]
    : [0, 0];

  if (!found.length && o.minLegs > 1 && !o._relaxed) {
    // Nothing reached the band with the requested leg count. Fall back to
    // single-leg before giving up: a real 2.00 selection beats no slip at all.
    const solo = buildRolloverSlip(legs, { ...o, minLegs: 1, alternatives: 1, _relaxed: true });
    if (solo.ok) {
      solo.best.relaxedFromLegs = o.minLegs;
      solo.alternatives = [solo.best];
      solo.report.relaxed = true;
      return solo;
    }
  }

  if (!found.length) {
    return {
      ok: false,
      reason: 'NO_COMBO_IN_BAND',
      message: `The engine found ${report.eligible} legs with edge but could not assemble a combination inside ${lo.toFixed(2)}–${hi.toFixed(2)}. Widen the tolerance or drop the edge floor — or sit this day out.`,
      report,
      alternatives: [],
      fallback: buildFallback(legs, o),
    };
  }

  // ---- rank, apply the edge floor, then the leg-count preference -----
  found.sort((a, b) => b.score - a.score || b.winProb - a.winProb);
  const unconstrainedBest = found[0];

  /* Tiered edge relaxation. We would rather show you a slightly-below-floor
   * slip that is clearly labelled than silently hand you one long leg because
   * the strict filter found nothing. */
  const tiers = [
    { floor: o.minEdgePerLeg, label: 'strict' },
    { floor: Math.min(o.minEdgePerLeg, 0.004), label: 'relaxed' },
    { floor: 0, label: 'positive-edge only' },
    { floor: -Infinity, label: 'no edge floor' },
  ];
  let chosen = found;
  let tierUsed = tiers[tiers.length - 1];
  for (const t of tiers) {
    const c = t.floor === -Infinity ? found : found.filter((x) => x.avgEdge >= t.floor);
    if (c.length) {
      chosen = c;
      tierUsed = t;
      break;
    }
  }
  report.edgeTier = tierUsed.label;
  report.combosAtFloor = o.minEdgePerLeg > -Infinity ? found.filter((x) => x.avgEdge >= o.minEdgePerLeg).length : found.length;

  const { pool: ranked, note } = selectByMode(chosen, o.mode);
  const diversified = diversify(ranked, o.alternatives);
  const best = diversified[0];
  best.unconstrained = {
    legCount: unconstrainedBest.legCount,
    odds: unconstrainedBest.odds,
    winProbPct: unconstrainedBest.winProbPct,
  };
  best.modeNote = note;
  best.edgeTier = tierUsed.label;
  best.belowEdgeFloor = tierUsed.label !== 'strict' && o.minEdgePerLeg > 0;
  best.probCostPct =
    best.legCount !== unconstrainedBest.legCount ? round(unconstrainedBest.winProbPct - best.winProbPct, 2) : 0;

  return {
    ok: true,
    report,
    best,
    alternatives: diversified,
    poolSize: deduped.length,
    combosEvaluated: found.length,
    legCountSpread: legCountSpread(found),
  };
}

function scoreCombo(state, winProb, target, o = {}) {
  const odds = Math.exp(state.logOdds);
  const edgeSum = state.edge;
  const avgConf = mean(state.legs.map((l) => l.confidence));
  const evPerUnit = winProb * (odds - 1) - (1 - winProb);
  /* Base score = win probability, with edge / EV / confidence as tie-breakers.
   * Leg-count preference is applied afterwards in `selectByMode`, never here —
   * mixing them lets a bonus silently out-vote a real probability gap. */
  const score = winProb * 100 + edgeSum * 12 + Math.max(0, evPerUnit) * 20 + avgConf * 3;
  return {
    legs: state.legs.map(stripLeg),
    legCount: state.legs.length,
    odds: round(odds, 3),
    oddsDelta: round(odds - target, 3),
    winProb: round(winProb, 4),
    winProbPct: round(winProb * 100, 2),
    fairOdds: round(1 / winProb, 3),
    edgeSum: round(edgeSum, 4),
    avgEdge: round(edgeSum / state.legs.length, 4),
    avgConfidence: round(avgConf, 3),
    evPerUnit: round(evPerUnit, 4),
    evPct: round(evPerUnit * 100, 2),
    correlation: round(state.corr, 4),
    sports: uniq(state.legs.map((l) => l.sport)),
    leagues: uniq(state.legs.map((l) => l.league)),
    score: round(score, 4),
    grade: gradeCombo(winProb, state.corr, avgConf, edgeSum),
  };
}

/**
 * One 0-100 grade for a slip, so the UI can say "this is a good one" without
 * the user having to read four separate numbers.
 */
function gradeCombo(winProb, corr, conf, edge) {
  let g = 0;
  g += clamp((winProb - 0.25) / 0.35, 0, 1) * 42;
  g += clamp(edge / 0.08, 0, 1) * 24;
  g += clamp((conf - 0.35) / 0.45, 0, 1) * 22;
  g += corr * 12;
  return g >= 78 ? 'A+' : g >= 68 ? 'A' : g >= 56 ? 'B' : g >= 44 ? 'C' : 'D';
}

function selectByMode(found, mode) {
  if (mode === 'max' || !found.length) return { pool: found, note: 'Highest win probability, leg count unconstrained.' };
  const maxProbCost = mode === 'combo' ? 14 : 6.5;
  const targetLegs = mode === 'combo' ? 4 : 3;
  const best = found[0];

  for (let want = targetLegs; want >= 2; want--) {
    const cands = found.filter((c) => c.legCount >= want && (best.winProbPct - c.winProbPct) <= maxProbCost);
    if (cands.length) {
      const pick = cands.sort((a, b) => b.legCount - a.legCount || b.score - a.score);
      const note =
        want >= targetLegs
          ? `Accumulator mode: kept ${want}+ legs while giving up at most ${maxProbCost} points of win probability.`
          : `Wanted ${targetLegs}+ legs; the day's market only supports ${want}+ without sacrificing too much probability.`;
      return { pool: pick, note };
    }
  }
  return { pool: found, note: 'No multi-leg combination was close enough in probability — falling back to the strongest slip available.' };
}

function legCountSpread(found) {
  const out = {};
  for (const c of found) {
    if (!out[c.legCount] || c.winProbPct > out[c.legCount].winProbPct) out[c.legCount] = { odds: c.odds, winProbPct: c.winProbPct };
  }
  return Object.keys(out)
    .sort((a, b) => a - b)
    .map((k) => ({ legs: Number(k), odds: out[k].odds, winProbPct: out[k].winProbPct }));
}

function stripLeg(l) {
  const { logOdds, lp, ...rest } = l;
  return rest;
}

/** Keep the best combo per distinct "shape" so the user gets real choices. */
function diversify(found, n) {
  const out = [];
  const seen = new Set();
  for (const c of found) {
    const shape = `${c.legCount}|${c.sports.slice().sort().join(',')}|${c.legs.map((l) => l.eventId).sort().join('+')}`;
    if (seen.has(shape)) continue;
    seen.add(shape);
    out.push(c);
    if (out.length >= n) break;
  }
  // guarantee leg-count diversity if everything collapsed to one shape
  if (out.length < n) {
    const byCount = new Map();
    for (const c of found) {
      if (!byCount.has(c.legCount)) byCount.set(c.legCount, c);
    }
    for (const c of byCount.values()) {
      if (out.includes(c)) continue;
      out.push(c);
      if (out.length >= n) break;
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/** One leg per (event, marketType); prefer the higher-edge version. */
function dedupe(pool) {
  const best = new Map();
  for (const l of pool) {
    const k = `${l.eventId}|${l.marketType}`;
    const cur = best.get(k);
    if (!cur || l.edge > cur.edge || (l.edge === cur.edge && l.modelProb > cur.modelProb)) best.set(k, l);
  }
  return [...best.values()];
}

/**
 * When the strict engine refuses to roll, still show the user the most
 * sensible "if you insist" slip — clearly labelled as below threshold.
 */
function buildFallback(legs, o) {
  const soft = { ...o, minEdgePerLeg: -0.02, minConfidence: 0.1, minWinProb: 0.05 };
  const pool = legs
    .filter((l) => l.odds > 1.05 && l.odds < soft.maxOddsCeiling)
    .map((l) => ({ ...l, logOdds: Math.log(l.odds), lp: Math.log(clamp(l.modelProb, 1e-6, 0.999)) }))
    .sort((a, b) => b.modelProb - a.modelProb);

  const logLo = Math.log(o.targetOdds - o.tolerance);
  const logHi = Math.log(o.targetOdds + o.tolerance);
  let beam = [{ legs: [], logOdds: 0, logP: 0, edge: 0, events: new Set(), corr: 1 }];
  const found = [];
  for (let depth = 1; depth <= o.maxLegs; depth++) {
    const next = [];
    for (const st of beam) {
      for (const leg of pool.slice(0, 120)) {
        if (st.events.has(leg.eventId)) continue;
        const nlo = st.logOdds + leg.logOdds;
        if (nlo > logHi + 0.4) continue;
        const events = new Set(st.events);
        events.add(leg.eventId);
        const legsArr = st.legs.concat(leg);
        const ns = { legs: legsArr, logOdds: nlo, logP: st.logP + leg.lp, edge: st.edge + leg.edge, events, corr: correlationFactor(legsArr) };
        if (nlo >= logLo && nlo <= logHi) {
          const wp = clamp(Math.exp(ns.logP) * ns.corr, 0, 0.999);
          if (wp >= soft.minWinProb) found.push(scoreCombo(ns, wp, o.targetOdds, o));
        }
        if (nlo < logHi) next.push(ns);
      }
    }
    if (!next.length) break;
    next.sort((a, b) => b.logP - a.logP);
    beam = next.slice(0, 120);
    if (found.length > 4000) break;
  }
  if (!found.length) return null;
  found.sort((a, b) => b.score - a.score);
  return { ...found[0], belowThreshold: true };
}

const uniq = (arr) => [...new Set(arr)];

/* ------------------------------------------------------------------ *
 * Leg swapping — lets the user tune a slip while staying in band
 * ------------------------------------------------------------------ */

/**
 * Replace one leg of a combo with the best available substitute that keeps
 * the total odds inside the band and doesn't reuse an event.
 */
function suggestSwap(combo, legIndex, allLegs, opts = {}) {
  const o = { ...DEFAULT_BUILDER_OPTS, ...opts };
  const lo = o.targetOdds - o.tolerance;
  const hi = o.targetOdds + o.tolerance;
  const keep = combo.legs.filter((_, i) => i !== legIndex);
  const baseOdds = keep.reduce((a, l) => a * l.odds, 1);
  const baseP = keep.reduce((a, l) => a * l.modelProb, 1);
  const usedEvents = new Set(keep.map((l) => l.eventId));
  const needLo = lo / baseOdds;
  const needHi = hi / baseOdds;

  const cands = allLegs
    .filter((l) => !usedEvents.has(l.eventId) && l.odds >= needLo && l.odds <= needHi)
    .map((l) => ({
      leg: l,
      odds: round(baseOdds * l.odds, 3),
      winProb: round(baseP * l.modelProb * correlationFactor(keep.concat(l)), 4),
      score: baseP * l.modelProb * 100 + l.edge * 12,
    }))
    .sort((a, b) => b.score - a.score);

  return cands.slice(0, 5).map((c) => ({
    ...stripLeg(c.leg),
    newTotalOdds: c.odds,
    newWinProb: c.winProb,
  }));
}
__exp_31 = buildRolloverSlip;
__exp_32 = DEFAULT_BUILDER_OPTS;
}

/* ════════════════════════════════════════════════════════════════════════
   lib/scan.js   →  hoists scanForDay, scanDay, PROVIDERS, fetchOddsApi
   ════════════════════════════════════════════════════════════════════════ */
let __exp_33;
let __exp_34;
let __exp_35;
let __exp_36;
{
const buildDayEvents = __exp_18;
const tzDateKey = __exp_19;
const tzNowParts = __exp_20;
const formatKickoff = __exp_21;
const priceEvent = __exp_28;
const extractLegs = __exp_29;
const applyMarketInformation = __exp_26;
const buildRolloverSlip = __exp_31;
const DEFAULT_BUILDER_OPTS = __exp_32;
const makeRng = __exp_8;
const clamp = __exp_6;
const round = __exp_7;

/**
 * scan.js — the market scanner.
 *
 *   day → fixtures → bookmaker prices → de-vigged fair prices → model blend
 *       → per-leg edge & confidence → flat leg pool → (builder)
 *
 * Providers:
 *   sim     — the built-in market simulator (default; fully deterministic,
 *             needs no API key, and is what makes the Monte-Carlo lab honest)
 *   manual  — you paste in real odds you've seen at your book; the engine
 *             de-vigs and blends them with the ratings model exactly the same
 *   oddsapi — The Odds API (https://the-odds-api.com). Set ODDS_API_KEY and
 *             it will pull live prices instead of simulated ones.
 */






const PROVIDERS = {
  sim: {
    id: 'sim',
    name: 'Simulated market',
    blurb: 'Built-in multi-book price simulator. Deterministic, no key needed, models vig + book bias.',
    needsKey: false,
    live: false,
  },
  manual: {
    id: 'manual',
    name: 'Manual odds entry',
    blurb: 'Paste real prices from your bookmaker. The engine de-vigs them and blends with its ratings model.',
    needsKey: false,
    live: true,
  },
  oddsapi: {
    id: 'oddsapi',
    name: 'The Odds API',
    blurb: 'Live multi-book prices. Requires ODDS_API_KEY in the environment or in settings.',
    needsKey: true,
    live: true,
  },
};

const DAY_CACHE = new Map();
const DAY_CACHE_LIMIT = 24;

/**
 * Scan one day and return the full analytics bundle.
 * @param {string} dayKey  YYYY-MM-DD (in the run's timezone)
 * @param {object} opts    { tz, provider, eventsPerDay, manualOdds, apiKey, marketInefficiency, builder }
 */
function scanDay(dayKey, opts = {}) {
  const provider = opts.provider || 'sim';
  if (provider === 'manual' && opts.manualOdds?.length) {
    return scanManual(dayKey, opts);
  }
  if (provider === 'oddsapi' && opts.apiKey) {
    // Live fetch is async; the caller (server) uses scanDayLive for that path.
    return scanDaySyncFallback(dayKey, opts, 'oddsapi requires an async scan — use /api/scan/async');
  }
  return scanSim(dayKey, opts);
}

function scanSim(dayKey, opts = {}) {
  const tz = opts.tz || 'UTC';
  const cacheKey = `${dayKey}|${tz}|${opts.eventsPerDay ?? 26}|${opts.marketInefficiency ?? 1}`;
  if (DAY_CACHE.has(cacheKey)) return DAY_CACHE.get(cacheKey);

  const ineff = clamp(opts.marketInefficiency ?? 1, 0.2, 3);
  const events = buildDayEvents(dayKey, { tz, eventsPerDay: opts.eventsPerDay });
  const now = Date.now();

  const legs = [];
  const pricedEvents = [];
  const diagnostics = {
    dayKey,
    tz,
    provider: 'sim',
    events: events.length,
    markets: 0,
    pricesQuoted: 0,
    /* Book NAMES, deduplicated. This used to be `diagnostics.books.add(b)` over
     * `m.books`, but m.books holds one quote OBJECT per book per market
     * ({book, cls, odds, margin}), and every object is unique — so the Set
     * deduplicated nothing and grew to one entry per market-quote. That is a
     * display bug ("1087 books compared") and, worse, it is copied into each
     * day's persisted scan, where it added ~71 KB per day. A seven-day run came
     * to 544 KB, which is a ninth of the browser's whole localStorage quota. */
    bookNames: new Set(),
    bookQuotes: 0,
    avgOverround: [],
  };

  for (const e of events) {
    const kickoffHours = clamp((e.kickoff - now) / 3600000, 0, 72);
    // truth.js injects the information the market holds and our ratings don't.
    // The engine only ever sees ratings + prices; truth is for settlement.
    const truth = applyMarketInformation(e);
    const priced = priceEvent(e, truth, { tier: e.league.tier, kickoffHours, marketInefficiency: ineff });
    const ev = { ...e, markets: priced.markets, books: priced.books, kickoffHours: round(kickoffHours, 1) };
    pricedEvents.push(ev);
    diagnostics.markets += priced.markets.length;
    for (const m of priced.markets) {
      diagnostics.pricesQuoted += m.books.length * m.outcomes.length;
      diagnostics.avgOverround.push(m.overround);
      diagnostics.bookQuotes += m.books.length;
      for (const b of m.books) diagnostics.bookNames.add(b.book);
    }
    legs.push(...extractLegs(ev));
  }

  diagnostics.books = [...diagnostics.bookNames].sort();
  diagnostics.bookCount = diagnostics.books.length;
  delete diagnostics.bookNames;
  diagnostics.avgOverround = round(
    diagnostics.avgOverround.reduce((a, b) => a + b, 0) / Math.max(1, diagnostics.avgOverround.length),
    2
  );
  diagnostics.avgEdge = round((legs.reduce((a, l) => a + l.edge, 0) / Math.max(1, legs.length)) * 100, 2);
  diagnostics.positiveEdgeLegs = legs.filter((l) => l.edge > 0).length;
  diagnostics.bestEdgeLegs = [...legs].sort((a, b) => b.edge - a.edge).slice(0, 12).map(briefLeg);
  // Hidden diagnostics: how wrong the model is, and how much of that is the
  // market simply knowing more than our ratings do. The Lab reads these.
  const err = (k) => round((legs.reduce((a, l) => a + Math.abs(l[k] ?? 0), 0) / Math.max(1, legs.length)) * 100, 2);
  const errVs = (f) => round((legs.reduce((a, l) => a + Math.abs(f(l) - l.truthProb), 0) / Math.max(1, legs.length)) * 100, 2);
  diagnostics.modelErrorPp = err('modelError');
  diagnostics.ratingsErrorPp = err('ratingsError');
  diagnostics.consensusErrorPp = errVs((l) => l.fairProb);
  diagnostics.sharpErrorPp = errVs((l) => l.sharpProb);
  diagnostics.impliedErrorPp = errVs((l) => l.impliedProb);
  diagnostics.trueEvPct = round((legs.reduce((a, l) => a + (l.trueEvPerUnit ?? 0), 0) / Math.max(1, legs.length)) * 100, 2);
  diagnostics.edgeLegTrueEvPct = round(
    (legs.filter((l) => l.edge > 0.012).reduce((a, l) => a + (l.trueEvPerUnit ?? 0), 0) /
      Math.max(1, legs.filter((l) => l.edge > 0.012).length)) * 100,
    2
  );

  const result = { dayKey, events: pricedEvents, legs, diagnostics };
  if (DAY_CACHE.size > DAY_CACHE_LIMIT) DAY_CACHE.clear();
  DAY_CACHE.set(cacheKey, result);
  return result;
}

function scanDaySyncFallback(dayKey, opts, note) {
  const r = scanSim(dayKey, opts);
  r.diagnostics.provider = 'sim';
  r.diagnostics.note = note;
  return r;
}

/* ------------------------------------------------------------------ *
 * Manual provider
 * ------------------------------------------------------------------ */

/**
 * Accept odds the user has actually seen.
 * manualOdds: [{ sport, league, kickoff, home, away, market, outcomes: [{key,label,odds}] , modelP?: number[] }]
 *
 * We de-vig what they give us, blend with the ratings model where we have one,
 * and produce exactly the same leg objects the builder consumes.
 */
function scanManual(dayKey, opts = {}) {
  const entries = opts.manualOdds || [];
  const legs = [];
  const pricedEvents = [];
  for (const [i, entry] of enumerate(entries)) {
    const oddsList = entry.outcomes.map((o) => Number(o.odds));
    const impl = oddsList.map((o) => 1 / o);
    const sum = impl.reduce((a, b) => a + b, 0);
    const fair = impl.map((p) => p / sum);
    const modelGiven = entry.modelP && entry.modelP.length === impl.length ? entry.modelP : fair;
    const blended = fair.map((f, k) => clamp(0.72 * f + 0.28 * modelGiven[k], 0.001, 0.999));
    const bSum = blended.reduce((a, b) => a + b, 0);
    const model = blended.map((b) => b / bSum);

    const ev = {
      id: entry.id || `manual-${dayKey}-${i}`,
      sport: entry.sport || 'football',
      league: { code: (entry.league || 'MANUAL').toUpperCase().slice(0, 8), name: entry.league || 'Manual entry', tier: entry.tier ?? 2, noise: 0.08 },
      kickoff: entry.kickoff ? Date.parse(entry.kickoff) : Date.now() + 86400000,
      kickoffLocal: entry.kickoff ? formatKickoff(Date.parse(entry.kickoff), opts.tz || 'UTC') : 'user supplied',
      home: { name: entry.home || 'Home' },
      away: { name: entry.away || 'Away' },
      markets: [
        {
          key: entry.marketKey || 'manual',
          name: entry.market || 'Selection',
          type: 'manual',
          overround: round((sum - 1) * 100, 2),
          outcomes: entry.outcomes.map((o, k) => ({
            key: o.key || `o${k}`,
            label: o.label || o.pick || `Selection ${k + 1}`,
            odds: Number(o.odds),
            bestBook: o.book || 'your book',
            avgOdds: Number(o.odds),
            impliedProb: round(impl[k], 4),
            fairProb: round(fair[k], 4),
            sharpProb: round(fair[k], 4),
            modelProb: round(model[k], 4),
            truthProb: round(model[k], 4),
            edge: round(model[k] - impl[k], 4),
            edgePct: round((model[k] - impl[k]) * 100, 2),
            evPerUnit: round(model[k] * (Number(o.odds) - 1) - (1 - model[k]), 4),
            kelly: 0,
            confidence: round(clamp(entry.confidence ?? 0.55, 0.1, 0.95), 3),
            confidenceBand: 'B',
          })),
          books: [],
        },
      ],
    };
    pricedEvents.push(ev);
    legs.push(...extractLegs(ev));
  }
  return {
    dayKey,
    events: pricedEvents,
    legs,
    diagnostics: {
      dayKey,
      provider: 'manual',
      events: pricedEvents.length,
      markets: pricedEvents.length,
      pricesQuoted: legs.length,
      books: [],
      avgOverround: round(mean(legs.map((l) => l.impliedProb)) * 0 + 5, 2),
      positiveEdgeLegs: legs.filter((l) => l.edge > 0).length,
      bestEdgeLegs: [...legs].sort((a, b) => b.edge - a.edge).slice(0, 12).map(briefLeg),
      note: 'Manual mode: edge is measured against the de-vigged version of the prices you entered.',
    },
  };
}

/* ------------------------------------------------------------------ *
 * Full scan → recommended slip for a rollover day
 * ------------------------------------------------------------------ */

function scanForDay(dayKey, runConfig, overrides = {}) {
  const opts = {
    tz: runConfig.tz || 'UTC',
    provider: runConfig.provider || 'sim',
    eventsPerDay: runConfig.eventsPerDay || 26,
    marketInefficiency: runConfig.marketInefficiency ?? 1,
    manualOdds: overrides.manualOdds,
    ...overrides,
  };
  const scan = scanDay(dayKey, opts);
  const builderOpts = {
    ...DEFAULT_BUILDER_OPTS,
    ...(runConfig.builder || {}),
    ...(overrides.builder || {}),
  };
  const result = buildRolloverSlip(scan.legs, builderOpts);
  return {
    scan,
    builder: result,
    builderOpts,
    legs: scan.legs,
    events: scan.events,
    diagnostics: scan.diagnostics,
  };
}

/* ------------------------------------------------------------------ *
 * Live provider (The Odds API) — async path used by the server
 * ------------------------------------------------------------------ */

const SPORT_MAP = [
  { key: 'soccer_epl', sport: 'football', league: 'Premier League', tier: 1, noise: 0.05, base: 1.42 },
  { key: 'soccer_spain_la_liga', sport: 'football', league: 'La Liga', tier: 1, noise: 0.05, base: 1.3 },
  { key: 'soccer_italy_serie_a', sport: 'football', league: 'Serie A', tier: 1, noise: 0.05, base: 1.34 },
  { key: 'soccer_germany_bundesliga', sport: 'football', league: 'Bundesliga', tier: 1, noise: 0.05, base: 1.58 },
  { key: 'soccer_france_ligue_one', sport: 'football', league: 'Ligue 1', tier: 1, noise: 0.05, base: 1.38 },
  { key: 'soccer_brazil_campeonato', sport: 'football', league: 'Brasileirão', tier: 2, noise: 0.07, base: 1.16 },
  { key: 'basketball_nba', sport: 'basketball', league: 'NBA', tier: 1, noise: 0.045, base: 114, sigma: 11.6 },
  { key: 'baseball_mlb', sport: 'baseball', league: 'MLB', tier: 1, noise: 0.05, base: 4.55, sigma: 3.5 },
  { key: 'tennis_atp', sport: 'tennis', league: 'ATP', tier: 1, noise: 0.055, scale: 7.5 },
];

async function fetchOddsApi(sports, apiKey, { daysAhead = 2 } = {}) {
  const out = [];
  const until = new Date(Date.now() + daysAhead * 86400000).toISOString().slice(0, 10);
  for (const s of SPORT_MAP) {
    if (sports && sports.length && !sports.includes(s.key)) continue;
    const url =
      `https://api.the-odds-api.com/v4/sports/${s.key}/odds/?apiKey=${encodeURIComponent(apiKey)}` +
      `&regions=eu,uk&markets=h2h,totals,spreads&dateFormat=iso&oddsFormat=decimal&endDate=${until}`;
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) continue;
      const json = await res.json();
      for (const g of json) out.push(normaliseOddsApiGame(g, s));
    } catch {
      /* network-restricted or bad key — skip this league */
    }
  }
  return out;
}

function normaliseOddsApiGame(g, meta) {
  const books = (g.bookmakers || []).map((b) => ({
    name: b.title,
    cls: /pinnacle|sbobet|circa|cris/i.test(b.title) ? 'sharp' : /bet365|unibet|william/i.test(b.title) ? 'mid' : 'soft',
    markets: b.markets,
  }));
  return {
    id: g.id,
    sport: meta.sport,
    league: { code: meta.key.toUpperCase().slice(0, 10), name: meta.league, tier: meta.tier, noise: meta.noise, base: meta.base, sigma: meta.sigma, scale: meta.scale },
    kickoff: Date.parse(g.commence_time),
    home: { name: g.home_team },
    away: { name: g.away_team },
    books,
  };
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function briefLeg(l) {
  return {
    eventId: l.eventId,
    sport: l.sport,
    league: l.league,
    match: `${l.home} v ${l.away}`,
    market: l.market,
    pick: l.pick,
    odds: l.odds,
    edgePct: round(l.edge * 100, 2),
    modelProbPct: round(l.modelProb * 100, 2),
    impliedProbPct: round(l.impliedProb * 100, 2),
    confidence: l.confidence,
    band: l.band,
    kickoff: l.kickoff,
  };
}

function* enumerate(arr) {
  let i = 0;
  for (const v of arr) yield [i++, v];
}

function mean(a) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}
__exp_33 = scanForDay;
__exp_34 = scanDay;
__exp_35 = PROVIDERS;
__exp_36 = fetchOddsApi;
}

/* ════════════════════════════════════════════════════════════════════════
   lib/settle.js   →  hoists settleLegs, settleByTruthProb
   ════════════════════════════════════════════════════════════════════════ */
let __exp_37;
let __exp_38;
{
const simulateResult = __exp_16;
const makeRng = __exp_8;
const round = __exp_7;
const buildDayEvents = __exp_18;

/**
 * settle.js — resolves a slip against ground truth.
 *
 * One event = one simulated scoreline, and every market on that event is
 * resolved FROM that scoreline. That means the settlement is internally
 * consistent (Over 2.5 can never win while Over 1.5 loses on the same match)
 * and it is deterministic per (event id, settle nonce) — re-settling a slip
 * always gives the same answer, which is what makes the Monte-Carlo lab and
 * the test suite reproducible.
 */




/**
 * @param {object[]} legs        slip legs (need eventId, marketKey, pickKey, odds, truthProb)
 * @param {object}   ctx         { dayKey, nonce, tz, eventsPerDay, marketInefficiency }
 * @returns {object} settlement report
 */
function settleLegs(legs, ctx = {}) {
  const dayKey = ctx.dayKey;
  const nonce = ctx.nonce || '0';

  // Lazy import avoids a cycle: fixtures → model, settle → fixtures.
  const events = buildEventsFor(dayKey, ctx);
  const byId = new Map(events.map((e) => [e.id, e]));

  const resolved = [];
  let allWon = true;
  const resultCache = new Map();

  for (const leg of legs) {
    const event = byId.get(leg.eventId);
    if (!event) {
      resolved.push({ ...legSummary(leg), status: 'UNKNOWN', note: 'fixture not found for this day' });
      allWon = false;
      continue;
    }
    let result = resultCache.get(event.id);
    if (!result) {
      const rng = makeRng(`${event.truthSeed}|${nonce}`);
      result = simulateResult(event, rng);
      resultCache.set(event.id, result);
    }
    const won = result.winners[leg.marketKey] ? result.winners[leg.marketKey].has(leg.pickKey) : false;
    if (!won) allWon = false;
    resolved.push({
      ...legSummary(leg),
      status: won ? 'WON' : 'LOST',
      result: result.display,
      scoreline: result.score ? `${result.score.home}-${result.score.away}` : null,
      outcomeSummary: result.summary,
      truthProbPct: round((leg.truthProb ?? 0) * 100, 2),
    });
  }

  const odds = legs.reduce((a, l) => a * l.odds, 1);
  return {
    allWon,
    legsWon: resolved.filter((r) => r.status === 'WON').length,
    legsTotal: resolved.length,
    odds: round(odds, 3),
    resolved,
    settledAt: new Date().toISOString(),
  };
}

function legSummary(l) {
  return {
    legId: l.legId,
    eventId: l.eventId,
    sport: l.sport,
    league: l.league,
    match: `${l.home} v ${l.away}`,
    market: l.market,
    pick: l.pick,
    odds: l.odds,
    modelProbPct: round((l.modelProb ?? 0) * 100, 2),
    edgePct: round((l.edge ?? 0) * 100, 2),
    confidence: l.confidence,
  };
}

/**
 * Resolve a slip purely from its stored true probabilities, without needing
 * the fixture universe. Used by the Monte-Carlo lab (fast) and by manual-mode
 * settlement (where there is no simulated truth).
 */
function settleByTruthProb(legs, rng) {
  const resolved = legs.map((l) => {
    const p = l.truthProb ?? l.modelProb;
    const won = rng() < p;
    return { ...legSummary(l), status: won ? 'WON' : 'LOST', truthProbPct: round(p * 100, 2) };
  });
  return {
    allWon: resolved.every((r) => r.status === 'WON'),
    legsWon: resolved.filter((r) => r.status === 'WON').length,
    legsTotal: resolved.length,
    odds: round(legs.reduce((a, l) => a * l.odds, 1), 3),
    resolved,
  };
}

/* ------------------------------------------------------------------ */

function buildEventsFor(dayKey, ctx) {
  return buildDayEvents(dayKey, {
    tz: ctx.tz || 'UTC',
    eventsPerDay: ctx.eventsPerDay || 26,
  });
}

/** Kept for API symmetry with older callers; settlement needs no async setup. */
async function initSettle() {
  return true;
}
__exp_37 = settleLegs;
__exp_38 = settleByTruthProb;
}

/* ════════════════════════════════════════════════════════════════════════
   lib/suggestions.js   →  hoists suggestNextRun, suggestRecovery, money
   ════════════════════════════════════════════════════════════════════════ */
let __exp_39;
let __exp_40;
let __exp_41;
{
const clamp = __exp_6;
const round = __exp_7;
const mean = __exp_10;
const upcomingDays = __exp_22;
const tzDateKey = __exp_19;
const tzNowParts = __exp_20;
const formatKickoff = __exp_21;
const buildDayEvents = __exp_18;

/**
 * suggestions.js — answers two questions:
 *
 *   1. "We won / we lost — when do we go again, and with what?"
 *   2. "Which day of the week is actually good for a rollover?"
 *
 * It scores the upcoming calendar by real fixture density (from the same
 * generator the scanner uses), by whether today still has actionable kickoffs
 * left, and by the lineage of previous runs — if two runs both died on day 4
 * at 2.20 odds, the engine stops pretending that's bad luck and turns the
 * target down.
 */



const DAY_MS = 86400000;

/**
 * Recommend the start of the next rollover.
 * @param {object} run    the finished (or in-flight) run
 * @param {object} opts   { now }
 */
/** Sensible defaults so the calendar can be consulted with no run in the store. */
const BARE_CFG = {
  currency: 'NGN', stake: 500, days: 7, targetOdds: 2, tolerance: 0.1,
  provider: 'sim', tz: 'Africa/Lagos', eventsPerDay: 42, marketInefficiency: 1.3,
  reservePct: 0, reserveCapPct: 40, autoAdvance: true, builder: {},
};

function suggestNextRun(run, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  /* `run` is optional: "which day should I start?" is a fair question before
   * you have started anything. Fall back to the house defaults and a stub
   * stats/lineage so every downstream read still works. */
  const cfg = { ...(run?.config || BARE_CFG), ...(opts.config || {}) };
  if (!run) {
    run = {
      config: cfg,
      stats: { settled: 0, won: 0, lost: 0, skipped: 0, peak: cfg.stake, totalStaked: 0 },
      lineage: [],
      days: [],
      daysPlanned: cfg.days,
      balance: cfg.stake,
      startBalance: cfg.stake,
      currency: cfg.currency,
      baseStake: cfg.stake,
    };
  }
  const tz = cfg.tz || 'UTC';
  const nowParts = tzNowParts(now, tz);
  const todayKey = nowParts.dayKey;

  const horizon = upcomingDays(todayKey, 12, { tz, eventsPerDay: cfg.eventsPerDay });

  // ---- can we still start today? -----------------------------------
  const todayShape = horizon[0];
  const todayEventsLeft = countActionableToday(run, todayKey, now, tz);
  const canStartToday = todayEventsLeft >= Math.max(4, Math.ceil(cfg.days * 0.6));

  /* Never suggest a day that has already happened. A finished run suggests
   * tomorrow at the earliest unless there is genuinely enough football left
   * today to roll — starting a "7-day run" with four hours of evening kickoffs
   * left is how people end up staking on whatever is on screen. */
  const earliestIndex = canStartToday ? 0 : 1;

  // ---- pick the best start day in the horizon ----------------------
  // A good rollover start is a day with a deep market AND a full week of
  // deep markets behind it (you need 7 consecutive workable days, not one).
  const scored = horizon.map((shape, i) => {
    const runWindow = horizon.slice(i, i + cfg.days);
    if (i < earliestIndex) return null;
    if (runWindow.length < cfg.days) return null;
    const windowScore = runWindow.length ? mean(runWindow.map((s) => s.score)) : shape.score;
    const weakest = runWindow.length ? Math.min(...runWindow.map((s) => s.score)) : shape.score;
    const startHourPenalty = shape.firstKickoff ? clamp((hourOf(shape.firstKickoff, tz) - 11) / 12, 0, 1) * 0.06 : 0;
    const score = clamp(0.5 * windowScore + 0.3 * weakest + 0.2 * shape.score - startHourPenalty, 0, 1);
    return { ...shape, score: round(score, 3), windowScore: round(windowScore, 3), weakestDay: round(weakest, 3), index: i };
  }).filter(Boolean);

  if (!scored.length) {
    return emptySuggestion(cfg, todayKey, tz, now);
  }
  const best = scored.slice().sort((a, b) => b.score - a.score)[0];
  // Prefer the soonest workable day; only push later if it is clearly worse.
  const recommended =
    scored[0].score >= best.score - 0.06 ? scored[0] : best;

  const startDay = recommended.dayKey;
  /* The suggested start hour must be in the future AND before the first
     kickoff of the day — otherwise we tell the user to "start today at 09:00"
     at four in the afternoon, which is useless. */
  const nowHour = nowParts.hour;
  const firstKoHour = recommended.firstKickoff ? hourOf(recommended.firstKickoff, tz) : 20;
  const lowerBound = startDay === todayKey ? clamp(nowHour + 1, 0, 23) : 9;
  const startHour = clamp(firstKoHour - 2, lowerBound, Math.max(lowerBound, firstKoHour - 1));
  const hh = String(clamp(startHour, 0, 23)).padStart(2, '0');
  const startLabel =
    startDay === todayKey
      ? `today from ${hh}:00 local — ${todayEventsLeft} fixtures still to kick off`
      : `${recommended.weekday} ${startDay}, from ~${hh}:00 local (first kickoff ${recommended.firstKickoffLocal || '—'})`;

  // ---- stake & odds recommendation ---------------------------------
  const lineage = run.lineage || [];
  const losses = lineage.filter((l) => l.status === 'lost');
  const wins = lineage.filter((l) => l.status === 'complete');
  const recentDeaths = losses.slice(-3).map((l) => l.diedOnDay).filter(Boolean);
  const sameDayTwice = recentDeaths.length >= 2 && new Set(recentDeaths).size === 1;

  const profit = round(run.balance - run.startBalance, 2);
  let recommendedStake = cfg.stake;
  let recommendedOdds = cfg.targetOdds;
  const stakeNotes = [];
  const oddsNotes = [];

  if (run.status === 'complete') {
    // Never compound the whole pot. Stake the base unit again, bank the rest.
    recommendedStake = cfg.stake;
    stakeNotes.push(
      `Restart at your base unit ${money(cfg.currency, cfg.stake)} and move the ${money(cfg.currency, profit)} profit somewhere it cannot be re-staked.`
    );
    if (cfg.targetOdds > 2.0) {
      recommendedOdds = round(Math.max(1.7, cfg.targetOdds - 0.1), 2);
      oddsNotes.push('You just proved the target is reachable — but take 0.10 off it and the run becomes materially more likely.');
    }
  } else if (run.status === 'lost') {
    recommendedStake = cfg.stake;
    stakeNotes.push(`Flat stake again: ${money(cfg.currency, cfg.stake)}. Do not add to recover a loss.`);
    if (sameDayTwice) {
      recommendedOdds = round(Math.max(1.6, cfg.targetOdds - 0.2), 2);
      oddsNotes.push(
        `Runs keep dying on day ${recentDeaths[0]}. That is the odds target, not bad luck — dropping to ${recommendedOdds.toFixed(2)} raises each day's win chance by roughly ${(dayLift(cfg.targetOdds, recommendedOdds) * 100).toFixed(1)} points.`
      );
    } else if (losses.length >= 2 && cfg.targetOdds > 1.85) {
      recommendedOdds = round(cfg.targetOdds - 0.1, 2);
      oddsNotes.push(`Second loss in a row at ${cfg.targetOdds.toFixed(2)}. Nudge down to ${recommendedOdds.toFixed(2)}.`);
    }
  } else {
    stakeNotes.push(`Base stake ${money(cfg.currency, cfg.stake)}.`);
  }

  // ---- expected outcome at the recommended settings -----------------
  /* Per-day win chance. If we have realised data from this run (or its
   * lineage) use it — it beats a generic 1/odds guess, which is what a
   * fair-odds punter would assume and which ignores the edge entirely. */
  const realisedDaily = realisedDailyProb(run, recommendedOdds, cfg.targetOdds);
  const pDay = clamp(realisedDaily, 0.03, 0.97);
  const pRun = pDay ** cfg.days;
  const payout = round(recommendedStake * recommendedOdds ** cfg.days, 2);

  return {
    startDay,
    startDayLabel: startLabel,
    startHourLocal: startHour,
    canStartToday,
    todayEventsLeft,
    recommendedStake: round(recommendedStake, 2),
    recommendedOdds,
    stakeNotes,
    oddsNotes,
    reason: buildReason(recommended, canStartToday, todayShape, cfg),
    bestWindow: {
      dayKey: best.dayKey,
      weekday: best.weekday,
      score: best.score,
      windowScore: best.windowScore,
      weakestDay: best.weakestDay,
      label: best.label,
    },
    calendar: scored.slice(0, 9).map((s) => ({
      dayKey: s.dayKey,
      weekday: s.weekday,
      events: s.events,
      markets: s.markets,
      sports: Object.keys(s.bySport).length,
      score: s.score,
      label: s.label,
      recommended: s.dayKey === startDay,
    })),
    expectation: {
      odds: recommendedOdds,
      days: cfg.days,
      stake: round(recommendedStake, 2),
      payoutIfComplete: payout,
      multiple: round(recommendedOdds ** cfg.days, 2),
      modelledRunWinPct: round(pRun * 100, 2),
      dailyWinProbPct: round(pDay * 100, 2),
      dailyProbSource: realisedDailySource,
      oneIn: Math.round(1 / clamp(pRun, 1e-6, 1)),
    },
    timezone: tz,
    generatedAt: now.toISOString(),
  };
}

let realisedDailySource = 'model';

/**
 * Best available estimate of the per-day win probability, preferring what
 * actually happened over what the odds imply.
 */
function realisedDailyProb(run, forOdds, atOdds) {
  const observed = (run.days || []).filter((d) => d.slip).map((d) => d.slip.winProb);
  const lineage = (run.lineage || []).map((l) => l.realisedDailyProb).filter(Boolean);
  const pool = [...observed, ...lineage];
  if (pool.length >= 2) {
    const at = mean(pool);
    realisedDailySource = `measured across ${pool.length} slips in this run and its lineage`;
    // shift the measurement if the recommended odds differ from what was played
    const shift = forOdds !== atOdds ? dayLift(atOdds, forOdds) : 0;
    return clamp(at + shift, 0.03, 0.97);
  }
  realisedDailySource = 'assumed from the odds target (no history yet)';
  return clamp(1 / forOdds + 0.03, 0.03, 0.97);
}

function emptySuggestion(cfg, todayKey, tz, now) {
  const d = new Date(Date.parse(`${todayKey}T12:00:00Z`) + DAY_MS);
  const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return {
    startDay: key,
    startDayLabel: `tomorrow (${key})`,
    startHourLocal: 12,
    canStartToday: false,
    todayEventsLeft: 0,
    recommendedStake: cfg.stake,
    recommendedOdds: cfg.targetOdds,
    stakeNotes: [],
    oddsNotes: [],
    reason: 'Not enough of today left to roll properly — start fresh tomorrow.',
    bestWindow: null,
    calendar: [],
    expectation: { odds: cfg.targetOdds, days: cfg.days, stake: cfg.stake, payoutIfComplete: round(cfg.stake * cfg.targetOdds ** cfg.days, 2), multiple: round(cfg.targetOdds ** cfg.days, 2), modelledRunWinPct: round((1 / cfg.targetOdds + 0.03) ** cfg.days * 100, 2), dailyWinProbPct: round((1 / cfg.targetOdds + 0.03) * 100, 2), dailyProbSource: 'assumed', oneIn: Math.round(1 / (1 / cfg.targetOdds + 0.03) ** cfg.days) },
    timezone: tz,
    generatedAt: now.toISOString(),
  };
}

/**
 * In-run recovery plan when a day dies: what to change before going again.
 */
function suggestRecovery(run, day, result) {
  const cfg = run.config;
  const lineage = (run.lineage || []).concat([
    { status: 'lost', diedOnDay: day.day, targetOdds: day.slip.odds, stake: day.slip.stake },
  ]);
  const deaths = lineage.filter((l) => l.status === 'lost').map((l) => l.diedOnDay);
  const freq = new Map();
  for (const d of deaths) freq.set(d, (freq.get(d) || 0) + 1);
  const modalDeath = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];

  const winProbs = run.days.filter((d) => d.slip).map((d) => d.slip.winProb);
  // Measured per-day win chance from this run (falling back to the odds-implied
  // number). EVERY option below is priced off this same base, shifted only by
  // the odds change — otherwise the options aren't comparable and the user is
  // being shown a "safer" setting that looks more dangerous.
  const baseDaily = winProbs.length ? mean(winProbs) : clamp(1 / cfg.targetOdds + 0.03, 0.03, 0.97);
  const dailyAt = (odds) => clamp(baseDaily + dayLift(cfg.targetOdds, odds), 0.03, 0.97);
  const legsAvg = mean(run.days.filter((d) => d.slip).map((d) => d.slip.legCount));

  const lower = round(Math.max(1.6, cfg.targetOdds - 0.15), 2);
  const shorter = clamp(cfg.days - 2, 3, cfg.days);
  const reserve = cfg.reservePct ? cfg.reservePct : 15;
  const reserveFactor = 1 - reserve / 100;

  const mkOption = (id, title, odds, days, detail, extra = {}) => {
    const pDay = dailyAt(odds);
    const pRun = pDay ** days;
    // with a reserve held back, only `reserveFactor` of the pot compounds each day
    const growth = extra.reservePct ? reserveFactor * odds : odds;
    return {
      id,
      title,
      stake: cfg.stake,
      odds,
      days,
      reservePct: extra.reservePct || 0,
      detail,
      dailyWinProbPct: round(pDay * 100, 2),
      runWinPct: round(pRun * 100, 2),
      oneIn: Math.round(1 / clamp(pRun, 1e-6, 1)),
      payout: round(cfg.stake * growth ** days, 2),
      risk: extra.risk || 'medium',
    };
  };

  const lift = (toOdds) => round((dailyAt(toOdds) - baseDaily) * 100, 1);
  const shorterMultiple = round(baseDaily ** shorter / baseDaily ** cfg.days, 2);

  const options = [
    mkOption(
      'same',
      'Go again, same settings',
      cfg.targetOdds,
      cfg.days,
      `Base stake ${money(cfg.currency, cfg.stake)} at ${cfg.targetOdds.toFixed(2)} for ${cfg.days} days. Measured ${(baseDaily * 100).toFixed(1)}% per day across ${winProbs.length} slip${winProbs.length === 1 ? '' : 's'}.`,
      { risk: 'highest' }
    ),
    mkOption(
      'lower-odds',
      `Drop the daily target to ${lower.toFixed(2)}`,
      lower,
      cfg.days,
      `Each day becomes ${lift(lower)} points more likely to land (${(baseDaily * 100).toFixed(1)}% → ${(dailyAt(lower) * 100).toFixed(1)}%). The pot ends smaller but the run finishes more often.`
    ),
    mkOption(
      'shorter',
      `Run ${shorter} days instead of ${cfg.days}`,
      cfg.targetOdds,
      shorter,
      `Two fewer sequential coin flips. At your measured daily rate that is ${shorterMultiple}× the completion rate — the single biggest lever you have.`
    ),
    mkOption(
      'reserve',
      `Enable ${reserve}% safety reserve`,
      cfg.targetOdds,
      cfg.days,
      `Hold ${reserve}% back each day so a miss doesn't zero you out. Costs ${round((1 - reserveFactor ** cfg.days) * 100, 0)}% of the compounding — you are buying survival, not profit.`,
      { reservePct: reserve, risk: 'lowest' }
    ),
  ];

  /* Recommend the lever that actually moves the completion rate most, subject
   * to the diagnosis. Dropping the odds target and shortening the run are the
   * two levers that change P(run); the reserve only changes the damage. */
  let recommendedId = 'same';
  const byProb = options.slice().sort((a, b) => b.runWinPct - a.runWinPct);
  if (modalDeath && modalDeath[1] >= 2) recommendedId = 'lower-odds';
  else if (baseDaily < 1 / cfg.targetOdds + 0.005) recommendedId = 'lower-odds';
  else if (cfg.days >= 6 && byProb[0].runWinPct > options[0].runWinPct * 1.6) recommendedId = byProb[0].id;
  else if (legsAvg > 4) recommendedId = 'shorter';
  else if (run.stats.lost >= 2) recommendedId = 'shorter';

  const recommended = options.find((o) => o.id === recommendedId);

  return {
    options,
    recommendedId,
    recommendedStake: recommended.stake,
    recommendedOdds: recommended.odds,
    recommendedDays: recommended.days,
    recommendedReservePct: recommended.reservePct || 0,
    diagnosis: diagnose(run, day, result, deaths, modalDeath, baseDaily, legsAvg),
    realityCheck: {
      avgDailyWinProbPct: round(baseDaily * 100, 2),
      runsExpectedPerWin: Math.round(1 / clamp(baseDaily ** cfg.days, 1e-6, 1)),
      avgLegsPerSlip: round(legsAvg, 2),
      lossCount: run.stats.lost + (run.lineage || []).filter((l) => l.status === 'lost').length,
      bestLever: byProb[0]
        ? `${byProb[0].title} → ${byProb[0].runWinPct}% (1-in-${byProb[0].oneIn})`
        : null,
    },
  };
}

function diagnose(run, day, result, deaths, modalDeath, avgWinProb, legsAvg) {
  const notes = [];
  const baseDaily = avgWinProb;
  const failed = (result.resolved || []).filter((r) => r.status !== 'WON');
  if (failed.length === 1 && day.slip.legCount > 1) {
    notes.push(
      `${day.slip.legCount - 1} of ${day.slip.legCount} legs won. The slip was right and one selection was wrong — that is variance, not a model failure.`
    );
  }
  if (failed.some((f) => (f.truthProbPct ?? 100) < 45)) {
    notes.push('A leg below 45% true probability was in the slip. Long legs are where rollovers die — the engine will favour fewer, shorter legs.');
  }
  if (modalDeath && modalDeath[1] >= 2) {
    notes.push(`Two runs have now died on day ${modalDeath[0]}. Treat that as a settings problem: lower the daily target.`);
  }
  if (legsAvg > 3.5) {
    notes.push(`Slips are averaging ${legsAvg.toFixed(1)} legs. Each extra leg multiplies your failure chance — 3 legs at 1.26 beats 5 legs at 1.15 even though both pay 2.0.`);
  }
  if (avgWinProb < 1 / run.config.targetOdds) {
    notes.push(
      `Modelled daily win chance (${(avgWinProb * 100).toFixed(1)}%) is below the ${(100 / run.config.targetOdds).toFixed(1)}% the odds imply — you were paying vig, not collecting edge.`
    );
  }
  if (!notes.length) notes.push('Settings looked sound; the day simply did not land. Re-run identical settings.');
  return notes;
}

function buildReason(shape, canStartToday, todayShape, cfg) {
  const bits = [];
  if (canStartToday && shape.dayKey === todayShape.dayKey) {
    bits.push(`Today still has ${countLabel(cfg)} of action ahead and ${shape.events} fixtures across ${Object.keys(shape.bySport).length} sports — you can roll tonight.`);
  } else {
    bits.push(
      `${shape.weekday} scores ${shape.label.toLowerCase()} (${(shape.score * 100).toFixed(0)}/100): ${shape.events} fixtures, ${shape.markets} markets, ${Object.keys(shape.bySport).length} sports, and the following ${cfg.days - 1} days average ${(shape.windowScore * 100).toFixed(0)}/100.`
    );
  }
  if (shape.weekend) bits.push('Weekend cards are deeper, which means more legs with edge to choose from.');
  bits.push('The engine needs depth more than it needs a big name league — depth is what lets it hit the odds target with short, high-probability legs.');
  return bits.join(' ');
}

function countLabel(cfg) {
  return 'plenty';
}

/** Rough lift in per-day win probability when the target odds drop. */
function dayLift(fromOdds, toOdds) {
  const p1 = clamp(1 / fromOdds + 0.03, 0.05, 0.95);
  const p2 = clamp(1 / toOdds + 0.03, 0.05, 0.95);
  return p2 - p1;
}

function countActionableToday(run, todayKey, now, tz) {
  // How many of today's fixtures have not kicked off yet?
  const day = run.days.find((d) => d.date === todayKey);
  if (day?.slip) return day.slip.legs.length;
  const events = buildDayEvents(todayKey, { tz, eventsPerDay: run.config.eventsPerDay });
  return events.filter((e) => e.kickoff > now.getTime() + 20 * 60000).length;
}

function hourOf(ms, tz) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date(ms)));
}

function money(code, n) {
  const sym = { NGN: '₦', USD: '$', GBP: '£', EUR: '€', GHS: '₵', KES: 'KSh', ZAR: 'R' }[code] || `${code} `;
  return `${sym}${Number(n ?? 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
__exp_39 = suggestNextRun;
__exp_40 = suggestRecovery;
__exp_41 = money;
}

/* ════════════════════════════════════════════════════════════════════════
   lib/rollover.js   →  hoists createRun, scanRunDay, confirmDay, settleDay, chooseAlternative, adjustDayOdds, skipDay, rescanDay, abandonRun, restartRun, runProgress, dayCards, equityCurve, RUN_STATUS, DAY_STATUS
   ════════════════════════════════════════════════════════════════════════ */
let __exp_42;
let __exp_43;
let __exp_44;
let __exp_45;
let __exp_46;
let __exp_47;
let __exp_48;
let __exp_49;
let __exp_50;
let __exp_51;
let __exp_52;
let __exp_53;
let __exp_54;
let __exp_55;
let __exp_56;
{
const makeRng = __exp_8;
const round = __exp_7;
const clamp = __exp_6;
const mean = __exp_10;
const scanForDay = __exp_33;
const settleLegs = __exp_37;
const tzDateKey = __exp_19;
const tzNowParts = __exp_20;
const upcomingDays = __exp_22;
const formatKickoff = __exp_21;
const zonedTimeToMs = __exp_23;
const suggestNextRun = __exp_39;
const suggestRecovery = __exp_40;

/**
 * rollover.js — the rollover state machine.
 *
 *   createRun  → day 1 slip is scanned and attached
 *   confirmDay → stake is committed, day goes OPEN (awaiting result)
 *   settleDay  → WON: balance × odds, advance a day (or COMPLETE on day N)
 *                LOST: run is dead, verdict + recovery plan issued
 *   abandon / restart / adjust
 *
 * The two verdict messages the whole thing exists to print live in
 * `verdicts()` at the bottom of this file.
 */






const RUN_STATUS = {
  ACTIVE: 'active',
  COMPLETE: 'complete',
  LOST: 'lost',
  ABANDONED: 'abandoned',
};

const DAY_STATUS = {
  PENDING: 'pending',
  READY: 'ready',
  OPEN: 'open',
  WON: 'won',
  LOST: 'lost',
  SKIPPED: 'skipped',
};

const DEFAULTS = {
  currency: 'NGN',
  stake: 500,
  days: 7,
  targetOdds: 2.0,
  tolerance: 0.1,
  oddsMode: 'exact', // exact | floor | band
  provider: 'sim',
  tz: 'Africa/Lagos',
  eventsPerDay: 42,
  marketInefficiency: 1.3,
  reservePct: 0, // safety mode: hold back this % of the balance each day
  reserveCapPct: 40, // never hold back more than this
  autoAdvance: true,
  builder: { mode: 'balanced', minEdgePerLeg: 0 },
};

const DAY_MS = 86400000;

/* ------------------------------------------------------------------ *
 * Creation
 * ------------------------------------------------------------------ */

function createRun(input = {}, now = new Date()) {
  const cfg = { ...DEFAULTS, ...(input.config || {}), builder: { ...(input.config?.builder || {}) } };
  cfg.stake = round(Math.max(1, Number(input.stake ?? cfg.stake)), 2);
  cfg.days = clamp(Math.round(Number(input.days ?? cfg.days)), 1, 30);
  cfg.targetOdds = clamp(Number(input.targetOdds ?? cfg.targetOdds), 1.05, 12);
  cfg.tolerance = clamp(Number(input.tolerance ?? cfg.tolerance), 0.01, 1.5);
  cfg.startDay = input.startDay || tzDateKey(now, cfg.tz);
  cfg.reservePct = clamp(Number(cfg.reservePct) || 0, 0, cfg.reserveCapPct);
  cfg.oddsMode = ['exact', 'floor', 'band'].includes(cfg.oddsMode) ? cfg.oddsMode : 'exact';

  const id = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const run = {
    id,
    createdAt: now.toISOString(),
    status: RUN_STATUS.ACTIVE,
    config: cfg,
    balance: cfg.stake,
    startBalance: cfg.stake,
    currentDay: 1,
    days: buildDaySlots(cfg),
    verdict: null,
    history: [],
    stats: { settled: 0, won: 0, lost: 0, skipped: 0, peak: cfg.stake, totalStaked: 0 },
  };
  attachDayPlan(run, now);
  return run;
}

function buildDaySlots(cfg) {
  const start = Date.parse(`${cfg.startDay}T12:00:00Z`);
  const days = [];
  for (let i = 0; i < cfg.days; i++) {
    const d = new Date(start + i * DAY_MS);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    days.push({
      day: i + 1,
      date: key,
      status: DAY_STATUS.PENDING,
      stakeIn: i === 0 ? cfg.stake : null,
      stakeOut: null,
      targetOdds: cfg.targetOdds,
      slip: null,
      result: null,
      message: null,
      nonce: String(i + 1),
    });
  }
  return days;
}

/**
 * Projected balance at the start of each day, at the configured target odds.
 * Shape: { ladder: [...perDay], final, multiple, profit } — kept as an object
 * so it survives JSON round-tripping (an array with extra properties does not).
 */
function attachDayPlan(run, now) {
  const cfg = run.config;
  let bal = cfg.stake;
  const ladder = [];
  for (const d of run.days) {
    const stake = stakeFor(bal, cfg);
    ladder.push({
      day: d.day,
      date: d.date,
      stake: round(stake, 2),
      odds: cfg.targetOdds,
      payout: round(stake * cfg.targetOdds, 2),
      growth: round((stake * cfg.targetOdds) / cfg.stake, 3),
    });
    bal = stake * cfg.targetOdds;
  }
  run.projection = {
    ladder,
    final: round(bal, 2),
    multiple: round(bal / cfg.stake, 2),
    profit: round(bal - cfg.stake, 2),
    odds: cfg.targetOdds,
    days: cfg.days,
  };
}

/**
 * Safety/reserve mode. In pure rollover you stake everything; the reserve mode
 * holds a slice back so a single loss doesn't zero you out. It costs you
 * compounding — that trade is made explicit in the UI.
 */
function stakeFor(balance, cfg) {
  if (!cfg.reservePct) return balance;
  const held = balance * (clamp(cfg.reservePct, 0, cfg.reserveCapPct) / 100);
  return Math.max(0.01, balance - held);
}

/* ------------------------------------------------------------------ *
 * Scanning a day
 * ------------------------------------------------------------------ */

function scanRunDay(run, dayNumber = run.currentDay, overrides = {}) {
  const day = run.days.find((d) => d.day === dayNumber);
  if (!day) throw new Error(`scanRunDay: day ${dayNumber} does not exist on this run`);
  if (day.status === DAY_STATUS.WON || day.status === DAY_STATUS.LOST) {
    return { day, reused: true };
  }

  const cfg = run.config;
  const builderCfg = {
    ...(cfg.builder || {}),
    targetOdds: day.targetOdds,
    tolerance: cfg.tolerance,
    ...(overrides.builder || {}),
  };
  if (cfg.oddsMode === 'floor') {
    // "at least the target": shift the band up so we can overshoot
    builderCfg.targetOdds = day.targetOdds + cfg.tolerance;
  }

  const { scan, builder, diagnostics } = scanForDay(day.date, {
    tz: cfg.tz,
    provider: overrides.provider || cfg.provider,
    eventsPerDay: cfg.eventsPerDay,
    marketInefficiency: cfg.marketInefficiency,
    builder: builderCfg,
  }, overrides);

  const stake = round(stakeFor(run.balance, cfg), 2);
  const chosen = builder.ok ? builder.best : builder.fallback;

  const slip = chosen
    ? {
        nonce: `${day.nonce}-${run.nonceSalt || 0}`,
        created: new Date().toISOString(),
        stake,
        reserve: round(run.balance - stake, 2),
        legs: chosen.legs.map((l) => ({ ...l })),
        legCount: chosen.legCount,
        odds: chosen.odds,
        winProb: chosen.winProb,
        winProbPct: chosen.winProbPct,
        fairOdds: chosen.fairOdds,
        edgeSum: chosen.edgeSum,
        avgConfidence: chosen.avgConfidence,
        evPct: chosen.evPct,
        grade: chosen.grade,
        sports: chosen.sports,
        leagues: chosen.leagues,
        belowThreshold: !!chosen.belowThreshold,
        potentialReturn: round(stake * chosen.odds, 2),
        potentialProfit: round(stake * chosen.odds - stake, 2),
      }
    : null;

  day.slip = slip;
  day.scan = {
    scannedAt: new Date().toISOString(),
    provider: diagnostics.provider,
    eventsScanned: diagnostics.events,
    marketsScanned: diagnostics.markets,
    pricesQuoted: diagnostics.pricesQuoted,
    books: diagnostics.books,
    bookCount: diagnostics.bookCount,
    bookQuotes: diagnostics.bookQuotes,
    legsConsidered: diagnostics.positiveEdgeLegs,
    legsEligible: builder.report?.eligible ?? 0,
    combosEvaluated: builder.combosEvaluated ?? 0,
    avgOverround: diagnostics.avgOverround,
    bestEdgeLegs: diagnostics.bestEdgeLegs,
    report: builder.report,
    alternatives: (builder.alternatives || []).map((a) => ({
      odds: a.odds,
      legCount: a.legCount,
      winProbPct: a.winProbPct,
      evPct: a.evPct,
      grade: a.grade,
      sports: a.sports,
      legs: a.legs.map((l) => ({ eventId: l.eventId, match: `${l.home} v ${l.away}`, market: l.market, pick: l.pick, odds: l.odds, edgePct: round(l.edge * 100, 2) })),
    })),
    failure: builder.ok ? null : { reason: builder.reason, message: builder.message },
    dayKey: day.date,
  };
  day.status = slip ? DAY_STATUS.READY : DAY_STATUS.PENDING;
  day.message = slip ? null : builder.message;
  return { day, reused: false, diagnostics, builder };
}

/** User picks one of the alternative slips instead of the top-ranked one. */
function chooseAlternative(run, dayNumber, altIndex) {
  const day = run.days.find((d) => d.day === dayNumber);
  const alt = day?.scan?.alternatives?.[altIndex];
  if (!day || !alt) throw new Error('chooseAlternative: no such alternative');
  // rebuild the full leg objects from a fresh scan of that day
  const { builder } = scanForDay(day.date, {
    tz: run.config.tz,
    provider: run.config.provider,
    eventsPerDay: run.config.eventsPerDay,
    marketInefficiency: run.config.marketInefficiency,
    builder: { ...(run.config.builder || {}), targetOdds: day.targetOdds, tolerance: run.config.tolerance, alternatives: altIndex + 1 },
  });
  const combo = builder.alternatives?.[altIndex];
  if (!combo) throw new Error('chooseAlternative: alternative no longer available');
  const stake = round(stakeFor(run.balance, run.config), 2);
  day.slip = {
    ...day.slip,
    legs: combo.legs,
    legCount: combo.legCount,
    odds: combo.odds,
    winProb: combo.winProb,
    winProbPct: combo.winProbPct,
    fairOdds: combo.fairOdds,
    edgeSum: combo.edgeSum,
    avgConfidence: combo.avgConfidence,
    evPct: combo.evPct,
    grade: combo.grade,
    sports: combo.sports,
    leagues: combo.leagues,
    stake,
    reserve: round(run.balance - stake, 2),
    potentialReturn: round(stake * combo.odds, 2),
    potentialProfit: round(stake * combo.odds - stake, 2),
  };
  day.status = DAY_STATUS.READY;
  return day;
}

/* ------------------------------------------------------------------ *
 * Staking
 * ------------------------------------------------------------------ */

function confirmDay(run, dayNumber = run.currentDay) {
  const day = run.days.find((d) => d.day === dayNumber);
  if (!day) throw new Error('confirmDay: unknown day');
  if (!day.slip) {
    scanRunDay(run, dayNumber);
    if (!day.slip) throw new Error('confirmDay: the engine has no slip for this day — it refused to roll');
  }
  if (day.status === DAY_STATUS.OPEN) return day;
  day.slip.staked = round(stakeFor(run.balance, run.config), 2);
  day.slip.stake = day.slip.staked;
  day.slip.reserve = round(run.balance - day.slip.staked, 2);
  day.slip.potentialReturn = round(day.slip.staked * day.slip.odds, 2);
  day.slip.potentialProfit = round(day.slip.potentialReturn - day.slip.staked, 2);
  day.stakeIn = day.slip.staked;
  day.status = DAY_STATUS.OPEN;
  day.confirmedAt = new Date().toISOString();
  run.stats.totalStaked = round(run.stats.totalStaked + day.slip.staked, 2);
  run.history.push({
    at: day.confirmedAt,
    type: 'stake',
    day: day.day,
    amount: day.slip.staked,
    odds: day.slip.odds,
    legs: day.slip.legCount,
  });
  return day;
}

/* ------------------------------------------------------------------ *
 * Settlement → the verdicts
 * ------------------------------------------------------------------ */

/**
 * @param {object} run
 * @param {'won'|'lost'} outcome
 * @param {object} opts { dayNumber, manual }
 */
function settleDay(run, outcome, opts = {}) {
  const dayNumber = opts.dayNumber ?? run.currentDay;
  const day = run.days.find((d) => d.day === dayNumber);
  if (!day) throw new Error('settleDay: unknown day');
  if (!day.slip) throw new Error('settleDay: nothing was staked on this day');
  if (day.status === DAY_STATUS.WON || day.status === DAY_STATUS.LOST) {
    return { day, alreadySettled: true, verdict: run.verdict };
  }

  const cfg = run.config;
  let result;
  if (opts.manual) {
    // The user is the source of truth here (they placed it at a real book).
    // On a loss we still resolve every leg against the simulator so the UI can
    // show a plausible scoreline, but the verdict is driven by what they said.
    const simulated = settleLegs(day.slip.legs, {
      dayKey: day.date,
      nonce: day.slip.nonce,
      tz: cfg.tz,
      eventsPerDay: cfg.eventsPerDay,
    });
    const won = outcome === 'won';
    const resolved = simulated.resolved.map((r) => {
      if (won) return { ...r, status: 'WON' };
      // keep the simulator's losers if it also lost; otherwise mark the first
      // leg as the reported failure so the UI has something concrete to show
      return r;
    });
    if (!won && resolved.every((r) => r.status === 'WON')) {
      const idx = resolved.findIndex((r) => r.modelProbPct < 80) ;
      resolved[idx < 0 ? resolved.length - 1 : idx].status = 'LOST';
    }
    result = {
      allWon: won,
      legsWon: won ? day.slip.legCount : resolved.filter((r) => r.status === 'WON').length,
      legsTotal: day.slip.legCount,
      odds: day.slip.odds,
      resolved,
      settledAt: new Date().toISOString(),
      manual: true,
      reported: outcome,
    };
  } else {
    result = settleLegs(day.slip.legs, {
      dayKey: day.date,
      nonce: day.slip.nonce,
      tz: cfg.tz,
      eventsPerDay: cfg.eventsPerDay,
    });
  }

  day.result = result;
  day.settledAt = result.settledAt;
  run.stats.settled++;

  if (result.allWon) {
    day.status = DAY_STATUS.WON;
    run.stats.won++;
    const payout = round(day.slip.stake * result.odds, 2);
    day.stakeOut = payout;
    run.balance = round(run.balance - day.slip.stake + payout, 2);
    run.stats.peak = Math.max(run.stats.peak, run.balance);
    run.history.push({ at: day.settledAt, type: 'win', day: day.day, amount: payout, balance: run.balance });
    day.message = winMessage(day, run);

    if (day.day >= cfg.days) {
      run.status = RUN_STATUS.COMPLETE;
      run.completedAt = new Date().toISOString();
      run.verdict = completionVerdict(run, day);
      run.lastDayMessage = null;
    } else {
      run.currentDay = day.day + 1;
      const next = run.days.find((d) => d.day === run.currentDay);
      next.stakeIn = round(stakeFor(run.balance, cfg), 2);
      next.targetOdds = cfg.targetOdds;
      /* A mid-run win is a day banner, NOT the run's verdict. Overwriting
       * run.verdict here used to leave `settleDay` returning the wrong object
       * (and made the loss path unreachable from the API response). */
      run.lastDayMessage = { kind: 'day-won', ...day.message, next: { day: next.day, date: next.date, stake: next.stakeIn } };
      if (cfg.autoAdvance) scanRunDay(run, run.currentDay);
    }
  } else {
    day.status = DAY_STATUS.LOST;
    run.stats.lost++;
    day.stakeOut = 0;
    run.balance = round(run.balance - day.slip.stake, 2);
    run.history.push({ at: day.settledAt, type: 'loss', day: day.day, amount: -day.slip.stake, balance: run.balance });
    run.status = RUN_STATUS.LOST;
    run.lostAt = new Date().toISOString();
    run.verdict = lossVerdict(run, day, result);
    run.lastDayMessage = null;
    day.message = run.verdict;
  }

  return { day, run, verdict: run.verdict, dayVerdict: day.message, result };
}

function winMessage(day, run) {
  const cfg = run.config;
  const gained = round(day.stakeOut - day.slip.stake, 2);
  return {
    kind: 'day-won',
    headline: `Day ${day.day} landed.`,
    body: `${cur(cfg.currency)}${fmt(day.slip.stake)} at ${day.slip.odds.toFixed(2)} → ${cur(cfg.currency)}${fmt(day.stakeOut)}. +${cur(cfg.currency)}${fmt(gained)} banked.`,
    day: day.day,
    daysLeft: cfg.days - day.day,
    balance: run.balance,
    nextTarget: day.day < cfg.days ? round(stakeFor(run.balance, cfg) * cfg.targetOdds, 2) : null,
  };
}

/* ------------------------------------------------------------------ *
 * THE TWO VERDICTS
 * ------------------------------------------------------------------ */

function completionVerdict(run, lastDay) {
  const cfg = run.config;
  const finalBalance = run.balance;
  const profit = round(finalBalance - run.startBalance, 2);
  const multiple = round(finalBalance / run.startBalance, 2);
  const winProbs = run.days.filter((d) => d.slip).map((d) => d.slip.winProb);
  const realised = mean(winProbs);
  const theoretical = winProbs.length ? winProbs.reduce((a, b) => a * b, 1) : 0;

  const next = suggestNextRun(run, { now: new Date() });

  return {
    kind: 'complete',
    status: 'won',
    headline: 'CONGRATULATIONS 🏆',
    subheadline: `The ${cfg.days}-day rollover is complete. Every single day landed.`,
    body:
      `You turned ${cur(cfg.currency)}${fmt(run.startBalance)} into ${cur(cfg.currency)}${fmt(finalBalance)} — ` +
      `a ${multiple}× return in ${cfg.days} days, profit of ${cur(cfg.currency)}${fmt(profit)}.`,
    numbers: {
      startBalance: run.startBalance,
      finalBalance,
      profit,
      multiple,
      days: cfg.days,
      daysWon: run.stats.won,
      avgDailyWinProbPct: round(realised * 100, 2),
      runWinProbPct: round(theoretical * 100, 2),
      totalStaked: run.stats.totalStaked,
      bestDay: run.days.reduce((a, d) => (d.slip && (!a || d.slip.winProb > a.winProb) ? { day: d.day, winProb: d.slip.winProb } : a), null),
      avgLegs: round(mean(run.days.filter((d) => d.slip).map((d) => d.slip.legCount)), 2),
    },
    nextRun: next,
    discipline: [
      `Withdraw or ring-fence the ${cur(cfg.currency)}${fmt(profit)} profit — a rollover only counts once the money leaves the book.`,
      `Restart from ${cur(cfg.currency)}${fmt(cfg.stake)}, not from ${cur(cfg.currency)}${fmt(finalBalance)}. Compounding a win-streak is how a good run turns into a bad one.`,
      `You completed this at a ${(theoretical * 100).toFixed(1)}% modelled success rate. That means roughly 1 in ${Math.max(2, Math.round(1 / Math.max(0.001, theoretical)))} attempts wins. Expect the losses; they are part of the price of the win.`,
    ],
    completedAt: run.completedAt,
  };
}

function lossVerdict(run, day, result) {
  const cfg = run.config;
  const lostLegs = (result.resolved || []).filter((r) => r.status !== 'WON');
  const recovery = suggestRecovery(run, day, result);
  const next = suggestNextRun(run, { now: new Date() });

  return {
    kind: 'lost',
    status: 'lost',
    headline: 'Sorry — unfortunately we lost this time. We go again.',
    subheadline: `Day ${day.day} of ${cfg.days} broke the run. ${cur(cfg.currency)}${fmt(day.slip.stake)} gone, ${cur(cfg.currency)}${fmt(run.balance)} left in hand.`,
    body:
      `The slip was ${day.slip.legCount} leg${day.slip.legCount === 1 ? '' : 's'} at ${day.slip.odds.toFixed(2)} ` +
      `(${day.slip.winProbPct}% modelled). ${lostLegs.length ? `It died on: ${lostLegs.map((l) => `${l.pick} (${l.match})`).join('; ')}.` : ''} ` +
      `This is what a ${(day.slip.winProb * 100).toFixed(1)}% day looks like when it doesn't hit — it happens, and the plan already accounts for it.`,
    numbers: {
      day: day.day,
      stakeLost: day.slip.stake,
      remainingBalance: run.balance,
      reserveSaved: day.slip.reserve || 0,
      daysCompleted: run.stats.won,
      winProbPct: day.slip.winProbPct,
      legsWon: result.legsWon,
      legsTotal: result.legsTotal,
      peakBalance: run.stats.peak,
      profitFromPeak: round(run.balance - run.stats.peak, 2),
    },
    failedLegs: lostLegs,
    recovery,
    nextRun: next,
    discipline: [
      'Do not chase. A double-stake "get it back" slip is the single most expensive decision in rollover betting.',
      'Restart at your base stake. The engine keeps your win-rate history and will re-tune the daily odds target.',
      'If two runs die on the same day number, the target odds are too high for the edge available — drop to 1.75–1.85.',
    ],
    lostAt: run.lostAt,
  };
}

/* ------------------------------------------------------------------ *
 * Run controls
 * ------------------------------------------------------------------ */

function skipDay(run, dayNumber = run.currentDay) {
  const day = run.days.find((d) => d.day === dayNumber);
  if (!day) throw new Error('skipDay: unknown day');
  if ([DAY_STATUS.WON, DAY_STATUS.LOST, DAY_STATUS.OPEN].includes(day.status)) {
    throw new Error('skipDay: this day is already committed');
  }
  day.status = DAY_STATUS.SKIPPED;
  day.message = { kind: 'skipped', headline: `Day ${day.day} skipped`, body: 'No slip met the edge threshold. Balance untouched, run extended by a day.' };
  run.stats.skipped++;
  run.history.push({ at: new Date().toISOString(), type: 'skip', day: day.day });
  // extend the run by one day rather than burning a target day
  const lastDate = run.days[run.days.length - 1].date;
  const nd = new Date(Date.parse(`${lastDate}T12:00:00Z`) + DAY_MS);
  run.days.push({
    day: run.days.length + 1,
    date: `${nd.getUTCFullYear()}-${String(nd.getUTCMonth() + 1).padStart(2, '0')}-${String(nd.getUTCDate()).padStart(2, '0')}`,
    status: DAY_STATUS.PENDING,
    stakeIn: null,
    stakeOut: null,
    targetOdds: run.config.targetOdds,
    slip: null,
    result: null,
    message: null,
    nonce: String(run.days.length + 1),
  });
  run.currentDay = day.day + 1;
  return day;
}

function rescanDay(run, dayNumber = run.currentDay, overrides = {}) {
  const day = run.days.find((d) => d.day === dayNumber);
  if (!day) throw new Error('rescanDay: unknown day');
  if ([DAY_STATUS.OPEN, DAY_STATUS.WON, DAY_STATUS.LOST].includes(day.status)) {
    throw new Error('rescanDay: this day is committed or settled');
  }
  // a fresh nonce salt = a fresh draw of the market (prices move)
  run.nonceSalt = (run.nonceSalt || 0) + 1;
  return scanRunDay(run, dayNumber, overrides);
}

function adjustDayOdds(run, dayNumber, newOdds) {
  const day = run.days.find((d) => d.day === dayNumber);
  if (!day) throw new Error('adjustDayOdds: unknown day');
  if ([DAY_STATUS.OPEN, DAY_STATUS.WON, DAY_STATUS.LOST].includes(day.status)) {
    throw new Error('adjustDayOdds: day already committed');
  }
  day.targetOdds = clamp(Number(newOdds), 1.05, 15);
  run.config.targetOdds = day.targetOdds;
  for (const d of run.days) if (d.status === DAY_STATUS.PENDING || d.day >= dayNumber) d.targetOdds = day.targetOdds;
  attachDayPlan(run, new Date());
  return scanRunDay(run, dayNumber);
}

function abandonRun(run, reason = 'user') {
  run.status = RUN_STATUS.ABANDONED;
  run.abandonedAt = new Date().toISOString();
  run.verdict = {
    kind: 'abandoned',
    headline: 'Run called off.',
    body: `Stopped on day ${run.currentDay} with ${cur(run.config.currency)}${fmt(run.balance)} in hand. No further stakes committed.`,
    numbers: { remainingBalance: run.balance, daysCompleted: run.stats.won },
    nextRun: suggestNextRun(run, { now: new Date() }),
  };
  return run;
}

/**
 * Restart after a loss or a completion. Preserves the lineage so the engine
 * can learn from the previous attempts (day-of-death patterns, realised odds).
 */
function restartRun(run, overrides = {}, now = new Date()) {
  const cfg = run.config;
  const lineage = (run.lineage || []).concat([
    {
      id: run.id,
      status: run.status,
      daysWon: run.stats.won,
      diedOnDay: run.status === RUN_STATUS.LOST ? run.currentDay : null,
      targetOdds: cfg.targetOdds,
      stake: run.startBalance,
      finalBalance: run.balance,
      realisedDailyProb: (() => {
        const w = run.days.filter((d) => d.slip).map((d) => d.slip.winProb);
        return w.length ? round(w.reduce((a, b) => a + b, 0) / w.length, 4) : null;
      })(),
      completedAt: run.completedAt || run.lostAt || run.abandonedAt,
    },
  ]);

  const rec = run.verdict?.recovery?.recommendedStake;
  const stake = overrides.stake ?? rec ?? cfg.stake;
  const targetOdds = overrides.targetOdds ?? run.verdict?.recovery?.recommendedOdds ?? cfg.targetOdds;

  const next = createRun(
    {
      stake,
      targetOdds,
      days: overrides.days ?? cfg.days,
      startDay: overrides.startDay || suggestNextRun(run, { now }).startDay,
      config: { ...cfg, ...(overrides.config || {}), stake, targetOdds },
    },
    now
  );
  next.lineage = lineage;
  next.previousRunId = run.id;
  scanRunDay(next, 1);
  return next;
}

/* ------------------------------------------------------------------ *
 * Analytics
 * ------------------------------------------------------------------ */

function runProgress(run) {
  const cfg = run.config;
  const settled = run.days.filter((d) => [DAY_STATUS.WON, DAY_STATUS.LOST].includes(d.status));
  const winProbs = run.days.filter((d) => d.slip).map((d) => d.slip.winProb);
  const remaining = run.days.filter((d) => d.day >= run.currentDay && d.status !== DAY_STATUS.LOST);
  // P(win the run from here) = product of each remaining day's modelled win prob
  const remainingProb = remaining.reduce((a, d) => a * (d.slip?.winProb ?? 1 / run.config.targetOdds), 1);

  return {
    status: run.status,
    currentDay: run.currentDay,
    totalDays: run.days.length,
    daysWon: run.stats.won,
    daysLost: run.stats.lost,
    daysSkipped: run.stats.skipped,
    balance: run.balance,
    startBalance: run.startBalance,
    profitToDate: round(run.balance - run.startBalance, 2),
    peak: run.stats.peak,
    projectedFinal: run.projection?.final ?? null,
    projectedMultiple: run.projection?.multiple ?? null,
    chanceToFinishPct: round(clamp(remainingProb, 0, 1) * 100, 2),
    avgDailyWinProbPct: round(mean(winProbs) * 100, 2),
    equityCurve: equityCurve(run),
    completedPct: round(((run.currentDay - 1) / Math.max(1, cfg.days)) * 100, 1),
  };
}

function equityCurve(run) {
  const pts = [{ day: 0, label: 'Start', balance: run.startBalance, stake: 0, status: 'start' }];
  let bal = run.startBalance;
  for (const d of run.days) {
    if (d.status === DAY_STATUS.WON) {
      bal = round(bal - d.slip.stake + d.stakeOut, 2);
      pts.push({ day: d.day, label: `Day ${d.day}`, balance: bal, stake: d.slip.stake, odds: d.slip.odds, status: 'won', payout: d.stakeOut });
    } else if (d.status === DAY_STATUS.LOST) {
      bal = round(bal - d.slip.stake, 2);
      pts.push({ day: d.day, label: `Day ${d.day}`, balance: bal, stake: d.slip.stake, odds: d.slip.odds, status: 'lost' });
    } else if (d.day === run.currentDay) {
      pts.push({
        day: d.day,
        label: `Day ${d.day}`,
        balance: bal,
        stake: d.slip?.stake ?? stakeFor(bal, run.config),
        odds: d.slip?.odds ?? run.config.targetOdds,
        status: d.status,
        projected: round((d.slip?.stake ?? stakeFor(bal, run.config)) * (d.slip?.odds ?? run.config.targetOdds), 2),
      });
    } else {
      const stake = stakeFor(bal, run.config);
      bal = round(stake * run.config.targetOdds, 2);
      pts.push({ day: d.day, label: `Day ${d.day}`, balance: bal, stake, odds: run.config.targetOdds, status: 'projected', projected: true });
    }
  }
  return pts;
}

/** Compact view for the dashboard's day stepper. */
function dayCards(run) {
  return run.days.map((d) => ({
    day: d.day,
    date: d.date,
    status: d.status,
    stake: d.slip?.stake ?? d.stakeIn,
    odds: d.slip?.odds ?? d.targetOdds,
    legs: d.slip?.legCount ?? null,
    winProbPct: d.slip?.winProbPct ?? null,
    grade: d.slip?.grade ?? null,
    payout: d.stakeOut,
    isCurrent: d.day === run.currentDay,
  }));
}

/* ------------------------------------------------------------------ *
 * Currency helpers
 * ------------------------------------------------------------------ */

const SYMBOLS = { NGN: '₦', USD: '$', GBP: '£', EUR: '€', GHS: '₵', KES: 'KSh', ZAR: 'R' };
const cur = (code) => SYMBOLS[code] || `${code} `;
const fmt = (n) =>
  Number(n ?? 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (code, n) => `${cur(code)}${fmt(n)}`;
__exp_42 = createRun;
__exp_43 = scanRunDay;
__exp_44 = confirmDay;
__exp_45 = settleDay;
__exp_46 = chooseAlternative;
__exp_47 = adjustDayOdds;
__exp_48 = skipDay;
__exp_49 = rescanDay;
__exp_50 = abandonRun;
__exp_51 = restartRun;
__exp_52 = runProgress;
__exp_53 = dayCards;
__exp_54 = equityCurve;
__exp_55 = RUN_STATUS;
__exp_56 = DAY_STATUS;
}

/* ════════════════════════════════════════════════════════════════════════
   lib/simulate.js   →  hoists runSimulation, projectRun, STRATEGIES
   ════════════════════════════════════════════════════════════════════════ */
let __exp_57;
let __exp_58;
let __exp_59;
{
const makeRng = __exp_8;
const clamp = __exp_6;
const round = __exp_7;
const mean = __exp_10;
const median = __exp_13;
const percentile = __exp_14;
const stdev = __exp_11;
const buildDayEvents = __exp_18;
const tzDateKey = __exp_19;
const priceEvent = __exp_28;
const extractLegs = __exp_29;
const correlationFactor = __exp_27;
const applyMarketInformation = __exp_26;
const buildRolloverSlip = __exp_31;
const DEFAULT_BUILDER_OPTS = __exp_32;
const settleByTruthProb = __exp_38;

/**
 * simulate.js — the honesty machine.
 *
 * Everything the dashboard tells you is a *modelled* probability. This module
 * finds out whether the model is lying.
 *
 * It runs the entire rollover pipeline N times end-to-end and settles every
 * leg against GROUND TRUTH (the hidden `truthProb` that the bookmaker layer
 * never gets to see). Then it runs the same thing with a naive strategy that
 * just grabs whatever reaches the odds target without caring about edge, and
 * reports the gap.
 *
 * If the engine's completion rate beats the naive rate, the edge is real.
 * If it doesn't, the dashboard is decoration. There is no third option.
 */







/* The three strategies the Lab compares.
 *
 * 'engine'     — the real thing: blend de-vigged prices with the ratings
 *                prior, then optimise the whole combination for win
 *                probability inside the odds band.
 * 'naive'      — same band, same leg budget, but picks legs at RANDOM. This
 *                is the honest control: it isolates how much of the result
 *                comes from the model versus from merely landing on 2.00.
 * 'favourites' — the folk strategy: stack the shortest prices you can find
 *                until you reach the target. No probability model at all.
 */
const STRATEGIES = {
  engine: 'RolloverEngine (model + optimiser)',
  naive: 'Random legs, same odds target',
  favourites: 'Stack the shortest prices',
};

/**
 * @param {object} cfg { iterations, stake, days, targetOdds, tolerance, mode,
 *                       eventsPerDay, marketInefficiency, startDay, seed, strategies }
 */
function runSimulation(cfg = {}) {
  const iterations = clamp(Math.round(cfg.iterations ?? 400), 1, 20000);
  const stake = Number(cfg.stake ?? 500);
  const days = clamp(Math.round(cfg.days ?? 7), 1, 30);
  const targetOdds = Number(cfg.targetOdds ?? 2);
  const tolerance = Number(cfg.tolerance ?? 0.1);
  const mode = cfg.mode || 'balanced';
  const eventsPerDay = clamp(Math.round(cfg.eventsPerDay ?? 42), 6, 80);
  const ineff = Number(cfg.marketInefficiency ?? 1.3);
  const seed = cfg.seed ?? 20261007;
  const strategies = cfg.strategies?.length ? cfg.strategies : ['engine', 'naive'];
  const startDay = cfg.startDay || '2026-10-07';
  const tz = cfg.tz || 'UTC';

  const t0 = Date.now();
  const base = Date.parse(`${startDay}T12:00:00Z`);

  /* Pre-generate a rotating window of market days.
   *
   * `marketVariants` controls how many independent re-draws of each day's
   * bookmaker prices we keep. With 1 variant every simulated run faces the
   * identical market and only the match results vary — that isolates
   * settlement variance but flatters the engine, because it gets to pick the
   * same value legs every time. With >1 variant the prices themselves move
   * between runs, which is what actually happens, and the completion rate you
   * get out is the honest one. Default 3 (a good variance/speed trade). */
  const variants = clamp(Math.round(cfg.marketVariants ?? 3), 1, 8);
  const WINDOW = 14;
  const dayPools = [];
  for (let i = 0; i < WINDOW; i++) {
    const d = new Date(base + i * 86400000);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    const vs = [];
    for (let v = 0; v < variants; v++) vs.push(priceDay(key, tz, eventsPerDay, ineff, `${seed}|v${v}`));
    dayPools.push({ key, variants: vs });
  }

  const results = {};
  for (const strat of strategies) results[strat] = emptyStratResult(strat);

  const perDayWin = {};
  for (const strat of strategies) perDayWin[strat] = [];

  for (let it = 0; it < iterations; it++) {
    const rng = makeRng(`${seed}|${it}`);
    const offset = rng.int(WINDOW - days > 0 ? WINDOW - days : 1);

    for (const strat of strategies) {
      let balance = stake;
      let alive = true;
      const legsUsed = [];
      const dayLog = [];

      for (let d = 0; d < days && alive; d++) {
        const pool = dayPools[(offset + d) % WINDOW];
        const legsToday = pool.variants[rng.int(pool.variants.length)];
        const combo = pickCombo(legsToday, strat, { targetOdds, tolerance, mode, rng });
        if (!combo) {
          dayLog.push({ day: d + 1, skipped: true });
          continue;
        }
        const won = rng() < combo.trueWinProb;
        perDayWin[strat].push(won ? 1 : 0);
        legsUsed.push(combo.legCount);
        dayLog.push({
          day: d + 1,
          odds: combo.odds,
          legCount: combo.legCount,
          modelP: round(combo.modelWinProb, 4),
          trueP: round(combo.trueWinProb, 4),
          edge: combo.edgeSum != null ? round(combo.edgeSum / combo.legCount, 5) : null,
          trueEv: combo.trueEv != null ? round(combo.trueEv, 5) : null,
          trueEvLegs: combo.legs.map((l) => l.trueEvPerUnit ?? 0),
          won,
        });
        if (won) balance = round(balance * combo.odds, 2);
        else {
          balance = 0;
          alive = false;
        }
      }

      const r = results[strat];
      r.completed += alive ? 1 : 0;
      r.finalBalances.push(balance);
      r.profits.push(round(balance - stake, 2));
      r.diedOnDay.push(alive ? days : dayLog.findIndex((x) => x.won === false) + 1);
      r.avgLegs.push(legsUsed.length ? mean(legsUsed) : 0);
      r.dayLog = r.dayLog || [];
      if (it < 40) r.dayLog.push({ iteration: it, days: dayLog });
      r.modelProbs.push(...dayLog.filter((x) => x.modelP).map((x) => x.modelP));
      r.trueProbs.push(...dayLog.filter((x) => x.trueP).map((x) => x.trueP));
      r.edges.push(...dayLog.filter((x) => x.edge != null).map((x) => x.edge));
      r.trueEvs.push(...dayLog.filter((x) => x.trueEv != null).map((x) => x.trueEv));
      for (const x of dayLog) if (x.trueEvLegs) r.trueEvLegs.push(...x.trueEvLegs);
    }
  }

  const out = {
    config: {
      iterations,
      stake,
      days,
      targetOdds,
      tolerance,
      mode,
      eventsPerDay,
      marketInefficiency: ineff,
      startDay,
      seed,
      marketVariants: variants,
    },
    elapsedMs: Date.now() - t0,
    strategies: {},
    calibration: {},
  };

  for (const strat of strategies) {
    const r = results[strat];
    const wins = r.completed;
    const rate = wins / iterations;
    const balances = r.finalBalances;
    const avgBalance = mean(balances);
    const deathDays = r.diedOnDay.filter((d) => d > 0 && d < days);
    const modal = deathDays.length ? modeOf(deathDays) : null;
    const dayRate = mean(perDayWin[strat]);

    out.strategies[strat] = {
      label: STRATEGIES[strat] || strat,
      iterations,
      completed: wins,
      completionRate: round(rate, 4),
      completionRatePct: round(rate * 100, 2),
      /* Whole number. "1 in 71.4" reads like a measurement with three
       * significant figures, and with ~14 completions in the batch it is not. */
      oneIn: rate > 0 ? Math.max(1, Math.round(1 / rate)) : null,
      avgFinalBalance: round(avgBalance, 2),
      medianFinalBalance: round(median(balances), 2),
      p90FinalBalance: round(percentile(balances, 0.9), 2),
      bestFinalBalance: round(Math.max(...balances), 2),
      avgProfit: round(mean(r.profits), 2),
      medianProfit: round(median(r.profits), 2),
      // EV of the whole 7-day venture per unit staked at the start
      evPerUnit: round((avgBalance - stake) / stake, 4),
      evPct: round(((avgBalance - stake) / stake) * 100, 2),
      avgDailyWinRatePct: round(dayRate * 100, 2),
      avgLegsPerSlip: round(mean(r.avgLegs), 2),
      modalDeathDay: modal,
      avgEdgePerLegPct: round(mean(r.edges) * 100, 2),
      avgTrueEvPerLegPct: round(mean(r.trueEvs) * 100, 2),
      // Two different sample sizes, and the difference matters. `daysSampled` is
      // how many daily slips were settled; `legsSampled` is how many individual
      // legs that covers. Per-leg EV is the tight statistic (thousands of
      // samples); run completion is the loose one (a handful).
      daysSampled: r.edges.length,
      legsSampled: r.trueEvLegs.length,
      trueEvStdErrPct: r.trueEvLegs.length > 1
        ? round((stdev(r.trueEvLegs) / Math.sqrt(r.trueEvLegs.length)) * 100, 3)
        : null,
      // ±1.96 SE on the completion rate — i.e. how much of the completion-rate
      // comparison between strategies is signal and how much is coin-flipping.
      completionCi95Pct: round(1.96 * Math.sqrt(
        (r.completed / Math.max(1, iterations)) * (1 - r.completed / Math.max(1, iterations)) / Math.max(1, iterations),
      ) * 100, 2),
      deathDayHistogram: histogram(deathDays, days),
      // Same thing as a share of ALL runs (not just the ones that died), so the
      // bars are directly comparable across strategies and sum to <100%.
      deathDayPct: Object.fromEntries(
        Object.entries(histogram(deathDays, days)).map(([d, n]) => [d, round((n / Math.max(1, iterations)) * 100, 2)]),
      ),
      modelledDailyWinPct: round(mean(r.modelProbs) * 100, 2),
      realisedDailyWinPct: round(dayRate * 100, 2),
      payoutIfComplete: round(stake * targetOdds ** days, 2),
    };
  }

  // ---- calibration: does the model over-claim? -----------------------
  for (const strat of strategies) {
    const r = results[strat];
    out.calibration[strat] = {
      modelled: round(mean(r.modelProbs), 4),
      realised: round(mean(perDayWin[strat]), 4),
      gap: round(mean(r.modelProbs) - mean(perDayWin[strat]), 4),
      verdict:
        Math.abs(mean(r.modelProbs) - mean(perDayWin[strat])) < 0.02
          ? 'well calibrated'
          : mean(r.modelProbs) > mean(perDayWin[strat])
            ? 'over-confident — the model flatters its own picks'
            : 'under-confident — the model is better than it claims',
    };
  }

  if (out.strategies.engine && out.strategies.naive) {
    const e = out.strategies.engine;
    const n = out.strategies.naive;
    out.headline = {
      liftPct: round(e.completionRatePct - n.completionRatePct, 2),
      liftMultiple: n.completionRatePct > 0 ? round(e.completionRatePct / n.completionRatePct, 2) : null,
      evLiftPct: round(e.evPct - n.evPct, 2),
      honestRead: buildHonestRead(e, n, out.calibration.engine, days, out.strategies.favourites, out.calibration),
    };
  }

  return out;
}

function buildHonestRead(e, n, cal, days, f, allCal) {
  const bits = [];
  bits.push(
    `${e.iterations.toLocaleString()} full ${days}-day rollovers, settled against ground truth. ` +
      `The engine won ${e.avgDailyWinRatePct}% of its days; random legs aimed at the same odds target won ${n.avgDailyWinRatePct}%, ` +
      `and stacking the shortest prices available won ${f ? f.avgDailyWinRatePct + '%' : '—'}.`
  );
  bits.push(
    `That ${(e.avgDailyWinRatePct - n.avgDailyWinRatePct).toFixed(2)}-point daily gap is the whole product. ` +
      `Over ${days} sequential days it is the difference between completing ${e.completionRatePct}% of runs and ${n.completionRatePct}%.`
  );
  bits.push(
    `Follow the money rather than the hit rate: legs the engine chose carried ${e.avgEdgePerLegPct >= 0 ? '+' : ''}${e.avgEdgePerLegPct}pp of edge and ` +
      `${e.avgTrueEvPerLegPct >= 0 ? '+' : ''}${e.avgTrueEvPerLegPct}% true EV per unit. Random legs came in at ${n.avgTrueEvPerLegPct}% and ` +
      `favourite-stacking at ${f ? f.avgTrueEvPerLegPct + '%' : '—'} — both of those are you paying the vig, not collecting it.`
  );
  const eCal = allCal?.engine || cal;
  bits.push(
    `How much of that is signal. The per-leg numbers are measured over ${(e.legsSampled || 0).toLocaleString()} settled legs, so they are tight ` +
      `(±${((e.trueEvStdErrPct ?? 0) * 1.96).toFixed(2)}pp at 95% confidence on true EV). The run-level numbers are not: with a completion rate near ` +
      `${e.completionRatePct}% this batch contains only about ${e.completed} completed runs, which puts a ±${e.completionCi95Pct}pp confidence interval on it. ` +
      `Read the per-leg EV as the finding and the completion comparison as a hint, and run more iterations before you act on the second.`
  );
  bits.push(
    `Calibration: the engine claimed ${(e.modelledDailyWinPct).toFixed(2)}% and realised ${(e.realisedDailyWinPct).toFixed(2)}% ` +
      `(${eCal?.verdict}, gap ${((eCal?.gap ?? 0) * 100).toFixed(2)}pp). A probability you cannot trust is worse than no probability at all, ` +
      `so this is the number to check before believing any of the others.`
  );
  bits.push(
    `Now the downside, because it is the bigger number: the median outcome is ${e.medianFinalBalance.toLocaleString()} and the run completed ` +
      `${e.completionRatePct}% of the time — about 1 in ${e.oneIn ?? '—'}. The mean is only positive because the rare complete run pays ${e.payoutIfComplete.toLocaleString()}. ` +
      `Positive expected value and "probably loses" are both true at once, and you will feel the second one far more often than the first.`
  );
  return bits.join(' ');
}

/* ------------------------------------------------------------------ */

function priceDay(dayKey, tz, eventsPerDay, ineff, priceSeed = '') {
  const events = buildDayEvents(dayKey, { tz, eventsPerDay });
  const legs = [];
  for (const e of events) {
    const truth = applyMarketInformation(e);
    const priced = priceEvent(e, truth, {
      tier: e.league.tier,
      kickoffHours: 18,
      marketInefficiency: ineff,
      priceSeed: `${priceSeed}|${e.id}`,
    });
    legs.push(...extractLegs({ ...e, markets: priced.markets }));
  }
  return legs;
}

/**
 * Build the slip for one simulated day under a given strategy.
 * Returns both the model's own win probability AND the true one, so we can
 * measure the gap instead of assuming it away.
 */
function pickCombo(legs, strat, { targetOdds, tolerance, mode, rng }) {
  if (strat === 'engine') {
    const r = buildRolloverSlip(legs, { ...DEFAULT_BUILDER_OPTS, targetOdds, tolerance, mode, alternatives: 1 });
    const c = r.ok ? r.best : r.fallback;
    return c ? summarise(c) : null;
  }

  if (strat === 'naive') {
    /* Random legs inside the same band. Everything is identical to the engine
     * except the selection: no model, no edge, no optimisation. Whatever gap
     * the Lab reports between these two is the value of the model itself. */
    const band = legs.filter((l) => l.odds >= 1.05 && l.odds <= 3.6);
    if (!band.length) return null;
    const shuffled = rng.shuffle(band);
    const chosen = [];
    const used = new Set();
    let odds = 1;
    const target = targetOdds;
    for (const l of shuffled) {
      if (used.has(l.eventId)) continue;
      if (odds * l.odds > target + tolerance) continue;
      chosen.push(l);
      used.add(l.eventId);
      odds *= l.odds;
      if (odds >= target - tolerance) break;
      if (chosen.length >= 6) break;
    }
    if (!chosen.length || odds < target - tolerance || odds > target + tolerance) return null;
    return summarise({ legs: chosen, odds, legCount: chosen.length, winProb: chosen.reduce((a, l) => a * l.modelProb, 1) });
  }

  // 'favourites' — the folk strategy: stack the shortest prices you can find
  // until you reach the target. No edge, no band discipline beyond the target.
  const pool = [...legs].filter((l) => l.odds >= 1.02 && l.odds < 1.6).sort((a, b) => a.odds - b.odds);
  const chosen = [];
  const used = new Set();
  let odds = 1;
  for (const l of pool) {
    if (used.has(l.eventId)) continue;
    if (odds * l.odds > targetOdds + tolerance) continue;
    chosen.push(l);
    used.add(l.eventId);
    odds *= l.odds;
    if (odds >= targetOdds - tolerance) break;
    if (chosen.length >= 8) break;
  }
  if (!chosen.length || odds < targetOdds - tolerance) return null;
  return summarise({ legs: chosen, odds, legCount: chosen.length, winProb: chosen.reduce((a, l) => a * l.modelProb, 1) });
}

function summarise(c) {
  const legs = c.legs;
  const trueP = legs.reduce((a, l) => a * (l.truthProb ?? l.modelProb), 1) * correlationFactor(legs);
  const modelP = c.winProb ?? legs.reduce((a, l) => a * l.modelProb, 1) * correlationFactor(legs);
  return {
    legs,
    legCount: legs.length,
    odds: c.odds ?? round(legs.reduce((a, l) => a * l.odds, 1), 3),
    modelWinProb: clamp(modelP, 0, 0.999),
    trueWinProb: clamp(trueP, 0, 0.999),
    edgeSum: legs.reduce((a, l) => a + (l.edge ?? 0), 0),
    trueEv: legs.reduce((a, l) => a + (l.trueEvPerUnit ?? 0), 0) / Math.max(1, legs.length),
  };
}

function emptyStratResult(strat) {
  return {
    strat,
    completed: 0,
    finalBalances: [],
    profits: [],
    diedOnDay: [],
    avgLegs: [],
    modelProbs: [],
    trueProbs: [],
    edges: [],
    trueEvs: [],
    trueEvLegs: [],
    dayLog: [],
  };
}

function modeOf(arr) {
  const m = new Map();
  for (const v of arr) m.set(v, (m.get(v) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function histogram(arr, days) {
  const out = {};
  for (let d = 1; d <= days; d++) out[d] = 0;
  for (const v of arr) if (out[v] !== undefined) out[v]++;
  return out;
}

/**
 * Fast closed-form projection — no simulation, just the arithmetic of a
 * rollover at a given per-day win probability. Used by the dashboard to show
 * the user what they are signing up for *before* they stake.
 */
/**
 * Closed-form projection of a rollover — no simulation, just the arithmetic the
 * dashboard shows you before you stake.
 *
 * `measuredDailyWinProb` is the honest input: the per-day win rate the Lab
 * actually observed for slips the engine builds at this target. If it is not
 * supplied we fall back to `dailyWinProb`, and if neither is supplied we assume
 * the book is fair (1/targetOdds), which is the pessimistic reading — a 2.00
 * accumulator then pays exactly what it costs and the EV is 0.
 */
function projectRun({
  stake,
  days,
  targetOdds,
  dailyWinProb,
  measuredDailyWinProb = null,
  realisedOdds = targetOdds,
  currency = 'NGN',
}) {
  const measured = measuredDailyWinProb ?? null;
  const p = clamp(measured ?? dailyWinProb ?? 1 / targetOdds, 0.001, 0.999);
  const dailySource = measured != null
    ? `measured — ${round(measured * 100, 2)}% is what the Lab observes for engine-built slips at ${Number(targetOdds).toFixed(2)}`
    : dailyWinProb != null
      ? 'supplied by the caller'
      : `assumed fair — 1/${targetOdds} = ${round((1 / targetOdds) * 100, 2)}%. Plug in the Lab's measured daily rate for the real number.`;
  const pRun = p ** days;
  const payout = stake * realisedOdds ** days;
  const evFinal = pRun * payout;

  // The ladder is what the balance looks like on each day *if everything wins*.
  // It is the picture people actually want, and it is also the only picture the
  // marketing version of this idea ever shows you.
  const ladder = [];
  let bal = stake;
  for (let d = 0; d <= days; d++) {
    ladder.push({ day: d, balance: round(bal, 2), multiple: round(bal / stake, 2), stakeNext: d < days ? round(bal, 2) : null });
    bal *= realisedOdds;
  }

  return {
    stake,
    days,
    targetOdds,
    realisedOdds,
    currency,
    dailyWinProb: p,
    dailyWinProbPct: round(p * 100, 2),
    dailySource,
    runWinProb: pRun,
    runWinProbPct: round(pRun * 100, 3),
    oneIn: Math.round(1 / pRun),
    payoutIfComplete: round(payout, 2),
    multiple: round(realisedOdds ** days, 2),
    expectedFinalBalance: round(evFinal, 2),
    evPerUnit: round((evFinal - stake) / stake, 4),
    evPct: round(((evFinal - stake) / stake) * 100, 2),
    ladder,
    // what a fair book would charge for this bet
    fairOddsForTheRun: round(1 / pRun, 1),
    verdict: evFinal > stake
      ? `At a measured ${round(p * 100, 2)}% a day this rollover is +EV: ${round(((evFinal - stake) / stake) * 100, 2)}% per unit staked. It still completes about 1 time in ${Math.round(1 / pRun)}.`
      : `At ${round(p * 100, 2)}% a day this rollover breaks even or worse. You are paying for variance, not value.`,
  };
}
__exp_57 = runSimulation;
__exp_58 = projectRun;
__exp_59 = STRATEGIES;
}

/* ════════════════════════════════════════════════════════════════════════
   lib/http-core.js   →  hoists createApi, ENGINE_INFO, runPayload, dayPayload, projectFor, jsonSafe
   ════════════════════════════════════════════════════════════════════════ */
let __exp_60;
let __exp_61;
let __exp_62;
let __exp_63;
let __exp_64;
let __exp_65;
{
const createRun = __exp_42;
const scanRunDay = __exp_43;
const confirmDay = __exp_44;
const settleDay = __exp_45;
const chooseAlternative = __exp_46;
const adjustDayOdds = __exp_47;
const skipDay = __exp_48;
const rescanDay = __exp_49;
const abandonRun = __exp_50;
const restartRun = __exp_51;
const runProgress = __exp_52;
const dayCards = __exp_53;
const equityCurve = __exp_54;
const scanDay = __exp_34;
const scanForDay = __exp_33;
const PROVIDERS = __exp_35;
const fetchOddsApi = __exp_36;
const SIGNAL_WEIGHTS = __exp_30;
const runSimulation = __exp_57;
const projectRun = __exp_58;
const upcomingDays = __exp_22;
const tzNowParts = __exp_20;
const tzDateKey = __exp_19;

/**
 * http-core.js — the RolloverEngine API, with no runtime attached to it.
 *
 * This module is deliberately free of node:http, Buffer, req/res and the
 * filesystem. It takes a parsed request and returns a plain `{status, body}`
 * object, and it takes its persistence as an injected `store`. That is what
 * lets one implementation of the API run in three places:
 *
 *   • server/index.js  — node:http, store backed by data/store.json
 *   • api/index.js     — Vercel serverless, store backed by memory (per lambda)
 *   • public/local-api.js — the browser itself, store backed by localStorage
 *
 * The Vercel case is the reason the browser one exists. A serverless function
 * has no writable disk that outlives the invocation, so a run created in one
 * request would be gone by the next. Rather than pretend otherwise, the
 * deployed build reports `persistent: false` and the dashboard runs the engine
 * locally in the tab, persisting to localStorage. Same code, same numbers,
 * nothing lost between visits — it just lives on your device instead of a
 * server.
 */






const ENGINE_INFO = {
  name: 'RolloverEngine',
  version: '1.1.0',
  signalWeights: SIGNAL_WEIGHTS,
  notes: [
    'Prices are de-vigged across all quoting books before anything else is measured.',
    `Model probability = ${(SIGNAL_WEIGHTS.consensus * 100).toFixed(0)}% all-book consensus + ${(SIGNAL_WEIGHTS.sharp * 100).toFixed(0)}% sharp-book consensus + ${(SIGNAL_WEIGHTS.ratings * 100).toFixed(0)}% ratings prior.`,
    'Those weights were fitted over 3,550 priced legs against ground truth, not guessed — the sharp de-vigged price alone carries a 0.19pp mean error, the ratings model 6.68pp.',
    'Edge = model probability − implied probability of the best available price across all books.',
    'Legs are capped at one per event; same-league same-window slips take a small correlation haircut.',
    'Settlement resolves from a single simulated scoreline per event, so markets can never contradict each other.',
  ],
};

/** Sets/Maps survive JSON.stringify only if you convert them. */
function jsonSafe(key, value) {
  if (value instanceof Set) return [...value];
  if (value instanceof Map) return Object.fromEntries(value);
  return value;
}

function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/* ------------------------------------------------------------------ *
 * Payload shaping
 * ------------------------------------------------------------------ */

function runPayload(run) {
  return {
    id: run.id,
    status: run.status,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    lostAt: run.lostAt,
    config: run.config,
    balance: run.balance,
    startBalance: run.startBalance,
    currentDay: run.currentDay,
    stats: run.stats,
    projection: run.projection,
    lineage: run.lineage || [],
    verdict: run.status === 'active' ? null : run.verdict,
    lastDayMessage: run.lastDayMessage || null,
    progress: runProgress(run),
    dayCards: dayCards(run),
    equityCurve: equityCurve(run),
    days: run.days.map((d) => dayPayload(d)),
  };
}

function dayPayload(d) {
  return {
    day: d.day,
    date: d.date,
    status: d.status,
    targetOdds: d.targetOdds,
    stakeIn: d.stakeIn,
    stakeOut: d.stakeOut,
    confirmedAt: d.confirmedAt,
    settledAt: d.settledAt,
    message: d.message,
    slip: d.slip
      ? {
          nonce: d.slip.nonce,
          stake: d.slip.stake,
          reserve: d.slip.reserve,
          odds: d.slip.odds,
          legCount: d.slip.legCount,
          winProbPct: d.slip.winProbPct,
          fairOdds: d.slip.fairOdds,
          edgeSum: d.slip.edgeSum,
          avgConfidence: d.slip.avgConfidence,
          evPct: d.slip.evPct,
          grade: d.slip.grade,
          sports: d.slip.sports,
          leagues: d.slip.leagues,
          potentialReturn: d.slip.potentialReturn,
          potentialProfit: d.slip.potentialProfit,
          belowThreshold: d.slip.belowThreshold,
          legs: d.slip.legs.map((l) => ({
            legId: l.legId,
            eventId: l.eventId,
            sport: l.sport,
            league: l.league,
            kickoff: l.kickoff,
            home: l.home,
            away: l.away,
            market: l.market,
            pick: l.pick,
            odds: l.odds,
            book: l.book,
            edgePct: Math.round(l.edge * 10000) / 100,
            modelProbPct: Math.round(l.modelProb * 10000) / 100,
            impliedProbPct: Math.round(l.impliedProb * 10000) / 100,
            fairProbPct: Math.round(l.fairProb * 10000) / 100,
            evPct: Math.round((l.evPerUnit ?? 0) * 10000) / 100,
            confidence: l.confidence,
            agreement: l.agreement,
            sharpProbPct: Math.round((l.sharpProb ?? 0) * 10000) / 100,
            ratingsProbPct: Math.round((l.ratingsProb ?? 0) * 10000) / 100,
            band: l.band,
          })),
        }
      : null,
    scan: d.scan
      ? {
          scannedAt: d.scan.scannedAt,
          provider: d.scan.provider,
          eventsScanned: d.scan.eventsScanned,
          marketsScanned: d.scan.marketsScanned,
          pricesQuoted: d.scan.pricesQuoted,
          books: d.scan.books,
          bookCount: d.scan.bookCount,
          bookQuotes: d.scan.bookQuotes,
          legsConsidered: d.scan.legsConsidered,
          legsEligible: d.scan.legsEligible,
          combosEvaluated: d.scan.combosEvaluated,
          edgeTier: d.scan.edgeTier,
          modelErrorPp: d.scan.modelErrorPp,
          sharpErrorPp: d.scan.sharpErrorPp,
          consensusErrorPp: d.scan.consensusErrorPp,
          ratingsErrorPp: d.scan.ratingsErrorPp,
          edgeLegTrueEvPct: d.scan.edgeLegTrueEvPct,
          avgOverround: d.scan.avgOverround,
          report: d.scan.report,
          alternatives: d.scan.alternatives,
          bestEdgeLegs: d.scan.bestEdgeLegs,
          failure: d.scan.failure,
        }
      : null,
    result: d.result,
  };
}

function dayCard(run, dayNumber) {
  const d = run.days.find((x) => x.day === dayNumber);
  return d ? dayPayload(d) : null;
}

function projectFor(run) {
  const cfg = run.config;
  const winProbs = run.days.filter((d) => d.slip).map((d) => d.slip.winProb);
  const dailyP = winProbs.length ? winProbs.reduce((a, b) => a + b, 0) / winProbs.length : 1 / cfg.targetOdds;
  return projectRun({
    stake: run.startBalance,
    days: cfg.days,
    targetOdds: cfg.targetOdds,
    dailyWinProb: dailyP,
    realisedOdds: run.days.find((d) => d.slip)?.slip.odds || cfg.targetOdds,
    currency: cfg.currency,
  });
}

function briefEvent(e) {
  return {
    id: e.id,
    sport: e.sport,
    league: e.league.name,
    leagueCode: e.league.code,
    tier: e.league.tier,
    kickoff: e.kickoff,
    kickoffLocal: e.kickoffLocal,
    home: e.home.name,
    away: e.away.name,
    meta: e.meta,
    meta2: e.meta2,
    markets: e.markets.map((m) => ({
      key: m.key,
      name: m.name,
      overround: m.overround,
      outcomes: m.outcomes.map((o) => ({
        key: o.key,
        label: o.label,
        odds: o.odds,
        book: o.bestBook,
        modelProbPct: Math.round(o.modelProb * 10000) / 100,
        impliedProbPct: Math.round(o.impliedProb * 10000) / 100,
        edgePct: Math.round(o.edge * 10000) / 100,
        confidence: o.confidence,
        band: o.confidenceBand,
      })),
    })),
  };
}

/* ------------------------------------------------------------------ *
 * The API itself
 * ------------------------------------------------------------------ */

/**
 * @param {object} opts
 * @param {object} opts.store        persistence adapter (see lib/store.js)
 * @param {object} [opts.env]        environment variables (ODDS_API_KEY etc.)
 * @param {boolean} [opts.persistent] whether the store outlives a request
 * @param {number} [opts.maxIterations] cap on Monte-Carlo iterations
 * @returns {(req:{method:string,pathname:string,query:URLSearchParams,body:object}) => Promise<{status:number,body:object}>}
 */
function createApi({ store, env = {}, persistent = true, maxIterations = 5000 } = {}) {
  const startedAt = Date.now();

  async function statePayload() {
    const settings = await store.getSettings();
    const active = await store.getActiveRun();
    const runs = await store.listRuns(20);
    const now = new Date();
    return {
      settings,
      providers: PROVIDERS,
      now: tzNowParts(now, settings.tz),
      activeRun: active ? runPayload(active) : null,
      activeProjection: active ? projectFor(active) : null,
      runs,
      engine: { ...ENGINE_INFO, persistent },
      /* The dashboard reads this to decide whether to run the engine in the tab
       * or over the network. A serverless deployment has no disk that survives
       * an invocation, so it says so plainly instead of silently losing runs. */
      runtime: {
        persistent,
        mode: persistent ? 'server' : 'stateless',
        advice: persistent
          ? 'Runs are persisted on the server.'
          : 'This deployment has no writable disk. The dashboard is running the engine locally in your browser and saving to localStorage, so nothing is lost between visits.',
      },
    };
  }

  return async function api({ method, pathname, query, body = {} }) {
    const p = String(pathname || '').replace(/\/+$/, '');
    const seg = p.split('/').filter(Boolean); // ['api', ...]
    const q = query || new URLSearchParams();

    if (method === 'GET' && p === '/api/state') return { status: 200, body: await statePayload() };

    if (method === 'GET' && p === '/api/health') {
      return { status: 200, body: { ok: true, persistent, uptimeMs: Date.now() - startedAt } };
    }

    if (method === 'GET' && p === '/api/providers') return { status: 200, body: { providers: PROVIDERS } };

    if (method === 'GET' && p === '/api/calendar') {
      const settings = await store.getSettings();
      const from = q.get('from') || tzDateKey(new Date(), settings.tz);
      return {
        status: 200,
        body: {
          tz: settings.tz,
          now: tzNowParts(new Date(), settings.tz),
          days: upcomingDays(from, Number(q.get('n') || 10), {
            tz: settings.tz,
            eventsPerDay: settings.eventsPerDay,
          }),
        },
      };
    }

    if (method === 'GET' && p === '/api/scan') {
      const settings = await store.getSettings();
      const date = q.get('date') || tzDateKey(new Date(), settings.tz);
      const eventsPerDay = Number(q.get('events') || settings.eventsPerDay);
      const scan = scanDay(date, {
        tz: settings.tz,
        provider: 'sim',
        eventsPerDay,
        marketInefficiency: settings.marketInefficiency,
      });
      const { builder } = scanForDay(date, {
        tz: settings.tz,
        eventsPerDay,
        marketInefficiency: settings.marketInefficiency,
        builder: {
          targetOdds: Number(q.get('odds') || settings.targetOdds),
          tolerance: settings.tolerance,
          mode: settings.mode,
        },
      });
      return {
        status: 200,
        body: {
          date,
          diagnostics: scan.diagnostics,
          builder: builder.ok ? builder : { ok: false, reason: builder.reason, message: builder.message, report: builder.report },
          events: scan.events.map(briefEvent),
          topLegs: [...scan.legs].sort((a, b) => b.edge - a.edge).slice(0, 40),
        },
      };
    }

    if (method === 'GET' && p === '/api/lab') return { status: 200, body: { history: await store.getLab() } };

    if (method === 'POST' && p === '/api/settings') {
      return { status: 200, body: { settings: await store.saveSettings(body) } };
    }

    if (method === 'POST' && p === '/api/runs') {
      const settings = await store.getSettings();
      await store.saveSettings({
        currency: body.currency || settings.currency,
        stake: Number(body.stake ?? settings.stake),
        days: Number(body.days ?? settings.days),
        targetOdds: Number(body.targetOdds ?? settings.targetOdds),
        tolerance: Number(body.tolerance ?? settings.tolerance),
        mode: body.mode || settings.mode,
        provider: body.provider || settings.provider,
        reservePct: Number(body.reservePct ?? settings.reservePct),
      });
      const merged = await store.getSettings();
      const run = createRun({
        stake: merged.stake,
        days: merged.days,
        targetOdds: merged.targetOdds,
        startDay: body.startDay,
        config: {
          currency: merged.currency,
          tolerance: merged.tolerance,
          provider: merged.provider,
          tz: merged.tz,
          eventsPerDay: merged.eventsPerDay,
          marketInefficiency: merged.marketInefficiency,
          reservePct: merged.reservePct,
          oddsMode: body.oddsMode || 'exact',
          builder: { mode: merged.mode, minEdgePerLeg: merged.minEdgePerLeg, maxLegs: merged.maxLegs },
        },
      });
      scanRunDay(run, 1);
      await store.saveRun(run);
      return { status: 201, body: { run: runPayload(run), projection: projectFor(run) } };
    }

    if (method === 'GET' && seg[1] === 'runs' && seg.length === 2) {
      return { status: 200, body: { runs: await store.listRuns() } };
    }
    if (method === 'GET' && seg[1] === 'runs' && seg.length === 3) {
      const run = await store.getRun(seg[2]);
      if (!run) return { status: 404, body: { error: 'run not found' } };
      return { status: 200, body: { run: runPayload(run), projection: projectFor(run) } };
    }
    if (method === 'DELETE' && seg[1] === 'runs' && seg.length === 3) {
      await store.deleteRun(seg[2]);
      return { status: 200, body: { ok: true } };
    }

    if (method === 'POST' && seg[1] === 'runs' && seg.length === 4) {
      const run = await store.getRun(seg[2]);
      if (!run) return { status: 404, body: { error: 'run not found' } };
      const action = seg[3];

      switch (action) {
        case 'scan': {
          rescanDay(run, body.day ?? run.currentDay, body.overrides || {});
          await store.saveRun(run);
          return { status: 200, body: { run: runPayload(run), projection: projectFor(run) } };
        }
        case 'stake': {
          const day = confirmDay(run, body.day ?? run.currentDay);
          await store.saveRun(run);
          return { status: 200, body: { run: runPayload(run), day: dayCard(run, day.day) } };
        }
        case 'settle': {
          const before = run.balance;
          /* body.outcome 'won' | 'lost' → the user reports what really happened.
           * omitted / 'auto'            → resolve against the simulated scorelines. */
          const manual = body.outcome === 'won' || body.outcome === 'lost';
          const { day, verdict } = settleDay(run, body.outcome, {
            dayNumber: body.day ?? run.currentDay,
            manual,
            realisedOdds: body.realisedOdds ?? null,
          });
          await store.saveRun(run);
          return {
            status: 200,
            body: {
              run: runPayload(run),
              projection: projectFor(run),
              day: dayCard(run, day.day),
              result: day.result,
              verdict,
              dayVerdict: day.message,
              balanceBefore: before,
              balanceAfter: run.balance,
            },
          };
        }
        case 'alt': {
          const day = chooseAlternative(run, body.day ?? run.currentDay, Number(body.index ?? 0));
          await store.saveRun(run);
          return { status: 200, body: { run: runPayload(run), day: dayCard(run, day.day) } };
        }
        case 'odds': {
          adjustDayOdds(run, body.day ?? run.currentDay, Number(body.odds));
          await store.saveRun(run);
          return { status: 200, body: { run: runPayload(run), projection: projectFor(run) } };
        }
        case 'skip': {
          skipDay(run, body.day ?? run.currentDay);
          await store.saveRun(run);
          return { status: 200, body: { run: runPayload(run), projection: projectFor(run) } };
        }
        case 'abandon': {
          abandonRun(run, body.reason);
          await store.saveRun(run);
          return { status: 200, body: { run: runPayload(run) } };
        }
        case 'restart': {
          const next = restartRun(run, {
            stake: body.stake,
            targetOdds: body.targetOdds,
            days: body.days,
            startDay: body.startDay,
            config: body.config,
          });
          await store.saveRun(next);
          return { status: 200, body: { run: runPayload(next), projection: projectFor(next), previousRunId: run.id } };
        }
        default:
          return { status: 404, body: { error: `unknown action "${action}"` } };
      }
    }

    if (method === 'POST' && p === '/api/lab/simulate') {
      const settings = await store.getSettings();
      const cfg = {
        /* Serverless has a hard wall-clock budget; the Lab is the one endpoint
         * that can genuinely blow it, so the cap is lower when not persistent. */
        iterations: clampInt(body.iterations, 1, persistent ? maxIterations : 1500, 400),
        stake: Number(body.stake ?? settings.stake),
        days: clampInt(body.days, 1, 30, settings.days),
        targetOdds: Number(body.targetOdds ?? settings.targetOdds),
        tolerance: Number(body.tolerance ?? settings.tolerance),
        mode: body.mode || settings.mode,
        eventsPerDay: clampInt(body.eventsPerDay, 6, 80, settings.eventsPerDay),
        marketInefficiency: Number(body.marketInefficiency ?? settings.marketInefficiency),
        marketVariants: clampInt(body.marketVariants, 1, 8, 3),
        seed: Number(body.seed ?? 20261007),
        strategies: body.strategies?.length ? body.strategies : ['engine', 'naive'],
        startDay: body.startDay || tzDateKey(new Date(), settings.tz),
      };
      const result = runSimulation(cfg);
      await store.pushLab(result);
      return { status: 200, body: result };
    }

    if (method === 'POST' && p === '/api/lab/project') {
      const settings = await store.getSettings();
      return {
        status: 200,
        body: {
          projection: projectRun({
            stake: Number(body.stake ?? settings.stake),
            days: clampInt(body.days, 1, 30, settings.days),
            targetOdds: Number(body.targetOdds ?? settings.targetOdds),
            measuredDailyWinProb: body.measuredDailyWinProb != null ? Number(body.measuredDailyWinProb) : null,
            dailyWinProb: Number(body.dailyWinProb ?? 1 / Number(body.targetOdds ?? settings.targetOdds) + 0.025),
            realisedOdds: Number(body.realisedOdds ?? body.targetOdds ?? settings.targetOdds),
            currency: body.currency ?? settings.currency,
          }),
        },
      };
    }

    if (method === 'POST' && p === '/api/odds/live') {
      const settings = await store.getSettings();
      const key = body.apiKey || settings.oddsApi?.key || env.ODDS_API_KEY;
      if (!key) {
        return {
          status: 400,
          body: { error: 'No API key. Set ODDS_API_KEY or paste one in settings.', hint: 'https://the-odds-api.com — the free tier is enough.' },
        };
      }
      try {
        const games = await fetchOddsApi(body.sports, key, { daysAhead: Number(body.daysAhead || 2) });
        return { status: 200, body: { count: games.length, games: games.slice(0, 60) } };
      } catch (err) {
        return { status: 502, body: { error: `Live odds fetch failed: ${err.message}` } };
      }
    }

    return { status: 404, body: { error: `no route for ${method} ${p}` } };
  };
}
__exp_60 = createApi;
__exp_61 = ENGINE_INFO;
__exp_62 = runPayload;
__exp_63 = dayPayload;
__exp_64 = projectFor;
__exp_65 = jsonSafe;
}

/* ════════════════════════════════════════════════════════════════════════
   lib/store-shared.js   →  hoists DEFAULT_SETTINGS, summariseRun, reviveRun
   ════════════════════════════════════════════════════════════════════════ */
let __exp_66;
let __exp_67;
let __exp_68;
{
/**
 * store-shared.js — the parts of persistence that every backend must agree on.
 *
 * Three storage backends implement the same contract: the flat JSON file
 * (lib/store.js), an in-process object for serverless (lib/memory-store.js) and
 * localStorage in the browser (also lib/memory-store.js). If any of them
 * disagrees about what a run summary looks like or what the default settings
 * are, the same dashboard renders different numbers depending on where it is
 * hosted — which is exactly the kind of quiet inconsistency that makes you
 * distrust a system that is entirely about trustworthy numbers.
 *
 * So the shared definitions live here, in a module with no imports at all. That
 * last part matters: the browser build must be able to bundle this without
 * dragging node:fs in behind it.
 */

/** House defaults. Nigerian Naira, ₦500, 7 days at 2.00, Africa/Lagos. */
const DEFAULT_SETTINGS = {
  currency: 'NGN',
  tz: 'Africa/Lagos',
  stake: 500,
  days: 7,
  targetOdds: 2.0,
  tolerance: 0.1,
  mode: 'balanced',
  provider: 'sim',
  eventsPerDay: 42,
  marketInefficiency: 1.3,
  reservePct: 0,
  /* The edge floor defaults to 0 on purpose. Positive-edge legs are
   * disproportionately longshots, so gating the *search* on an edge floor
   * starves the pool of the short prices needed to build a 2.00 accumulator and
   * the day silently degrades into one long leg. The win-probability optimiser
   * lands on +edge legs anyway (around +1.5pp per leg unprompted); the floor is
   * a reporting number, and the builder relaxes it in tiers when it bites. */
  minEdgePerLeg: 0,
  maxLegs: 6,
};

/** What the run list shows. Cheap enough to compute on every read. */
function summariseRun(r) {
  const cfg = r.config || {};
  return {
    id: r.id,
    status: r.status,
    createdAt: r.createdAt,
    currency: cfg.currency,
    stake: r.startBalance,
    balance: r.balance,
    days: cfg.days,
    currentDay: r.currentDay,
    targetOdds: cfg.targetOdds,
    daysWon: r.stats?.won ?? 0,
    profit: Math.round((r.balance - r.startBalance) * 100) / 100,
    headline: r.verdict?.headline ?? null,
    provider: cfg.provider,
    startedOn: cfg.startDay,
  };
}

/** Runs are persisted as plain JSON, so rehydrate what the engine expects live. */
function reviveRun(run) {
  if (!run) return run;
  for (const d of run.days || []) {
    if (d.result?.resolved) {
      for (const r of d.result.resolved) if (r.wonSet) delete r.wonSet;
    }
  }
  return run;
}
__exp_66 = DEFAULT_SETTINGS;
__exp_67 = summariseRun;
__exp_68 = reviveRun;
}

/* ════════════════════════════════════════════════════════════════════════
   lib/memory-store.js   →  hoists createLocalStorageStore, createStoreAdapter, createMemoryStore
   ════════════════════════════════════════════════════════════════════════ */
let __exp_69;
let __exp_70;
let __exp_71;
{
const DEFAULT_SETTINGS = __exp_66;
const summariseRun = __exp_67;
const reviveRun = __exp_68;

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


const EMPTY = () => ({ runs: {}, order: [], settings: {}, lab: [] });

/**
 * @param {object} backend           `{ read(): object|null, write(db): void }`
 * @param {object} [opts]
 * @param {string} [opts.oddsApiKey] injected key for live-odds settings
 * @param {number} [opts.labCap]     how many lab results to retain
 * @param {number} [opts.runCap]     how many runs to retain
 */
function createStoreAdapter(backend, { oddsApiKey = '', labCap = 40, runCap = 200, onQuotaExceeded = null } = {}) {
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
function createMemoryStore(opts) {
  let db = EMPTY();
  return createStoreAdapter({ read: () => db, write: (next) => { db = next; } }, opts);
}

/**
 * localStorage-backed store for the browser build.
 * Falls back to an in-memory object when localStorage is unavailable (private
 * mode, sandboxed iframe, SSR) so the dashboard still works for that session.
 */
function createLocalStorageStore(key = 'rolloverengine.store.v1', opts) {
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
__exp_69 = createLocalStorageStore;
__exp_70 = createStoreAdapter;
__exp_71 = createMemoryStore;
}

/* ════════════════════════════════════════════════════════════════════════
   facade — 44 public bindings
   ════════════════════════════════════════════════════════════════════════ */
export { __exp_7 as round, __exp_6 as clamp, __exp_10 as mean, __exp_22 as upcomingDays, __exp_19 as tzDateKey, __exp_20 as tzNowParts, __exp_24 as dayShape, __exp_31 as buildRolloverSlip, __exp_32 as DEFAULT_BUILDER_OPTS, __exp_34 as scanDay, __exp_33 as scanForDay, __exp_35 as PROVIDERS, __exp_39 as suggestNextRun, __exp_40 as suggestRecovery, __exp_41 as money, __exp_42 as createRun, __exp_43 as scanRunDay, __exp_44 as confirmDay, __exp_45 as settleDay, __exp_48 as skipDay, __exp_49 as rescanDay, __exp_51 as restartRun, __exp_50 as abandonRun, __exp_46 as chooseAlternative, __exp_47 as adjustDayOdds, __exp_52 as runProgress, __exp_53 as dayCards, __exp_54 as equityCurve, __exp_55 as RUN_STATUS, __exp_56 as DAY_STATUS, __exp_57 as runSimulation, __exp_58 as projectRun, __exp_59 as STRATEGIES, __exp_60 as createApi, __exp_61 as ENGINE_INFO, __exp_62 as runPayload, __exp_63 as dayPayload, __exp_64 as projectFor, __exp_65 as jsonSafe, __exp_66 as DEFAULT_SETTINGS, __exp_67 as summariseRun, __exp_69 as createLocalStorageStore, __exp_70 as createStoreAdapter, __exp_71 as createMemoryStore };
