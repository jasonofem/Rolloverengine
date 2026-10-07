#!/usr/bin/env node
/**
 * rollover — the RolloverEngine on the command line.
 *
 *   rollover create   --stake 500 --days 7 --odds 2.0 --tol 0.1 --mode balanced
 *   rollover scan     [--run ID] [--day N] [--all] [--date YYYY-MM-DD]
 *   rollover stake    [--run ID] [--day N] [--alt K]
 *   rollover settle   [--run ID] [--day N] [--result won|lost] [--odds 2.14] [--manual]
 *   rollover skip     [--run ID] [--day N]
 *   rollover restart  [--run ID] [--days N] [--odds X] [--stake N]
 *   rollover show     [--run ID]
 *   rollover runs
 *   rollover calendar [--from YYYY-MM-DD] [--tz Africa/Lagos]
 *   rollover lab      [--iters 500] [--days 7] [--odds 2.0] [--seed 4242]
 *   rollover project  [--stake 500] [--days 7] [--odds 2.0] [--daily 53.7]
 *   rollover delete   --run ID
 *
 * Zero dependencies. Shares one JSON store with the web dashboard (data/store.json),
 * so a run started in either place shows up in both.
 */
import process from 'node:process';
import { saveRun, getRun, listRuns, getActiveRun, getSettings, deleteRun } from '../lib/store.js';
import {
  createRun, scanRunDay, confirmDay, settleDay, skipDay, rescanDay, restartRun,
  chooseAlternative, runProgress, RUN_STATUS, money as fmtMoney,
} from '../lib/rollover.js';
import { suggestNextRun } from '../lib/suggestions.js';
import { scanForDay } from '../lib/scan.js';
import { runSimulation, projectRun } from '../lib/simulate.js';

/* ── args ──────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';

const flag = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = argv[i + 1];
  return v === undefined || String(v).startsWith('--') ? true : v;
};
const has = (name) => argv.includes(`--${name}`);
const num = (name, dflt) => {
  const v = flag(name, null);
  return v === null || v === true ? dflt : Number(v);
};
const str = (name, dflt) => {
  const v = flag(name, null);
  return v === null || v === true ? dflt : v;
};

/* ── colour + formatting ───────────────────────────────────────────── */

const ANSI = /\x1b\[[0-9;]*m/g;
const c = {
  dim: (t) => `\x1b[2m${t}\x1b[0m`,
  bold: (t) => `\x1b[1m${t}\x1b[0m`,
  green: (t) => `\x1b[32m${t}\x1b[0m`,
  red: (t) => `\x1b[31m${t}\x1b[0m`,
  gold: (t) => `\x1b[33m${t}\x1b[0m`,
  cyan: (t) => `\x1b[36m${t}\x1b[0m`,
};
if (!process.stdout.isTTY || process.env.NO_COLOR) {
  for (const k of Object.keys(c)) c[k] = (t) => String(t);
}

const money = (v, code) => fmtMoney(code || 'NGN', v ?? 0);
const pct = (v, d = 2) => `${Number(v ?? 0).toFixed(d)}%`;
const signed = (v, d = 2, suffix = '') => `${v >= 0 ? '+' : ''}${Number(v ?? 0).toFixed(d)}${suffix}`;
const vis = (t) => String(t).replace(ANSI, '');
const pad = (t, n, right = false) => {
  const s = vis(t);
  const fill = ' '.repeat(Math.max(0, n - s.length));
  return right ? fill + t : t + fill;
};

function wrap(text, width = 100) {
  const lines = [];
  let cur = '';
  for (const word of String(text).split(/\s+/)) {
    if (!word) continue;
    if ((cur + ' ' + word).trim().length > width) { lines.push(cur.trim()); cur = word; }
    else cur += ' ' + word;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines;
}

/* ── shared renderers ──────────────────────────────────────────────── */

const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayLabel = (dateStr, tz) => {
  try {
    const d = new Date(`${dateStr}T12:00:00Z`);
    return DAY_LABELS[d.getUTCDay()].slice(0, 3) + ' ' + dateStr.slice(5);
  } catch { return dateStr; }
};

function legLine(l) {
  const match = `${l.home ?? ''}${l.away ? ' v ' + l.away : ''}`.trim() || l.event || '';
  return c.dim(
    '             ' +
    pad(String(l.odds), 6, true) + '  ' +
    pad(l.sport, 10) +
    pad(String(l.league).slice(0, 20), 21) +
    pad(match.slice(0, 30), 31) +
    pad(String(l.market).slice(0, 22), 23) +
    pad(String(l.pick).slice(0, 18), 19) +
    pad(`p ${pct((l.modelProb ?? 0) * 100, 1)}`, 9, true) + '  ' +
    pad(`edge ${signed((l.edge ?? 0) * 100, 2, 'pp')}`, 14, true),
  );
}

function slipBlock(slip, indent = '         ') {
  console.log(c.dim(
    `${indent}slip  ${slip.legCount} legs @ ${slip.odds.toFixed(3)}  ·  win ${pct(slip.winProbPct)}  ·  EV ${pct(slip.evPct)}  ·  grade ${slip.grade}` +
    `  ·  stake ${money(slip.stake)} → ${money(slip.potentialReturn)}`,
  ));
  console.log(c.dim(`${indent}      ${slip.sports.join(', ')}  ·  avg confidence ${pct((slip.avgConfidence ?? 0) * 100, 0)}${slip.belowThreshold ? '  ·  ' + c.gold('BELOW WIN-PROB THRESHOLD') : ''}`));
  for (const l of slip.legs) console.log(legLine(l));
}

function verdictBlock(v, status) {
  if (!v) return;
  const colour = status === RUN_STATUS.COMPLETE ? c.green : c.red;
  console.log('');
  console.log(colour(c.bold(`  ${v.headline}`)));
  for (const line of wrap(v.subheadline || v.body || '', 98)) console.log(c.dim(`  ${line}`));
  if (v.numbers) {
    console.log('');
    for (const [k, val] of Object.entries(v.numbers)) {
      console.log(c.dim(`    ${k.replace(/([A-Z])/g, ' $1').toLowerCase().padEnd(22)} ${typeof val === 'number' && k.endsWith('Pct') ? pct(val) : (typeof val === 'number' && /stake|balance|profit|lost|saved/i.test(k) ? money(val) : val)}`));
    }
  }
  if (v.failedLegs?.length) {
    console.log(c.dim('\n    the legs that broke it:'));
    for (const l of v.failedLegs) console.log(c.dim(`      ${String(l.odds).padStart(6)}  ${String(l.match || l.event || '').slice(0, 34).padEnd(35)} ${String(l.pick).slice(0, 20).padEnd(21)} ${l.status} ${l.scoreline ? '(' + l.scoreline + ')' : ''}`));
  }
  if (v.recovery) {
    console.log(c.dim('\n  recovery options'));
    for (const o of v.recovery.options) {
      const mark = o.id === v.recovery.recommendedId ? c.green('▸ ') : '  ';
      console.log(
        mark + pad(o.id, 13) + pad(String(o.title).slice(0, 34), 35) +
        pad(`run ${pct(o.runWinPct)}`, 12, true) + '  ' +
        pad(`daily ${pct(o.dailyWinProbPct, 1)}`, 14, true) + '  ' +
        pad(`${o.days}d @${o.odds}`, 11) +
        pad(`${money(o.stake)} → ${money(o.payout)}`, 26, true),
      );
      console.log(c.dim(`               ${o.detail}`));
    }
    if (v.recovery.diagnosis) {
      console.log('');
      for (const line of wrap(Array.isArray(v.recovery.diagnosis) ? v.recovery.diagnosis.join(' ') : v.recovery.diagnosis, 98)) console.log(c.dim(`  ${line}`));
    }
    const rc = v.recovery.realityCheck;
    if (rc && typeof rc === 'object') {
      console.log('');
      console.log(c.gold(`  reality check  measured ${pct(rc.avgDailyWinProbPct)} a day across your slips → about 1 win per ${rc.runsExpectedPerWin?.toLocaleString()} runs, ${rc.avgLegsPerSlip} legs a slip, ${rc.lossCount} loss(es) on record.`));
      if (rc.bestLever) console.log(c.gold(`                 biggest lever available: ${rc.bestLever}`));
    } else if (rc) {
      console.log('');
      for (const line of wrap(rc, 98)) console.log(c.gold(`  ${line}`));
    }
  }
  if (v.discipline) {
    console.log('');
    for (const line of wrap(Array.isArray(v.discipline) ? v.discipline.join(' ') : v.discipline, 98)) console.log(c.dim(`  ${line}`));
  }
  if (v.nextRun) {
    console.log('');
    console.log(c.cyan(`  next run: ${v.nextRun.startDayLabel || v.nextRun.startDay}`));
    for (const line of wrap(v.nextRun.reason || '', 98)) console.log(c.dim(`            ${line}`));
    for (const n of v.nextRun.stakeNotes || []) console.log(c.dim(`            · ${n}`));
    if (v.nextRun.alternatives) {
      for (const a of v.nextRun.alternatives) console.log(c.dim(`            · alt: ${a.startDayLabel || a.startDay} (${a.reason || a.label || ''})`));
    }
  }
  console.log('');
}

function showRun(run) {
  const cur = run.config.currency;
  const p = runProgress(run);
  const cfg = run.config;

  console.log('');
  console.log(c.bold(`  ROLLOVERENGINE  ·  ${run.id}`));
  console.log(c.dim(`  ${new Date(run.createdAt).toUTCString().slice(0, 22)}  ·  ${cfg.provider}  ·  ${cfg.builder?.mode || 'balanced'}  ·  tz ${cfg.tz}  ·  ${run.status}`));
  console.log('');
  console.log(`  stake        ${money(cfg.stake, cur)}   target ${cfg.targetOdds} ± ${cfg.tolerance}   ${cfg.days} days   ${cfg.oddsMode} odds mode`);
  console.log(`  balance      ${money(run.balance, cur)}${run.status === RUN_STATUS.COMPLETE ? c.green(`   ×${p.projectedMultiple}`) : c.dim(`   target ${money(p.projectedFinal, cur)}`)}`);
  console.log(`  days         ${p.daysWon} won · ${p.daysLost} lost · ${p.daysSkipped} skipped · on day ${p.currentDay} of ${p.totalDays}`);
  /* Two different numbers, and labelling them the same way is how a dashboard
   * ends up telling you "128× · 1 in 116" — a target-odds payout next to a
   * realised-odds probability. The plan is what 2.00 every day would give you.
   * The chance is measured off the slips the engine actually built. */
  if (run.projection?.final != null) {
    console.log(c.dim(`  the plan     every day at exactly ${run.projection.odds} → ${run.projection.multiple}× → ${money(run.projection.final, cur)} (${money(run.projection.profit, cur)} profit)`));
  }
  const oneIn = p.chanceToFinishPct > 0 ? Math.round(100 / p.chanceToFinishPct) : null;
  console.log(`  your chance  ${pct(p.chanceToFinishPct)} of finishing · avg daily win ${pct(p.avgDailyWinProbPct)}${oneIn ? ` · about 1 in ${oneIn}` : ''}`);
  if (cfg.reservePct) console.log(c.dim(`  reserve      ${cfg.reservePct}% held back each day (cap ${cfg.reserveCapPct}%) — it costs compounding, deliberately`));
  if (run.lineage?.length) console.log(c.dim(`  lineage      ${run.lineage.length} previous: ${run.lineage.map((l) => `${l.id} died day ${l.diedOnDay}`).join(', ')}`));
  console.log('');

  const STATUS = { won: c.green('WON'), lost: c.red('LOST'), open: c.gold('STAKED'), ready: c.cyan('READY'), pending: c.dim('—'), skipped: c.dim('SKIP') };
  for (const d of run.days) {
    const label = dayLabel(d.date, cfg.tz);
    const head = `  day ${String(d.day).padStart(2)}  ${d.date}  ${pad(label, 11)} ${pad(STATUS[d.status] ?? d.status, 18)} ${d.stakeIn != null ? pad('stake ' + money(d.stakeIn, cur), 20) : pad('', 20)} ${d.stakeOut != null ? c.bold(money(d.stakeOut, cur)) : ''}`;
    console.log(head);

    if (d.scan) {
      const s = d.scan;
      console.log(c.dim(`         scan  ${s.eventsScanned} fixtures · ${s.marketsScanned} markets · ${s.pricesQuoted} prices · ${s.bookCount ?? s.books?.length ?? 0} books · vig ${s.avgOverround}%`));
      console.log(c.dim(`               ${s.legsConsidered} legs at +edge · ${s.legsEligible} passed filters · ${s.combosEvaluated} combos evaluated${s.report?.edgeTier ? ` · edge tier ${s.report.edgeTier}` : ''}`));
      if (s.diagnostics) console.log(c.dim(`               model error ${s.diagnostics.modelErrorPp}pp vs truth · ratings-only ${s.diagnostics.ratingsErrorPp}pp · true EV of edge legs ${s.diagnostics.edgeLegTrueEvPct}%`));
    }
    if (d.slip) slipBlock(d.slip, '         ');
    else if (d.scan?.failure) console.log(c.dim(`         ${c.red('no slip')}: ${d.scan.failure.reason} — ${String(d.scan.failure.message || '').slice(0, 92)}`));
    else if (d.status === 'pending') console.log(c.dim('         not scanned yet'));

    if (d.result) {
      const r = d.result;
      const tag = r.allWon ? c.green(`WON ${r.legsWon}/${r.legsTotal} legs @ ${r.odds.toFixed(3)}`) : c.red(`LOST ${r.legsWon}/${r.legsTotal} legs landed`);
      console.log(`         ${tag}${r.manual ? c.dim(`  (reported${r.reported ? ' ' + r.reported : ''})`) : ''}`);
      for (const l of r.resolved || []) {
        const col = l.status === 'WON' ? c.green : l.status === 'LOST' ? c.red : c.dim;
        console.log(col(`           ${pad(l.status, 8)} ${pad(String(l.odds), 6, true)}  ${pad(String(l.match || '').slice(0, 34), 35)} ${pad(String(l.pick).slice(0, 20), 21)} ${pad(String(l.result || ''), 8)} ${c.dim(String(l.outcomeSummary || '').slice(0, 40))}`));
      }
    }
    if (d.message) console.log(c.dim(`         ${d.message}`));
  }

  verdictBlock(run.verdict, run.status);
}

/* ── commands ──────────────────────────────────────────────────────── */

async function pickRun() {
  const id = str('run', null);
  if (id) {
    const r = await getRun(id);
    if (!r) throw new Error(`no run with id ${id} — try: rollover runs`);
    return r;
  }
  const active = await getActiveRun();
  if (active) return active;
  const all = await listRuns();
  if (!all.length) return null;
  // listRuns() hands back lightweight summaries; we need the whole run.
  const last = all[0];
  const full = await getRun(last.id);
  console.log(c.dim(`  no active run — using the most recent: ${last.id}`));
  return full;
}

const commands = {
  async help() {
    console.log(`
${c.bold('rollover')} — the RolloverEngine CLI

  ${c.cyan('create')}    --stake 500 --days 7 --odds 2.0 --tol 0.1 --mode balanced|combo|max
              --provider sim|manual --tz Africa/Lagos --reserve 10 --currency NGN --start 2026-10-10
  ${c.cyan('scan')}      [--run ID] [--day N] [--all] [--date YYYY-MM-DD] [--events 42]
  ${c.cyan('stake')}     [--run ID] [--day N] [--alt K]
  ${c.cyan('settle')}    [--run ID] [--day N] [--result won|lost] [--odds 2.14] [--manual]
  ${c.cyan('skip')}      [--run ID] [--day N]
  ${c.cyan('restart')}   [--run ID] [--days N] [--odds X] [--stake N]
  ${c.cyan('show')}      [--run ID]
  ${c.cyan('runs')}      everything in the store
  ${c.cyan('calendar')}  [--from YYYY-MM-DD] [--tz Africa/Lagos]
  ${c.cyan('lab')}       [--iters 500] [--days 7] [--odds 2.0] [--stake 500] [--seed 4242]
              [--strategies engine,naive,favourites] [--variants 3] [--events 42]
  ${c.cyan('project')}   [--stake 500] [--days 7] [--odds 2.0] [--daily 53.7]
  ${c.cyan('delete')}    --run ID

The CLI and the web dashboard share one store (data/store.json).
Set NO_COLOR=1 to strip the ANSI codes.
`);
  },

  async create() {
    const run = createRun({
      baseStake: num('stake', 500),
      days: num('days', 7),
      targetOdds: num('odds', 2.0),
      tolerance: num('tol', 0.1),
      provider: str('provider', null),
      timezone: str('tz', null),
      mode: str('mode', null),
      reservePct: has('reserve') ? num('reserve', 0) : null,
      currency: str('currency', null),
      startDate: str('start', null),
      marketInefficiency: has('inefficiency') ? num('inefficiency', 1.3) : null,
      eventsPerDay: has('events') ? num('events', 42) : null,
    });
    await saveRun(run);
    const cur = run.config.currency;
    console.log(c.green(`\n  run created: ${run.id}`));
    console.log(c.dim(`  ${money(run.config.stake, cur)} over ${run.config.days} days at ${run.config.targetOdds} ± ${run.config.tolerance}, starting ${run.days[0].date}`));
    const p0 = runProgress(run);
    if (run.projection?.final != null) {
      console.log(c.dim(`  the plan: ${run.projection.days} days at exactly ${run.projection.odds} → ${run.projection.multiple}× → ${money(run.projection.final, cur)}`));
    }
    const oneIn0 = p0.chanceToFinishPct > 0 ? Math.round(100 / p0.chanceToFinishPct) : null;
    console.log(c.dim(`  your chance: ${pct(p0.avgDailyWinProbPct)} a day off the slips actually built → ${pct(p0.chanceToFinishPct)} of finishing${oneIn0 ? ` (1 in ${oneIn0})` : ''}`));
    if (!has('noscan')) scanRunDay(run, 1);
    await saveRun(run);
    showRun(run);
    console.log(c.dim(`  next: rollover stake --run ${run.id}\n`));
  },

  async scan() {
    const run = await pickRun();
    const date = str('date', null);

    if (date) {
      const settings = await getSettings();
      const tz = str('tz', run?.config.tz || settings.timezone || 'Africa/Lagos');
      const res = scanForDay(date, {
        tz,
        provider: str('provider', run?.config.provider || settings.provider || 'sim'),
        eventsPerDay: num('events', run?.config.eventsPerDay ?? settings.eventsPerDay ?? 42),
        marketInefficiency: num('inefficiency', settings.marketInefficiency ?? 1.3),
        builder: {
          targetOdds: num('odds', run?.config.targetOdds ?? settings.targetOdds ?? 2.0),
          tolerance: num('tol', run?.config.tolerance ?? settings.tolerance ?? 0.1),
          mode: str('mode', run?.config.builder?.mode || settings.mode || 'balanced'),
        },
      });
      const d = res.scan;
      const dg = d.diagnostics;
      const best = res.builder.best;

      console.log(`\n  ${c.bold(`${d.dayKey} — ${dayLabel(d.dayKey, tz)}`)}  ${dg.events} fixtures · ${dg.markets} markets · ${dg.pricesQuoted} prices · vig ${dg.avgOverround}%`);
      console.log(c.dim(`  accuracy vs ground truth: model ${dg.modelErrorPp}pp · sharp ${dg.sharpErrorPp}pp · consensus ${dg.consensusErrorPp}pp · ratings-only ${dg.ratingsErrorPp}pp`));
      console.log(c.dim(`  value: ${dg.positiveEdgeLegs} legs at +edge · their TRUE EV ${dg.edgeLegTrueEvPct}% · betting everything blindly ${dg.trueEvPct}%\n`));

      if (best) {
        console.log(c.green(`  best slip: ${best.legCount} legs @ ${best.odds.toFixed(3)} · win ${pct(best.winProbPct)} · EV ${pct(best.evPct)} · grade ${best.grade} · edge tier ${best.edgeTier ?? '—'}`));
        for (const l of best.legs) console.log(legLine(l));
      } else {
        console.log(c.red(`  no slip: ${res.builder.reason} — ${res.builder.message}`));
      }
      const n = Math.min(num('limit', 20), d.legs.length);
      console.log(c.dim(`\n  top ${n} of ${d.legs.length} eligible legs\n`));
      for (const l of d.legs.slice(0, n)) console.log(legLine(l));
      console.log('');
      return;
    }

    if (!run) return commands.create();
    const days = has('all') ? run.days.map((d) => d.day) : [num('day', run.currentDay ?? 1)];
    for (const n of days) {
      const r = rescanDay(run, n);
      const d = r.day ?? run.days[n - 1];
      if (d?.slip) console.log(c.green(`  day ${n} (${d.date}): ${d.slip.legCount} legs @ ${d.slip.odds.toFixed(3)}, win ${pct(d.slip.winProbPct)}, grade ${d.slip.grade}`));
      else console.log(c.red(`  day ${n} (${d?.date ?? '?'}): ${d?.scan?.failure?.reason ?? 'no slip'} — ${String(d?.scan?.failure?.message || r?.error || '').slice(0, 100)}`));
    }
    await saveRun(run);
    showRun(run);
  },

  async stake() {
    const run = await pickRun();
    if (!run) return commands.create();
    const n = num('day', run.currentDay ?? 1);
    if (has('alt')) {
      const r = chooseAlternative(run, n, num('alt', 1));
      if (r?.ok) console.log(c.dim(`  switched day ${n} to alternative ${num('alt', 1)}: ${r.day.slip.legCount} legs @ ${r.day.slip.odds.toFixed(3)}, win ${pct(r.day.slip.winProbPct)}`));
      else console.log(c.red(`  ${r?.error || 'could not switch alternative'}`));
    }
    const d = confirmDay(run, n);
    await saveRun(run);
    console.log(c.green(`\n  staked ${money(d.slip.stake, run.config.currency)} on day ${n} — ${d.slip.legCount} legs @ ${d.slip.odds.toFixed(3)}, model win chance ${pct(d.slip.winProbPct)}`));
    if (d.slip.belowThreshold) console.log(c.gold(`  warning: this slip is below the engine's own win-probability threshold. ${d.slip.grade} grade.`));
    console.log(c.dim(`  balance after staking: ${money(run.balance, run.config.currency)}`));
    console.log(c.dim(`  if it lands: ${money(d.slip.potentialReturn, run.config.currency)}  ·  then: rollover settle --day ${n}\n`));
  },

  async settle() {
    const run = await pickRun();
    if (!run) return commands.help();
    const n = num('day', run.currentDay ?? 1);
    const result = str('result', null);
    const realisedOdds = has('odds') ? num('odds', null) : null;
    const isManual = result !== null || realisedOdds !== null || has('manual');
    const cur = run.config.currency;

    const res = settleDay(run, result ?? 'auto', {
      dayNumber: n,
      manual: isManual ? (result || 'won') : undefined,
      realisedOdds,
    });
    await saveRun(run);
    const day = res.day;
    const r = day.result;

    console.log('');
    console.log(r.allWon
      ? c.green(`  day ${n} WON — ${r.legsWon}/${r.legsTotal} legs @ ${r.odds.toFixed(3)} → ${money(day.stakeOut, cur)}`)
      : c.red(`  day ${n} LOST — ${r.legsWon}/${r.legsTotal} legs landed, ${money(day.stakeIn, cur)} gone`));
    if (r.manual) console.log(c.dim(`  (settled from your report${r.reported ? ': ' + r.reported : ''}, scorelines resolved by the simulator)`));
    console.log(c.dim(`  balance ${money(run.balance, cur)}  ·  status ${run.status.toUpperCase()}`));
    for (const l of r.resolved || []) {
      const col = l.status === 'WON' ? c.green : l.status === 'LOST' ? c.red : c.dim;
      console.log(col(`    ${pad(l.status, 8)} ${pad(String(l.odds), 6, true)}  ${pad(String(l.match || '').slice(0, 34), 35)} ${pad(String(l.pick).slice(0, 20), 21)} ${pad(String(l.result || ''), 8)} ${c.dim(String(l.outcomeSummary || '').slice(0, 42))}`));
    }

    if (res.dayVerdict) {
      console.log('');
      console.log(day.status === 'won' ? c.green(c.bold(`  ${res.dayVerdict.headline}`)) : c.red(c.bold(`  ${res.dayVerdict.headline}`)));
      for (const line of wrap(res.dayVerdict.body || '', 98)) console.log(c.dim(`  ${line}`));
      if (res.dayVerdict.nextTarget != null) console.log(c.dim(`  next day stakes ${money(res.dayVerdict.nextTarget, cur)}`));
    }

    if (res.verdict) {
      verdictBlock(res.verdict, run.status);
      const rec = res.verdict.recovery;
      if (rec) console.log(c.dim(`  restart with: rollover restart --run ${run.id} --days ${rec.recommendedDays ?? run.config.days} --odds ${rec.recommendedOdds ?? run.config.targetOdds} --stake ${rec.recommendedStake ?? run.config.stake}\n`));
    } else {
      console.log('');
    }
  },

  async skip() {
    const run = await pickRun();
    if (!run) return commands.help();
    const n = num('day', run.currentDay ?? 1);
    const res = skipDay(run, n);
    await saveRun(run);
    const day = res?.day ?? run.days.find((d) => d.day === n);
    console.log(c.gold(`\n  day ${n} (${day?.date ?? '?'}) skipped — run extended to ${run.config.days} days`));
    console.log(c.dim(`  balance unchanged at ${money(run.balance, run.config.currency)}`));
    console.log(c.dim(`  a skipped day costs you a day of compounding, which is the point: the run survives.\n`));
  },

  async restart() {
    const run = await pickRun();
    if (!run) return commands.help();
    const next = restartRun(run, {
      days: has('days') ? num('days', run.config.days) : undefined,
      targetOdds: has('odds') ? num('odds', run.config.targetOdds) : undefined,
      baseStake: has('stake') ? num('stake', run.config.stake) : undefined,
      reservePct: has('reserve') ? num('reserve', 0) : undefined,
    });
    await saveRun(next);
    console.log(c.cyan(`\n  restarted as ${next.id} — lineage ${next.lineage?.length ?? 0} previous run(s)`));
    console.log(c.dim(`  ${money(next.config.stake, next.config.currency)} over ${next.config.days} days at ${next.config.targetOdds}, starting ${next.days[0].date}\n`));
  },

  async show() {
    const run = await pickRun();
    if (!run) { console.log(c.dim('\n  nothing in the store yet — try: rollover create\n')); return; }
    showRun(run);
  },

  async runs() {
    const all = await listRuns();
    if (!all.length) { console.log(c.dim('\n  no runs yet — try: rollover create --stake 500\n')); return; }
    console.log(c.dim(`\n  ${all.length} run(s) in the store\n`));
    for (const r of all) {
      const col = r.status === RUN_STATUS.COMPLETE ? c.green : r.status === RUN_STATUS.LOST ? c.red : c.cyan;
      const mult = r.stake > 0 && r.balance > 0 ? (r.balance / r.stake) : 0;
      console.log(
        `  ${col(pad(r.status.toUpperCase(), 10))} ${pad(r.id, 24)} ` +
        pad(`${money(r.stake, r.currency)} ${r.days}d @${r.targetOdds}`, 24) +
        pad(`won ${r.daysWon}/${r.days}`, 10) +
        pad(`day ${r.currentDay ?? '—'}`, 8) +
        pad(`balance ${money(r.balance, r.currency)}`, 26, true) +
        (mult > 1 ? c.green(`  ×${mult.toFixed(1)}`) : '') +
        c.dim(`  ${new Date(r.createdAt).toISOString().slice(0, 16).replace('T', ' ')}`),
      );
      if (r.headline) console.log(c.dim(`             ${r.headline}`));
    }
    console.log('');
  },

  async calendar() {
    const settings = await getSettings();
    const tz = str('tz', settings.timezone || 'Africa/Lagos');
    const from = str('from', null);
    let run = await getActiveRun();
    if (!run) {
      const all = await listRuns();
      if (all.length) run = await getRun(all[0].id);
    }
    const sug = suggestNextRun(run, { now: from ? new Date(`${from}T09:00:00Z`) : undefined });
    console.log(c.dim(`\n  ${sug.timezone || tz} — when to start the next rollover\n`));
    for (const d of sug.calendar || []) {
      const bar = '█'.repeat(Math.round((d.score ?? 0) * 24)).padEnd(24, '·');
      const line =
        `  ${(d.recommended ? c.green('▸ ') : '  ') + pad(`${d.weekday} ${d.dayKey}`, 18)} ${bar} ` +
        pad(String(Math.round((d.score ?? 0) * 100)), 4, true) + '/100  ' +
        pad(d.label, 11) +
        pad(String(d.events), 4, true) + ' fx  ' +
        pad(String(d.markets), 5, true) + ' mkts  ' +
        String(d.sports) + ' sports';
      console.log(d.recommended ? line : c.dim(line));
    }
    if (sug.startDayLabel || sug.startDay) {
      console.log('');
      console.log(c.cyan(`  recommendation: ${sug.startDayLabel || sug.startDay}`));
      if (sug.reason) for (const l of wrap(sug.reason, 98)) console.log(c.dim(`  ${l}`));
      const e = sug.expectation;
      if (e) {
        console.log('');
        console.log(`  ${money(e.stake, sug.currency || 'NGN')} over ${e.days} days at ${e.odds} → ${money(e.payoutIfComplete, sug.currency || 'NGN')} (${e.multiple}×)`);
        console.log(c.dim(`  ${pct(e.dailyWinProbPct)} a day (${e.dailyProbSource}) → ${pct(e.modelledRunWinPct)} of finishing · 1 in ${e.oneIn}`));
      }
    } else if (sug.note) {
      console.log(c.dim(`\n  ${sug.note}`));
    }
    console.log('');
  },

  async lab() {
    const iterations = num('iters', 500);
    const strategies = String(str('strategies', 'engine,naive,favourites')).split(',');
    console.log(c.dim(`\n  running ${iterations.toLocaleString()} rollovers × ${strategies.length} strategies…\n`));
    const res = runSimulation({
      iterations,
      days: num('days', 7),
      targetOdds: num('odds', 2.0),
      stake: num('stake', 500),
      tolerance: num('tol', 0.1),
      mode: str('mode', 'balanced'),
      eventsPerDay: num('events', 42),
      marketInefficiency: num('inefficiency', 1.3),
      marketVariants: num('variants', 3),
      seed: num('seed', 4242),
      strategies,
    });
    const cur = res.config.currency;
    console.log(c.bold(`  ${iterations.toLocaleString()} runs · ${res.elapsedMs ?? '?'}ms · settled against ground truth\n`));
    console.log(c.dim('  strategy      completed   daily win   avg legs   edge/leg   TRUE EV/leg      run EV    median final'));
    for (const [k, s] of Object.entries(res.strategies)) {
      const col = k === 'engine' ? c.green : c.dim;
      console.log(col(
        `  ${pad(k, 13)} ${pad(pct(s.completionRatePct), 9, true)} ${pad(pct(s.avgDailyWinRatePct), 11, true)} ` +
        `${pad(String(s.avgLegsPerSlip), 10, true)} ${pad(signed(s.avgEdgePerLegPct, 2, 'pp'), 10, true)} ` +
        `${pad(signed(s.avgTrueEvPerLegPct, 2, '%'), 13, true)} ${pad(signed(s.evPct, 1, '%'), 11, true)} ${pad(money(s.medianFinalBalance, cur), 15, true)}`,
      ));
    }
    console.log('');
    console.log(c.dim('  where the run dies — share of ALL runs, not just the ones that failed'));
    for (const [k, s] of Object.entries(res.strategies)) {
      const hist = Object.entries(s.deathDayPct || {}).map(([d, v]) => `D${d} ${v}%`).join('  ');
      console.log(c.dim(`  ${pad(s.label || k, 13)} ${hist}   modal day ${s.modalDeathDay || '—'}`));
    }
    console.log('');
    console.log('');
    for (const [k, cal] of Object.entries(res.calibration)) {
      console.log(c.dim(`  calibration ${pad(k, 11)} claimed ${pct(cal.modelled * 100)}  realised ${pct(cal.realised * 100)}  gap ${signed(cal.gap * 100, 2, 'pp')}  → ${cal.verdict}`));
    }
    console.log('');
    const e = res.strategies.engine;
    const n = res.strategies.naive;
    if (e && n) {
      console.log(c.gold(`  LIFT over picking at random: ${signed(e.avgDailyWinRatePct - n.avgDailyWinRatePct, 2, 'pp')} per day · ${signed(e.evPct - n.evPct, 1, 'pp')} run EV · ${signed(e.avgTrueEvPerLegPct - n.avgTrueEvPerLegPct, 2, 'pp')} true EV per leg`));
    }
    console.log('');
    wrap(res.headline?.honestRead || '', 98).forEach((l, i) => console.log(i === 0 ? c.gold('  ' + l) : c.dim('  ' + l)));
    console.log('');
  },

  async project() {
    const stake = num('stake', 500);
    const p = projectRun({
      stake,
      days: num('days', 7),
      targetOdds: num('odds', 2.0),
      measuredDailyWinProb: has('daily') ? num('daily', 0) / 100 : null,
      currency: str('currency', 'NGN'),
    });
    const cur = p.currency;
    console.log(c.dim('\n  closed-form projection — no simulation\n'));
    console.log(`  stake        ${money(stake, cur)}`);
    console.log(`  days         ${p.days} at ${p.targetOdds} → ${p.multiple}× → ${money(p.payoutIfComplete, cur)}`);
    console.log(`  daily win    ${pct(p.dailyWinProbPct)}  ${c.dim(p.dailySource)}`);
    console.log(`  run win      ${pct(p.runWinProbPct, 3)}  ·  1 in ${p.oneIn}  ·  fair odds for the run ${p.fairOddsForTheRun}`);
    console.log(`  EV           ${signed(p.evPct)}%  ${p.evPct >= 0 ? c.green('+EV') : c.red('−EV')}  ${c.dim(`expected final ${money(p.expectedFinalBalance, cur)} on ${money(p.stake, cur)} staked`)}`);
    console.log(c.dim(`  ladder       ${p.ladder.map((x) => money(x.balance, cur)).join(' → ')}`));
    console.log('');
    wrap(p.verdict, 98).forEach((l) => console.log(c.gold('  ' + l)));
    console.log(c.dim('\n  Tip: run `rollover lab --iters 500` first and pass the engine\'s measured daily win rate\n  to --daily. Without it this assumes the book is fair and you are only buying variance.\n'));
  },

  async delete() {
    const id = str('run', null);
    if (!id) { console.log(c.red('\n  --run ID is required\n')); return; }
    await deleteRun(id);
    console.log(c.dim(`\n  deleted ${id}\n`));
  },
};

try {
  await (commands[cmd] || commands.help)();
} catch (err) {
  console.error(c.red(`\n  ${err.message}\n`));
  if (process.env.ROLLOVER_DEBUG) console.error(err.stack);
  process.exitCode = 1;
}
