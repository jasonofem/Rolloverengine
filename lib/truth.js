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

import { clamp, makeRng } from './math.js';

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
export function applyMarketInformation(event) {
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
export function shiftVector(outcomes, w) {
  const n = outcomes.length;
  const flat = 1 / n;
  const shifted = outcomes.map((o) => clamp(o.p * (1 - w) + flat * w, 0.004, 0.992));
  const sum = shifted.reduce((a, b) => a + b, 0) || 1;
  return outcomes.map((o, i) => ({ ...o, p: shifted[i] / sum }));
}

/** How much of a league's dispersion is per-book error (the exploitable part). */
export function bookErrorScale(event) {
  const tier = event.league?.tier ?? 2;
  const leagueNoise = event.league?.noise ?? 0.07;
  return leagueNoise * (1 - (INFO_SHARE[tier] ?? 0.65));
}

export { INFO_SHARE };
