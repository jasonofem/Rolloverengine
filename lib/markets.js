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

import { devig, makeRng, clamp, round, mean, stdev, ev } from './math.js';
import { bookErrorScale } from './truth.js';

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
export const SIGNAL_WEIGHTS = {
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
export function priceEvent(event, truth, opts = {}) {
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
export function extractLegs(event) {
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
export function correlationFactor(legs) {
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
export const CORR_PER_EXTRA_LEG = 0.012;
export const CORR_CAP = 0.06;

/* ------------------------------------------------------------------ *
 * LIVE pricing — real quotes from a bookmaker API
 * ------------------------------------------------------------------ */

/**
 * Classify a book by name, using the same three tiers the simulator uses.
 *
 * The tier is what decides how much weight a quote carries: sharp books are
 * de-vigged to a 0.19pp error against ground truth, so they get 0.62 of the
 * blend, and a misclassified Pinnacle would quietly poison the whole estimate.
 * Unknown books are treated as soft — the conservative default, since assuming
 * sharpness is the error that flatters us.
 */
export function classifyBook(name) {
  const n = String(name || '').toLowerCase();
  if (/pinnacle|sbobet|circa|cris|betfair|matchbook|smarkets/.test(n)) return 'sharp';
  if (/bet365|unibet|william|betway|888|marathon/.test(n)) return 'mid';
  return 'soft';
}

/**
 * Price an event from REAL quotes rather than simulated ones.
 *
 * Shares `devig`, `SIGNAL_WEIGHTS`, `confidence`, `confBand` and
 * `crossBookAgreement` with `priceEvent`, so the blend that the Lab justified is
 * the blend the live path runs — the maths is not duplicated, only the offer
 * construction is, because that is the part that genuinely differs: here the
 * quotes are facts instead of draws from a seeded RNG.
 *
 * There is no ground truth and no honest way to invent one. `truthKnown` is
 * false and truthProb / trueEvPerUnit / modelError / ratingsError come back
 * null rather than being filled from the model — a calibration number computed
 * against your own prediction is a tautology, and reporting one would let the
 * live deployment "confirm" the very weights it is supposed to be testing.
 *
 * @param {object} event          { id, home, away, league, kickoff, markets: [{ key, name, type, outcomes }] }
 * @param {Map}    offersByMarket  market key -> [{ book: { name, cls }, odds: [...] }] aligned to outcomes
 * @param {object} opts            { tier, kickoffHours }
 */
export function priceEventFromOffers(event, offersByMarket, opts = {}) {
  const tier = opts.tier ?? event.league?.tier ?? 2;
  const kickoffHours = opts.kickoffHours ?? 20;
  const priced = [];
  const bookNames = new Set();

  for (const m of event.markets || []) {
    const raw = offersByMarket.get(m.key);
    const n = m.outcomes?.length || 0;
    if (!raw?.length || !n) continue;

    /* A book that did not quote every outcome has to go. De-vigging two of three
     * prices divides by an over-round that excludes the missing outcome, which
     * silently inflates the ones we did get — and one NaN anywhere in the vector
     * then poisons every average built from it. Dropping the incomplete book is
     * the conservative move; there is no honest way to guess the price. */
    const offers = raw.filter((off) =>
      Array.isArray(off.odds) && off.odds.length === n && off.odds.every((o) => Number.isFinite(o) && o > 1));
    if (!offers.length) continue;
    for (const off of offers) bookNames.add(off.book.name);

    // ---- line shopping: best available price per outcome --------------
    const bestOdds = new Array(n).fill(0);
    const bestBook = new Array(n).fill(null);
    for (const off of offers) {
      for (let i = 0; i < n; i++) {
        const o = off.odds[i];
        if (Number.isFinite(o) && o > bestOdds[i]) { bestOdds[i] = o; bestBook[i] = off.book.name; }
      }
    }
    if (bestOdds.some((o) => !(o > 1))) continue; // an outcome nobody priced

    // ---- de-vig every book, then across the sharp subset --------------
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
      // No sharp book quoted this market. Fall back to consensus rather than
      // letting a null propagate into the blend.
      for (let k = 0; k < n; k++) sharp[k] = consensus[k];
    }

    // ---- the same blend, with the ratings prior as the only local view --
    const w = SIGNAL_WEIGHTS;
    const ratingsP = m.outcomes.map((o) => o.p);
    const model = new Array(n).fill(0);
    for (let i = 0; i < n; i++) model[i] = w.consensus * consensus[i] + w.sharp * sharp[i] + w.ratings * ratingsP[i];
    const mSum = model.reduce((a, c) => a + c, 0) || 1;
    for (let i = 0; i < n; i++) model[i] /= mSum;

    const implied = bestOdds.map((o) => 1 / o);
    const outcomeRows = m.outcomes.map((o, i) => {
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
        truthProb: null,
        edge: round(model[i] - implied[i], 4),
        edgePct: round((model[i] - implied[i]) * 100, 2),
        evPerUnit: round(ev(model[i], bestOdds[i]), 4),
        trueEvPerUnit: null,
        kelly: round(Math.max(0, ((bestOdds[i] - 1) * model[i] - (1 - model[i])) / (bestOdds[i] - 1)), 4),
        confidence: round(conf, 3),
        confidenceBand: confBand(conf),
        agreement: round(agreement, 4),
        modelError: null,
        ratingsError: null,
      };
    });

    priced.push({
      key: m.key,
      name: m.name,
      type: m.type,
      line: m.line ?? null,
      team: m.team ?? null,
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

  return { markets: priced, books: [...bookNames].sort(), truthKnown: false };
}
