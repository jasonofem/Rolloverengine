/**
 * RolloverEngine — dashboard
 * Vanilla ES modules, no build step, no CDN. Talks to the Node API.
 */

/* ══════════════════════════ state & helpers ══════════════════════════ */

const S = {
  settings: null,
  providers: {},
  state: null,
  run: null,
  projection: null,
  tab: 'dashboard',
  market: null,
  lab: null,
  selectedAlt: 0,
  storageNote: null, // where your runs actually live — see chooseTransport()
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const SYMBOLS = { NGN: '₦', USD: '$', GBP: '£', EUR: '€', GHS: '₵', KES: 'KSh', ZAR: 'R' };
const cur = () => SYMBOLS[S.settings?.currency] || '₦';
const money = (n, c = cur()) =>
  `${c}${Number(n ?? 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const money0 = (n, c = cur()) => `${c}${Math.round(Number(n ?? 0)).toLocaleString('en-NG')}`;
const pct = (n, dp = 1) => `${Number(n ?? 0).toFixed(dp)}%`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const SPORT_LABEL = { football: 'Football', basketball: 'Basketball', baseball: 'Baseball', tennis: 'Tennis', mma: 'MMA' };

/* ------------------------------------------------------------------ *
 * Transport
 *
 * Normally this is a plain fetch to the Node server. But if the dashboard is
 * served from somewhere with no writable disk — a Vercel deployment, where a
 * serverless function's /tmp is discarded between invocations — then a run
 * created in one request would be gone by the next, and a rollover is a
 * seven-day object. Rather than silently lose your pot, the server says
 * `persistent: false` and we load the engine bundle and run it right here in
 * the tab, saving to localStorage. Same engine, same numbers, same route table;
 * only the transport changes, and only once, at boot.
 * ------------------------------------------------------------------ */

let transport = null; // null → use the network; otherwise a local fetch()

async function api(path, opts = {}) {
  const res = transport
    ? await transport(path, opts)
    : await fetch(path, {
        method: opts.method || 'GET',
        headers: { 'content-type': 'application/json' },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

/**
 * Decide where state lives. Returns a short human description for the badge.
 * Never throws — if detection fails we stay on the network and let boot()
 * report the real error.
 */
async function chooseTransport() {
  try {
    const res = await fetch('/api/state', { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const st = await res.json();
    if (st?.runtime?.persistent !== false) return null; // a real server: keep using it

    const mod = await import('./local-api.js');
    transport = mod.localFetch;

    const info = mod.storageInfo();
    if (info.backend !== 'localStorage') {
      return {
        local: true,
        degraded: true,
        label: 'this tab only',
        note: 'Your browser is blocking local storage (private window, or storage disabled), so the engine is running in memory. Everything works, but nothing survives a reload — settle your run before you close the tab.',
      };
    }
    return {
      local: true,
      degraded: false,
      label: 'running locally',
      note: `This deployment has no writable disk — a serverless function's scratch space is thrown away between requests, and a rollover is a seven-day object. So the engine runs here in your browser and saves each run to ${info.key}. Same code and same numbers as the server build; the state just lives on your device.`,
      info: mod.storageInfo,
    };
  } catch {
    return null;
  }
}

function toast(title, msg = '', kind = 'ok', ms = 4600) {
  const el = document.createElement('div');
  el.className = `toast ${kind === 'err' ? 'err' : kind === 'warn' ? 'warn' : ''}`;
  el.innerHTML = `<b>${esc(title)}</b>${msg ? `<span>${esc(msg)}</span>` : ''}`;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .35s, transform .35s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(20px)';
    setTimeout(() => el.remove(), 380);
  }, ms);
}

/* ══════════════════════════ boot ══════════════════════════ */

/**
 * Tell the user where their runs live. On a normal server this is boring and
 * stays hidden; on a diskless deployment it is the difference between trusting
 * the dashboard and losing a seven-day run to a cold lambda.
 */
function renderStorageBadge(runtime) {
  const el = $('#storage-badge');
  if (!el) return;
  const s = S.storageNote;
  if (!s || !s.local || runtime?.persistent !== false) {
    el.hidden = true;
    return;
  }

  // Re-read live: eviction happens as the tab goes on.
  const info = s.info ? s.info() : null;
  const evicted = info?.evictions?.length || 0;
  const kb = info ? Math.round(info.bytes / 1024) : 0;

  el.hidden = false;
  el.className = 'storage-badge local' + (s.degraded ? ' degraded' : '');
  el.textContent = s.degraded ? '⚠ this tab only' : `⚡ ${s.label}`;

  const parts = [s.note];
  if (kb) parts.push(`Currently holding ${kb} KB of run history in your browser.`);
  if (evicted) {
    parts.push(`Storage filled up, so ${evicted} finished run${evicted === 1 ? '' : 's'} were released to make room — the oldest first, and never the run you have open. Nothing you are playing is at risk.`);
  }
  if (info?.quotaExhausted) {
    parts.push('Storage is now full and there was nothing left to release, so new results are being kept in memory only. Export or delete old runs to get persistence back.');
  }
  el.title = parts.join('\n\n');
}

async function boot() {
  try {
    S.storageNote = await chooseTransport();
    const st = await api('/api/state');
    S.state = st;
    S.settings = st.settings;
    S.providers = st.providers;
    S.run = st.activeRun;
    S.projection = st.activeProjection;
    $('#engine-version').textContent = `v${st.engine.version}`;
    renderStorageBadge(st.runtime);
    applySettingsToForms();
    startClock();
    renderAll();
  } catch (err) {
    toast('Could not reach the engine', err.message, 'err', 9000);
  }
}

function startClock() {
  const tick = () => {
    const tz = S.settings?.tz || 'UTC';
    const now = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(new Date());
    $('#clock').textContent = `${now} · ${tz.split('/')[1]?.replace('_', ' ') || tz}`;
  };
  tick();
  setInterval(tick, 1000);
}

function applySettingsToForms() {
  const s = S.settings;
  $('#f-stake').value = s.stake;
  $('#f-currency').value = s.currency;
  $('#f-days').value = s.days;
  $('#f-odds').value = s.targetOdds;
  $('#f-tol').value = s.tolerance;
  $('#f-mode').value = s.mode;
  $('#f-reserve').value = s.reservePct;
  $('#f-reserve-val').textContent = `${s.reservePct}%`;
  $('#f-provider').value = s.provider;
  $('#cur-symbol').textContent = SYMBOLS[s.currency] || '';
  $('#s-tz').value = s.tz;
  $('#s-events').value = s.eventsPerDay;
  $('#s-ineff').value = s.marketInefficiency;
  $('#s-ineff-val').textContent = `${s.marketInefficiency}×`;
  $('#s-edge').value = (s.minEdgePerLeg * 100).toFixed(1);
  $('#s-edge-val').textContent = `${(s.minEdgePerLeg * 100).toFixed(1)}%`;
  $('#s-maxlegs').value = s.maxLegs;
  $('#s-apikey').value = s.oddsApi?.key || '';
  const today = new Date().toISOString().slice(0, 10);
  $('#f-startday').value = today;
  $('#f-startday').min = today;
  $('#market-date').value = today;
  $('#lab-days').value = s.days;
  $('#lab-odds').value = s.targetOdds;
  $('#lab-ineff').value = s.marketInefficiency;
  $('#lab-ineff-val').textContent = `${s.marketInefficiency}×`;
  $('#lab-mode').value = s.mode;
}

function renderAll() {
  renderDashboard();
  renderSlip();
  renderTabs();
  renderRuns();
}

async function refreshRun(runId) {
  const { run, projection } = await api(`/api/runs/${runId}`);
  S.run = run;
  S.projection = projection;
  renderAll();
}

/* ══════════════════════════ tabs ══════════════════════════ */

function renderTabs() {
  const day = S.run?.days?.find((d) => d.day === S.run.currentDay);
  const actionable = S.run && day && ['pending', 'ready'].includes(day.status) && day.slip;
  $('#tab-slip-dot').hidden = !actionable;
}

$$('#tabs .tab').forEach((t) =>
  t.addEventListener('click', () => {
    S.tab = t.dataset.tab;
    $$('#tabs .tab').forEach((x) => x.classList.toggle('is-active', x === t));
    $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${S.tab}`));
    if (S.tab === 'market' && !S.market) loadMarket();
    if (S.tab === 'market') loadCalendar();
  })
);

/* ══════════════════════════ dashboard ══════════════════════════ */

function renderDashboard() {
  renderVerdict();
  renderHero();
  renderStepper();
  renderStats();
  renderChart();
  renderProjection();
}

function renderHero() {
  const r = S.run;
  if (!r) {
    $('#hero-balance').textContent = money(0);
    $('#hero-sub').textContent = 'No run in progress. Set your stake, your daily odds target and how many days you want to roll.';
    $('#hero-target').textContent = money(0);
    $('#hero-mult').textContent = '—';
    $('#hero-day-chip').textContent = 'no run';
    $('#hero-day-chip').className = 'chip chip-dim';
    $('#hero-bar').style.width = '0%';
    $('#btn-goto-slip').hidden = true;
    return;
  }
  const cfg = r.config;
  const target = r.projection?.final ?? cfg.stake * cfg.targetOdds ** cfg.days;
  $('#hero-balance').textContent = money(r.balance);
  $('#hero-target').textContent = money0(target);
  $('#hero-mult').textContent = `${r.projection?.multiple ?? '—'}× · ${r.stats.won}/${cfg.days} days landed`;
  const chip = $('#hero-day-chip');
  chip.textContent = r.status === 'complete' ? 'complete' : r.status === 'lost' ? 'run ended' : `day ${r.currentDay} of ${cfg.days}`;
  chip.className = `chip ${r.status === 'complete' ? 'chip-green' : r.status === 'lost' ? 'chip-red' : 'chip-gold'}`;

  const progress = r.status === 'complete' ? 100 : r.status === 'lost' ? ((r.currentDay - 1) / cfg.days) * 100 : ((r.currentDay - 1) / cfg.days) * 100;
  $('#hero-bar').style.width = `${Math.max(2, Math.min(100, progress))}%`;

  const day = r.days.find((d) => d.day === r.currentDay);
  $('#hero-sub').textContent =
    r.status === 'active' && day?.slip
      ? `Day ${day.day} · ${money(day.slip.stake)} staked at ${day.slip.odds.toFixed(2)} → ${money(day.slip.potentialReturn)} if it lands. Modelled ${pct(day.slip.winProbPct)} chance.`
      : r.status === 'active'
        ? `Day ${r.currentDay} is waiting for a scan.`
        : r.status === 'complete'
          ? `Every day landed. ${money(r.balance - r.startBalance)} profit banked.`
          : `The run ended on day ${r.currentDay}. ${money(r.balance)} left in hand.`;

  $('#btn-goto-slip').hidden = r.status !== 'active';
  $('#btn-new-run').textContent = r.status === 'active' ? 'Abandon & start over' : 'New rollover';
}

function renderStepper() {
  const r = S.run;
  const host = $('#stepper');
  if (!r) {
    host.innerHTML = `<div class="dim" style="padding:8px 2px;font-size:13px">Start a rollover to see the day-by-day ladder.</div>`;
    $('#stepper-days-label').textContent = S.settings?.days ?? 7;
    $('#stepper-note').textContent = '—';
    return;
  }
  $('#stepper-days-label').textContent = r.config.days;
  $('#stepper-note').textContent = `${r.stats.won} won · ${r.stats.lost} lost · ${r.stats.skipped} skipped`;

  host.innerHTML = r.dayCards
    .map((d) => {
      const cls = d.isCurrent ? 'is-current' : d.status === 'won' ? 'is-won' : d.status === 'lost' ? 'is-lost' : d.status === 'pending' ? 'is-projected' : '';
      const icon = { won: '✓', lost: '✕', open: '●', ready: '◎', pending: '·', skipped: '↷' }[d.status] || '·';
      const prob = d.winProbPct ? `<div class="step-prob ${d.winProbPct >= 55 ? 'pos' : d.winProbPct >= 45 ? 'gold' : 'neg'}">${pct(d.winProbPct, 1)}</div>` : '';
      const bar = d.winProbPct ? `<div class="step-bar"><i style="width:${Math.min(100, d.winProbPct)}%"></i></div>` : '';
      return `<div class="step ${cls}">
        <div class="step-head"><span class="step-n">DAY ${d.day}</span><span class="step-icon">${icon}</span></div>
        <div class="step-amt">${d.stake != null ? money0(d.stake) : '—'}</div>
        <div class="step-meta">@ ${(d.odds ?? r.config.targetOdds).toFixed(2)}${d.legs ? ` · ${d.legs} leg${d.legs === 1 ? '' : 's'}` : ''}</div>
        ${prob}${bar}
      </div>`;
    })
    .join('');
}

function renderStats() {
  const host = $('#stat-grid');
  const r = S.run;
  if (!r) {
    host.innerHTML = '';
    return;
  }
  const p = r.progress;
  const day = r.days.find((d) => d.day === r.currentDay);
  const slip = day?.slip;
  const cards = [
    { label: 'Chance to finish', value: pct(p.chanceToFinishPct, 1), sub: 'product of remaining days', cls: p.chanceToFinishPct >= 8 ? 'stat-green' : 'stat-gold' },
    { label: 'Profit to date', value: money(p.profitToDate), sub: `peak ${money0(p.peak)}`, cls: p.profitToDate >= 0 ? 'stat-green' : 'stat-red' },
    { label: "Today's slip", value: slip ? `${slip.legCount} leg${slip.legCount === 1 ? '' : 's'}` : '—', sub: slip ? `grade ${slip.grade} · ${slip.sports.length} sport${slip.sports.length === 1 ? '' : 's'}` : 'nothing scanned', cls: 'stat-blue' },
    { label: 'Slip win probability', value: slip ? pct(slip.winProbPct, 1) : '—', sub: slip ? `fair odds ${slip.fairOdds?.toFixed(2) ?? '—'} vs ${slip.odds.toFixed(2)} taken` : '', cls: slip && slip.winProbPct > 100 / slip.odds ? 'stat-green' : 'stat-gold' },
    { label: 'Expected value', value: slip ? `${slip.evPct >= 0 ? '+' : ''}${pct(slip.evPct, 1)}` : '—', sub: 'per unit staked on this slip', cls: slip && slip.evPct > 0 ? 'stat-green' : 'stat-red' },
    { label: 'Total edge collected', value: slip ? `+${(slip.edgeSum * 100).toFixed(1)}pp` : '—', sub: 'sum of per-leg edge', cls: 'stat-green' },
    { label: 'Days landed', value: `${r.stats.won}/${r.config.days}`, sub: `${r.stats.lost} lost · ${r.stats.skipped} skipped`, cls: 'stat-blue' },
    { label: 'If it all lands', value: money0(r.projection?.final), sub: `${r.projection?.multiple}× your stake`, cls: 'stat-gold' },
  ];
  host.innerHTML = cards
    .map((c) => `<div class="stat ${c.cls}"><div class="stat-label">${c.label}</div><div class="stat-value">${c.value}</div><div class="stat-sub">${esc(c.sub)}</div></div>`)
    .join('');
}

function renderChart() {
  const svg = $('#equity-chart');
  const r = S.run;
  if (!r || !r.equityCurve?.length) {
    svg.innerHTML = `<text x="310" y="112" text-anchor="middle" class="axis-label" style="font-size:12px">No run yet — the equity curve plots realised balance against the projected ladder.</text>`;
    $('#curve-note').textContent = '—';
    return;
  }
  const pts = r.equityCurve;
  const W = 620, H = 220, PAD_L = 54, PAD_R = 14, PAD_T = 16, PAD_B = 26;
  const maxY = Math.max(...pts.map((p) => p.balance)) * 1.12;
  const x = (i) => PAD_L + (i / Math.max(1, pts.length - 1)) * (W - PAD_L - PAD_R);
  const y = (v) => H - PAD_B - (v / maxY) * (H - PAD_T - PAD_B);

  const gridLines = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const v = maxY * f;
      return `<line class="grid-line" x1="${PAD_L}" x2="${W - PAD_R}" y1="${y(v)}" y2="${y(v)}" />
              <text class="axis-label" x="${PAD_L - 8}" y="${y(v) + 3.5}" text-anchor="end">${shortMoney(v)}</text>`;
    })
    .join('');

  const realPts = pts.filter((p) => !p.projected);
  const projPts = pts.slice(realPts.length ? realPts.length - 1 : 0);
  const path = (arr) => arr.map((p, i) => `${i ? 'L' : 'M'}${x(pts.indexOf(p)).toFixed(1)},${y(p.balance).toFixed(1)}`).join(' ');
  const areaPath = realPts.length > 1 ? `${path(realPts)} L${x(pts.indexOf(realPts[realPts.length - 1]))},${y(0)} L${x(pts.indexOf(realPts[0]))},${y(0)} Z` : '';

  const dots = pts
    .map((p, i) => {
      const col = p.status === 'won' ? 'var(--green)' : p.status === 'lost' ? 'var(--red)' : p.projected ? 'rgba(255,200,87,.5)' : 'var(--blue)';
      const rad = p.status === 'won' || p.status === 'lost' ? 4.6 : 3;
      return `<circle cx="${x(i)}" cy="${y(p.balance)}" r="${rad}" fill="${col}" stroke="#07100d" stroke-width="1.6"><title>${esc(p.label)} — ${money(p.balance)}${p.projected ? ' (projected)' : ''}</title></circle>`;
    })
    .join('');

  const labels = pts
    .map((p, i) => (i % Math.ceil(pts.length / 8) === 0 || i === pts.length - 1 ? `<text class="axis-label" x="${x(i)}" y="${H - 8}" text-anchor="middle">${p.day === 0 ? 'start' : 'D' + p.day}</text>` : ''))
    .join('');

  svg.innerHTML = `
    <defs>
      <linearGradient id="fillReal" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgba(61,220,151,.28)" /><stop offset="100%" stop-color="rgba(61,220,151,0)" />
      </linearGradient>
    </defs>
    ${gridLines}
    ${areaPath ? `<path d="${areaPath}" fill="url(#fillReal)" />` : ''}
    ${projPts.length > 1 ? `<path d="${path(projPts)}" fill="none" stroke="var(--gold)" stroke-width="2" stroke-dasharray="5 4" opacity=".62" />` : ''}
    ${realPts.length > 1 ? `<path d="${path(realPts)}" fill="none" stroke="var(--green)" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round" />` : ''}
    ${dots}${labels}`;

  const realised = r.balance;
  $('#curve-note').textContent = `now ${money0(realised)} · projected ${money0(r.projection?.final)}`;
}

function shortMoney(v) {
  const c = cur();
  if (v >= 1e9) return `${c}${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${c}${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${c}${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k`;
  return `${c}${Math.round(v)}`;
}

function renderProjection() {
  const host = $('#proj-grid');
  const p = S.projection;
  const r = S.run;
  if (!p || !r) {
    host.innerHTML = `<div class="dim" style="font-size:13px">Start a run to see the arithmetic.</div>`;
    $('#proj-note').textContent = '';
    return;
  }
  const cfg = r.config;
  const rows = [
    ['Daily target odds', cfg.targetOdds.toFixed(2)],
    ['Days to roll', cfg.days],
    ['Modelled win chance per day', pct(p.dailyWinProbPct, 1)],
    ['Chance the whole run lands', pct(p.runWinProbPct, 2)],
    ['That is roughly 1 in', p.oneIn.toLocaleString()],
    ['Payout if every day lands', money0(p.payoutIfComplete)],
    ['Growth multiple', `${p.multiple}×`],
    ['Expected final balance', money0(p.expectedFinalBalance)],
    ['EV per ₦1 committed', `${p.evPct >= 0 ? '+' : ''}${pct(p.evPct, 1)}`],
    ['Fair odds for the whole run', `${p.fairOddsForTheRun.toLocaleString()}/1`],
  ];
  host.innerHTML = rows
    .map(([k, v], i) => `<div class="vnum"><div class="vnum-l">${k}</div><div class="vnum-v" style="font-size:${i === 3 ? 22 : 17}px;${i === 3 ? 'color:var(--gold)' : ''}">${v}</div></div>`)
    .join('');
  $('#proj-note').textContent =
    `A ${cfg.days}-day rollover at ${cfg.targetOdds.toFixed(2)} is a ${p.oneIn.toLocaleString()}-to-1 shot even when every leg carries edge. ` +
    `The edge does not make it likely — it makes the expected value positive, which is a different and much weaker promise. ` +
    `Stake accordingly: the median outcome of this bet is ${money0(0)}.`;
}

/* ══════════════════════════ verdict banner ══════════════════════════ */

function renderVerdict() {
  const host = $('#verdict-slot');
  const r = S.run;
  if (!r) {
    host.innerHTML = '';
    return;
  }
  // Terminal verdicts (complete / lost / abandoned) take the big banner.
  // A mid-run win only gets the slim day banner.
  const v = r.status === 'active' ? r.lastDayMessage : r.verdict;
  if (!v) {
    host.innerHTML = '';
    return;
  }
  host.innerHTML = verdictHTML(v, r);
  wireVerdictButtons(r);
  if (r.status === 'complete' && !host.dataset.celebrated) {
    host.dataset.celebrated = '1';
    celebrate();
  }
}

function verdictHTML(v, r) {
  if (v.kind === 'complete') {
    const n = v.numbers;
    return `<div class="verdict verdict-win">
      <h1>${esc(v.headline)}</h1>
      <div class="verdict-sub">${esc(v.subheadline)}</div>
      <div class="verdict-body">${esc(v.body)}</div>
      <div class="verdict-nums">
        ${vnum('Started with', money0(n.startBalance))}
        ${vnum('Finished with', money0(n.finalBalance), 'var(--green)')}
        ${vnum('Profit', `+${money0(n.profit)}`, 'var(--green)')}
        ${vnum('Multiple', `${n.multiple}×`)}
        ${vnum('Days landed', `${n.daysWon}/${n.days}`)}
        ${vnum('Avg legs per slip', n.avgLegs)}
        ${vnum('Avg daily win prob', pct(n.avgDailyWinProbPct))}
        ${vnum('Run was a 1-in', n.runWinProbPct > 0 ? Math.round(100 / n.runWinProbPct).toLocaleString() : '—', 'var(--gold)')}
      </div>
      <div class="verdict-actions">
        <button class="btn btn-primary btn-lg" data-act="restart">Go again →</button>
        <button class="btn btn-ghost" data-act="new">Custom rollover</button>
      </div>
      ${nextRunHTML(v.nextRun)}
      <ul class="verdict-list" style="margin-top:16px">${v.discipline.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>
    </div>`;
  }

  if (v.kind === 'lost') {
    const n = v.numbers;
    const rec = v.recovery;
    return `<div class="verdict verdict-lose">
      <h1>${esc(v.headline)}</h1>
      <div class="verdict-sub">${esc(v.subheadline)}</div>
      <div class="verdict-body">${esc(v.body)}</div>
      <div class="verdict-nums">
        ${vnum('Died on day', `${n.day}`)}
        ${vnum('Stake lost', money0(n.stakeLost), 'var(--red)')}
        ${vnum('Left in hand', money0(n.remainingBalance))}
        ${vnum('Reserve saved', n.reserveSaved > 0 ? money0(n.reserveSaved) : '—', n.reserveSaved > 0 ? 'var(--green)' : null)}
        ${vnum('Days landed first', `${n.daysCompleted}`)}
        ${vnum('Slip was modelled at', pct(n.winProbPct))}
        ${vnum('Legs that hit', `${n.legsWon}/${n.legsTotal}`)}
        ${vnum('Peak balance reached', money0(n.peakBalance))}
      </div>
      ${rec ? recoveryHTML(rec, r) : ''}
      <div class="verdict-actions" style="margin-top:18px">
        <button class="btn btn-primary btn-lg" data-act="restart" data-rec="1">Go again with the recommended settings</button>
        <button class="btn btn-ghost" data-act="restart">Same settings</button>
        <button class="btn btn-ghost" data-act="new">Custom rollover</button>
      </div>
      ${nextRunHTML(v.nextRun)}
      <ul class="verdict-list" style="margin-top:16px">${v.discipline.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>
    </div>`;
  }

  if (v.kind === 'day-won') {
    return `<div class="verdict verdict-day">
      <h1>${esc(v.headline)}</h1>
      <div class="verdict-body">${esc(v.body)} ${v.nextTarget ? `Next target: <b class="gold">${money0(v.nextTarget)}</b>.</div>` : ''}</div>
      ${v.next ? `<div class="dim" style="font-size:12.5px">Day ${v.next.day} · ${esc(v.next.date)} · staking ${money0(v.next.stake)}</div>` : ''}
      <div class="verdict-actions" style="margin-top:13px"><button class="btn btn-primary" data-act="goto-slip">Open day ${v.next?.day ?? ''} slip →</button></div>
    </div>`;
  }

  return `<div class="verdict verdict-day"><h1>${esc(v.headline || 'Run')}</h1><div class="verdict-body">${esc(v.body || '')}</div></div>`;
}

function vnum(label, value, color) {
  return `<div class="vnum"><div class="vnum-l">${label}</div><div class="vnum-v" ${color ? `style="color:${color}"` : ''}>${value}</div></div>`;
}

function recoveryHTML(rec, r) {
  const opts = rec.options
    .map((o) => {
      const isRec = o.id === rec.recommendedId;
      return `<div class="alt ${isRec ? 'is-selected' : ''}" data-recovery="${o.id}">
        <div class="alt-head">
          <span style="font-size:13px;font-weight:620">${esc(o.title)}</span>
          ${isRec ? '<span class="chip chip-green">recommended</span>' : ''}
        </div>
        <div class="alt-legs">${esc(o.detail)}</div>
        <div class="leg-stats" style="border-top:1px dashed var(--line);margin-top:9px;padding-top:9px">
          <span class="leg-stat">run win <b>${o.runWinPct}%</b></span>
          <span class="leg-stat">payout <b>${money0(o.payout)}</b></span>
          <span class="leg-stat">stake <b>${money0(o.stake)}</b></span>
        </div>
      </div>`;
    })
    .join('');
  return `<div class="section-title" style="margin-top:20px">Recovery options — pick your line</div>
    <div class="alts">${opts}</div>
    <div class="lab-headline" style="margin-top:13px">
      <b>Diagnosis.</b> ${rec.diagnosis.map(esc).join(' ')}<br />
      <b>Reality check.</b> Your slips averaged ${rec.realityCheck.avgDailyWinProbPct}% per day at ${rec.realityCheck.avgLegsPerSlip} legs.
      At that rate you should expect to complete roughly <b>1 run in ${rec.realityCheck.runsExpectedPerWin.toLocaleString()}</b>.
    </div>`;
}

function nextRunHTML(next) {
  if (!next) return '';
  const cal = (next.calendar || [])
    .map((c) => `<div class="cal-row ${c.recommended ? 'is-best' : ''}">
        <span class="cal-day">${esc(c.weekday.slice(0, 3))}</span>
        <span class="cal-date">${esc(c.dayKey.slice(5))}</span>
        <span class="cal-bar"><i style="width:${(c.score * 100).toFixed(0)}%"></i></span>
        <span class="cal-score">${(c.score * 100).toFixed(0)}</span>
        <span class="cal-score" style="min-width:56px">${c.events} fx</span>
      </div>`)
    .join('');
  return `<div class="next-run">
    <h3>⟳ Next rollover — suggested start</h3>
    <div class="next-run-when">${esc(next.startDayLabel)}</div>
    <div class="leg-stats" style="border:0;padding:0;margin-top:9px">
      <span class="leg-stat">stake <b>${money0(next.recommendedStake)}</b></span>
      <span class="leg-stat">daily odds <b>${next.recommendedOdds.toFixed(2)}</b></span>
      <span class="leg-stat">payout if complete <b>${money0(next.expectation.payoutIfComplete)}</b></span>
      <span class="leg-stat">modelled <b>${pct(next.expectation.modelledRunWinPct, 2)}</b> · 1-in-${next.expectation.oneIn.toLocaleString()}</span>
    </div>
    <div class="next-run-why">${esc(next.reason)}</div>
    ${next.oddsNotes?.length ? `<ul class="verdict-list" style="margin-top:9px">${next.oddsNotes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    ${next.stakeNotes?.length ? `<ul class="verdict-list" style="margin-top:6px">${next.stakeNotes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    <details style="margin-top:11px"><summary class="dim" style="cursor:pointer;font-size:12.5px">Why this day? — 8-day window</summary>
      <div class="calendar" style="margin-top:9px">${cal}</div>
    </details>
  </div>`;
}

function wireVerdictButtons(r) {
  $$('#verdict-slot [data-act]').forEach((b) =>
    b.addEventListener('click', async () => {
      const act = b.dataset.act;
      if (act === 'new') return openSetup();
      if (act === 'goto-slip') return switchTab('slip');
      if (act === 'restart') {
        const recEl = $('#verdict-slot .alt.is-selected');
        const recId = b.dataset.rec ? recEl?.dataset.recovery : null;
        const rec = recId ? r.verdict.recovery?.options.find((o) => o.id === recId) : null;
        b.disabled = true;
        try {
          const { run, projection } = await api(`/api/runs/${r.id}/restart`, {
            method: 'POST',
            body: rec
              ? { stake: rec.stake, targetOdds: rec.odds, days: rec.days, config: { reservePct: rec.reservePct || 0 } }
              : {},
          });
          S.run = run;
          S.projection = projection;
          renderAll();
          toast('New rollover started', `Day 1 · ${money(run.balance)} at ${run.config.targetOdds.toFixed(2)}`);
        } catch (err) {
          toast('Restart failed', err.message, 'err');
          b.disabled = false;
        }
      }
    })
  );
  $$('#verdict-slot [data-recovery]').forEach((el) =>
    el.addEventListener('click', () => {
      $$('#verdict-slot [data-recovery]').forEach((x) => x.classList.toggle('is-selected', x === el));
    })
  );
}

/* ══════════════════════════ slip view ══════════════════════════ */

function renderSlip() {
  const r = S.run;
  if (!r || r.status !== 'active') {
    $('#slip-empty').hidden = false;
    $('#slip-body').hidden = true;
    if (r && r.status !== 'active') {
      $('#slip-empty').innerHTML = `<div class="empty-icon">▣</div><h2>Run ${r.status}</h2>
        <p>${r.status === 'complete' ? 'That rollover is finished — every day landed.' : 'This run ended. Start another from the dashboard.'}</p>
        <button class="btn btn-primary" onclick="document.getElementById('btn-new-run').click()">New rollover</button>`;
    }
    return;
  }
  $('#slip-empty').hidden = true;
  $('#slip-body').hidden = false;
  const day = r.days.find((d) => d.day === r.currentDay) || r.days[r.days.length - 1];
  $('#slip-body').innerHTML = slipHTML(day, r);
  wireSlip(day, r);
}

function slipHTML(day, r) {
  const cfg = r.config;
  if (!day.slip) {
    const fail = day.scan?.failure;
    return `<div class="panel">
      <div class="panel-head"><h2>Day ${day.day} — ${esc(day.date)}</h2></div>
      <div class="empty-state" style="padding:38px 10px">
        <div class="empty-icon">⚠</div>
        <h2>${fail ? 'The engine refused to roll today' : 'Nothing scanned yet'}</h2>
        <p>${esc(fail?.message || day.message?.body || 'Scan the day to get a slip.')}</p>
        <div class="btn-row" style="justify-content:center">
          <button class="btn btn-primary" data-act="scan">Scan the market</button>
          <button class="btn btn-ghost" data-act="skip">Skip this day</button>
        </div>
      </div>${scanStatsHTML(day)}</div>`;
  }

  const s = day.slip;
  const isSettled = ['won', 'lost'].includes(day.status);
  const isOpen = day.status === 'open';
  const statusChip = { pending: ['chip-dim', 'not staked'], ready: ['chip-gold', 'ready to stake'], open: ['chip-blue', 'STAKED — awaiting result'], won: ['chip-green', 'WON'], lost: ['chip-red', 'LOST'], skipped: ['chip-dim', 'skipped'] }[day.status] || ['chip-dim', day.status];

  const legs = s.legs
    .map((l, i) => {
      const res = day.result?.resolved?.[i];
      const cls = res ? (res.status === 'WON' ? 'is-won' : 'is-lost') : '';
      const edgeCls = l.edgePct > 0 ? 'pos' : 'neg';
      return `<div class="leg ${cls}">
        <div class="leg-top">
          <div style="flex:1">
            <div class="leg-league"><span class="sport-badge sp-${esc(l.sport)}">${esc(SPORT_LABEL[l.sport] || l.sport)}</span> &nbsp;${esc(l.league)} · ${esc(new Date(l.kickoff).toISOString().slice(5, 16).replace('T', ' '))}</div>
            <div class="leg-match">${esc(l.home)} <span class="dim">v</span> ${esc(l.away)}</div>
            <div class="leg-market">${esc(l.market)}${res?.result ? ` — <b class="${res.status === 'WON' ? 'pos' : 'neg'}">${esc(res.result)}</b>` : ''}</div>
            <div class="leg-pick">▸ ${esc(l.pick)}</div>
          </div>
          <div style="text-align:right">
            <div class="leg-odds">${l.odds.toFixed(2)}</div>
            ${res ? `<div class="chip ${res.status === 'WON' ? 'chip-green' : 'chip-red'}">${res.status}</div>` : `<div class="dim mono" style="font-size:10.5px">${esc(l.book || '')}</div>`}
          </div>
        </div>
        <div class="leg-stats">
          <span class="leg-stat" title="The price you can actually get, as a probability — vig still in it">book implies <b>${pct(l.impliedProbPct)}</b></span>
          <span class="leg-stat" title="All quoting books, de-vigged and averaged">market fair <b>${pct(l.fairProbPct)}</b></span>
          <span class="leg-stat" title="The sharp books only — the most accurate estimate in the whole system">sharp says <b>${pct(l.sharpProbPct ?? l.fairProbPct)}</b></span>
          <span class="leg-stat" title="What the engine actually believes, after blending">model <b>${pct(l.modelProbPct)}</b></span>
          <span class="leg-stat">edge <b class="${edgeCls}">${l.edgePct >= 0 ? '+' : ''}${pct(l.edgePct)}</b></span>
          <span class="leg-stat">EV <b class="${l.evPct >= 0 ? 'pos' : 'neg'}">${l.evPct >= 0 ? '+' : ''}${pct(l.evPct)}</b></span>
          <span class="leg-stat" title="Data quality: how closely the books agree and how liquid the market is. NOT a measure of edge — big edges happen where books disagree, which is where the model is likeliest to be wrong."><span class="conf-bar"><i style="width:${(l.confidence * 100).toFixed(0)}%"></i></span>conf <b>${(l.confidence * 100).toFixed(0)}% (${esc(l.band)})</b></span>
        </div>
      </div>`;
    })
    .join('');

  const alts = (day.scan?.alternatives || [])
    .map((a, i) => `<button class="alt ${a.odds === s.odds && a.legCount === s.legCount ? 'is-selected' : ''}" data-alt="${i}">
        <div class="alt-head"><span class="alt-odds">${a.odds.toFixed(2)}</span><span class="alt-prob">${a.legCount} legs · ${a.winProbPct}%</span></div>
        <div class="alt-legs">${a.legs.map((l) => `${esc(l.pick)} <b class="mono">${l.odds.toFixed(2)}</b>`).join('<br />')}</div>
        <div class="leg-stats" style="margin-top:8px;padding-top:8px"><span class="leg-stat">EV <b class="${a.evPct >= 0 ? 'pos' : 'neg'}">${a.evPct >= 0 ? '+' : ''}${a.evPct}%</b></span><span class="leg-stat">grade <b>${esc(a.grade)}</b></span><span class="leg-stat">${a.sports.length} sport${a.sports.length === 1 ? '' : 's'}</span></div>
      </button>`)
    .join('');

  return `
  <div class="slip-head">
    <div>
      <div class="eyebrow">Day ${day.day} of ${cfg.days} · ${esc(day.date)} <span class="chip ${statusChip[0]}" style="margin-left:7px">${statusChip[1]}</span></div>
      <div class="slip-title">Today's rollover slip</div>
      <div class="hero-sub" style="margin-top:7px;max-width:62ch">
        ${s.legCount} selection${s.legCount === 1 ? '' : 's'} across ${s.sports.length} sport${s.sports.length === 1 ? '' : 's'} — ${esc(s.leagues.slice(0, 3).join(', '))}${s.leagues.length > 3 ? ` +${s.leagues.length - 3} more` : ''}.
        ${s.belowThreshold ? '<b class="neg">Below the engine\'s edge threshold — it would rather you skipped today.</b>' : 'Every leg cleared the edge floor.'}
      </div>
    </div>
    <div class="slip-kpis">
      <div class="kpi"><div class="slip-odds-label">Total odds</div><div class="slip-odds">${s.odds.toFixed(2)}</div></div>
      <div class="kpi"><div class="slip-odds-label">Win probability</div><div class="kpi-v ${s.winProbPct > 100 / s.odds ? 'pos' : 'gold'}">${pct(s.winProbPct)}</div></div>
      <div class="kpi"><div class="slip-odds-label">Stake → return</div><div class="kpi-v">${money0(s.stake)} <span class="dim">→</span> <span class="gold">${money0(s.potentialReturn)}</span></div></div>
    </div>
  </div>

  ${day.result ? resultStripHTML(day) : ''}

  <div class="panel">
    <div class="panel-head"><h2>The selections</h2><span class="panel-note">one leg per event · correlation-haircut applied</span></div>
    ${legs}
    <div class="leg-stats" style="border-top:1px solid var(--line);margin-top:12px;padding-top:12px">
      <span class="leg-stat">combined odds <b>${s.odds.toFixed(3)}</b></span>
      <span class="leg-stat">fair odds for this slip <b>${s.fairOdds?.toFixed(3) ?? '—'}</b></span>
      <span class="leg-stat">total edge <b class="pos">+${(s.edgeSum * 100).toFixed(1)}pp</b></span>
      <span class="leg-stat">avg confidence <b>${pct((s.avgConfidence || 0) * 100, 0)}</b></span>
      <span class="leg-stat">slip EV <b class="${s.evPct >= 0 ? 'pos' : 'neg'}">${s.evPct >= 0 ? '+' : ''}${pct(s.evPct)}</b></span>
      <span class="leg-stat">grade <b>${esc(s.grade)}</b></span>
      ${s.reserve > 0 ? `<span class="leg-stat">reserve held back <b class="gold">${money0(s.reserve)}</b></span>` : ''}
    </div>
  </div>

  ${
    !isSettled
      ? `<div class="panel">
      <div class="panel-head"><h2>${isOpen ? 'Settle day ' + day.day : 'Commit the stake'}</h2><span class="panel-note">${isOpen ? 'the run pauses until you report the result' : 'nothing is staked until you press it'}</span></div>
      <div class="btn-row">
        ${!isOpen ? `<button class="btn btn-primary btn-lg" data-act="stake">Stake ${money0(s.stake)} on this slip</button>` : ''}
        ${isOpen ? `<button class="btn btn-primary btn-lg" data-act="settle-won">✓ We won — pay out ${money0(s.potentialReturn)}</button>
                   <button class="btn btn-danger btn-lg" data-act="settle-lost">✕ We lost</button>` : ''}
        <button class="btn btn-ghost" data-act="scan">↻ Rescan the market</button>
        ${!isOpen ? `<button class="btn btn-ghost" data-act="skip">Skip this day</button>` : ''}
      </div>
      ${isOpen ? `<p class="foot-note">Settling resolves every leg against the day's simulated scorelines — one scoreline per event, so the markets can never contradict each other. If you placed this at a real book, press whichever button matches reality.</p>` : ''}
      ${oddsAdjustHTML(day, cfg)}
    </div>`
      : ''
  }

  ${alts ? `<div class="panel">
      <div class="panel-head"><h2>Alternative slips for the same target</h2><span class="panel-note">ranked by win probability, diversified by shape</span></div>
      <div class="alts">${alts}</div>
    </div>` : ''}

  ${scanStatsHTML(day)}`;
}

function resultStripHTML(day) {
  const res = day.result;
  const won = res.allWon;
  return `<div class="panel" style="border-color:${won ? 'rgba(61,220,151,.35)' : 'rgba(255,92,108,.35)'}">
    <div class="panel-head">
      <h2 style="color:${won ? 'var(--green)' : 'var(--red)'}">${won ? '✓ Slip won' : '✕ Slip lost'} — ${res.legsWon}/${res.legsTotal} legs hit</h2>
      <span class="panel-note">${esc(res.settledAt?.slice(0, 16).replace('T', ' ') || '')}${res.manual ? ' · manual settlement' : ''}</span>
    </div>
    <div class="table-wrap"><table class="table"><thead><tr><th>Fixture</th><th>Pick</th><th>Result</th><th>Odds</th><th>True P</th><th></th></tr></thead><tbody>
      ${res.resolved.map((x) => `<tr>
        <td>${esc(x.match)}<div class="dim" style="font-size:11px">${esc(x.league)} · ${esc(x.market)}</div></td>
        <td>${esc(x.pick)}</td>
        <td class="mono">${esc(x.result || x.outcomeSummary || '—')}</td>
        <td class="num">${x.odds?.toFixed(2) ?? '—'}</td>
        <td class="num dim">${x.truthProbPct != null ? x.truthProbPct + '%' : '—'}</td>
        <td class="num ${x.status === 'WON' ? 'pos' : 'neg'}"><b>${x.status}</b></td>
      </tr>`).join('')}
    </tbody></table></div>
  </div>`;
}

function scanStatsHTML(day) {
  const sc = day.scan;
  if (!sc) return '';
  const cells = [
    [sc.eventsScanned, 'fixtures scanned'],
    [sc.marketsScanned, 'markets priced'],
    [sc.pricesQuoted?.toLocaleString(), 'individual prices'],
    [sc.bookCount ?? sc.books?.length ?? 0, 'books compared'],
    [`${sc.avgOverround ?? '—'}%`, 'avg overround (vig)'],
    [sc.legsConsidered, 'legs with +edge'],
    [sc.legsEligible, 'passed the filters'],
    [sc.combosEvaluated, 'combos evaluated'],
    [sc.modelErrorPp != null ? `${sc.modelErrorPp}pp` : '—', 'model error vs truth'],
    [sc.ratingsErrorPp != null ? `${sc.ratingsErrorPp}pp` : '—', 'ratings-only error'],
    [sc.edgeLegTrueEvPct != null ? `${sc.edgeLegTrueEvPct}%` : '—', 'true EV of edge legs'],
    [sc.edgeTier || '—', 'edge tier used'],
  ];
  return `<div class="panel">
    <div class="panel-head"><h2>Scan telemetry — ${esc(day.date)}</h2>
      <span class="panel-note">${esc(sc.provider)} · ${esc(sc.scannedAt?.slice(0, 16).replace('T', ' ') || '')} · band ${sc.report?.lo ?? '—'}–${sc.report?.hi ?? '—'}</span></div>
    <div class="scan-grid">${cells.map(([v, l]) => `<div class="scan-cell"><div class="v">${v ?? '—'}</div><div class="l">${l}</div></div>`).join('')}</div>
    ${sc.bestEdgeLegs?.length ? `<div class="section-title">Rejected & accepted — the day's fattest edges</div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Fixture</th><th>Pick</th><th>Odds</th><th>Implied</th><th>Model</th><th>Edge</th><th>Conf</th></tr></thead><tbody>
      ${sc.bestEdgeLegs.map((l) => `<tr><td>${esc(l.match)}<div class="dim" style="font-size:11px">${esc(l.league)}</div></td><td>${esc(l.pick)}<div class="dim" style="font-size:11px">${esc(l.market)}</div></td><td class="num">${l.odds.toFixed(2)}</td><td class="num dim">${l.impliedProbPct}%</td><td class="num">${l.modelProbPct}%</td><td class="num pos">+${l.edgePct}%</td><td class="num">${(l.confidence * 100).toFixed(0)}% ${esc(l.band)}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
  </div>`;
}

function oddsAdjustHTML(day, cfg) {
  return `<div style="margin-top:16px;padding-top:14px;border-top:1px dashed var(--line)">
    <div class="eyebrow" style="margin-bottom:8px">Change the day's odds target</div>
    <div class="btn-row" style="align-items:center">
      <input type="number" class="input input-sm" id="odds-input" value="${day.targetOdds}" min="1.2" max="5" step="0.05" style="width:104px" />
      <button class="btn btn-sm btn-ghost" data-act="odds">Rebuild at these odds</button>
      <span class="dim" style="font-size:12px">“we win 2.1 or 2.2 or the way it comes” — set it and the engine rebuilds the slip.</span>
    </div>
  </div>`;
}

function wireSlip(day, r) {
  const body = $('#slip-body');
  $$('[data-act]', body).forEach((b) =>
    b.addEventListener('click', async () => {
      const act = b.dataset.act;
      b.disabled = true;
      try {
        if (act === 'scan') {
          const { run, projection } = await api(`/api/runs/${r.id}/scan`, { method: 'POST', body: { day: day.day } });
          S.run = run; S.projection = projection; renderAll();
          toast('Market rescanned', run.days.find((d) => d.day === run.currentDay)?.slip ? 'New slip ready' : 'Still nothing above the edge floor', 'ok');
        } else if (act === 'stake') {
          const { run, projection } = await api(`/api/runs/${r.id}/stake`, { method: 'POST', body: { day: day.day } });
          S.run = run; S.projection = projection; renderAll();
          toast('Stake committed', `${money(day.slip.stake)} at ${day.slip.odds.toFixed(2)} — settle it when the games finish.`, 'ok', 6000);
        } else if (act === 'settle-won' || act === 'settle-lost') {
          const outcome = act === 'settle-won' ? 'won' : 'lost';
          const { run, projection, verdict } = await api(`/api/runs/${r.id}/settle`, { method: 'POST', body: { day: day.day, outcome } });
          S.run = run; S.projection = projection; renderAll();
          if (verdict?.kind === 'complete') {
            openResultModal(verdict, run);
          } else if (verdict?.kind === 'lost') {
            openResultModal(verdict, run);
          } else {
            toast(outcome === 'won' ? 'Day landed ✓' : 'Day lost', outcome === 'won' ? `${money(run.balance)} in the pot. Day ${run.currentDay} next.` : 'The run is over. Recovery options are on the dashboard.', outcome === 'won' ? 'ok' : 'warn', 6500);
          }
        } else if (act === 'skip') {
          const { run, projection } = await api(`/api/runs/${r.id}/skip`, { method: 'POST', body: { day: day.day } });
          S.run = run; S.projection = projection; renderAll();
          toast('Day skipped', 'Balance untouched — the run was extended by a day instead.', 'warn');
        } else if (act === 'odds') {
          const odds = Number($('#odds-input').value);
          const { run, projection } = await api(`/api/runs/${r.id}/odds`, { method: 'POST', body: { day: day.day, odds } });
          S.run = run; S.projection = projection; renderAll();
          toast('Target updated', `Rebuilt the ladder at ${odds.toFixed(2)} per day.`);
        }
      } catch (err) {
        toast('That did not work', err.message, 'err', 7000);
        b.disabled = false;
      }
    })
  );
  $$('[data-alt]', body).forEach((el) =>
    el.addEventListener('click', async () => {
      if (day.status === 'open') return toast('Already staked', 'Settle this day before switching slips.', 'warn');
      try {
        const { run } = await api(`/api/runs/${r.id}/alt`, { method: 'POST', body: { day: day.day, index: Number(el.dataset.alt) } });
        S.run = run; renderAll();
        toast('Slip swapped', `Now ${run.days.find((d) => d.day === run.currentDay).slip.legCount} legs at ${run.days.find((d) => d.day === run.currentDay).slip.odds.toFixed(2)}`);
      } catch (err) {
        toast('Could not swap', err.message, 'err');
      }
    })
  );
}

/* ══════════════════════════ result modal ══════════════════════════ */

function openResultModal(verdict, run) {
  const inner = $('#result-modal-inner');
  inner.innerHTML = verdictHTML(verdict, run) + `<div style="padding:14px 20px;text-align:right;border-top:1px solid var(--line)"><button class="btn btn-ghost" data-close="modal-result">Close</button></div>`;
  $('#modal-result').hidden = false;
  wireVerdictButtons(run);
  if (verdict.kind === 'complete') celebrate();
}

/* ══════════════════════════ market view ══════════════════════════ */

async function loadMarket() {
  const date = $('#market-date').value || new Date().toISOString().slice(0, 10);
  try {
    const data = await api(`/api/scan?date=${date}&odds=${S.settings.targetOdds}`);
    S.market = data;
    renderMarket(data);
  } catch (err) {
    toast('Scan failed', err.message, 'err');
  }
}

function renderMarket(d) {
  const dg = d.diagnostics;
  const rep = d.builder?.report || {};
  const cells = [
    [dg.events, 'fixtures'],
    [dg.markets, 'markets'],
    [dg.pricesQuoted?.toLocaleString(), 'prices quoted'],
    [dg.bookCount ?? dg.books?.length ?? 0, 'books quoting'],
    [`${dg.avgOverround}%`, 'avg overround (vig)'],
    [dg.positiveEdgeLegs, 'legs with +edge'],
    [rep.eligible ?? '—', 'passed edge floor'],
    [d.builder?.combosEvaluated ?? '—', 'combos in band'],
  ];
  $('#scan-grid').innerHTML = cells.map(([v, l]) => `<div class="scan-cell"><div class="v">${v ?? '—'}</div><div class="l">${l}</div></div>`).join('');

  const tb = $('#value-board tbody');
  tb.innerHTML = (d.topLegs || [])
    .slice(0, 22)
    .map((l) => `<tr>
      <td><b>${esc(l.pick)}</b><div class="dim" style="font-size:11px">${esc(l.home)} v ${esc(l.away)}</div></td>
      <td class="dim">${esc(l.market)}<div class="dim" style="font-size:10.5px">${esc(l.league)}</div></td>
      <td class="num">${l.odds.toFixed(2)}</td>
      <td class="dim" style="font-size:11px">${esc(l.book || '')}</td>
      <td class="num dim">${(l.impliedProb * 100).toFixed(1)}%</td>
      <td class="num">${(l.modelProb * 100).toFixed(1)}%</td>
      <td class="num ${l.edge > 0 ? 'pos' : 'neg'}"><b>${l.edge > 0 ? '+' : ''}${(l.edge * 100).toFixed(1)}%</b></td>
      <td class="num">${(l.confidence * 100).toFixed(0)}% ${esc(l.band)}</td>
    </tr>`)
    .join('');

  $('#fixture-note').textContent = `${d.events.length} events · ${d.events.reduce((a, e) => a + e.markets.length, 0)} markets`;
  $('#fixture-list').innerHTML = d.events
    .map((e) => `<div class="fixture">
      <div class="fixture-top">
        <span class="fixture-league"><span class="sport-badge sp-${esc(e.sport)}">${esc(SPORT_LABEL[e.sport] || e.sport)}</span> ${esc(e.league)}</span>
        <span class="fixture-time">${esc(e.kickoffLocal)}</span>
      </div>
      <div class="fixture-teams">${esc(e.home)} <span class="dim">v</span> ${esc(e.away)}</div>
      <div class="fixture-markets">${e.markets.map((m) => {
        const best = m.outcomes.reduce((a, o) => (o.edgePct > (a?.edgePct ?? -99) ? o : a), null);
        return `<span class="fm ${best && best.edgePct > 1.2 ? 'has-edge' : ''}" title="${esc(m.name)}: ${esc(best?.label || '')} ${best?.odds ?? ''} (edge ${best?.edgePct ?? 0}%)">${esc(m.name.split(' ').slice(0, 2).join(' '))} ${best?.odds?.toFixed(2) ?? ''}</span>`;
      }).join('')}</div>
    </div>`)
    .join('');
}

async function loadCalendar() {
  try {
    const { days, now } = await api('/api/calendar?n=10');
    const best = days.reduce((a, b) => (b.score > a.score ? b : a), days[0]);
    $('#calendar').innerHTML = days
      .map((c) => `<div class="cal-row ${c.dayKey === best.dayKey ? 'is-best' : ''}">
        <span class="cal-day">${esc(c.weekday.slice(0, 3))}${c.weekend ? ' ✦' : ''}</span>
        <span class="cal-date">${esc(c.dayKey.slice(5))}</span>
        <span class="cal-bar"><i style="width:${(c.score * 100).toFixed(0)}%"></i></span>
        <span class="cal-score">${(c.score * 100).toFixed(0)}</span>
        <span class="cal-score" style="min-width:74px">${c.events} fx · ${Object.keys(c.bySport).length} sp</span>
        <span class="cal-score" style="min-width:64px">${esc(c.label)}</span>
      </div>`)
      .join('');
  } catch (err) {
    console.warn(err);
  }
}

/* ══════════════════════════ lab ══════════════════════════ */

async function runLab() {
  const btn = $('#btn-run-lab');
  btn.disabled = true;
  $('#lab-progress').hidden = false;
  $('#lab-results').innerHTML = '';
  const body = {
    iterations: Number($('#lab-iter').value),
    days: Number($('#lab-days').value),
    targetOdds: Number($('#lab-odds').value),
    marketInefficiency: Number($('#lab-ineff').value),
    mode: $('#lab-mode').value,
    stake: Number(S.settings.stake),
    strategies: ['engine', 'naive', 'favourites'],
  };
  try {
    const res = await api('/api/lab/simulate', { method: 'POST', body });
    S.lab = res;
    renderLab(res);
  } catch (err) {
    toast('Simulation failed', err.message, 'err');
  } finally {
    btn.disabled = false;
    $('#lab-progress').hidden = true;
  }
}

function renderLab(res) {
  const e = res.strategies.engine;
  const n = res.strategies.naive;
  const f = res.strategies.favourites;
  const cfg = res.config;

  const card = (s, cls) => {
    const hist = s.deathDayHistogram || {};
    const maxH = Math.max(1, ...Object.values(hist));
    return `<div class="lab-card ${cls}">
      <h3>${esc(s.label)}</h3>
      <div class="rate">${s.completionRatePct}%</div>
      <div class="dim" style="font-size:12px">${s.completed.toLocaleString()} of ${s.iterations.toLocaleString()} runs completed · 1-in-${s.oneIn ?? '∞'}</div>
      <div class="lab-rows">
        ${row('Avg final balance', money0(s.avgFinalBalance))}
        ${row('Median final balance', money0(s.medianFinalBalance))}
        ${row('Best run', money0(s.bestFinalBalance))}
        ${row('TRUE EV per leg', `${s.avgTrueEvPerLegPct >= 0 ? '+' : ''}${s.avgTrueEvPerLegPct}%`, s.avgTrueEvPerLegPct >= 0 ? 'var(--green)' : 'var(--red)')}
        ${row('Edge per leg', `${s.avgEdgePerLegPct >= 0 ? '+' : ''}${s.avgEdgePerLegPct}pp`)}
        ${row('Run EV per unit staked', `${s.evPct >= 0 ? '+' : ''}${s.evPct}%`, s.evPct >= 0 ? 'var(--green)' : 'var(--red)')}
        ${row('Realised daily win rate', pct(s.avgDailyWinRatePct))}
        ${row('Model claimed', pct(s.modelledDailyWinPct))}
        ${row('Avg legs per slip', s.avgLegsPerSlip)}
        ${row('Most common day to die', s.modalDeathDay ? `day ${s.modalDeathDay}` : '—')}
      </div>
      <div class="hist">${Object.entries(hist).map(([d, v]) => `<div class="hist-bar" style="height:${(v / maxH) * 100}%"><span>${d}</span></div>`).join('')}</div>
      <div class="dim" style="font-size:10.5px;margin-top:22px">where the run died, by day number</div>
    </div>`;
  };
  const row = (k, v, color) => `<div class="lab-row"><span>${k}</span><span ${color ? `style="color:${color}"` : ''}>${v}</span></div>`;

  const cal = res.calibration?.engine || {};
  $('#lab-results').innerHTML = `
    <div class="lab-headline" style="margin-bottom:16px">
      <b>${esc(res.headline?.honestRead || '')}</b>
    </div>
    <div class="lab-compare">${card(e, 'is-engine')}${card(n, 'is-naive')}${f ? card(f, 'is-naive') : ''}</div>
    <div class="panel" style="margin:0;background:var(--panel-2)">
      <div class="panel-head"><h2>Head-to-head</h2><span class="panel-note">${cfg.iterations} runs · ${cfg.days} days · ${cfg.targetOdds.toFixed(2)} daily · ${cfg.marketVariants} market re-draws · ${(res.elapsedMs / 1000).toFixed(1)}s</span></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Strategy</th><th>Completed</th><th>Daily win rate</th><th>Avg legs</th><th>Edge/leg</th><th>TRUE EV/leg</th><th>Run EV</th><th>Median</th><th>Calibration</th></tr></thead>
        <tbody>
          ${[['engine', e], ['naive', n], f ? ['favourites', f] : null].filter(Boolean).map(([k, s]) => `<tr>
            <td><b>${esc(s.label)}</b></td>
            <td class="num ${k === 'engine' ? 'pos' : ''}">${s.completionRatePct}%</td>
            <td class="num">${s.avgDailyWinRatePct}%</td>
            <td class="num">${s.avgLegsPerSlip}</td>
            <td class="num ${s.avgEdgePerLegPct >= 0 ? 'pos' : 'neg'}">${s.avgEdgePerLegPct >= 0 ? '+' : ''}${s.avgEdgePerLegPct ?? '—'}pp</td>
            <td class="num ${s.avgTrueEvPerLegPct >= 0 ? 'pos' : 'neg'}"><b>${s.avgTrueEvPerLegPct >= 0 ? '+' : ''}${s.avgTrueEvPerLegPct ?? '—'}%</b></td>
            <td class="num ${s.evPct >= 0 ? 'pos' : 'neg'}">${s.evPct >= 0 ? '+' : ''}${s.evPct}%</td>
            <td class="num">${money0(s.medianFinalBalance)}</td>
            <td class="dim" style="font-size:11.5px">${esc(res.calibration[k]?.verdict || '—')} <span class="mono">(gap ${((res.calibration[k]?.gap ?? 0) * 100).toFixed(1)}pp)</span></td>
          </tr>`).join('')}
        </tbody>
      </table></div>
      <p class="foot-note">
        All three strategies face identical markets and an identical odds target; only the
        <i>selection</i> differs. <b>Random legs</b> picks at random inside the same odds band — no model,
        no edge, no optimisation — so any gap against it is the measurable value of everything this engine
        does. <b>Stack favourites</b> is the folk strategy: the shortest prices you can find until you reach
        ${cfg.targetOdds.toFixed(2)}. It completes more often and still loses money, which is the most
        useful single row in this table. Read <b>TRUE EV/leg</b> first — it is settled against ground truth
        the engine never sees, so it is the one column that cannot flatter itself. Calibration tells you
        whether any probability on this site deserves to be believed.
      </p>
    </div>`;
}

function renderExplainer() {
  const w = S.state?.engine?.signalWeights || { consensus: 0.3, sharp: 0.62, ratings: 0.08 };
  const pc = (x) => `${Math.round(x * 100)}%`;
  const steps = [
    ['1. De-vig the price', `A book quotes every outcome so the implied probabilities sum to more than 100% — that excess is its margin, typically 5–9% on a football 1X2 and more on thin leagues. Divide each implied probability by the sum and you get the book's <i>own</i> opinion of the truth with the toll removed. This is free, it works on every market, and almost nobody does it consistently.`, `fair_i = (1/odds_i) ÷ Σ(1/odds_j)`],
    ['2. Trust the sharp books most', `This is the step that matters most, and it was fitted rather than assumed. Sweeping every weighting of the three signals across 3,550 priced legs and scoring each against ground truth: the sharp books' de-vigged price carries a mean absolute error of <b>0.19pp</b>, the all-book consensus <b>0.54pp</b>, the best single price you could actually bet <b>1.11pp</b>, and our ratings model <b>6.68pp</b>. So the blend is weighted accordingly.`, `P_model = ${pc(w.consensus)}·consensus + ${pc(w.sharp)}·sharp + ${pc(w.ratings)}·ratings   →   MAE 0.25pp`],
    ['3. Accept that the ratings model is the weak signal', `Uncomfortable but load-bearing: the market knows things a ratings model does not — the injury announced this morning, the rotated squad, the waterlogged pitch, where the money is going. An earlier version of this engine weighted ratings at 28% and it <i>destroyed</i> accuracy (MAE 2.14pp instead of 0.25pp) and cut the true value of the legs it found from +19.6% to +6.7%. Ratings now earn ${pc(w.ratings)}, as a tie-breaker and as the fallback on thinly quoted markets.`, `edge ≠ "our model is smarter than the market"`],
    ['4. Edge is what the price charges versus what is true', `Line-shop every book for the best price on each outcome, then compare. A leg at 2.10 implies 47.6%; if the blend says 51.0%, that is +3.4pp of edge. Measured across this market, legs flagged at ≥1.2pp of edge carry <b>+11.9% true expected value</b> per unit, while betting everything indiscriminately carries <b>−0.4%</b>. The filter is doing real work.`, `edge = P_model − (1/best_odds) · EV = P·(odds−1) − (1−P)`],
    ['5. Optimise the slip, not the legs', `Two slips can both pay 2.00 and have very different chances of winning. The builder searches the whole combination space with a bucketed depth-wise DP — one leg per event, a small haircut when legs share a league and kickoff window — and picks the product inside your band with the <b>highest win probability</b>. Stacking the shortest prices instead looks sensible and measurably is not: the Lab puts it at 45.6% a day versus 53.7%.`, `maximise Π P_model(leg_i) · s.t.  target−tol ≤ Π odds_i ≤ target+tol`],
    ['6. Compound, and let the arithmetic be honest', `Day 2 stakes whatever day 1 returned. Over 7 days at 2.00 that is 2⁷ = 128× — and one miss ends everything. The Lab measures the real completion rate instead of letting you assume it, the verdict screen shows you the 1-in-N <i>before</i> you stake, and the calibration line tells you whether any of the probabilities on this site deserve to be believed.`, `P(run) = Π P(day_i) · payout = stake × odds^days`],
  ];
  $('#explainer').innerHTML = steps
    .map(([h, p, f]) => `<div class="exp"><h4>${h}</h4><p>${p}</p><div class="formula">${f.startsWith('edge ≠') || f.startsWith('maximise') || f.startsWith('P(') ? esc(f) : f}</div></div>`)
    .join('');
}

/* ══════════════════════════ runs ══════════════════════════ */

function renderRuns() {
  const runs = S.state?.runs || [];
  const tb = $('#runs-table tbody');
  if (!runs.length) {
    tb.innerHTML = `<tr><td colspan="9" class="dim" style="padding:20px;text-align:center">No runs yet.</td></tr>`;
  } else {
    tb.innerHTML = runs
      .map((r) => `<tr>
        <td class="mono">${esc(r.createdAt?.slice(0, 16).replace('T', ' ') || '')}</td>
        <td class="num">${money0(r.stake, SYMBOLS[r.currency] || '₦')}</td>
        <td class="num">${r.targetOdds?.toFixed(2)}</td>
        <td class="num">${r.days}</td>
        <td class="num">${r.daysWon}/${r.days} ${r.status === 'active' ? `<span class="dim">(on day ${r.currentDay})</span>` : ''}</td>
        <td class="num">${money0(r.balance, SYMBOLS[r.currency] || '₦')}</td>
        <td class="num ${r.profit >= 0 ? 'pos' : 'neg'}">${r.profit >= 0 ? '+' : ''}${money0(r.profit, SYMBOLS[r.currency] || '₦')}</td>
        <td><span class="chip ${r.status === 'complete' ? 'chip-green' : r.status === 'lost' ? 'chip-red' : r.status === 'active' ? 'chip-gold' : 'chip-dim'}">${esc(r.status)}</span></td>
        <td><button class="btn btn-sm btn-ghost" data-open="${esc(r.id)}">Open</button></td>
      </tr>`)
      .join('');
    $$('[data-open]').forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          const { run, projection } = await api(`/api/runs/${b.dataset.open}`);
          S.run = run; S.projection = projection; renderAll(); switchTab('dashboard');
        } catch (err) { toast('Could not open run', err.message, 'err'); }
      })
    );
  }

  const lin = S.run?.lineage || [];
  $('#lineage').innerHTML = lin.length
    ? `<div class="table-wrap"><table class="table"><thead><tr><th>Run</th><th>Target</th><th>Stake</th><th>Days won</th><th>Died on</th><th>Final</th><th>Status</th></tr></thead><tbody>
        ${lin.map((l) => `<tr><td class="mono dim">${esc(String(l.id).slice(-6))}</td><td class="num">${l.targetOdds?.toFixed(2)}</td><td class="num">${money0(l.stake)}</td><td class="num">${l.daysWon}</td><td class="num">${l.diedOnDay ? 'day ' + l.diedOnDay : '—'}</td><td class="num">${money0(l.finalBalance)}</td><td><span class="chip ${l.status === 'complete' ? 'chip-green' : 'chip-red'}">${esc(l.status)}</span></td></tr>`).join('')}
      </tbody></table></div>`
    : `<p class="dim" style="font-size:13px">Nothing yet. When a run finishes, its settings and outcome are stored here — and the engine reads this list before it recommends your next stake and odds target. If two runs die on the same day number, it stops calling that bad luck and turns the target down.</p>`;
}

function switchTab(name) {
  const t = $(`#tabs .tab[data-tab="${name}"]`);
  if (t) t.click();
}

/* ══════════════════════════ setup modal ══════════════════════════ */

function openSetup() {
  $('#modal-setup').hidden = false;
  updateSetupPreview();
}

function updateSetupPreview() {
  const stake = Number($('#f-stake').value) || 0;
  const days = Number($('#f-days').value) || 7;
  const odds = Number($('#f-odds').value) || 2;
  const tol = Number($('#f-tol').value) || 0.1;
  const reserve = Number($('#f-reserve').value) || 0;
  const sym = SYMBOLS[$('#f-currency').value] || '₦';
  $('#cur-symbol').textContent = sym;
  $('#f-reserve-val').textContent = `${reserve}%`;

  const effectiveStake = reserve ? stake * (1 - reserve / 100) : stake;
  // a real slip usually lands slightly off the exact target; use the mid-band
  const realised = odds;
  let bal = effectiveStake;
  const ladder = [];
  for (let i = 0; i < days; i++) {
    const st = reserve ? bal * (1 - reserve / 100) : bal;
    ladder.push({ day: i + 1, stake: st, out: st * realised });
    bal = reserve ? bal - st + st * realised : st * realised;
  }
  const final = bal;
  const pDay = Math.min(0.97, 1 / odds + 0.025);
  const pRun = pDay ** days;

  $('#setup-preview').innerHTML = `
    <div class="lp-row"><span>${days}-day ladder at ${odds.toFixed(2)} per day (±${tol.toFixed(2)})</span><span>${ladder.map((l) => `${money0(l.stake, sym)}→${money0(l.out, sym)}`).join('  ·  ')}</span></div>
    <div class="lp-row" style="border-top:1px dashed var(--line);margin-top:8px;padding-top:9px"><span>If every day lands</span><span class="lp-big">${money0(final, sym)}</span></div>
    <div class="lp-row"><span>Growth multiple</span><span>${(final / Math.max(1, stake)).toFixed(1)}× your ${money0(stake, sym)}</span></div>
    <div class="lp-row"><span>Modelled chance per day / whole run</span><span>${(pDay * 100).toFixed(1)}% · <b class="gold">${(pRun * 100).toFixed(2)}%</b> (≈1 in ${Math.round(1 / pRun).toLocaleString()})</span></div>
    <div class="lp-row"><span>Median outcome</span><span class="neg">${money0(0, sym)} — you lose the stake ${((1 - pRun) * 100).toFixed(1)}% of the time</span></div>
    ${reserve ? `<div class="lp-row"><span>Safety reserve</span><span>${reserve}% held back daily · costs you ${(final / (stake * odds ** days) * 100 - 100).toFixed(0)}% of the upside</span></div>` : ''}
  `;
}

async function createRun() {
  const body = {
    stake: Number($('#f-stake').value),
    currency: $('#f-currency').value,
    days: Number($('#f-days').value),
    targetOdds: Number($('#f-odds').value),
    tolerance: Number($('#f-tol').value),
    mode: $('#f-mode').value,
    provider: $('#f-provider').value,
    reservePct: Number($('#f-reserve').value),
    startDay: $('#f-startday').value || undefined,
  };
  if (S.run?.status === 'active') {
    try { await api(`/api/runs/${S.run.id}/abandon`, { method: 'POST', body: { reason: 'replaced by new run' } }); } catch {}
  }
  const btn = $('#btn-create-run');
  btn.disabled = true;
  try {
    await api('/api/settings', { method: 'POST', body: { currency: body.currency } });
    const { run, projection } = await api('/api/runs', { method: 'POST', body });
    const st = await api('/api/state');
    S.state = st; S.settings = st.settings;
    S.run = run; S.projection = projection;
    $('#modal-setup').hidden = true;
    renderAll();
    switchTab('dashboard');
    const day1 = run.days[0];
    if (day1.slip) toast('Rollover started', `Day 1: ${day1.slip.legCount} legs at ${day1.slip.odds.toFixed(2)} · ${pct(day1.slip.winProbPct)} modelled`, 'ok', 7000);
    else toast('Rollover created', 'The engine found nothing above the edge floor for day 1 — try a rescan or a different start date.', 'warn', 8000);
  } catch (err) {
    toast('Could not start the run', err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

/* ══════════════════════════ settings modal ══════════════════════════ */

async function saveSettings() {
  const body = {
    tz: $('#s-tz').value,
    eventsPerDay: Number($('#s-events').value),
    marketInefficiency: Number($('#s-ineff').value),
    minEdgePerLeg: Number($('#s-edge').value) / 100,
    maxLegs: Number($('#s-maxlegs').value),
    oddsApi: { key: $('#s-apikey').value.trim(), sports: [] },
  };
  try {
    const { settings } = await api('/api/settings', { method: 'POST', body });
    S.settings = settings;
    applySettingsToForms();
    $('#modal-settings').hidden = true;
    toast('Settings saved', 'New scans and runs will use them.', 'ok');
    if (S.run?.status === 'active') refreshRun(S.run.id);
    S.market = null;
    if (S.tab === 'market') loadMarket();
  } catch (err) {
    toast('Could not save', err.message, 'err');
  }
}

/* ══════════════════════════ confetti ══════════════════════════ */

function celebrate() {
  const c = $('#confetti');
  const ctx = c.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = (c.width = window.innerWidth * dpr);
  const H = (c.height = window.innerHeight * dpr);
  c.style.width = window.innerWidth + 'px';
  c.style.height = window.innerHeight + 'px';
  const colors = ['#3ddc97', '#ffc857', '#57b6ff', '#ffffff', '#b48cff'];
  const parts = Array.from({ length: 190 }, () => ({
    x: Math.random() * W,
    y: -Math.random() * H * 0.5,
    w: (3 + Math.random() * 6) * dpr,
    h: (5 + Math.random() * 10) * dpr,
    vx: (Math.random() - 0.5) * 1.6 * dpr,
    vy: (2 + Math.random() * 4) * dpr,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.16,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));
  let frames = 0;
  const maxFrames = 260;
  (function loop() {
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.vy += 0.045 * dpr; p.rot += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.globalAlpha = Math.max(0, 1 - frames / maxFrames);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    frames++;
    if (frames < maxFrames) requestAnimationFrame(loop);
    else ctx.clearRect(0, 0, W, H);
  })();
}

/* ══════════════════════════ wiring ══════════════════════════ */

$('#btn-new-run').addEventListener('click', async () => {
  if (S.run?.status === 'active') {
    if (!confirm('Abandon the current run and start a new one?')) return;
  }
  openSetup();
});
$('#btn-new-run-2').addEventListener('click', openSetup);
$('#btn-goto-slip').addEventListener('click', () => switchTab('slip'));
$('#btn-create-run').addEventListener('click', createRun);
$('#btn-settings').addEventListener('click', () => ($('#modal-settings').hidden = false));
$('#btn-save-settings').addEventListener('click', saveSettings);
$('#btn-rescan').addEventListener('click', loadMarket);
$('#market-date').addEventListener('change', loadMarket);
$('#btn-run-lab').addEventListener('click', runLab);
$('#lab-ineff').addEventListener('input', () => ($('#lab-ineff-val').textContent = `${$('#lab-ineff').value}×`));
$('#s-ineff').addEventListener('input', () => ($('#s-ineff-val').textContent = `${$('#s-ineff').value}×`));
$('#s-edge').addEventListener('input', () => ($('#s-edge-val').textContent = `${$('#s-edge').value}%`));
$('#f-reserve').addEventListener('input', updateSetupPreview);
['#f-stake', '#f-days', '#f-odds', '#f-tol', '#f-currency'].forEach((sel) => $(sel).addEventListener('input', updateSetupPreview));
$$('[data-close]').forEach((b) => b.addEventListener('click', () => ($(b.dataset.close).hidden = true)));
$$('.modal-backdrop').forEach((m) =>
  m.addEventListener('click', (e) => { if (e.target === m) m.hidden = true; })
);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $$('.modal-backdrop').forEach((m) => (m.hidden = true));
});

renderExplainer();
boot();
