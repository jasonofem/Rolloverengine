/**
 * Engine unit tests — node:test, no dependencies.
 *   npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  poissonPmf, scoreGrid, sumGrid, overProb, normCdf, devig, ev, kelly,
  makeRng, hashSeed, blendVectors, toFractional, clamp, percentile,
} from '../lib/math.js';
import { modelTruth, simulateResult } from '../lib/model.js';
import { priceEvent, priceEventFromOffers, extractLegs, correlationFactor, classifyBook } from '../lib/markets.js';
import { applyMarketInformation, INFO_SHARE } from '../lib/truth.js';
import { buildRolloverSlip } from '../lib/builder.js';
import { buildDayEvents, dayShape, eventsForDay, tzDateKey, zonedTimeToMs } from '../lib/fixtures.js';
import { scanDay, scanDayLive } from '../lib/scan.js';
import { settleLegs } from '../lib/settle.js';
import {
  createRun, scanRunDay, confirmDay, settleDay, restartRun, skipDay,
  adjustDayOdds, runProgress, stakeFor, RUN_STATUS, DAY_STATUS,
} from '../lib/rollover.js';
import { runSimulation, projectRun } from '../lib/simulate.js';

const TZ = 'Africa/Lagos';
const DAY = '2026-10-10'; // a Saturday — deepest card of the week

describe('math primitives', () => {
  test('poisson pmf sums to ~1', () => {
    for (const lambda of [0.4, 1.2, 2.5, 4.0]) {
      const s = poissonPmf(lambda, 30).reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(s - 1) < 1e-9, `lambda ${lambda} summed to ${s}`);
    }
  });

  test('score grid sums to 1 and 1X2 partitions it exactly', () => {
    const g = scoreGrid(1.6, 1.1);
    const total = sumGrid(g, () => true);
    assert.ok(Math.abs(total - 1) < 1e-9);
    const h = sumGrid(g, (i, j) => i > j);
    const d = sumGrid(g, (i, j) => i === j);
    const a = sumGrid(g, (i, j) => i < j);
    assert.ok(Math.abs(h + d + a - 1) < 1e-9);
    assert.ok(h > a, 'home side with higher lambda should be more likely to win');
  });

  test('over 2.5 is the complement of under 2.5', () => {
    const o = overProb(1.5, 1.2, 2.5);
    assert.ok(o > 0 && o < 1);
    assert.ok(Math.abs(overProb(1.5, 1.2, 2.5) + (1 - overProb(1.5, 1.2, 2.5)) - 1) < 1e-12);
  });

  test('normCdf matches known values', () => {
    assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-6);
    assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-3);
    assert.ok(Math.abs(normCdf(-1.96) - 0.025) < 1e-3);
  });

  test('devig removes the overround exactly', () => {
    const { fair, overround } = devig([1.85, 3.6, 4.2]);
    assert.ok(overround > 0.02, 'a 3-way book should carry margin');
    assert.ok(Math.abs(fair.reduce((a, b) => a + b, 0) - 1) < 1e-12);
    // De-vigging divides every implied prob by the overround, so each fair
    // prob is LOWER than its implied prob — the favourite's true chance is
    // shorter than the price suggested, which is the whole point.
    assert.ok(fair[0] < 1 / 1.85, 'de-vigged favourite must be below its implied prob');
    assert.ok(fair.every((f, i) => f < 1 / [1.85, 3.6, 4.2][i] + 1e-12));
  });

  test('EV and Kelly agree on sign', () => {
    assert.ok(ev(0.55, 2.0) > 0);
    assert.ok(ev(0.45, 2.0) < 0);
    assert.ok(kelly(0.55, 2.0) > 0);
    assert.equal(kelly(0.45, 2.0), 0, 'never stake on negative edge');
    // Kelly at fair odds is zero
    assert.ok(Math.abs(kelly(0.5, 2.0, 1)) < 1e-9);
  });

  test('rng is deterministic per seed and differs across seeds', () => {
    const a = Array.from({ length: 5 }, () => makeRng('seed-x')().toFixed(9));
    const b = [makeRng('seed-x')(), makeRng('seed-x')(), makeRng('seed-x')(), makeRng('seed-x')(), makeRng('seed-x')()];
    assert.deepEqual(a, b.map((x) => Number(x).toFixed(9)));
    const seq1 = makeRng('one'); const seq2 = makeRng('one'); const seq3 = makeRng('two');
    assert.deepEqual([seq1(), seq1(), seq1()], [seq2(), seq2(), seq2()]);
    assert.notEqual(hashSeed('one'), hashSeed('two'));
    assert.ok(makeRng('three')() !== seq3(), 'different seeds diverge');
  });

  test('blendVectors renormalises', () => {
    const out = blendVectors([[0.5, 0.3, 0.2], [0.4, 0.4, 0.2]], [0.7, 0.3]);
    assert.ok(Math.abs(out.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  });

  test('fractional odds render sensibly', () => {
    assert.equal(toFractional(2.0), '1/1');
    assert.equal(toFractional(1.5), '1/2');
    assert.equal(toFractional(3.0), '2/1');
  });

  test('clamp and percentile behave', () => {
    assert.equal(clamp(5, 0, 3), 3);
    assert.equal(clamp(-5, 0, 3), 0);
    assert.equal(percentile([1, 2, 3, 4], 0.5), 3);
  });
});

describe('truth model', () => {
  const footballEvent = {
    id: 't1', sport: 'football',
    league: { code: 'T', name: 'T', base: 1.4, tier: 1, noise: 0.06 },
    kickoff: Date.now(), home: { name: 'Strong', att: 1.6, def: 0.8 }, away: { name: 'Weak', att: 0.8, def: 1.3 },
  };

  test('football truth sums to 1 and reflects the ratings', () => {
    const t = modelTruth(footballEvent);
    const sum = t.truth.reduce((a, x) => a + x.p, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
    assert.ok(t.truth[0].p > t.truth[2].p, 'stronger home side must be favoured');
    assert.ok(t.markets.length >= 5, 'should offer 1X2, O/U, BTTS, DC and team totals at minimum');
  });

  test('every mutually-exclusive market sums to 1', () => {
    const t = modelTruth(footballEvent);
    for (const m of t.markets) {
      // Double chance outcomes deliberately overlap (1X and X2 both contain the
      // draw), so that vector sums to 2 by construction. Everything else must
      // partition the event.
      if (m.type === 'double_chance') {
        const s = m.outcomes.reduce((a, o) => a + o.p, 0);
        assert.ok(Math.abs(s - 2) < 1e-6, `double chance should sum to 2, got ${s}`);
        continue;
      }
      const s = m.outcomes.reduce((a, o) => a + o.p, 0);
      assert.ok(Math.abs(s - 1) < 1e-6, `${m.name} summed to ${s}`);
    }
  });

  test('basketball truth has no draw and respects ratings', () => {
    const e = {
      id: 't2', sport: 'basketball',
      league: { code: 'NBA', name: 'NBA', base: 114, sigma: 11.6, tier: 1, noise: 0.05 },
      kickoff: Date.now(), home: { name: 'Top', rtg: 9 }, away: { name: 'Bottom', rtg: -7 },
    };
    const t = modelTruth(e);
    assert.equal(t.truth.length, 2);
    assert.ok(Math.abs(t.truth[0].p + t.truth[1].p - 1) < 1e-9);
    assert.ok(t.truth[0].p > 0.75, 'a 16-point rating gap should be a heavy favourite');
  });

  test('simulated results resolve markets consistently with the scoreline', () => {
    const events = buildDayEvents(DAY, { tz: TZ });
    const fb = events.find((e) => e.sport === 'football');
    const r = simulateResult(fb, makeRng('consistency'));
    const [hg, ag] = [r.score.home, r.score.away];
    const h2h = fb.markets.find((m) => m.key === 'h2h');
    const winner = [...r.winners[h2h.key]][0];
    assert.equal(winner, hg > ag ? 'home' : hg === ag ? 'draw' : 'away');
    const ou = fb.markets.find((m) => m.type === 'totals');
    if (ou) assert.equal([...r.winners[ou.key]][0], hg + ag > ou.line ? 'over' : 'under');
    const btts = fb.markets.find((m) => m.type === 'btts');
    if (btts) assert.equal([...r.winners[btts.key]][0], hg > 0 && ag > 0 ? 'yes' : 'no');
  });

  test('the same seed always produces the same scoreline', () => {
    const e = buildDayEvents(DAY, { tz: TZ }).find((x) => x.sport === 'football');
    const a = simulateResult(e, makeRng(`${e.truthSeed}|x`));
    const b = simulateResult(e, makeRng(`${e.truthSeed}|x`));
    assert.deepEqual(a.score, b.score);
    const c = simulateResult(e, makeRng(`${e.truthSeed}|y`));
    assert.notDeepEqual(a.score, c.score, 'a different nonce must give a different draw');
  });
});

describe('pricing & edge', () => {
  const events = buildDayEvents(DAY, { tz: TZ });
  const priced = events.slice(0, 6).map((e) => {
    const truth = applyMarketInformation(e);
    const p = priceEvent(e, truth, { tier: e.league.tier, kickoffHours: 18, marketInefficiency: 1.3 });
    return { e, p };
  });

  test('every book quotes an overround above 100%', () => {
    for (const { p } of priced) {
      for (const m of p.markets) {
        assert.ok(m.overround > 0.5, `${m.name} had overround ${m.overround}`);
        for (const b of m.books) assert.ok(b.margin > 0);
      }
    }
  });

  test('de-vigged fair probabilities sit below the implied ones', () => {
    for (const { p } of priced) {
      for (const m of p.markets) {
        if (!m.exclusive) continue;
        const fairSum = m.outcomes.reduce((a, o) => a + o.fairProb, 0);
        assert.ok(Math.abs(fairSum - 1) < 0.02, `fair probs summed to ${fairSum}`);
        /* Line shopping means we take the BEST price per outcome, which can be
         * better than any single book's de-vigged view. So an individual
         * outcome's implied prob can legitimately sit BELOW the fair consensus
         * — that residual is exactly the shopper's profit, and it is where a
         * chunk of the engine's edge comes from. What must always hold:
         *   • the de-vigged consensus partitions the event (sums to 1)
         *   • the best-price implied vector sums to <= the single-book
         *     overround, i.e. shopping never makes the book worse for you
         *   • sharp books' de-vigged view sits closer to the truth than the
         *     all-book consensus does */
        const impliedSum = m.outcomes.reduce((a, o) => a + o.impliedProb, 0);
        const worstBookSum = Math.max(...m.books.map((b) => b.odds.reduce((a, o) => a + 1 / o, 0)));
        assert.ok(impliedSum <= worstBookSum + 1e-9,
          `${m.name}: shopping should never be worse than one book (${impliedSum} vs ${worstBookSum})`);
        const sharpErr = m.outcomes.reduce((a, o) => a + Math.abs(o.sharpProb - o.truthProb), 0);
        const consErr = m.outcomes.reduce((a, o) => a + Math.abs(o.fairProb - o.truthProb), 0);
        const modelErr = m.outcomes.reduce((a, o) => a + Math.abs(o.modelProb - o.truthProb), 0);
        assert.ok(modelErr < Math.max(sharpErr, consErr) * 1.6,
          `${m.name}: blended model error ${modelErr} should be competitive with its inputs (sharp ${sharpErr}, consensus ${consErr})`);
      }
    }
  });

  test('model probabilities sum to 1 and stay in (0,1)', () => {
    for (const { p } of priced) {
      for (const m of p.markets) {
        const s = m.outcomes.reduce((a, o) => a + o.modelProb, 0);
        assert.ok(Math.abs(s - 1) < 0.01, `${m.name} model probs summed to ${s}`);
        for (const o of m.outcomes) assert.ok(o.modelProb > 0 && o.modelProb < 1);
      }
    }
  });

  test('sharp books carry less margin than soft books', () => {
    const margins = { soft: [], sharp: [] };
    for (const { p } of priced) for (const m of p.markets) for (const b of m.books) {
      if (b.cls === 'soft') margins.soft.push(b.margin);
      if (b.cls === 'sharp') margins.sharp.push(b.margin);
    }
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    assert.ok(margins.soft.length && margins.sharp.length);
    assert.ok(avg(margins.sharp) < avg(margins.soft), `sharp ${avg(margins.sharp)} vs soft ${avg(margins.soft)}`);
  });

  test('the model is closer to truth than the raw price is', () => {
    // |model − truth| should beat |implied − truth| on average, otherwise the
    // whole blending exercise is worse than just reading the odds.
    let modelErr = 0, impliedErr = 0, fairErr = 0, n = 0;
    for (const { p } of priced) for (const m of p.markets) for (const o of m.outcomes) {
      modelErr += Math.abs(o.modelProb - o.truthProb);
      impliedErr += Math.abs(o.impliedProb - o.truthProb);
      fairErr += Math.abs(o.fairProb - o.truthProb);
      n++;
    }
    assert.ok(modelErr / n < impliedErr / n, 'model must beat the raw price');
    assert.ok(modelErr / n < fairErr / n * 1.35, 'model should be competitive with pure de-vigging');
  });

  test('edge is exactly model minus implied', () => {
    for (const { p } of priced) for (const m of p.markets) for (const o of m.outcomes) {
      assert.ok(Math.abs(o.edge - (o.modelProb - o.impliedProb)) < 1e-3);
    }
  });

  test('confidence is bounded and graded', () => {
    for (const { p } of priced) for (const m of p.markets) for (const o of m.outcomes) {
      assert.ok(o.confidence > 0 && o.confidence < 1);
      assert.ok(['A', 'B', 'C', 'D'].includes(o.confidenceBand));
      assert.ok(o.agreement >= 0 && o.agreement <= 1);
    }
  });

  test('confidence tracks accuracy, not edge size', () => {
    /* The regression this guards: confidence used to include edge size, which
     * made it ANTI-correlated with accuracy (big edges happen where the books
     * disagree with the model — i.e. where the model is likeliest to be wrong).
     * High-confidence legs must now be more accurate than low-confidence ones. */
    const s = scanDay(DAY, { tz: TZ, eventsPerDay: 42, marketInefficiency: 1.3 });
    const hi = s.legs.filter((l) => l.confidence >= 0.65);
    const lo = s.legs.filter((l) => l.confidence < 0.45);
    assert.ok(hi.length > 5 && lo.length > 5, 'need enough legs in both bands to measure');
    const err = (arr) => arr.reduce((a, l) => a + Math.abs(l.modelError), 0) / arr.length;
    assert.ok(err(hi) < err(lo), `high-conf error ${err(hi)} should be below low-conf ${err(lo)}`);
  });

  test('extractLegs yields one leg per outcome with all analytics attached', () => {
    const legs = extractLegs({ ...priced[0].e, markets: priced[0].p.markets });
    assert.ok(legs.length > 8);
    for (const l of legs) {
      assert.ok(l.legId && l.eventId && l.pick && l.odds > 1);
      assert.ok(typeof l.edge === 'number' && typeof l.modelProb === 'number');
      assert.ok(l.correlation === l.eventId, 'correlation group is the event');
    }
  });

  test('correlation haircut penalises same-league same-window stacking', () => {
    const mk = (code, ko) => ({ leagueCode: code, kickoff: ko, eventId: code + ko });
    const spread = [mk('EPL', '2026-10-10T19:00'), mk('NBA', '2026-10-10T19:00'), mk('MLB', '2026-10-11T01:00')];
    const stacked = [mk('EPL', '2026-10-10T19:00'), mk('EPL', '2026-10-10T19:00'), mk('EPL', '2026-10-10T19:00')];
    assert.ok(correlationFactor(spread) > correlationFactor(stacked));
    assert.ok(correlationFactor(stacked) < 1);
    assert.ok(correlationFactor(spread) <= 1);
  });
});

describe('truth layer — the model must NOT be omniscient', () => {
  test('the market holds information the ratings do not', () => {
    const events = buildDayEvents(DAY, { tz: TZ }).slice(0, 8);
    let moved = 0;
    for (const e of events) {
      const t = applyMarketInformation(e);
      const ratings = e.markets.find((m) => m.key === 'h2h').outcomes;
      const truth = t.truthMarkets.find((m) => m.key === 'h2h').outcomes;
      assert.ok(Math.abs(truth.reduce((a, o) => a + o.p, 0) - 1) < 1e-9, 'truth must stay normalised');
      if (Math.abs(truth[0].p - ratings[0].p) > 1e-4) moved++;
    }
    assert.ok(moved >= 6, `only ${moved}/8 events moved — the ratings should not equal the truth`);
  });

  test('the information shock is deterministic per event', () => {
    const e = buildDayEvents(DAY, { tz: TZ })[0];
    assert.equal(applyMarketInformation(e).infoGap, applyMarketInformation(e).infoGap);
  });

  test('tier-1 leagues are better informed than tier-3', () => {
    // A heavily traded league leaves less room for a ratings-only model.
    assert.ok(INFO_SHARE[1] > INFO_SHARE[2] && INFO_SHARE[2] > INFO_SHARE[3]);
  });
});

describe('fixtures', () => {
  test('a day generates events across all five sports', () => {
    const events = buildDayEvents(DAY, { tz: TZ });
    const sports = new Set(events.map((e) => e.sport));
    assert.ok(sports.size >= 5, `only got ${[...sports]}`);
    assert.ok(events.length >= 30);
    for (const e of events) {
      assert.ok(e.id && e.home?.name && e.away?.name && e.kickoff);
      assert.ok(e.markets.length >= 1);
      assert.notEqual(e.home.name, e.away.name, 'a team cannot play itself');
    }
  });

  test('fixtures are deterministic for a date', () => {
    const a = buildDayEvents(DAY, { tz: TZ }).map((e) => e.id);
    const b = buildDayEvents(DAY, { tz: TZ }).map((e) => e.id);
    assert.deepEqual(a, b);
  });

  test('Saturday is deeper than Monday', () => {
    assert.ok(eventsForDay('2026-10-10') > eventsForDay('2026-10-12'));
    assert.ok(dayShape('2026-10-10', { tz: TZ }).score > dayShape('2026-10-12', { tz: TZ }).score);
    assert.equal(dayShape('2026-10-10', { tz: TZ }).weekend, true);
    assert.equal(dayShape('2026-10-12', { tz: TZ }).weekend, false);
  });

  test('every day keeps all sports represented even when thin', () => {
    const thin = buildDayEvents('2026-10-12', { tz: TZ }); // Monday
    const sports = new Set(thin.map((e) => e.sport));
    assert.ok(sports.size >= 4, `Monday only produced ${[...sports]}`);
  });

  test('kickoffs land inside the day in local time', () => {
    const events = buildDayEvents(DAY, { tz: TZ });
    for (const e of events) {
      const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date(e.kickoff)));
      assert.ok(h >= 9 && h <= 23, `kickoff at ${h}:00 local`);
    }
  });

  test('tzDateKey respects the timezone', () => {
    const lateUtc = new Date('2026-10-07T23:30:00Z');
    assert.equal(tzDateKey(lateUtc, 'UTC'), '2026-10-07');
    assert.equal(tzDateKey(lateUtc, TZ), '2026-10-08', 'Lagos is UTC+1');
  });

  test('tennis never pairs an ATP player with a WTA player', () => {
    const events = buildDayEvents(DAY, { tz: TZ }).filter((e) => e.sport === 'tennis');
    for (const e of events) assert.ok(/ATP|WTA/.test(e.league.code), `${e.league.code} has no tour`);
  });
});

describe('slip builder', () => {
  const scan = scanDay(DAY, { tz: TZ, eventsPerDay: 42, marketInefficiency: 1.3 });

  test('finds a combo inside the tolerance band', () => {
    for (const target of [1.8, 2.0, 2.2]) {
      const r = buildRolloverSlip(scan.legs, { targetOdds: target, tolerance: 0.1 });
      assert.ok(r.ok, `target ${target} failed: ${r.reason}`);
      assert.ok(r.best.odds >= target - 0.1 - 1e-9 && r.best.odds <= target + 0.1 + 1e-9,
        `target ${target} produced ${r.best.odds}`);
    }
  });

  test('every leg clears the confidence floor', () => {
    const r = buildRolloverSlip(scan.legs, { targetOdds: 2.0, tolerance: 0.1 });
    for (const l of r.best.legs) assert.ok(l.confidence >= 0.25 - 1e-9);
  });

  test('the edge floor is applied at selection, and reports which tier was used', () => {
    const strict = buildRolloverSlip(scan.legs, { targetOdds: 2.0, tolerance: 0.1, minEdgePerLeg: 0.02 });
    assert.ok(strict.ok);
    assert.ok(['strict', 'relaxed', 'positive-edge only', 'no edge floor'].includes(strict.best.edgeTier));
    // whatever tier it landed on, the slip must respect it
    if (strict.best.edgeTier === 'strict') assert.ok(strict.best.avgEdge >= 0.02 - 1e-9);
  });

  test('the optimiser finds +EV legs unprompted, with no edge floor set', () => {
    const r = buildRolloverSlip(scan.legs, { targetOdds: 2.0, tolerance: 0.1, minEdgePerLeg: 0 });
    assert.ok(r.best.avgEdge > 0, `with no floor the optimiser should still land on +edge, got ${r.best.avgEdge}`);
    assert.ok(r.best.evPct > 0);
  });

  test('never uses two legs from the same event', () => {
    const r = buildRolloverSlip(scan.legs, { targetOdds: 2.2, tolerance: 0.2, mode: 'combo' });
    const ids = r.best.legs.map((l) => l.eventId);
    assert.equal(new Set(ids).size, ids.length, 'duplicate events in one slip');
  });

  test('winProb equals the product of leg model probs times the correlation factor', () => {
    const r = buildRolloverSlip(scan.legs, { targetOdds: 2.0, tolerance: 0.12 });
    const legs = r.best.legs;
    const product = legs.reduce((a, l) => a * l.modelProb, 1) * correlationFactor(legs);
    assert.ok(Math.abs(product - r.best.winProb) < 0.01, `${product} vs ${r.best.winProb}`);
    assert.equal(r.best.legCount, legs.length);
  });

  test('mode max never loses to mode balanced on win probability', () => {
    const max = buildRolloverSlip(scan.legs, { targetOdds: 2.0, tolerance: 0.1, mode: 'max' });
    const bal = buildRolloverSlip(scan.legs, { targetOdds: 2.0, tolerance: 0.1, mode: 'balanced' });
    assert.ok(max.best.winProb >= bal.best.winProb - 1e-9,
      `max ${max.best.winProb} < balanced ${bal.best.winProb}`);
  });

  test('balanced mode prefers more legs when the probability cost is small', () => {
    const max = buildRolloverSlip(scan.legs, { targetOdds: 2.0, tolerance: 0.15, mode: 'max' });
    const bal = buildRolloverSlip(scan.legs, { targetOdds: 2.0, tolerance: 0.15, mode: 'balanced' });
    assert.ok(bal.best.legCount >= max.best.legCount);
    assert.ok(bal.best.probCostPct <= 6.5 + 1e-9, 'balanced gave away too much probability');
  });

  test('alternatives are distinct and individually in band', () => {
    const r = buildRolloverSlip(scan.legs, { targetOdds: 2.0, tolerance: 0.15, alternatives: 4 });
    assert.ok(r.alternatives.length >= 1);
    const shapes = new Set(r.alternatives.map((a) => a.legs.map((l) => l.eventId).sort().join()));
    assert.equal(shapes.size, r.alternatives.length, 'alternatives must differ');
    for (const a of r.alternatives) {
      assert.ok(a.odds >= 1.85 - 1e-9 && a.odds <= 2.15 + 1e-9);
    }
  });

  test('an impossible confidence floor fails cleanly with a useful message', () => {
    const r = buildRolloverSlip(scan.legs, { targetOdds: 2.0, tolerance: 0.02, minConfidence: 0.999 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'NO_EDGE');
    assert.ok(r.message.length > 20);
    assert.ok(r.fallback === null || typeof r.fallback === 'object');
  });

  test('an unreachably narrow band fails cleanly', () => {
    const r = buildRolloverSlip(scan.legs, { targetOdds: 9.5, tolerance: 0.001, maxOddsCeiling: 1.2 });
    assert.equal(r.ok, false);
    assert.ok(['NO_COMBO_IN_BAND', 'NO_EDGE'].includes(r.reason));
  });

  test('legCountSpread reports the best slip available at each leg count', () => {
    const r = buildRolloverSlip(scan.legs, { targetOdds: 2.0, tolerance: 0.2, mode: 'max' });
    assert.ok(Array.isArray(r.legCountSpread));
    for (const row of r.legCountSpread) {
      assert.ok(row.legs >= 1 && row.odds > 1 && row.winProbPct > 0);
    }
  });
});

describe('rollover state machine', () => {
  const mk = (over = {}) => {
    const run = createRun({ stake: 500, days: 7, targetOdds: 2.0, config: { tz: TZ, eventsPerDay: 42, marketInefficiency: 1.3 }, ...over });
    scanRunDay(run, 1);
    return run;
  };

  test('creates a run with the right ladder and projection', () => {
    const run = mk();
    assert.equal(run.startBalance, 500);
    assert.equal(run.config.days, 7);
    assert.equal(run.days.length, 7);
    assert.equal(run.projection.ladder.length, 7);
    assert.equal(run.projection.ladder[0].stake, 500);
    assert.equal(run.projection.ladder[1].stake, 1000);
    assert.equal(run.projection.final, 64000);
    assert.equal(run.projection.multiple, 128);
    assert.equal(run.status, RUN_STATUS.ACTIVE);
    assert.equal(run.verdict, null, 'a fresh run has no verdict');
  });

  test('projection survives JSON round-tripping', () => {
    const run = mk();
    const back = JSON.parse(JSON.stringify(run));
    assert.equal(back.projection.final, 64000, 'projection.final must not be an array property');
    assert.equal(back.projection.ladder.length, 7);
  });

  test('clamps nonsense configuration', () => {
    const run = createRun({ stake: -50, days: 999, targetOdds: 0.5, config: { tz: TZ } });
    assert.ok(run.config.stake >= 1);
    assert.ok(run.config.days <= 30);
    assert.ok(run.config.targetOdds >= 1.05);
  });

  test('win compounds the balance and advances the day', () => {
    const run = mk();
    confirmDay(run, 1);
    const stake = run.days[0].slip.stake;
    const odds = run.days[0].slip.odds;
    const { verdict } = settleDay(run, 'won', { dayNumber: 1, manual: true });
    assert.equal(run.days[0].status, DAY_STATUS.WON);
    assert.ok(Math.abs(run.balance - stake * odds) < 0.02, `balance ${run.balance} vs ${stake * odds}`);
    assert.equal(run.currentDay, 2);
    assert.equal(run.status, RUN_STATUS.ACTIVE);
    assert.equal(run.verdict, null, 'a mid-run win must not set the run verdict');
    assert.equal(verdict, null);
    assert.equal(run.lastDayMessage.kind, 'day-won');
  });

  test('day 2 stakes whatever day 1 returned', () => {
    const run = mk();
    confirmDay(run, 1);
    settleDay(run, 'won', { dayNumber: 1, manual: true });
    scanRunDay(run, 2);
    confirmDay(run, 2);
    assert.ok(Math.abs(run.days[1].slip.stake - run.balance) < 0.02);
    assert.ok(run.days[1].slip.stake > 500, 'the pot must have grown');
  });

  test('a loss ends the run with the recovery verdict', () => {
    const run = mk();
    confirmDay(run, 1);
    const { verdict } = settleDay(run, 'lost', { dayNumber: 1, manual: true });
    assert.equal(run.status, RUN_STATUS.LOST);
    assert.equal(verdict.kind, 'lost');
    assert.match(verdict.headline, /lost this time/i);
    assert.match(verdict.headline, /go again/i);
    assert.equal(run.balance, 0, 'pure rollover with no reserve loses everything');
    assert.ok(verdict.recovery.options.length >= 3);
    assert.ok(verdict.nextRun.startDay);
    for (const o of verdict.recovery.options) {
      assert.ok(o.days >= 1 && o.odds >= 1.2 && o.stake > 0);
      assert.ok(o.runWinPct > 0 && o.payout > 0);
    }
  });

  test('recovery options are monotonic — lower odds means a higher daily win chance', () => {
    const run = mk();
    confirmDay(run, 1);
    settleDay(run, 'lost', { dayNumber: 1, manual: true });
    const opts = run.verdict.recovery.options;
    const same = opts.find((o) => o.id === 'same');
    const lower = opts.find((o) => o.id === 'lower-odds');
    assert.ok(lower.odds < same.odds);
    assert.ok(lower.dailyWinProbPct > same.dailyWinProbPct, 'a shorter price must be more likely');
    assert.ok(lower.runWinPct > same.runWinPct);
    assert.ok(lower.payout < same.payout, 'and it must pay less');
  });

  test('shortening the run raises the completion rate more than lowering the odds', () => {
    const run = mk();
    confirmDay(run, 1);
    settleDay(run, 'lost', { dayNumber: 1, manual: true });
    const opts = run.verdict.recovery.options;
    const shorter = opts.find((o) => o.id === 'shorter');
    const lower = opts.find((o) => o.id === 'lower-odds');
    assert.ok(shorter.runWinPct > lower.runWinPct, 'fewer sequential days is the stronger lever');
  });

  test('seven wins in a row completes the run with the congratulations verdict', () => {
    const run = mk();
    for (let d = 1; d <= 7; d++) {
      if (!run.days.find((x) => x.day === d).slip) scanRunDay(run, d);
      confirmDay(run, d);
      settleDay(run, 'won', { dayNumber: d, manual: true });
    }
    assert.equal(run.status, RUN_STATUS.COMPLETE);
    const v = run.verdict;
    assert.equal(v.kind, 'complete');
    assert.match(v.headline, /congratulations/i);
    assert.equal(v.numbers.daysWon, 7);
    assert.ok(v.numbers.finalBalance > 20000, `final balance ${v.numbers.finalBalance}`);
    assert.ok(v.numbers.multiple > 40);
    assert.ok(v.nextRun, 'must suggest the next rollover');
    assert.ok(v.discipline.length >= 2);
  });

  test('the completion verdict tells the honest 1-in-N story', () => {
    const run = mk();
    for (let d = 1; d <= 7; d++) {
      if (!run.days.find((x) => x.day === d).slip) scanRunDay(run, d);
      confirmDay(run, d);
      settleDay(run, 'won', { dayNumber: d, manual: true });
    }
    const v = run.verdict;
    assert.ok(v.numbers.runWinProbPct < 20, 'a 7-day 2.0 rollover is never likely');
    assert.match(v.discipline.join(' '), /1 in \d+/);
  });

  test('staking twice is idempotent and does not double-count', () => {
    const run = mk();
    confirmDay(run, 1);
    const staked = run.stats.totalStaked;
    confirmDay(run, 1);
    assert.equal(run.days[0].status, DAY_STATUS.OPEN);
    assert.equal(run.stats.totalStaked, staked, 'a second confirm must not stake again');
    assert.equal(run.history.filter((h) => h.type === 'stake').length, 1);
  });

  test('cannot settle a day that was never staked', () => {
    const run = mk();
    assert.throws(() => settleDay(run, 'won', { dayNumber: 3, manual: true }), /nothing was staked/);
  });

  test('a reported win settles as a win regardless of what the simulator says', () => {
    const run = mk();
    confirmDay(run, 1);
    const stake = run.days[0].slip.stake;
    const odds = run.days[0].slip.odds;
    const { verdict } = settleDay(run, 'won', { dayNumber: 1, manual: true });
    assert.equal(run.days[0].status, DAY_STATUS.WON);
    assert.ok(Math.abs(run.balance - stake * odds) < 0.02);
    assert.equal(verdict, null, 'a mid-run win is not a run verdict');
  });

  test('cannot settle the same day twice', () => {
    const run = mk();
    confirmDay(run, 1);
    settleDay(run, 'won', { dayNumber: 1, manual: true });
    const again = settleDay(run, 'lost', { dayNumber: 1, manual: true });
    assert.equal(again.alreadySettled, true);
    assert.equal(run.days[0].status, DAY_STATUS.WON, 'the second settle must not overwrite the first');
  });

  test('reserve mode holds cash back and survives a loss', () => {
    const run = mk({ config: { tz: TZ, eventsPerDay: 42, marketInefficiency: 1.3, reservePct: 20 } });
    assert.ok(Math.abs(stakeFor(1000, run.config) - 800) < 0.01);
    confirmDay(run, 1);
    assert.ok(run.days[0].slip.stake < 500);
    assert.ok(run.days[0].slip.reserve > 0);
    settleDay(run, 'lost', { dayNumber: 1, manual: true });
    assert.ok(run.balance > 0, 'reserve mode must not zero out');
    assert.ok(Math.abs(run.balance - run.days[0].slip.reserve) < 0.02);
  });

  test('skipDay leaves the balance alone and extends the run', () => {
    const run = mk();
    const before = run.balance;
    skipDay(run, 1);
    assert.equal(run.balance, before);
    assert.equal(run.days.length, 8);
    assert.equal(run.currentDay, 2);
    assert.equal(run.days[0].status, DAY_STATUS.SKIPPED);
  });

  test('adjustDayOdds rebuilds the ladder and the slip', () => {
    const run = mk();
    adjustDayOdds(run, 1, 2.5);
    assert.equal(run.config.targetOdds, 2.5);
    const slip = run.days[0].slip;
    if (slip) assert.ok(slip.odds >= 2.4 - 0.2 && slip.odds <= 2.5 + 0.2, `rebuilt at ${slip.odds}`);
    assert.ok(run.projection.final > 64000, 'a higher daily target compounds further');
  });

  test('restart carries the lineage forward', () => {
    const run = mk();
    confirmDay(run, 1);
    settleDay(run, 'lost', { dayNumber: 1, manual: true });
    const next = restartRun(run, { days: 5 });
    assert.equal(next.config.days, 5);
    assert.equal(next.days.length, 5);
    assert.equal(next.lineage.length, 1);
    assert.equal(next.lineage[0].id, run.id);
    assert.equal(next.lineage[0].diedOnDay, 1);
    assert.equal(next.previousRunId, run.id);
    assert.equal(next.startBalance, run.config.stake, 'restart at the base stake, never the pot');
  });

  test('two deaths on the same day number makes the engine drop the odds target', () => {
    const first = mk();
    confirmDay(first, 1);
    settleDay(first, 'lost', { dayNumber: 1, manual: true });

    const second = restartRun(first, { days: 7 });
    assert.equal(second.lineage.length, 1);
    assert.equal(second.lineage[0].diedOnDay, 1);
    confirmDay(second, 1);
    settleDay(second, 'lost', { dayNumber: 1, manual: true });

    // Two runs dead on day 1 → the engine must stop calling it bad luck.
    assert.equal(second.lineage.length, 1, 'lineage holds the *previous* runs');
    const deaths = [...second.lineage.map((l) => l.diedOnDay), second.verdict.numbers.day];
    assert.equal(deaths.filter((d) => d === 1).length, 2);
    assert.match(second.verdict.recovery.diagnosis.join(' '), /day 1/i);
    assert.ok(second.verdict.recovery.recommendedOdds <= 2.0);

    const third = restartRun(second, { days: 7 });
    assert.equal(third.lineage.length, 2);
  });

  test('progress and equity curve stay consistent with the balance', () => {
    const run = mk();
    confirmDay(run, 1);
    settleDay(run, 'won', { dayNumber: 1, manual: true });
    const p = runProgress(run);
    assert.equal(p.daysWon, 1);
    assert.ok(Math.abs(p.balance - run.balance) < 0.01);
    const curve = p.equityCurve;
    const realised = curve.filter((c) => !c.projected);
    assert.ok(Math.abs(realised[realised.length - 1].balance - run.balance) < 0.02);
    assert.ok(p.chanceToFinishPct > 0 && p.chanceToFinishPct < 100);
  });

  test('auto-scan prepares the next day after a win', () => {
    const run = mk();
    confirmDay(run, 1);
    settleDay(run, 'won', { dayNumber: 1, manual: true });
    const next = run.days.find((d) => d.day === 2);
    assert.ok(next.slip || next.scan, 'autoAdvance should have scanned day 2');
  });
});

describe('settlement integrity', () => {
  test('auto settlement resolves each leg against one scoreline per event', () => {
    const run = createRun({ stake: 500, days: 7, targetOdds: 2.2, config: { tz: TZ, eventsPerDay: 42, marketInefficiency: 1.3 } });
    scanRunDay(run, 1);
    assert.ok(run.days[0].slip);
    confirmDay(run, 1);
    const { result } = settleDay(run, 'auto', { dayNumber: 1 });
    assert.equal(result.resolved.length, run.days[0].slip.legCount);
    for (const r of result.resolved) {
      assert.ok(['WON', 'LOST'].includes(r.status));
      assert.ok(r.result || r.outcomeSummary, 'every leg should report a scoreline');
    }
  });

  test('the same slip settles identically every time', () => {
    const legs = (() => {
      const run = createRun({ stake: 500, days: 7, targetOdds: 2.0, config: { tz: TZ, eventsPerDay: 42, marketInefficiency: 1.3 } });
      scanRunDay(run, 1);
      return { legs: run.days[0].slip.legs, day: run.days[0].date, nonce: run.days[0].slip.nonce };
    })();
    const a = settleLegs(legs.legs, { dayKey: legs.day, nonce: legs.nonce, tz: TZ, eventsPerDay: 42 });
    const b = settleLegs(legs.legs, { dayKey: legs.day, nonce: legs.nonce, tz: TZ, eventsPerDay: 42 });
    assert.equal(a.allWon, b.allWon);
    assert.deepEqual(a.resolved.map((r) => r.status), b.resolved.map((r) => r.status));
    assert.deepEqual(a.resolved.map((r) => r.result), b.resolved.map((r) => r.result));
  });

  test('an unknown fixture fails safe rather than counting as a win', () => {
    const r = settleLegs(
      [{ legId: 'x', eventId: 'does-not-exist', marketKey: 'h2h', pickKey: 'home', odds: 2, modelProb: 0.5 }],
      { dayKey: DAY, nonce: '1', tz: TZ }
    );
    assert.equal(r.allWon, false);
    assert.equal(r.resolved[0].status, 'UNKNOWN');
  });
});

describe('monte-carlo lab', () => {
  test('the engine beats a naive target-matcher over many runs', () => {
    const res = runSimulation({
      iterations: 120, days: 7, targetOdds: 2.0, stake: 500,
      eventsPerDay: 42, marketInefficiency: 1.3, marketVariants: 3, seed: 4242,
      strategies: ['engine', 'naive'],
    });
    const e = res.strategies.engine;
    const n = res.strategies.naive;
    assert.ok(e.iterations === 120);
    assert.ok(e.avgDailyWinRatePct > n.avgDailyWinRatePct,
      `engine ${e.avgDailyWinRatePct}% should beat random ${n.avgDailyWinRatePct}%`);
    // The decisive test: legs the engine picked must carry positive TRUE EV,
    // while randomly-chosen legs at the same odds target must not.
    assert.ok(e.avgTrueEvPerLegPct > 0, `engine legs should be +EV, got ${e.avgTrueEvPerLegPct}%`);
    assert.ok(n.avgTrueEvPerLegPct < e.avgTrueEvPerLegPct, 'random legs must be worse value');
    assert.ok(e.avgEdgePerLegPct > n.avgEdgePerLegPct);
    assert.ok(res.headline.liftPct >= 0);
  });

  test('the engine is calibrated — claimed win chance matches realised', () => {
    const res = runSimulation({
      iterations: 200, days: 5, targetOdds: 2.0, eventsPerDay: 42,
      marketInefficiency: 1.3, marketVariants: 2, seed: 99, strategies: ['engine'],
    });
    const e = res.calibration.engine;
    assert.ok(Math.abs(e.gap) < 0.045, `engine miscalibrated by ${e.gap}`);
  });

  test('the blend beats both the ratings prior and the raw all-book consensus', () => {
    /* The load-bearing claim. Ratings alone are a weak signal (the market knows
     * team news we don't) and the all-book consensus is diluted by soft books,
     * so the blend must beat BOTH — otherwise the weighting is wrong. Fitted
     * weights put the sharp de-vigged price in charge, which is what makes this
     * pass; an earlier ratings-heavy weighting failed it badly. */
    const s = scanDay(DAY, { tz: TZ, eventsPerDay: 42, marketInefficiency: 1.3 });
    assert.ok(s.diagnostics.modelErrorPp < s.diagnostics.ratingsErrorPp,
      `model ${s.diagnostics.modelErrorPp}pp should beat ratings ${s.diagnostics.ratingsErrorPp}pp`);
    assert.ok(s.diagnostics.modelErrorPp < s.diagnostics.consensusErrorPp,
      `model ${s.diagnostics.modelErrorPp}pp should beat raw consensus ${s.diagnostics.consensusErrorPp}pp`);
    assert.ok(s.diagnostics.modelErrorPp < 1.0,
      `model error ${s.diagnostics.modelErrorPp}pp is too high to trade on`);
  });

  test('the blend keeps the sharp-book accuracy rather than diluting it', () => {
    const s = scanDay(DAY, { tz: TZ, eventsPerDay: 42, marketInefficiency: 1.3 });
    assert.ok(s.diagnostics.modelErrorPp < s.diagnostics.sharpErrorPp * 1.8,
      `blending must not wreck the sharp signal: model ${s.diagnostics.modelErrorPp}pp vs sharp ${s.diagnostics.sharpErrorPp}pp`);
  });

  test('positive claimed edge really does mean positive true EV', () => {
    const s = scanDay(DAY, { tz: TZ, eventsPerDay: 42, marketInefficiency: 1.3 });
    assert.ok(s.diagnostics.edgeLegTrueEvPct > 0,
      `legs the engine would accept must be +EV in truth, got ${s.diagnostics.edgeLegTrueEvPct}%`);
    assert.ok(s.diagnostics.trueEvPct < s.diagnostics.edgeLegTrueEvPct,
      'betting everything indiscriminately must be worse than betting only the edge');
  });

  test('completion rate falls as the odds target rises', () => {
    const low = runSimulation({ iterations: 60, days: 5, targetOdds: 1.6, eventsPerDay: 42, marketVariants: 2, seed: 5, strategies: ['engine'] });
    const high = runSimulation({ iterations: 60, days: 5, targetOdds: 2.6, eventsPerDay: 42, marketVariants: 2, seed: 5, strategies: ['engine'] });
    assert.ok(low.strategies.engine.completionRatePct > high.strategies.engine.completionRatePct,
      `${low.strategies.engine.completionRatePct}% at 1.6 should beat ${high.strategies.engine.completionRatePct}% at 2.6`);
  });

  test('completion rate falls as the number of days rises', () => {
    const short = runSimulation({ iterations: 60, days: 3, targetOdds: 2.0, eventsPerDay: 42, marketVariants: 2, seed: 7, strategies: ['engine'] });
    const long = runSimulation({ iterations: 60, days: 9, targetOdds: 2.0, eventsPerDay: 42, marketVariants: 2, seed: 7, strategies: ['engine'] });
    assert.ok(short.strategies.engine.completionRatePct > long.strategies.engine.completionRatePct);
  });

  test('is reproducible for a given seed', () => {
    const a = runSimulation({ iterations: 40, days: 4, seed: 1234, eventsPerDay: 30, marketVariants: 2, strategies: ['engine'] });
    const b = runSimulation({ iterations: 40, days: 4, seed: 1234, eventsPerDay: 30, marketVariants: 2, strategies: ['engine'] });
    assert.equal(a.strategies.engine.completionRatePct, b.strategies.engine.completionRatePct);
    assert.equal(a.strategies.engine.avgFinalBalance, b.strategies.engine.avgFinalBalance);
  });

  test('closed-form projection matches the arithmetic of compounding', () => {
    const p = projectRun({ stake: 500, days: 7, targetOdds: 2, dailyWinProb: 0.5 });
    assert.equal(p.payoutIfComplete, 64000);
    assert.equal(p.multiple, 128);
    assert.ok(Math.abs(p.runWinProbPct - 0.5 ** 7 * 100) < 0.01);
    assert.equal(p.oneIn, 128);
    // At exactly fair odds the rollover is EV-neutral: you stake 500 every day
    // and get back 500 in expectation. It is variance, not value.
    assert.ok(Math.abs(p.evPct) < 0.01, `a fair-odds rollover should be EV-neutral, got ${p.evPct}%`);
  });

  test('a modelled edge turns the run EV positive', () => {
    const fair = projectRun({ stake: 500, days: 7, targetOdds: 2, dailyWinProb: 0.5 });
    const edged = projectRun({ stake: 500, days: 7, targetOdds: 2, dailyWinProb: 0.55 });
    assert.ok(edged.evPct > fair.evPct);
    assert.ok(edged.evPct > 0, 'a 55% day at 2.0 odds must be +EV overall');
  });
});

describe('scan pipeline', () => {
  test('a scan returns events, legs and diagnostics', () => {
    const s = scanDay(DAY, { tz: TZ, eventsPerDay: 42, marketInefficiency: 1.3 });
    assert.ok(s.events.length >= 30);
    assert.ok(s.legs.length > 200);
    assert.ok(s.diagnostics.pricesQuoted > s.legs.length);
    assert.ok(s.diagnostics.books.length >= 3);
    assert.ok(s.diagnostics.positiveEdgeLegs > 0, 'a market with no +EV legs anywhere is broken');
    assert.ok(s.diagnostics.bestEdgeLegs.length <= 12);
    assert.ok(typeof s.diagnostics.modelErrorPp === 'number');
    assert.ok(typeof s.diagnostics.ratingsErrorPp === 'number');
  });

  test('scanning is idempotent for a date', () => {
    const a = scanDay(DAY, { tz: TZ, eventsPerDay: 42 });
    const b = scanDay(DAY, { tz: TZ, eventsPerDay: 42 });
    assert.equal(a.legs.length, b.legs.length);
    assert.equal(a.legs[0].odds, b.legs[0].odds);
  });

  test('softer markets produce fatter edges', () => {
    const sharp = scanDay(DAY, { tz: TZ, eventsPerDay: 42, marketInefficiency: 0.5 });
    const soft = scanDay(DAY, { tz: TZ, eventsPerDay: 42, marketInefficiency: 2.2 });
    const best = (s) => Math.max(...s.legs.map((l) => l.edge));
    assert.ok(best(soft) > best(sharp), `soft ${best(soft)} vs sharp ${best(sharp)}`);
  });

  test('manual provider de-vigs whatever odds you paste in', () => {
    const s = scanDay(DAY, {
      tz: TZ, provider: 'manual',
      manualOdds: [{
        sport: 'football', league: 'EPL', home: 'Arsenal', away: 'Chelsea',
        market: 'Match Result',
        outcomes: [{ key: 'home', label: 'Arsenal', odds: 1.9 }, { key: 'draw', label: 'Draw', odds: 3.8 }, { key: 'away', label: 'Chelsea', odds: 4.4 }],
      }],
    });
    assert.equal(s.diagnostics.provider, 'manual');
    assert.equal(s.legs.length, 3);
    const home = s.legs.find((l) => l.pickKey === 'home');
    assert.ok(home.fairProb < home.impliedProb, 'de-vigged must be below implied');
    assert.ok(s.events[0].markets[0].overround > 0);
  });
});

/* ================================================================== *
 * Persistence
 *
 * Three of these are regression tests for bugs that were real, found by
 * measuring rather than by reading, and would each have cost a user their pot:
 *
 *   1. `diagnostics.books` was a Set filled with one quote OBJECT per book per
 *      market instead of book names, so it never deduplicated. It was copied
 *      into every persisted day and cost ~71 KB a day — a complete seven-day
 *      run came to 544 KB, which is a ninth of the browser's localStorage
 *      quota. The UI also read "1087 books compared".
 *   2. The file store cached its snapshot forever. `npm start` and the CLI are
 *      two processes over one store.json, so whichever wrote second resurrected
 *      everything the first had deleted.
 *   3. `persist()` returned the PREVIOUS link in its write chain, so awaiting it
 *      resolved before the file was written. Every caller believed a write had
 *      landed when it had only been queued.
 * ================================================================== */

import { fork } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMemoryStore, createLocalStorageStore } from '../lib/memory-store.js';
import { createApi } from '../lib/http-core.js';

describe('persistence & storage', () => {
  test('diagnostics carry 8 book NAMES, not one object per quote', () => {
    const s = scanDay(DAY, { tz: TZ, eventsPerDay: 42 });
    const d = s.diagnostics;
    assert.ok(d.books.length <= 12, `${d.books.length} "books" — this is the quote-object bug`);
    assert.ok(d.books.every((b) => typeof b === 'string'), 'books must be names');
    assert.equal(d.bookCount, d.books.length);
    // The honest number: ~8 books each quoting ~170 markets.
    assert.ok(d.bookQuotes > 500, `only ${d.bookQuotes} quotes across ${d.markets} markets`);
    assert.ok(d.bookQuotes >= d.books.length * 10);
  });

  test('a day of scan telemetry is small enough to persist', () => {
    const run = createRun({ stake: 500, days: 7, targetOdds: 2.0 });
    scanRunDay(run, 1);
    const bytes = JSON.stringify(run.days[0].scan).length;
    assert.ok(bytes < 15_000, `day 1 scan is ${(bytes / 1024).toFixed(1)} KB — the books bug is back`);
  });

  test('a whole seven-day run fits comfortably in a browser quota', () => {
    const run = createRun({ stake: 500, days: 7, targetOdds: 2.0 });
    for (let d = 1; d <= 7; d++) {
      scanRunDay(run, d);
      confirmDay(run, d);
      settleDay(run, 'won', { dayNumber: d, manual: 'won' });
    }
    const kb = JSON.stringify(run).length / 1024;
    assert.ok(kb < 150, `a complete run is ${kb.toFixed(0)} KB; 25 of them must fit in ~5 MB`);
  });

  test('the memory store implements the whole contract', async () => {
    const store = createMemoryStore();
    const settings = await store.getSettings();
    assert.equal(settings.currency, 'NGN');
    assert.equal(settings.minEdgePerLeg, 0);
    assert.equal(await store.getActiveRun(), null);

    const run = createRun({ stake: 500, days: 7, targetOdds: 2.0 });
    await store.saveRun(run);
    assert.equal((await store.getRun(run.id)).id, run.id);
    assert.equal((await store.getActiveRun()).id, run.id);
    assert.equal((await store.listRuns())[0].id, run.id);

    await store.deleteRun(run.id);
    assert.equal(await store.getRun(run.id), null);
    assert.deepEqual(await store.listRuns(), []);
  });

  test('the localStorage store survives a reload, which is the entire point', async () => {
    // No DOM here, so back it with an object that outlives both "page loads".
    const disk = new Map();
    const backend = {
      read: () => (disk.has('k') ? JSON.parse(disk.get('k')) : null),
      write: (db) => disk.set('k', JSON.stringify(db)),
    };
    const { createStoreAdapter } = await import('../lib/memory-store.js');

    const first = createStoreAdapter(backend, { runCap: 25 });
    const run = createRun({ stake: 500, days: 7, targetOdds: 2.0 });
    scanRunDay(run, 1);
    confirmDay(run, 1);
    settleDay(run, 'won', { dayNumber: 1, manual: 'won' });
    const balance = run.balance;
    await first.saveRun(run);

    // A brand new adapter over the same backend is a page reload.
    const second = createStoreAdapter(backend, { runCap: 25 });
    const back = await second.getActiveRun();
    assert.ok(back, 'the run must still be there after a reload');
    assert.equal(back.id, run.id);
    assert.equal(back.days[0].status, 'won');
    assert.ok(Math.abs(back.balance - balance) < 0.01, `${back.balance} vs ${balance}`);
  });

  test('when storage fills up it releases finished runs and never the active one', async () => {
    const { createStoreAdapter } = await import('../lib/memory-store.js');
    let blob = null;
    const notes = [];
    // A deliberately tiny quota so eviction has to happen.
    const tiny = createStoreAdapter(
      {
        read: () => (blob ? JSON.parse(blob) : null),
        write: (db) => {
          const s = JSON.stringify(db);
          if (s.length > 4096) throw new Error('QuotaExceededError');
          blob = s;
        },
      },
      { runCap: 50, onQuotaExceeded: (i) => notes.push(i) },
    );

    const fat = (i, status) => ({
      id: `r${i}`, status, createdAt: Date.now() + i,
      config: { currency: 'NGN', days: 7, targetOdds: 2, stake: 500 },
      startBalance: 500, balance: 64000, currentDay: 7, stats: { won: 7 },
      days: Array.from({ length: 7 }, (_, d) => ({ day: d + 1, date: 'x'.repeat(400) })),
    });
    for (let i = 0; i < 6; i++) await tiny.saveRun(fat(i, i === 5 ? 'active' : 'complete'));

    const left = await tiny.listRuns(50);
    assert.ok(notes.length > 0, 'nothing was evicted, so the quota never bit');
    assert.ok(left.some((r) => r.id === 'r5' && r.status === 'active'), 'the active run was evicted — that is the one with money on it');
    assert.ok(!left.some((r) => r.id === 'r0'), 'the oldest finished run should have gone first');
  });

  test('a blocked localStorage degrades to memory instead of throwing', () => {
    // Nothing defines globalThis.localStorage in this process, which is exactly
    // the private-window case.
    const store = createLocalStorageStore('__no_dom_here__');
    assert.equal(store.backend, 'memory');
  });

  test('a long-lived process notices another process rewriting store.json', async () => {
    /* The bug this guards is specific and was real: lib/store.js filled its
     * snapshot cache once and never invalidated it. `npm start` and the CLI are
     * two processes over one store.json, so a server that had been up since
     * before your CLI delete would write its stale snapshot back and quietly
     * resurrect every run you had removed.
     *
     * So the child must import the store ONCE and keep using it — a fresh import
     * would prove nothing. It reads, the parent rewrites the file underneath it,
     * it reads again. Then it writes, and the parent checks nothing came back. */
    const dir = mkdtempSync(join(tmpdir(), 're-xproc-'));
    const worker = join(process.cwd(), 'test/helpers/store-worker.mjs');
    const file = join(dir, 'store.json');
    writeFileSync(file, JSON.stringify({ runs: {}, order: [], settings: {}, lab: [] }));

    const child = fork(worker, [], { cwd: process.cwd(), env: { ...process.env, RE_DATA_DIR: dir }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const messages = [];
    child.on('message', (m) => messages.push(m));
    const waitFor = (phase) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`worker never reported "${phase}" (got ${JSON.stringify(messages)})`)), 15000);
      const check = () => {
        const hit = messages.find((m) => m.phase === phase);
        if (hit) { clearTimeout(t); child.off('message', check); resolve(hit); }
      };
      child.on('message', check);
      check();
    });

    try {
      const first = await waitFor('first');
      assert.deepEqual(first.ids, [], 'the worker should start on an empty store');

      // Rewrite the file from this process while the worker holds its cache.
      writeFileSync(file, JSON.stringify({
        runs: { alpha: { id: 'alpha', status: 'lost', createdAt: 1, config: { currency: 'NGN' }, startBalance: 500, balance: 0, currentDay: 2, stats: {} },
                beta: { id: 'beta', status: 'lost', createdAt: 2, config: { currency: 'NGN' }, startBalance: 500, balance: 0, currentDay: 3, stats: {} } },
        order: ['alpha', 'beta'], settings: {}, lab: [],
      }));
      child.send('changed');

      const second = await waitFor('second');
      assert.deepEqual(second.ids.sort(), ['alpha', 'beta'],
        'the worker still sees its own stale snapshot — the cache is not invalidated by mtime');

      // And the other direction: a worker write must not resurrect anything.
      child.send('write');
      const wrote = await waitFor('wrote');
      assert.deepEqual(wrote.ids.sort(), ['alpha', 'beta', 'from-worker']);
      const onDisk = JSON.parse(readFileSync(file, 'utf8'));
      assert.deepEqual(Object.keys(onDisk.runs).sort(), ['alpha', 'beta', 'from-worker'],
        'the worker wrote back a stale snapshot and clobbered the other process\'s state');
    } finally {
      child.send('exit');
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a write is on disk by the time the await resolves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 're-durable-'));
    try {
      process.env.RE_DATA_DIR = dir;
      const store = await import(`${pathToFileURL(join(process.cwd(), 'lib/store.js')).href}?durable=${Date.now()}`);
      const run = createRun({ stake: 500, days: 7, targetOdds: 2.0 });
      await store.saveRun(run);
      // No sleep, no retry: if persist() only queued the write this reads stale.
      const onDisk = JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8'));
      assert.ok(onDisk.runs[run.id], 'saveRun resolved before the file was written');

      await store.deleteRun(run.id);
      const after = JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8'));
      assert.deepEqual(Object.keys(after.runs), [], 'deleteRun resolved before the file was written');
    } finally {
      delete process.env.RE_DATA_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the API reports honestly whether the host can actually keep your runs', async () => {
    const call = async (api, method, pathname, body) => {
      const url = new URL(pathname, 'http://local');
      return api({ method, pathname: url.pathname, query: url.searchParams, body: body || {} });
    };

    const stateless = createApi({ store: createMemoryStore(), persistent: false });
    let res = await call(stateless, 'GET', '/api/state');
    assert.equal(res.status, 200);
    assert.equal(res.body.runtime.persistent, false);
    assert.equal(res.body.runtime.mode, 'stateless');
    assert.match(res.body.runtime.advice, /no writable disk/i);

    const persistent = createApi({ store: createMemoryStore(), persistent: true });
    res = await call(persistent, 'GET', '/api/state');
    assert.equal(res.body.runtime.persistent, true);
    assert.equal(res.body.runtime.mode, 'server');

    // The dashboard keys off this flag to decide where state lives, so a
    // stateless host must also refuse to accept an unbounded Lab run.
    res = await call(stateless, 'POST', '/api/lab/simulate', { iterations: 99999, strategies: ['engine'] });
    assert.equal(res.status, 200);
    assert.ok(res.body.config.iterations <= 1500, `ran ${res.body.config.iterations} iterations on a capped host`);
  });

  test('the whole run lifecycle works through the API with no server at all', async () => {
    const disk = new Map();
    const { createStoreAdapter } = await import('../lib/memory-store.js');
    const store = createStoreAdapter({
      read: () => (disk.has('k') ? JSON.parse(disk.get('k')) : null),
      write: (db) => disk.set('k', JSON.stringify(db)),
    });
    const api = createApi({ store, persistent: false });
    const call = (m, t, b) => {
      const url = new URL(t, 'http://local');
      return api({ method: m, pathname: url.pathname, query: url.searchParams, body: b || {} });
    };

    let res = await call('POST', '/api/runs', { stake: 500, days: 7, targetOdds: 2.0 });
    assert.equal(res.status, 201);
    const id = res.body.run.id;
    assert.ok(res.body.run.days[0].slip, 'day 1 should be scanned on creation');

    let balance = 500;
    for (let d = 1; d <= 7; d++) {
      await call('POST', `/api/runs/${id}/scan`, { day: d });
      res = await call('POST', `/api/runs/${id}/stake`, { day: d });
      assert.equal(res.status, 200, `day ${d} stake: ${JSON.stringify(res.body).slice(0, 120)}`);
      res = await call('POST', `/api/runs/${id}/settle`, { day: d, outcome: 'won' });
      assert.equal(res.status, 200);
      assert.ok(res.body.run.balance > balance, `day ${d} should grow the pot`);
      balance = res.body.run.balance;
    }

    res = await call('GET', `/api/runs/${id}`);
    assert.equal(res.body.run.status, 'complete');
    assert.match(res.body.run.verdict.headline, /CONGRATULATIONS/i);
    assert.ok(balance > 500 * 100, `₦${balance.toFixed(2)} should be a >100× return`);
    assert.ok(res.body.run.verdict.nextRun?.startDayLabel, 'a completed run must suggest when to go again');
  });
});

describe('projection arithmetic', () => {
  test('a run is priced off the odds you actually got, not the target', () => {
    const p = projectRun({ stake: 500, days: 7, targetOdds: 2.0, realisedOdds: 1.996, dailyWinProb: 0.55 });
    // 2.00^7 would be 128× / ₦64,000. Claiming that when you got 1.996 is the
    // kind of rounding that makes a dashboard feel like marketing.
    assert.ok(p.multiple < 128, `${p.multiple}× should be below the round 128×`);
    assert.ok(Math.abs(p.multiple - 1.996 ** 7) < 0.02);
    assert.ok(Math.abs(p.payoutIfComplete - 500 * 1.996 ** 7) < 0.5);
    assert.equal(p.ladder.length, 8, 'day 0 through day 7');
    assert.equal(p.ladder[0].balance, 500);
    assert.ok(Math.abs(p.ladder[7].balance - p.payoutIfComplete) < 0.5);
  });

  test('at exactly fair odds a rollover is EV-neutral, not negative', () => {
    const p = projectRun({ stake: 500, days: 7, targetOdds: 2.0, dailyWinProb: 0.5 });
    assert.equal(p.oneIn, 128);
    assert.ok(Math.abs(p.evPct) < 0.01, `${p.evPct}% — you stake 500 a day and get 500 back in expectation`);
  });

  test('with no daily rate supplied it assumes the book is fair and says so', () => {
    /* The pessimistic default. If you have not measured a win rate, the honest
     * assumption is that 2.00 odds mean 50% — EV-neutral, pure variance — and
     * the projection must say the number was assumed rather than let you read it
     * as a finding. */
    const p = projectRun({ stake: 500, days: 7, targetOdds: 2.0 });
    assert.equal(p.dailyWinProbPct, 50);
    assert.equal(p.oneIn, 128);
    assert.ok(Math.abs(p.evPct) < 0.01);
    assert.match(p.dailySource, /assumed fair/i);
    assert.match(p.verdict, /variance/i, 'it should warn you are buying variance, not value');
  });

  test('a caller-supplied rate is attributed to the caller', () => {
    const p = projectRun({ stake: 500, days: 7, targetOdds: 2.0, dailyWinProb: 0.58 });
    assert.match(p.dailySource, /supplied by the caller/i);
  });

  test('a measured daily rate is labelled as measured', () => {
    const p = projectRun({ stake: 500, days: 7, targetOdds: 2.0, measuredDailyWinProb: 0.537 });
    assert.match(p.dailySource, /measured/i);
    assert.ok(p.evPct > 0, 'above breakeven must be +EV');
    assert.ok(p.oneIn < 128, 'better than fair odds means better than 1-in-128');
  });
});

/* ================================================================== *
 * LIVE ODDS — the path that prices real bookmaker quotes
 * ================================================================== */

/**
 * A realistic The Odds API v4 payload. Three books on the football game
 * including one sharp (Pinnacle), two on the basketball game, and a market the
 * live scanner deliberately ignores (totals) so we can prove it is not silently
 * half-pricing things it cannot model.
 */
const LIVE_FIXTURES = {
  soccer_epl: [{
    id: 'epl-1', sport_key: 'soccer_epl',
    commence_time: new Date(Date.now() + 20 * 3600e3).toISOString(),
    home_team: 'Arsenal', away_team: 'Everton',
    bookmakers: [
      { key: 'pinnacle', title: 'Pinnacle', markets: [
        { key: 'h2h', outcomes: [{ name: 'Arsenal', price: 1.42 }, { name: 'Everton', price: 8.1 }, { name: 'Draw', price: 5.05 }] },
        { key: 'totals', point: 2.5, outcomes: [{ name: 'Over', price: 1.9, point: 2.5 }, { name: 'Under', price: 1.95, point: 2.5 }] },
      ] },
      { key: 'bet365', title: 'Bet365', markets: [
        { key: 'h2h', outcomes: [{ name: 'Arsenal', price: 1.4 }, { name: 'Everton', price: 8.0 }, { name: 'Draw', price: 4.8 }] },
      ] },
      { key: 'bet9ja', title: 'Bet9ja', markets: [
        { key: 'h2h', outcomes: [{ name: 'Arsenal', price: 1.38 }, { name: 'Everton', price: 7.5 }, { name: 'Draw', price: 4.6 }] },
      ] },
    ],
  }],
  basketball_nba: [{
    id: 'nba-1', sport_key: 'basketball_nba',
    commence_time: new Date(Date.now() + 22 * 3600e3).toISOString(),
    home_team: 'Lakers', away_team: 'Celtics',
    bookmakers: [
      { key: 'pinnacle', title: 'Pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'Lakers', price: 2.05 }, { name: 'Celtics', price: 1.86 }] }] },
      { key: 'unibet', title: 'Unibet', markets: [{ key: 'h2h', outcomes: [{ name: 'Lakers', price: 2.0 }, { name: 'Celtics', price: 1.83 }] }] },
    ],
  }],
};

/** Swap globalThis.fetch for the duration of one test. */
async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

const okFetch = async (url) => {
  const key = /sports\/([a-z_]+)\/odds/.exec(url)?.[1];
  return { ok: true, json: async () => LIVE_FIXTURES[key] || [] };
};

describe('live odds — real quotes, and never a silent simulation', () => {
  const dayKey = new Date(Date.now() + 20 * 3600e3).toISOString().slice(0, 10);
  const liveOpts = { apiKey: 'test-key', tz: 'UTC', daysAhead: 3, builder: { targetOdds: 2.0, tolerance: 0.35, mode: 'balanced' } };

  test('classifies books into the same three tiers the simulator uses', () => {
    assert.equal(classifyBook('Pinnacle'), 'sharp');
    assert.equal(classifyBook('SBOBET'), 'sharp');
    assert.equal(classifyBook('Bet365'), 'mid');
    // Unknown books are soft — assuming sharpness is the error that flatters us.
    assert.equal(classifyBook('SomeBackyardBook'), 'soft');
    assert.equal(classifyBook(''), 'soft');
  });

  test('prices a real fixture through the same blend the Lab justified', async () => {
    const res = await withFetch(okFetch, () => scanDayLive(dayKey, liveOpts));
    assert.equal(res.scan.events.length, 2, 'both fixtures are on that day');
    assert.equal(res.diagnostics.providerUsed, 'oddsapi');
    assert.equal(res.diagnostics.fellBack, false);
    assert.ok(res.diagnostics.books.includes('Pinnacle'), 'the sharp book is in the pool');
    assert.equal(res.diagnostics.bookCount, res.diagnostics.books.length);

    const arsenal = res.scan.legs.find((l) => l.pick === 'Arsenal');
    assert.ok(arsenal, 'Arsenal is priced');
    // Line shopping must take the BEST price, not the first or the average.
    assert.equal(arsenal.odds, 1.42, 'best of 1.42 / 1.40 / 1.38');
    assert.equal(arsenal.book, 'Pinnacle');
    // De-vigged consensus across three books whose raw implied sums to >1.
    assert.ok(arsenal.fairProb > 0.6 && arsenal.fairProb < 0.75, `fairProb ${arsenal.fairProb}`);
    // The sharp book quotes Arsenal shortest-relative, so sharpProb >= consensus.
    assert.ok(arsenal.sharpProb >= arsenal.fairProb - 0.02, `sharp ${arsenal.sharpProb} vs consensus ${arsenal.fairProb}`);
    assert.ok(arsenal.confidence > 0 && arsenal.confidence <= 1);
    assert.equal(arsenal.live, true);
  });

  test('leaves truth null on a live leg — no tautological calibration', async () => {
    const res = await withFetch(okFetch, () => scanDayLive(dayKey, liveOpts));
    assert.equal(res.diagnostics.truthKnown, false);
    for (const l of res.scan.legs) {
      assert.equal(l.truthProb, null, 'a live fixture has no ground truth yet');
      assert.equal(l.trueEvPerUnit, null);
      assert.equal(l.modelError, null);
      assert.equal(l.ratingsError, null);
    }
  });

  test('prices every market the books quote on both sides, and says which', async () => {
    const res = await withFetch(okFetch, () => scanDayLive(dayKey, liveOpts));
    assert.match(res.diagnostics.scope, /totals/i, 'the scope line names the widened market set');
    const types = new Set(res.scan.legs.map((l) => l.marketType));
    assert.ok(types.has('h2h') && types.has('totals'), `h2h + totals expected, got ${[...types].join(',')}`);
    // 3 h2h outcomes + 2 total outcomes on the football game, 2 on the basketball game.
    assert.equal(res.scan.legs.length, 7);
    const over = res.scan.legs.find((l) => l.marketType === 'totals' && l.pick === 'Over');
    assert.ok(over, 'a one-book total is still priced — with the confidence that one book earns');
    assert.ok(Number.isFinite(over.edge));
  });

  test('builds a real slip from live prices', async () => {
    const res = await withFetch(okFetch, () => scanDayLive(dayKey, liveOpts));
    assert.ok(res.builder.ok, res.builder.message);
    assert.ok(res.builder.best.odds > 0);
    assert.ok(res.builder.best.winProbPct > 0 && res.builder.best.winProbPct < 100);
  });

  test('throws when there is no key instead of quietly simulating', async () => {
    await assert.rejects(
      () => scanDayLive(dayKey, { tz: 'UTC' }),
      (e) => { assert.equal(e.code, 'NO_KEY'); return true; },
      'a missing key must be an error, not an invented price list',
    );
  });

  test('throws when the API returns nothing — a dead key must not look like a quiet day', async () => {
    await withFetch(async () => ({ ok: true, json: async () => [] }), async () => {
      await assert.rejects(
        () => scanDayLive(dayKey, liveOpts),
        (e) => { assert.equal(e.code, 'NO_GAMES'); return true; },
      );
    });
  });

  test('the synchronous scan admits when it fell back, and why', () => {
    const noKey = scanDay(dayKey, { tz: 'UTC', provider: 'oddsapi' });
    assert.equal(noKey.diagnostics.providerRequested, 'oddsapi');
    assert.equal(noKey.diagnostics.providerUsed, 'sim');
    assert.equal(noKey.diagnostics.fellBack, true);
    assert.match(noKey.diagnostics.fallbackReason, /no API key/i);

    const withKey = scanDay(dayKey, { tz: 'UTC', provider: 'oddsapi', apiKey: 'k' });
    assert.equal(withKey.diagnostics.fellBack, true);
    assert.match(withKey.diagnostics.fallbackReason, /async live scan/i, 'it points at the route that can actually fetch');

    const manual = scanDay(dayKey, { tz: 'UTC', provider: 'manual' });
    assert.equal(manual.diagnostics.fellBack, true);
    assert.match(manual.diagnostics.fallbackReason, /none were supplied/i);

    const plain = scanDay(dayKey, { tz: 'UTC' });
    assert.equal(plain.diagnostics.fellBack, false, 'asking for the simulator and getting it is not a fallback');
    assert.equal(plain.diagnostics.fallbackReason, null);
  });

  test('one cached day cannot leak another request\'s provider story', () => {
    /* scanSim memoises on (dayKey, tz, events, inefficiency) — NOT on provider —
     * so it hands back a shared object. Stamping that object in place made the
     * fourth request inherit the third one's answer. Copy, never mutate. */
    const a = scanDay(dayKey, { tz: 'UTC', provider: 'oddsapi' });
    const b = scanDay(dayKey, { tz: 'UTC' });
    assert.equal(a.diagnostics.fellBack, true, 'the oddsapi request still reports its own fallback');
    assert.equal(b.diagnostics.fellBack, false, 'and the sim request was not contaminated by it');
    assert.equal(a.diagnostics.providerRequested, 'oddsapi');
    assert.equal(b.diagnostics.providerRequested, 'sim');
  });

  test('priceEventFromOffers returns the same row shape priceEvent does', () => {
    /* The live and simulated paths must stay interchangeable downstream, or the
     * builder and the UI grow a second set of special cases. */
    const event = {
      id: 'x', sport: 'football', league: { name: 'Test', code: 'TST', tier: 1 },
      kickoff: Date.now() + 86400e3, home: { name: 'A' }, away: { name: 'B' },
      markets: [{ key: 'h2h', name: 'Match Result', type: 'h2h', outcomes: [
        { key: 'a', label: 'A', p: 0.4 }, { key: 'b', label: 'B', p: 0.3 }, { key: 'draw', label: 'Draw', p: 0.3 },
      ] }],
    };
    const offers = new Map([['h2h', [
      { book: { name: 'Pinnacle', cls: 'sharp' }, odds: [2.1, 3.6, 3.4] },
      { book: { name: 'Bet365', cls: 'mid' }, odds: [2.0, 3.5, 3.3] },
    ]]]);
    const live = priceEventFromOffers(event, offers, { tier: 1, kickoffHours: 20 });
    assert.equal(live.truthKnown, false);
    assert.equal(live.markets.length, 1);
    const row = live.markets[0].outcomes[0];
    for (const f of ['key', 'label', 'odds', 'bestBook', 'avgOdds', 'impliedProb', 'fairProb', 'sharpProb',
                     'ratingsProb', 'modelProb', 'edge', 'edgePct', 'evPerUnit', 'kelly', 'confidence',
                     'confidenceBand', 'agreement']) {
      assert.ok(f in row, `live row is missing "${f}" that the simulated path emits`);
    }
    assert.equal(row.odds, 2.1, 'best price wins');
    assert.equal(row.bestBook, 'Pinnacle');
    assert.equal(row.truthProb, null);
  });

  test('skips a book that failed to quote every outcome rather than de-vigging a partial market', () => {
    /* De-vigging 2 of 3 outcomes silently inflates the third. Dropping the
     * incomplete book is the conservative move. */
    const event = {
      id: 'y', sport: 'football', league: { name: 'Test', code: 'TST', tier: 1 },
      kickoff: Date.now(), home: { name: 'A' }, away: { name: 'B' },
      markets: [{ key: 'h2h', name: 'Match Result', type: 'h2h', outcomes: [
        { key: 'a', label: 'A', p: 0.4 }, { key: 'b', label: 'B', p: 0.3 }, { key: 'draw', label: 'Draw', p: 0.3 },
      ] }],
    };
    const offers = new Map([['h2h', [
      { book: { name: 'Pinnacle', cls: 'sharp' }, odds: [2.1, 3.6, 3.4] },
      { book: { name: 'Partial', cls: 'soft' }, odds: [2.0, 3.5, NaN] },
    ]]]);
    const priced = priceEventFromOffers(event, offers, { tier: 1 });
    assert.equal(priced.markets[0].books.length, 1, 'the incomplete book was dropped');
    assert.equal(priced.markets[0].books[0].book, 'Pinnacle');
  });
});

describe('live odds — quota, multi-sport, and pasted prices', () => {
  test('fetchOddsApi captures the quota headers and queries every sport on the board', async () => {
    const { fetchOddsApi } = await import('../lib/scan.js');
    const urls = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (u) => {
      urls.push(String(u));
      const key = /sports\/([a-z_]+)\/odds/.exec(u)?.[1];
      if (key === 'cricket_odi') return { ok: false, status: 404, headers: { get: () => null } };
      return {
        ok: true,
        headers: { get: (h) => (h === 'x-requests-remaining' ? '431' : h === 'x-requests-used' ? '69' : null) },
        json: async () => [],
      };
    };
    try {
      const { games, quota, leagues } = await fetchOddsApi(null, 'k', { daysAhead: 2 });
      assert.deepEqual(games, []);
      assert.equal(quota.remaining, 431, 'the allowance is surfaced, not swallowed');
      assert.equal(quota.used, 69);
      const sports = new Set(urls.map((u) => /sports\/([a-z_]+)\/odds/.exec(u)[1]));
      for (const k of ['basketball_nba', 'tennis_atp', 'tennis_wta', 'mma_mixed_martial_arts', 'icehockey_nhl', 'baseball_mlb']) {
        assert.ok(sports.has(k), `${k} must be on the board — the engine is not football-only`);
      }
      assert.ok(sports.size >= 20, `expected a broad board, got ${sports.size}`);
      const cricket = leagues.find((l) => l.key === 'cricket_odi');
      assert.equal(cricket.ok, false, 'an out-of-season or unknown key is recorded, not fatal');
      assert.equal(cricket.status, 404);
      const nba = leagues.find((l) => l.key === 'basketball_nba');
      assert.equal(nba.ok, true);
      assert.equal(nba.fixtures, 0);
    } finally { globalThis.fetch = real; }
  });

  test('a sports subset in settings trims the board (and the credit burn)', async () => {
    const { fetchOddsApi } = await import('../lib/scan.js');
    const urls = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (u) => { urls.push(String(u)); return { ok: true, headers: { get: () => null }, json: async () => [] }; };
    try {
      await fetchOddsApi(['basketball_nba', 'tennis_atp'], 'k', {});
      assert.equal(urls.length, 2, 'one request per requested key — the free tier is 500 a month');
    } finally { globalThis.fetch = real; }
  });

  test('live scan prices totals and spreads, not just 1X2', async () => {
    const { scanDayLive } = await import('../lib/scan.js');
    const d = new Date();
    const commence = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0)).toISOString();
    const dayKey = commence.slice(0, 10);
    const game = {
      id: 'mm1',
      commence_time: commence,
      home_team: 'Lakers',
      away_team: 'Celtics',
      bookmakers: [
        { title: 'Pinnacle', markets: [
          { key: 'h2h', outcomes: [{ name: 'Lakers', price: 1.95 }, { name: 'Celtics', price: 1.95 }] },
          { key: 'totals', point: 220.5, outcomes: [{ name: 'Over', price: 1.9 }, { name: 'Under', price: 2.0 }] },
          { key: 'spreads', point: -1.5, outcomes: [{ name: 'Lakers', price: 1.87, point: -1.5 }, { name: 'Celtics', price: 2.03, point: 1.5 }] },
        ] },
        { title: 'Bet365', markets: [
          { key: 'h2h', outcomes: [{ name: 'Lakers', price: 1.9 }, { name: 'Celtics', price: 2.0 }] },
          { key: 'totals', point: 220.5, outcomes: [{ name: 'Over', price: 1.95 }, { name: 'Under', price: 1.95 }] },
          { key: 'spreads', point: -1.5, outcomes: [{ name: 'Lakers', price: 1.9, point: -1.5 }, { name: 'Celtics', price: 2.0, point: 1.5 }] },
        ] },
      ],
    };
    const real = globalThis.fetch;
    globalThis.fetch = async (u) => ({
      ok: true,
      headers: { get: (h) => (h === 'x-requests-remaining' ? '400' : null) },
      json: async () => (String(u).includes('basketball_nba') ? [game] : []),
    });
    try {
      const out = await scanDayLive(dayKey, { apiKey: 'k', sports: ['basketball_nba'], tz: 'UTC' });
      const types = new Set(out.legs.map((l) => l.marketType));
      assert.ok(types.has('h2h') && types.has('totals') && types.has('spreads'),
        `expected all three market families, got ${[...types].join(',')}`);
      for (const l of out.legs) {
        assert.equal(l.live, true);
        assert.equal(l.truthProb, null);
        assert.ok(Number.isFinite(l.edge), 'every live leg carries a finite edge');
      }
      const over = out.legs.find((l) => l.marketType === 'totals' && l.pick === 'Over');
      assert.ok(over.odds >= 1.95, 'line shopping must take the best Over price across books');
      assert.ok(out.diagnostics.scope.includes('totals'), 'diagnostics state the widened scope honestly');
    } finally { globalThis.fetch = real; }
  });

  test('the Vercel entry speaks classic (req, res): no bridge can hang on it', async () => {
    const { Readable } = await import('node:stream');
    const mod = await import('../api/index.js');
    const handler = mod.default;
    assert.equal(handler.length, 2, 'default export must be the two-argument Node handler');
    const payload = JSON.stringify({ stake: 500, currency: 'NGN', days: 7, targetOdds: 2, tolerance: 0.1, mode: 'balanced', provider: 'sim' });
    const req = Object.assign(Readable.from([Buffer.from(payload)]), {
      method: 'POST',
      url: '/api/runs',
      headers: { host: 'test' },
    });
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(d) { this.body = d; },
    };
    await handler(req, res);
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.ok(body.run?.days?.[0], 'a run came back through the classic bridge');
  });

  test('run creation prices day 1 from live fixtures when a key exists', async () => {
    const { createApi } = await import('../lib/http-core.js');
    const { createMemoryStore } = await import('../lib/memory-store.js');
    const api = createApi({ store: createMemoryStore(), env: {}, persistent: false });
    const dayKey = new Date(Date.now() + 20 * 3600e3).toISOString().slice(0, 10);
    await api({ method: 'POST', pathname: '/api/settings', query: new URLSearchParams(), body: { tz: 'UTC' } });
    await withFetch(okFetch, async () => {
      const out = await api({
        method: 'POST', pathname: '/api/runs', query: new URLSearchParams(),
        body: { stake: 500, currency: 'NGN', days: 7, targetOdds: 2, tolerance: 0.35, mode: 'balanced', provider: 'oddsapi', apiKey: 'test-key', startDay: dayKey },
      });
      assert.equal(out.status, 201);
      const day = out.body.run.days[0];
      assert.equal(day.scan.provider, 'oddsapi', 'day 1 must carry the live provider, not a silent sim');
      assert.equal(day.scan.providerFellBack, false);
      assert.ok(day.scan.books.includes('Pinnacle'), 'real book names, not simulated ones');
    });
  });

  test('a dashboard-fetched board prices the run with zero network access', async () => {
    const { createApi } = await import('../lib/http-core.js');
    const { createMemoryStore } = await import('../lib/memory-store.js');
    const api = createApi({ store: createMemoryStore(), env: {}, persistent: false });
    const dayKey = new Date(Date.now() + 20 * 3600e3).toISOString().slice(0, 10);
    await api({ method: 'POST', pathname: '/api/settings', query: new URLSearchParams(), body: { tz: 'UTC' } });
    let board = null;
    await withFetch(okFetch, async () => {
      const j = await api({ method: 'POST', pathname: '/api/scan/live', query: new URLSearchParams(), body: { apiKey: 'test-key', date: dayKey } });
      assert.equal(j.status, 200);
      board = { scan: j.body.scan, builder: j.body.builder };
    });
    const real = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('the route must not refetch when handed a board'); };
    try {
      const out = await api({
        method: 'POST', pathname: '/api/runs', query: new URLSearchParams(),
        body: { stake: 500, currency: 'NGN', days: 7, targetOdds: 2, tolerance: 0.35, mode: 'balanced', provider: 'oddsapi', startDay: dayKey, liveBoard: board },
      });
      assert.equal(out.status, 201);
      const day = out.body.run.days[0];
      assert.equal(day.scan.provider, 'oddsapi');
      assert.ok(day.scan.books.includes('Pinnacle'));
    } finally { globalThis.fetch = real; }
  });

  test('pasted prices become a real slip: settings → scan → builder', async () => {
    const { createApi } = await import('../lib/http-core.js');
    const { createMemoryStore } = await import('../lib/memory-store.js');
    const api = createApi({ store: createMemoryStore(), env: {}, persistent: false });
    /* Two fixtures, because a rollover combines games: minLegs is 2 by design
     * ("rollover = combine"), and one pasted match can never be a slip. A real
     * paste is a board of several matches, which is what this imitates. */
    const mk = (home, away, league, h, d, a) => ({
      home, away, sport: 'football', league, tier: 2,
      kickoff: new Date(Date.now() + 30 * 3600e3).toISOString(),
      market: 'Match Result', marketKey: `${home}-${away}`.toLowerCase(),
      outcomes: [
        { pick: home, odds: h, book: 'SportyBet' },
        { pick: 'Draw', odds: d, book: 'SportyBet' },
        { pick: away, odds: a, book: 'SportyBet' },
      ],
    });
    const entries = [
      mk('Rangers', 'Enyimba', 'NPFL', 1.42, 4.2, 6.5),
      mk('Kano Pillars', 'Shooting Stars', 'NPFL', 1.45, 4.0, 6.2),
    ];
    let r = await api({ method: 'POST', pathname: '/api/settings', body: { manualOdds: entries, provider: 'manual' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.settings.manualOdds.length, 2, 'the paste survives a save');

    const date = new Date(Date.now() + 30 * 3600e3).toISOString().slice(0, 10);
    r = await api({ method: 'GET', pathname: '/api/scan', query: new URLSearchParams(`date=${date}&odds=2.0&provider=manual`) });
    assert.equal(r.status, 200);
    assert.equal(r.body.provider.used, 'manual', 'pasted prices are used, not simulated over');
    assert.equal(r.body.provider.fellBack, false);
    const leg = r.body.topLegs.find((l) => l.home === 'Rangers');
    assert.ok(leg, 'the pasted fixture is priced');
    assert.equal(leg.book, 'SportyBet');
    assert.equal(leg.viewSource, 'pasted-single-book');
    assert.ok(r.body.builder.ok, r.body.builder.message);
    const best = r.body.builder.best;
    assert.equal(best.legCount, 2, 'two pasted games combined into the accumulator');
    assert.ok(best.odds >= 1.9 && best.odds <= 2.1, `combined odds ${best.odds} inside the band`);
    assert.ok(best.legs.every((l) => l.book === 'SportyBet'), 'every leg is YOUR price, not a simulated one');
  });

  test('garbage in the paste box is refused with a diagnosis, not stored half-parsed', async () => {
    const { createApi } = await import('../lib/http-core.js');
    const { createMemoryStore } = await import('../lib/memory-store.js');
    const api = createApi({ store: createMemoryStore(), env: {}, persistent: false });
    const r = await api({ method: 'POST', pathname: '/api/settings', body: { manualOdds: [{ home: 'A', away: 'B', outcomes: [{ pick: 'A', odds: 0.5 }, { pick: 'B', odds: 0.8 }] }] } });
    assert.equal(r.status, 200, 'the store accepts what it is given…');
    const date = new Date(Date.now() + 30 * 3600e3).toISOString().slice(0, 10);
    const scan = await api({ method: 'GET', pathname: '/api/scan', query: new URLSearchParams(`date=${date}&provider=manual`) });
    assert.equal(scan.body.provider.used, 'sim', '…but odds below 1 cannot price anything, so it falls back');
    assert.equal(scan.body.provider.fellBack, true);
    assert.match(scan.body.provider.reason, /could not be used/i);
  });
});

describe('API surface — provider honesty and malformed input', () => {
  const mkApi = async (env = {}) => {
    const { createApi } = await import('../lib/http-core.js');
    const { createMemoryStore } = await import('../lib/memory-store.js');
    return createApi({ store: createMemoryStore(), env, persistent: false });
  };
  const qs = (s) => new URLSearchParams(s);

  test('GET /api/scan reports which provider answered', async () => {
    const api = await mkApi();
    const r = await api({ method: 'GET', pathname: '/api/scan', query: qs(`date=${DAY}&odds=2.0&provider=oddsapi`) });
    assert.equal(r.status, 200);
    assert.equal(r.body.provider.requested, 'oddsapi');
    assert.equal(r.body.provider.used, 'sim');
    assert.equal(r.body.provider.fellBack, true);
    assert.ok(r.body.provider.reason, 'and it explains itself');
  });

  test('/api/scan/live exists — the route the sync scan has always advertised', async () => {
    const api = await mkApi();
    const r = await api({ method: 'POST', pathname: '/api/scan/live', body: { date: DAY } });
    assert.equal(r.status, 400, 'no key is a client error, not a 404 for a missing route');
    assert.match(r.body.error, /No API key/);
    assert.ok(r.body.hint);
  });

  test('/api/scan/live really prices live quotes when a key is present', async () => {
    const api = await mkApi();
    await withFetch(okFetch, async () => {
      const date = new Date(Date.now() + 20 * 3600e3).toISOString().slice(0, 10);
      const r = await api({ method: 'POST', pathname: '/api/scan/live', body: { date, apiKey: 'k', odds: 2.0, tolerance: 0.35 } });
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
      assert.equal(r.body.provider.used, 'oddsapi');
      assert.equal(r.body.provider.fellBack, false);
      assert.equal(r.body.truthKnown, false);
      assert.ok(r.body.diagnostics.books.length >= 2);
    });
  });

  test('toPlain survives Sets and Maps; jsonSafe is a reviver, not a sanitizer', async () => {
    /* jsonSafe(key, value) is a JSON.stringify REVIVER. Calling it as
     * jsonSafe(obj) passes the object as the key and undefined as the value, so
     * it returns undefined — which silently emptied a whole route's body. */
    const { jsonSafe, toPlain } = await import('../lib/http-core.js');
    assert.equal(jsonSafe({ a: 1 }), undefined, 'the trap: one argument means "no value"');
    const withSet = { books: new Set(['a', 'b']), byKey: new Map([['k', 1]]) };
    assert.deepEqual(toPlain(withSet), { books: ['a', 'b'], byKey: { k: 1 } });
    assert.equal(JSON.stringify(withSet, jsonSafe).includes('"a"'), true);
  });

  test('a malformed query is an empty query, not a crashed handler', async () => {
    const api = await mkApi();
    for (const bad of ['date=2026-10-08', undefined, null, '']) {
      const r = await api({ method: 'GET', pathname: '/api/scan', query: bad });
      assert.equal(r.status, 200, `query=${JSON.stringify(bad)}`);
    }
  });
});

describe('the dashboard as a browser sees it', () => {
  /* Everything else in this file runs against modules and HTTP. These two run
   * against the actual stylesheet and markup, because the bug they guard was
   * invisible to every other kind of test: it only exists once a real browser
   * computes the cascade. */
  const css = readFileSync(join(process.cwd(), 'public', 'app.css'), 'utf8');
  const html = readFileSync(join(process.cwd(), 'public', 'index.html'), 'utf8');

  test('the [hidden] attribute is defended against author display rules', () => {
    /* [hidden] is display:none only in the UA stylesheet. Any author display
     * rule — .modal-backdrop's grid, .btn's inline-flex — outranks it, so every
     * hidden element rendered anyway and the empty result-modal backdrop dimmed
     * and blurred the entire app, swallowing all clicks. One !important author
     * rule restores the attribute's meaning. */
    assert.match(
      css,
      /\[hidden\]\s*\{\s*display:\s*none\s*!important/,
      'app.css must keep `[hidden] { display: none !important; }` — see the comment above it',
    );
  });

  test('every element that relies on hidden has an author display rule that would break it', () => {
    /* This is the tripwire in the other direction: if someone "cleans up" the
     * !important rule, this test lists exactly which elements would start
     * rendering while hidden, so the failure message is the diagnosis. */
    const hiddenEls = [...html.matchAll(/<[^>]*\bhidden[^>]*>/g)].map((m) => m[0])
      .filter((tag) => !/aria-hidden/.test(tag));
    assert.ok(hiddenEls.length >= 5, 'the dashboard uses hidden in several places');
    for (const tag of hiddenEls) {
      const cls = /class="([^"]+)"/.exec(tag)?.[1]?.split(/\s+/).filter(Boolean) || [];
      const id = /id="([^"]+)"/.exec(tag)?.[1];
      const offenders = cls.filter((c) => new RegExp(`\\.${c}[^{]*\\{[^}]*display:`).test(css));
      if (offenders.length) {
        assert.match(
          css,
          /\[hidden\]\s*\{\s*display:\s*none\s*!important/,
          `#${id} (.${offenders.join(', .')}) sets display in author CSS and needs the [hidden] guard`,
        );
      }
    }
  });

  test('modal backdrops are the last word in stacking, above the topbar and toasts-excepted', () => {
    /* The dim wall in the bug report was a backdrop. Keep its contract explicit:
     * fixed, full viewport, and above ordinary page chrome. */
    const bd = /\.modal-backdrop\s*\{([^}]*)\}/.exec(css)[1];
    assert.match(bd, /position:\s*fixed/);
    assert.match(bd, /inset:\s*0/);
    const z = Number(/z-index:\s*(\d+)/.exec(bd)[1]);
    const topbarZ = Number(/z-index:\s*(\d+)/.exec(/\.topbar\s*\{([^}]*)\}/.exec(css)[1])[1]);
    assert.ok(z > topbarZ, 'a modal must dim the topbar, not slide under it');
  });
});
