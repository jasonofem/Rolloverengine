/**
 * fixtures.js — builds the day's scan universe.
 *
 * Given a date, it produces a deterministic set of fixtures spread across
 * every sport in the ratings database. "Sports versatility" in the engine
 * means: the slip is never forced to be five Premier League results. It can
 * be an EPL double-chance + an NBA point line + a Serie A under 2.5 + a
 * tennis moneyline — as long as each leg carries edge and the product lands
 * on the day's odds target.
 *
 * Everything is seeded off the date string, so re-scanning the same day
 * returns the same universe (idempotent) until you settle it.
 */

import { makeRng, clamp, round } from './math.js';
import { modelTruth } from './model.js';
import { RATINGS } from './ratings.js';

/** How the day's event budget is split across sports. */
export const SPORT_MIX = {
  football: 0.6,
  basketball: 0.15,
  baseball: 0.09,
  tennis: 0.11,
  mma: 0.05,
};


/* ------------------------------------------------------------------ *
 * Timezone helpers — "next good window" reasoning is all local time
 * ------------------------------------------------------------------ */

export function tzDateKey(date = new Date(), tz = 'UTC') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

export function tzHour(date = new Date(), tz = 'UTC') {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(date));
}

export function tzNowParts(date = new Date(), tz = 'UTC') {
  return {
    dayKey: tzDateKey(date, tz),
    hour: tzHour(date, tz),
    label: new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date),
  };
}

/** Local wall-clock time in `tz` → absolute epoch ms. */
export function zonedTimeToMs(dayKey, hour, minute = 0, tz = 'UTC') {
  const naive = Date.parse(`${dayKey}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  if (tz === 'UTC') return naive;
  // Binary-search-free offset probe: format the naive guess in tz, measure drift, correct once.
  const guess = new Date(naive);
  const drift = probeOffset(guess, tz, dayKey, hour, minute);
  return naive - drift;
}

function probeOffset(date, tz, dayKey, hour, minute) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  const shown = Date.parse(`${g('year')}-${String(g('month')).padStart(2, '0')}-${String(g('day')).padStart(2, '0')}T${String(g('hour') % 24).padStart(2, '0')}:${String(g('minute')).padStart(2, '0')}:00Z`);
  return shown - date.getTime();
}

export function formatKickoff(ms, tz = 'UTC') {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ms));
}

/* ------------------------------------------------------------------ *
 * Day plan — which leagues get fixtures today, and how many
 * ------------------------------------------------------------------ */

/**
 * Real fixture density by day of week (0 = Sunday). Saturday is the deepest
 * card in world football; Monday is a desert. Tue/Wed carry the European
 * midweek competitions. This is what makes "which day should I start the
 * rollover?" an actual question with an actual answer rather than noise.
 */
export const DAY_WEIGHTS = [1.16, 0.62, 0.94, 0.98, 0.9, 1.02, 1.3];

export function eventsForDay(dayKey, base = 42) {
  const dow = new Date(`${dayKey}T12:00:00Z`).getUTCDay();
  return clamp(Math.round(base * (DAY_WEIGHTS[dow] ?? 1)), 12, 72);
}

export function planDay(dayKey, opts = {}) {
  const base = opts.eventsPerDay ?? 42;
  const total = opts.fixedEventCount ? base : eventsForDay(dayKey, base);
  const rng = makeRng(`plan|${dayKey}`);
  // Largest-remainder apportionment: keeps every sport represented even on a
  // thin Monday, instead of rounding the small sports down to nothing.
  const sports = Object.keys(SPORT_MIX);
  const mins = { football: 6, basketball: 2, baseball: 1, tennis: 1, mma: 1 };
  const raw = sports.map((sp) => total * SPORT_MIX[sp]);
  const floor = raw.map((v, i) => Math.max(mins[sports[i]] ?? 1, Math.floor(v)));
  let left = total - floor.reduce((a, b) => a + b, 0);
  const frac = raw.map((v, i) => ({ i, f: v - Math.floor(v) })).sort((a, b) => b.f - a.f);
  let k = 0;
  while (left > 0 && frac.length) {
    floor[frac[k % frac.length].i]++;
    left--;
    k++;
  }
  while (left < 0) {
    // over-committed by the minimums — take it back out of football
    const idx = sports.indexOf('football');
    if (floor[idx] > mins.football) { floor[idx]--; left++; } else break;
  }
  const budget = {};
  sports.forEach((sp, i) => (budget[sp] = floor[i]));

  const plan = [];
  for (const [sport, count] of Object.entries(budget)) {
    if (count <= 0) continue;
    if (sport === 'tennis' || sport === 'mma') {
      plan.push({ sport, count, league: sport === 'tennis' ? RATINGS.tennis : RATINGS.mma });
      continue;
    }
    const leagues = rng.shuffle(RATINGS[sport]);
    let left = count;
    let i = 0;
    while (left > 0 && i < count) {
      const lg = leagues[i % leagues.length];
      const per = clamp(Math.ceil(left / Math.max(1, Math.min(4, leagues.length))), 1, 6);
      const take = Math.min(per, left);
      plan.push({ sport, count: take, league: lg });
      left -= take;
      i++;
    }
  }
  return plan;
}

/** Kickoff slots, in local hours, weighted toward prime betting windows. */
const SLOTS = [
  { h: 11, m: 0, w: 0.5 },
  { h: 12, m: 30, w: 0.8 },
  { h: 14, m: 0, w: 1.0 },
  { h: 15, m: 0, w: 1.4 },
  { h: 16, m: 30, w: 1.0 },
  { h: 17, m: 30, w: 1.3 },
  { h: 18, m: 0, w: 0.9 },
  { h: 19, m: 0, w: 1.2 },
  { h: 19, m: 30, w: 1.4 },
  { h: 20, m: 0, w: 1.6 },
  { h: 20, m: 30, w: 1.2 },
  { h: 21, m: 0, w: 1.3 },
  { h: 22, m: 0, w: 0.8 },
];

function pickSlot(rng) {
  const totalW = SLOTS.reduce((a, s) => a + s.w, 0);
  let r = rng() * totalW;
  for (const s of SLOTS) {
    r -= s.w;
    if (r <= 0) return s;
  }
  return SLOTS[SLOTS.length - 1];
}

/* ------------------------------------------------------------------ *
 * Build raw fixtures for a day (no prices yet)
 * ------------------------------------------------------------------ */

export function buildDayEvents(dayKey, opts = {}) {
  const tz = opts.tz || 'UTC';
  const plan = planDay(dayKey, opts);
  const events = [];
  const usedSlots = new Map();

  for (const p of plan) {
    const rng = makeRng(`fx|${dayKey}|${p.league.code}|${p.count}`);
    if (p.sport === 'football' || p.sport === 'basketball' || p.sport === 'baseball') {
      const teams = rng.shuffle(p.league.teams);
      const pairCount = Math.min(p.count, Math.floor(teams.length / 2));
      for (let i = 0; i < pairCount; i++) {
        const a = teams[i * 2];
        const b = teams[i * 2 + 1];
        // coin flip home/away so the draw of the fixture list doesn't bias venue
        const [homeRow, awayRow] = rng.chance(0.5) ? [a, b] : [b, a];
        events.push(teamSportEvent(dayKey, p, homeRow, awayRow, rng, tz, usedSlots, events.length));
      }
    } else if (p.sport === 'mma') {
      const chosen = rng.shuffle(RATINGS.mma.fighters);
      const pairCount = Math.min(p.count, Math.floor(chosen.length / 2));
      for (let i = 0; i < pairCount; i++) {
        events.push(individualEvent(dayKey, p, chosen[i * 2], chosen[i * 2 + 1], rng, tz, usedSlots, events.length, i));
      }
    } else {
      // Tennis must pair within a tour — a WTA player never meets an ATP player.
      const men = rng.shuffle(RATINGS.tennis.players.filter((pl) => !WOMEN.has(pl[0])));
      const women = rng.shuffle(RATINGS.tennis.players.filter((pl) => WOMEN.has(pl[0])));
      let mi = 0;
      let wi = 0;
      let made = 0;
      let guard = 0;
      while (made < p.count && guard++ < 40) {
        const useWomen = wi + 1 < women.length && (mi + 1 >= men.length || rng.chance(0.42));
        const pool = useWomen ? women : men;
        const idx = useWomen ? wi : mi;
        if (idx + 1 >= pool.length) {
          if (useWomen) break;
          mi = men.length;
          continue;
        }
        events.push(
          individualEvent(dayKey, p, pool[idx], pool[idx + 1], rng, tz, usedSlots, events.length, made, useWomen ? 'WTA' : 'ATP')
        );
        if (useWomen) wi += 2;
        else mi += 2;
        made++;
      }
    }
  }

  return events.sort((x, y) => x.kickoff - y.kickoff);
}

function slotFor(rng, usedSlots, dayKey, tz) {
  let slot = pickSlot(rng);
  let guard = 0;
  const key = (s) => `${s.h}:${s.m}`;
  while ((usedSlots.get(key(slot)) || 0) >= 4 && guard++ < 20) slot = pickSlot(rng);
  usedSlots.set(key(slot), (usedSlots.get(key(slot)) || 0) + 1);
  return zonedTimeToMs(dayKey, slot.h, slot.m, tz);
}

function teamSportEvent(dayKey, plan, homeRow, awayRow, rng, tz, usedSlots, idx) {
  const sport = plan.sport;
  const league = plan.league;
  const home =
    sport === 'football'
      ? { name: homeRow[0], code: homeRow[1], att: homeRow[2], def: homeRow[3] }
      : { name: homeRow[0], code: homeRow[1], rtg: homeRow[2] };
  const away =
    sport === 'football'
      ? { name: awayRow[0], code: awayRow[1], att: awayRow[2], def: awayRow[3] }
      : { name: awayRow[0], code: awayRow[1], rtg: awayRow[2] };

  const kickoff = slotFor(rng, usedSlots, dayKey, tz);
  const event = {
    id: `${dayKey}-${league.code}-${idx}`,
    sport,
    league: { code: league.code, name: league.name, country: league.country, base: league.base, sigma: league.sigma, tier: league.tier, noise: league.noise },
    kickoff,
    kickoffLocal: formatKickoff(kickoff, tz),
    home,
    away,
    neutral: rng.chance(0.04),
  };
  const truth = modelTruth(event);
  event.markets = truth.markets;
  event.meta = truth.meta;
  event.truthSeed = `${event.id}|result`;
  return event;
}

function individualEvent(dayKey, plan, a, b, rng, tz, usedSlots, idx, pairIdx, tour = null) {
  const sport = plan.sport;
  const league = sport === 'tennis' ? RATINGS.tennis : RATINGS.mma;
  const [homeRow, awayRow] = rng.chance(0.5) ? [a, b] : [b, a];
  const kickoff = slotFor(rng, usedSlots, dayKey, tz);
  const event = {
    id: `${dayKey}-${league.code}-${idx}`,
    sport,
    league: {
      code: tour ? `${league.code}-${tour}` : league.code,
      name: tour ? `${league.name} · ${tour}` : league.name,
      country: league.country,
      tier: league.tier,
      noise: league.noise,
      scale: league.scale,
    },
    kickoff,
    kickoffLocal: formatKickoff(kickoff, tz),
    home: { name: homeRow[0], code: initials(homeRow[0]), rtg: homeRow[1] },
    away: { name: awayRow[0], code: initials(awayRow[0]), rtg: awayRow[1] },
    neutral: true,
    meta2: sport === 'tennis' ? { tour, round: roundLabel(pairIdx) } : { card: cardLabel(pairIdx) },
  };
  const truth = modelTruth(event);
  event.markets = truth.markets;
  event.meta = truth.meta;
  event.truthSeed = `${event.id}|result`;
  return event;
}

function initials(name) {
  return name
    .replace(/[^A-Za-z ]/g, '')
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 4);
}

const WOMEN = new Set([
  'Aryna Sabalenka', 'Iga Świątek', 'Coco Gauff', 'Elena Rybakina', 'Jasmine Paolini',
  'Jessica Pegula', 'Qinwen Zheng', 'Mirra Andreeva', 'Madison Keys', 'Barbora Krejčíková',
  'Emma Navarro', 'Danielle Collins', 'Karolína Muchová', 'Daria Kasatkina', 'Anna Kalinskaya', 'Marta Kostyuk',
]);

function roundLabel(i) {
  return i < 2 ? 'Quarter-final' : i < 4 ? 'Round of 16' : 'Semi-final';
}

function cardLabel(i) {
  return i === 0 ? 'Main Event' : i === 1 ? 'Co-main Event' : `Prelim ${i - 1}`;
}

/* ------------------------------------------------------------------ *
 * Day shape analytics — used for "when should I start?" suggestions
 * ------------------------------------------------------------------ */

/**
 * Score a day for rollover-friendliness: how much bettable surface exists
 * and how early the action starts (an early first kickoff means you can
 * settle and roll within the same day).
 */
export function dayShape(dayKey, opts = {}) {
  const events = opts.events || buildDayEvents(dayKey, opts);
  const tz = opts.tz || 'UTC';
  const bySport = {};
  for (const e of events) bySport[e.sport] = (bySport[e.sport] || 0) + 1;
  const markets = events.reduce((a, e) => a + e.markets.length, 0);
  const hours = events.map((e) => new Date(e.kickoff).getUTCHours());
  const firstKickoff = events.length ? Math.min(...events.map((e) => e.kickoff)) : null;
  const lastKickoff = events.length ? Math.max(...events.map((e) => e.kickoff)) : null;
  const weekend = [0, 6].includes(new Date(`${dayKey}T12:00:00Z`).getUTCDay());

  // Calibrated against a 42-event baseline day: a full Saturday card (~55
  // fixtures, 260 markets) should read ~0.95 and a bare Monday (~26 fixtures,
  // 120 markets) should read ~0.55, otherwise "start on the best day" is
  // meaningless because every day looks prime.
  const sportsCount = Object.keys(bySport).length;
  const score = clamp(
    0.38 * clamp(events.length / 55, 0, 1) +
      0.24 * clamp(markets / 260, 0, 1) +
      0.14 * clamp(sportsCount / 5, 0, 1) +
      0.16 * (weekend ? 1 : 0.55) +
      0.08 * clamp((tzHour(firstKickoff ? new Date(firstKickoff) : new Date(), tz) - 9) / 8, 0, 1),
    0,
    0.98
  );

  return {
    dayKey,
    weekday: new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long' }).format(new Date(`${dayKey}T12:00:00Z`)),
    events: events.length,
    markets,
    bySport,
    weekend,
    firstKickoff,
    lastKickoff,
    firstKickoffLocal: firstKickoff ? formatKickoff(firstKickoff, tz) : null,
    lastKickoffLocal: lastKickoff ? formatKickoff(lastKickoff, tz) : null,
    score: round(score, 3),
    label: score >= 0.85 ? 'Prime' : score >= 0.7 ? 'Good' : score >= 0.52 ? 'Workable' : 'Thin',
  };
}

export function upcomingDays(fromDayKey, n = 10, opts = {}) {
  const out = [];
  const start = new Date(`${fromDayKey}T12:00:00Z`);
  for (let i = 0; i < n; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    out.push(dayShape(key, opts));
  }
  return out;
}

export { RATINGS };
