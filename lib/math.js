/**
 * math.js — deterministic numeric + RNG primitives used across the engine.
 *
 * Everything here is pure and side-effect free. The RNG is seeded (mulberry32)
 * so a given event/day/simulation always resolves identically. That is what
 * makes the Monte-Carlo lab and the test-suite reproducible.
 */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const round = (v, dp = 2) => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

/** 32-bit string hash (FNV-1a) → seed for mulberry32. */
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — tiny, fast, good-enough-quality PRNG. */
export function makeRng(seed) {
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
export function poissonPmf(lambda, max = 12) {
  const out = new Array(max + 1);
  const l = Math.max(1e-9, lambda);
  for (let k = 0; k <= max; k++) out[k] = (Math.exp(-l) * l ** k) / FACT[k];
  return out;
}

/** Joint scoreline grid p[i][j] = P(home=i, away=j), normalised to sum 1. */
export function scoreGrid(lh, la, max = 12) {
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

export function sumGrid(grid, pred) {
  let s = 0;
  for (let i = 0; i < grid.length; i++) for (let j = 0; j < grid[i].length; j++) if (pred(i, j)) s += grid[i][j];
  return s;
}

/** P(home goals + away goals > line) using the two marginals (exact for integer/half lines). */
export function overProb(lh, la, line, max = 20) {
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
export function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  let p =
    d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

/** Two-sided normal scoreline model used for basketball / baseball / hockey. */
export function gaussianTruth(muHome, muAway, sigma, maxMargin = 60) {
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
export function h2hTruth(ratingA, ratingB, scale = 8) {
  const pA = 1 / (1 + Math.exp(-(ratingA - ratingB) / scale));
  return { pA: clamp(pA, 0.02, 0.98), pB: clamp(1 - pA, 0.02, 0.98) };
}

/** Shannon entropy (bits) of a probability vector — used as an uncertainty gauge. */
export function entropy(probs) {
  let h = 0;
  for (const p of probs) if (p > 0) h -= p * Math.log2(p);
  return h;
}

/* ------------------------------------------------------------------ *
 * Bookmaker arithmetic
 * ------------------------------------------------------------------ */

/** Decimal odds → implied probability (with the vig still in it). */
export const impliedProb = (odds) => 1 / odds;

/**
 * Remove the overround from a set of prices.
 * Returns fair probabilities that sum to 1, plus the book's overround.
 *
 * Method: multiplicative de-vig (the "power" method is overkill here).
 */
export function devig(oddsList) {
  const impl = oddsList.map(impliedProb);
  const sum = impl.reduce((a, b) => a + b, 0);
  return {
    fair: impl.map((p) => p / sum),
    overround: sum - 1,
    payout: 1 / sum,
  };
}

/** Fair (no-vig) decimal odds from a probability. */
export const fairOdds = (p) => (p > 0 ? 1 / p : Infinity);

/** Expected value per unit staked at `odds` with true/model probability `p`. */
export const ev = (p, odds) => p * (odds - 1) - (1 - p);

/**
 * Kelly fraction for a single binary bet.
 * b = net decimal odds (odds - 1). Clamped to [0, cap].
 */
export function kelly(p, odds, cap = 0.25) {
  const b = odds - 1;
  const q = 1 - p;
  const f = (b * p - q) / b;
  return clamp(f, 0, cap);
}

/** Fractional-Kelly stake sizing helper. */
export const kellyStake = (bankroll, p, odds, fraction = 0.25, cap = 0.1) =>
  round(bankroll * kelly(p, odds, cap) * fraction, 2);

/** Decimal → approximate fractional odds string (for slip display). */
export function toFractional(decimal) {
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
export function blendVectors(vectors, weights) {
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

export const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

export const stdev = (arr) => {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((x) => (x - m) ** 2)));
};

export const percentile = (arr, p) => {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const idx = clamp(Math.floor(p * s.length), 0, s.length - 1);
  return s[idx];
};

export const median = (arr) => percentile(arr, 0.5);
