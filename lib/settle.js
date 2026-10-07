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

import { simulateResult } from './model.js';
import { makeRng, round } from './math.js';
import { buildDayEvents } from './fixtures.js';

/**
 * @param {object[]} legs        slip legs (need eventId, marketKey, pickKey, odds, truthProb)
 * @param {object}   ctx         { dayKey, nonce, tz, eventsPerDay, marketInefficiency }
 * @returns {object} settlement report
 */
export function settleLegs(legs, ctx = {}) {
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
export function settleByTruthProb(legs, rng) {
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
export async function initSettle() {
  return true;
}
