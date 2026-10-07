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

import { clamp, round, mean } from './math.js';
import { correlationFactor } from './markets.js';

export const DEFAULT_BUILDER_OPTS = {
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
export function buildRolloverSlip(legs, opts = {}) {
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
    /* A pasted single-book leg can never earn cross-book confidence — one book
     * has no agreement to measure. Its confidence is a flat tier label instead,
     * so the cross-book floor must not be the thing that silently deletes the
     * only real prices you have. */
    if (l.confidence < o.minConfidence && l.viewSource !== 'pasted-single-book') {
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
export function suggestSwap(combo, legIndex, allLegs, opts = {}) {
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
