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

import {
  createRun,
  scanRunDay,
  confirmDay,
  settleDay,
  chooseAlternative,
  adjustDayOdds,
  skipDay,
  rescanDay,
  abandonRun,
  restartRun,
  runProgress,
  dayCards,
  equityCurve,
} from './rollover.js';
import { scanDay, scanForDay, scanDayLive, PROVIDERS, fetchOddsApi } from './scan.js';
import { SIGNAL_WEIGHTS } from './markets.js';
import { runSimulation, projectRun } from './simulate.js';
import { upcomingDays, tzNowParts, tzDateKey } from './fixtures.js';

export const ENGINE_INFO = {
  name: 'RolloverEngine',
  version: '1.1.5',
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
export function jsonSafe(key, value) {
  if (value instanceof Set) return [...value];
  if (value instanceof Map) return Object.fromEntries(value);
  return value;
}

/**
 * Serialise a value the way the wire will, Sets and Maps included.
 *
 * `jsonSafe` is a JSON.stringify REVIVER — its first parameter is the key. Calling
 * it as `jsonSafe(obj)` silently returns undefined, which is how a whole route
 * once shipped an empty body. Route handlers should use this.
 */
export function toPlain(value) {
  return JSON.parse(JSON.stringify(value, jsonSafe));
}

export function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/* ------------------------------------------------------------------ *
 * Payload shaping
 * ------------------------------------------------------------------ */

export function runPayload(run) {
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

export function dayPayload(d) {
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
          /* The provider story travels with every payload: a run priced off
           * invented numbers must say so wherever it is rendered, including
           * weeks later from history. */
          providerRequested: d.scan.providerRequested ?? d.scan.provider,
          providerFellBack: Boolean(d.scan.providerFellBack),
          providerFallbackReason: d.scan.providerFallbackReason ?? null,
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

export function dayCard(run, dayNumber) {
  const d = run.days.find((x) => x.day === dayNumber);
  return d ? dayPayload(d) : null;
}

export function projectFor(run) {
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

export function briefEvent(e) {
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
/**
 * Real fixtures for the day being priced, whenever a key exists to fetch them.
 *
 * The synchronous scan cannot await the network, so before this helper every
 * run opened on simulated prices no matter what was in settings — the one day
 * money gets staked was the one day the engine went blind. Routes now await
 * `scanDayLive` here and hand the result to `scanRunDay` as a prepared board.
 *
 * Three honest exits, in order: a board the dashboard already fetched (the
 * browser-bundle case, where the route itself must not refetch); a live fetch
 * on server-shaped hosts; and `{}` — meaning "I could not get live prices",
 * which lets the sync path run and stamp its own loud fallback. A failure to
 * fetch is never disguised as a success, and a success is never invented.
 */
async function livePreparedFor(env, body, settings, dateKey, board) {
  if (settings.provider !== 'oddsapi') return {};
  if (board?.scan && board?.builder) return { prepared: { scan: board.scan, builder: board.builder } };
  /* In a browser bundle the route has no server-side key and no business
   * firing cross-origin requests with someone's key in the URL; the dashboard
   * fetches the board through its own origin and hands it over instead. */
  if (globalThis.window !== undefined) return {};
  const key = body.apiKey || settings.oddsApi?.key || env.ODDS_API_KEY || '';
  if (!key || !dateKey) return {};
  try {
    const live = await scanDayLive(dateKey, {
      tz: settings.tz,
      apiKey: key,
      sports: settings.oddsApi?.sports || [],
      builder: {
        targetOdds: settings.targetOdds,
        tolerance: settings.tolerance,
        mode: settings.mode,
      },
    });
    return { prepared: { scan: live.scan, builder: live.builder } };
  } catch {
    return {};
  }
}

export function createApi({ store, env = {}, persistent = true, maxIterations = 5000 } = {}) {
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
    /* Every host normalises differently — server/index.js builds URLSearchParams
     * from the request, api/index.js from the Vercel URL, and a test may pass a
     * raw string. Coerce once so a malformed query is an empty one rather than a
     * TypeError that takes the whole handler down. */
    const q = query instanceof URLSearchParams
      ? query
      : new URLSearchParams(typeof query === 'string' ? query : '');
    const p = String(pathname || '').replace(/\/+$/, '');
    const seg = p.split('/').filter(Boolean); // ['api', ...]

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
      /* Honour the requested provider, and report which one actually answered.
       * Hardcoding 'sim' here meant a user who selected "The Odds API" and pasted
       * a key was silently shown invented prices — the worst failure mode this
       * engine has, because it looks exactly like success. */
      const wantProvider = q.get('provider') || settings.provider || 'sim';
      const scan = scanDay(date, {
        tz: settings.tz,
        provider: wantProvider,
        eventsPerDay,
        marketInefficiency: settings.marketInefficiency,
        apiKey: q.get('apiKey') || settings.oddsApi?.key || env.ODDS_API_KEY || '',
        manualOdds: settings.manualOdds,
      });
      const { builder } = scanForDay(date, {
        tz: settings.tz,
        provider: wantProvider,
        eventsPerDay,
        marketInefficiency: settings.marketInefficiency,
        manualOdds: settings.manualOdds,
        apiKey: q.get('apiKey') || settings.oddsApi?.key || env.ODDS_API_KEY || '',
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
          /* Which provider was asked for and which one actually answered.
           * `fellBack` is the flag the UI must never hide. */
          provider: {
            requested: scan.diagnostics?.providerRequested ?? wantProvider,
            used: scan.diagnostics?.providerUsed ?? 'sim',
            fellBack: Boolean(scan.diagnostics?.fellBack),
            reason: scan.diagnostics?.fallbackReason ?? null,
          },
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
      scanRunDay(run, 1, await livePreparedFor(env, body, merged, run.days[0].date, body.liveBoard));
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
          const settings = await store.getSettings();
          const dayNum = body.day ?? run.currentDay;
          const day = run.days.find((d) => d.day === dayNum);
          const overrides = body.overrides || {};
          if (!overrides.prepared) {
            Object.assign(overrides, await livePreparedFor(env, body, settings, day?.date, body.liveBoard));
          }
          rescanDay(run, dayNum, overrides);
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

    /* The live scan. Async because fetching nine leagues cannot be done inside
     * the synchronous scan path. Throws rather than falling back: "I could not
     * get you live prices" and "here are live prices" are not interchangeable. */
    if ((method === 'POST' || method === 'GET') && p === '/api/scan/live') {
      const settings = await store.getSettings();
      const src = method === 'POST' ? (body || {}) : Object.fromEntries(q);
      const key = src.apiKey || settings.oddsApi?.key || env.ODDS_API_KEY;
      const date = src.date || tzDateKey(new Date(), settings.tz);
      if (!key) {
        return {
          status: 400,
          body: {
            error: 'No API key. Set ODDS_API_KEY or paste one in settings.',
            hint: 'https://the-odds-api.com — the free tier is enough. Until a key is present every scan is simulated, and says so.',
          },
        };
      }
      try {
        const res = await scanDayLive(date, {
          tz: settings.tz,
          apiKey: key,
          sports: src.sports || settings.oddsApi?.sports || [],
          daysAhead: Number(src.daysAhead || 2),
          builder: {
            targetOdds: Number(src.odds || settings.targetOdds),
            tolerance: Number(src.tolerance ?? settings.tolerance),
            mode: src.mode || settings.mode,
          },
        });
        return {
          status: 200,
          body: {
            dayKey: date,
            provider: { requested: 'oddsapi', used: 'oddsapi', fellBack: false, reason: null },
            scan: toPlain(res.scan),
            builder: toPlain(res.builder),
            diagnostics: toPlain(res.diagnostics),
            quota: res.quota || null,
            leagues: toPlain(res.leagues || []),
            truthKnown: false,
            note: 'Live prices. truthProb and calibration are null on purpose — with real fixtures nobody knows the answer yet.',
          },
        };
      } catch (err) {
        const status = err.code === 'NO_KEY' ? 400 : err.code === 'NO_GAMES' ? 502 : 502;
        return { status, body: { error: err.message, code: err.code || 'FETCH_FAILED' } };
      }
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
        const fetched = await fetchOddsApi(body.sports, key, { daysAhead: Number(body.daysAhead || 2) });
        return {
          status: 200,
          body: {
            count: fetched.games.length,
            games: fetched.games.slice(0, 60),
            quota: fetched.quota,
            leagues: fetched.leagues,
          },
        };
      } catch (err) {
        return { status: 502, body: { error: `Live odds fetch failed: ${err.message}` } };
      }
    }

    return { status: 404, body: { error: `no route for ${method} ${p}` } };
  };
}
