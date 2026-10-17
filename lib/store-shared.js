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

/**
 * Sports this build refuses to price, league-key prefixes included.
 *
 * Basketball was retired as a product decision after repeated rollover losses:
 * the user does not want it on the board, in a slip, or in a league chip ever
 * again. This is a risk policy, not a modelling claim — the gaussian margin
 * maths in model.js stays because baseball still uses it. The policy lives here
 * (in the module with no imports) so every backend, the browser bundle, the
 * scanner and the builder all enforce the same list.
 */
export const RETIRED_SPORTS = ['basketball'];

/** True for `basketball`, `basketball_nba`, `basketball-euroleague`, … */
export function isRetiredSport(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return false;
  return RETIRED_SPORTS.some(
    (r) => s === r || s.startsWith(`${r}_`) || s.startsWith(`${r}-`) || s.startsWith(`${r} `)
  );
}

/** Preferred sports are a tie-break in the builder, never a subsidy. */
export const DEFAULT_PREFER_SPORTS = ['tennis'];

/** Normalise a `preferSports` value from settings, a run config or a caller. */
export function normalisePreferSports(value) {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : DEFAULT_PREFER_SPORTS;
  const cleaned = list
    .map((s) => String(s).trim().toLowerCase())
    .filter((s) => s && !isRetiredSport(s));
  return [...new Set(cleaned)];
}

/**
 * Drop retired sport keys from a settings patch before it is persisted.
 *
 * A user's saved `settings.oddsApi.sports` may still contain `basketball_*`
 * from before this change. Silently stripping them here — on the way in AND on
 * the way out (see `sanitiseSettings`) — is what stops old localStorage or
 * Vercel state from resurrecting a board entry the product no longer offers.
 * Silent on purpose: the user never asked to manage a key list, and an error
 * about a sport they asked us to remove would be noise, not honesty.
 */
export function sanitiseSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object') return patch;
  return sanitiseSettings(patch);
}

/** Strip retired sport keys and normalise preferences on a full settings object. */
export function sanitiseSettings(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  const out = { ...settings };
  if (out.oddsApi && typeof out.oddsApi === 'object') {
    const sports = Array.isArray(out.oddsApi.sports)
      ? out.oddsApi.sports.filter((k) => !isRetiredSport(k))
      : [];
    out.oddsApi = { ...out.oddsApi, sports };
  }
  if (out.preferSports !== undefined) {
    out.preferSports = normalisePreferSports(out.preferSports);
  }
  return out;
}

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
  /* Tennis is the promoted replacement for the retired basketball board. The
   * builder only reads this as a tie-break between combinations it already
   * considers equal on score — it can never lift a leg over the edge floor, the
   * odds band or a confidence gate. */
  preferSports: [...DEFAULT_PREFER_SPORTS],
  /* Real prices you pasted yourself (SportyBet screenshot transcription, a
   * telegram tip with numbers, whatever). Empty means "nothing pasted", which
   * the scan reports as a fallback rather than pretending to use them. */
  manualOdds: [],
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
