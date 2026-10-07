/**
 * store-shared.js — the parts of persistence that every backend must agree on.
 *
 * Three storage backends implement the same contract: the flat JSON file
 * (lib/store.js), an in-process object for serverless (lib/memory-store.js) and
 * localStorage in the browser (also lib/memory-store.js). If any of them
 * disagrees about what a run summary looks like or what the default settings
 * are, the same dashboard renders different numbers depending on where it is
 * hosted — which is exactly the kind of quiet inconsistency that makes you
 * distrust a system that is entirely about trustworthy numbers.
 *
 * So the shared definitions live here, in a module with no imports at all. That
 * last part matters: the browser build must be able to bundle this without
 * dragging node:fs in behind it.
 */

/** House defaults. Nigerian Naira, ₦500, 7 days at 2.00, Africa/Lagos. */
export const DEFAULT_SETTINGS = {
  currency: 'NGN',
  tz: 'Africa/Lagos',
  stake: 500,
  days: 7,
  targetOdds: 2.0,
  tolerance: 0.1,
  mode: 'balanced',
  provider: 'sim',
  eventsPerDay: 42,
  marketInefficiency: 1.3,
  reservePct: 0,
  /* The edge floor defaults to 0 on purpose. Positive-edge legs are
   * disproportionately longshots, so gating the *search* on an edge floor
   * starves the pool of the short prices needed to build a 2.00 accumulator and
   * the day silently degrades into one long leg. The win-probability optimiser
   * lands on +edge legs anyway (around +1.5pp per leg unprompted); the floor is
   * a reporting number, and the builder relaxes it in tiers when it bites. */
  minEdgePerLeg: 0,
  maxLegs: 6,
};

/** What the run list shows. Cheap enough to compute on every read. */
export function summariseRun(r) {
  const cfg = r.config || {};
  return {
    id: r.id,
    status: r.status,
    createdAt: r.createdAt,
    currency: cfg.currency,
    stake: r.startBalance,
    balance: r.balance,
    days: cfg.days,
    currentDay: r.currentDay,
    targetOdds: cfg.targetOdds,
    daysWon: r.stats?.won ?? 0,
    profit: Math.round((r.balance - r.startBalance) * 100) / 100,
    headline: r.verdict?.headline ?? null,
    provider: cfg.provider,
    startedOn: cfg.startDay,
  };
}

/** Runs are persisted as plain JSON, so rehydrate what the engine expects live. */
export function reviveRun(run) {
  if (!run) return run;
  for (const d of run.days || []) {
    if (d.result?.resolved) {
      for (const r of d.result.resolved) if (r.wonSet) delete r.wonSet;
    }
  }
  return run;
}
