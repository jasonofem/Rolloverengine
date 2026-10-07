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

import { clamp, round, mean } from './math.js';
import { upcomingDays, tzDateKey, tzNowParts, formatKickoff, buildDayEvents } from './fixtures.js';

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

export function suggestNextRun(run, opts = {}) {
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
export function suggestRecovery(run, day, result) {
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
export function dayLift(fromOdds, toOdds) {
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

export function money(code, n) {
  const sym = { NGN: '₦', USD: '$', GBP: '£', EUR: '€', GHS: '₵', KES: 'KSh', ZAR: 'R' }[code] || `${code} `;
  return `${sym}${Number(n ?? 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
