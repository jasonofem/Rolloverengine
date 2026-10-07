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

import { buildDayEvents, tzDateKey, tzNowParts, formatKickoff } from './fixtures.js';
import { priceEvent, extractLegs } from './markets.js';
import { applyMarketInformation } from './truth.js';
import { buildRolloverSlip, DEFAULT_BUILDER_OPTS } from './builder.js';
import { makeRng, clamp, round } from './math.js';

export const PROVIDERS = {
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
export function scanDay(dayKey, opts = {}) {
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

export function scanSim(dayKey, opts = {}) {
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
export function scanManual(dayKey, opts = {}) {
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

export function scanForDay(dayKey, runConfig, overrides = {}) {
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

export async function fetchOddsApi(sports, apiKey, { daysAhead = 2 } = {}) {
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

export { tzDateKey, tzNowParts, buildDayEvents };
