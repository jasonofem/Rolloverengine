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

import { makeRng, round, clamp, mean } from './math.js';
import { scanForDay } from './scan.js';
import { settleLegs } from './settle.js';
import { tzDateKey, tzNowParts, upcomingDays, formatKickoff, zonedTimeToMs } from './fixtures.js';
import { suggestNextRun, suggestRecovery } from './suggestions.js';

export const RUN_STATUS = {
  ACTIVE: 'active',
  COMPLETE: 'complete',
  LOST: 'lost',
  ABANDONED: 'abandoned',
};

export const DAY_STATUS = {
  PENDING: 'pending',
  READY: 'ready',
  OPEN: 'open',
  WON: 'won',
  LOST: 'lost',
  SKIPPED: 'skipped',
};

export const DEFAULTS = {
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

export function createRun(input = {}, now = new Date()) {
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
export function stakeFor(balance, cfg) {
  if (!cfg.reservePct) return balance;
  const held = balance * (clamp(cfg.reservePct, 0, cfg.reserveCapPct) / 100);
  return Math.max(0.01, balance - held);
}

/* ------------------------------------------------------------------ *
 * Scanning a day
 * ------------------------------------------------------------------ */

export function scanRunDay(run, dayNumber = run.currentDay, overrides = {}) {
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
export function chooseAlternative(run, dayNumber, altIndex) {
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

export function confirmDay(run, dayNumber = run.currentDay) {
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
export function settleDay(run, outcome, opts = {}) {
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

export function skipDay(run, dayNumber = run.currentDay) {
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

export function rescanDay(run, dayNumber = run.currentDay, overrides = {}) {
  const day = run.days.find((d) => d.day === dayNumber);
  if (!day) throw new Error('rescanDay: unknown day');
  if ([DAY_STATUS.OPEN, DAY_STATUS.WON, DAY_STATUS.LOST].includes(day.status)) {
    throw new Error('rescanDay: this day is committed or settled');
  }
  // a fresh nonce salt = a fresh draw of the market (prices move)
  run.nonceSalt = (run.nonceSalt || 0) + 1;
  return scanRunDay(run, dayNumber, overrides);
}

export function adjustDayOdds(run, dayNumber, newOdds) {
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

export function abandonRun(run, reason = 'user') {
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
export function restartRun(run, overrides = {}, now = new Date()) {
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

export function runProgress(run) {
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

export function equityCurve(run) {
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
export function dayCards(run) {
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
export const cur = (code) => SYMBOLS[code] || `${code} `;
export const fmt = (n) =>
  Number(n ?? 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const money = (code, n) => `${cur(code)}${fmt(n)}`;

export { suggestNextRun, suggestRecovery, tzNowParts, upcomingDays, formatKickoff, zonedTimeToMs };
