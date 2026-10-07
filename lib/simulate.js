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

import { makeRng, clamp, round, mean, median, percentile, stdev } from './math.js';
import { buildDayEvents, tzDateKey } from './fixtures.js';
import { priceEvent, extractLegs, correlationFactor } from './markets.js';
import { applyMarketInformation } from './truth.js';
import { buildRolloverSlip, DEFAULT_BUILDER_OPTS } from './builder.js';
import { settleByTruthProb } from './settle.js';

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
export const STRATEGIES = {
  engine: 'RolloverEngine (model + optimiser)',
  naive: 'Random legs, same odds target',
  favourites: 'Stack the shortest prices',
};

/**
 * @param {object} cfg { iterations, stake, days, targetOdds, tolerance, mode,
 *                       eventsPerDay, marketInefficiency, startDay, seed, strategies }
 */
export function runSimulation(cfg = {}) {
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
export function projectRun({
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

export { settleByTruthProb, tzDateKey };
