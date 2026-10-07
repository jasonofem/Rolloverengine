/**
 * model.js — turns team/player ratings into *true* outcome probabilities,
 * then expands those into the full market tree for an event.
 *
 * Sport-specific truth models:
 *   football  → independent Poisson scoreline grid (bivariate-ish via joint pmf)
 *   basketball/baseball/hockey → gaussian margin model (no ties)
 *   tennis/MMA → logistic head-to-head on skill index
 *
 * The output of this module is the "ground truth" that the rest of the engine
 * compares bookmaker prices against. That difference is the edge.
 */

import {
  scoreGrid,
  sumGrid,
  overProb,
  poissonPmf,
  gaussianTruth,
  h2hTruth,
  clamp,
  round,
} from './math.js';

const HOME_ADV = {
  football: 1.16,
  basketball: 2.4, // points
  baseball: 0.28, // runs
  hockey: 0.35,
  tennis: 0,
  mma: 0,
};

/**
 * Compute the truth vector + derived markets for an event.
 * @param {object} event  { sport, league:{base,sigma}, home:{att,def,rtg}, away:{...}, neutral? }
 * @returns {truth: [{key,label,p}], markets: [{key,name,type,line,outcomes:[{key,label,p}]}]}
 */
export function modelTruth(event) {
  const sport = event.sport;
  if (sport === 'football') return footballTruth(event);
  if (sport === 'basketball' || sport === 'baseball' || sport === 'hockey') return gaussianSportTruth(event, sport);
  if (sport === 'tennis' || sport === 'mma') return h2hSportTruth(event, sport);
  throw new Error(`modelTruth: unsupported sport "${sport}"`);
}

/* ------------------------------------------------------------------ */

function footballTruth(event) {
  const base = event.league.base ?? 1.35;
  const adv = event.neutral ? 1.0 : HOME_ADV.football;
  const lh = clamp(base * event.home.att * event.away.def * adv, 0.12, 5.0);
  const la = clamp(base * event.away.att * event.home.def, 0.1, 4.5);

  const grid = scoreGrid(lh, la);
  const pH = sumGrid(grid, (i, j) => i > j);
  const pD = sumGrid(grid, (i, j) => i === j);
  const pA = sumGrid(grid, (i, j) => i < j);

  const pOver = (line) => overProb(lh, la, line);
  const ph = poissonPmf(lh, 12);
  const pa = poissonPmf(la, 12);
  const pHomeOver = (line) => ph.slice(Math.floor(line) + 1).reduce((a, b) => a + b, 0);
  const pAwayOver = (line) => pa.slice(Math.floor(line) + 1).reduce((a, b) => a + b, 0);
  const pBTTS = (1 - ph[0]) * (1 - pa[0]);

  // most likely exact score, for display flavour
  let topScore = { i: 1, j: 1, p: 0 };
  for (let i = 0; i <= 6; i++)
    for (let j = 0; j <= 6; j++) if (grid[i][j] > topScore.p) topScore = { i, j, p: grid[i][j] };

  const markets = [
    {
      key: 'h2h',
      name: 'Match Result',
      type: 'result',
      outcomes: [
        { key: 'home', label: `${event.home.name} to win`, p: pH },
        { key: 'draw', label: 'Draw', p: pD },
        { key: 'away', label: `${event.away.name} to win`, p: pA },
      ],
    },
    {
      key: 'ou25',
      name: 'Total Goals Over/Under 2.5',
      type: 'totals',
      line: 2.5,
      outcomes: [
        { key: 'over', label: 'Over 2.5 goals', p: pOver(2.5) },
        { key: 'under', label: 'Under 2.5 goals', p: 1 - pOver(2.5) },
      ],
    },
    {
      key: 'btts',
      name: 'Both Teams To Score',
      type: 'btts',
      outcomes: [
        { key: 'yes', label: 'BTTS — Yes', p: pBTTS },
        { key: 'no', label: 'BTTS — No', p: 1 - pBTTS },
      ],
    },
  ];

  // Asian handicap — only offered when the match is not near a coin flip,
  // which is exactly how real books behave.
  const spread = spreadFromProb(pH, pA);
  if (spread) {
    const hp = handicapProb(grid, spread);
    markets.push({
      key: `ah${spread}`,
      name: `Asian Handicap ${spread > 0 ? '+' : ''}${spread}`,
      type: 'handicap',
      line: spread,
      outcomes: [
        { key: 'home', label: `${event.home.name} ${spread > 0 ? '+' : ''}${spread}`, p: hp },
        { key: 'away', label: `${event.away.name} ${spread > 0 ? -spread : +(-spread) * -1}`, p: 1 - hp },
      ],
    });
  }

  // Double chance — the classic rollover "safety" leg.
  markets.push({
    key: 'dc',
    name: 'Double Chance',
    type: 'double_chance',
    outcomes: [
      { key: '1x', label: `${event.home.name} or Draw`, p: pH + pD },
      { key: '12', label: `${event.home.name} or ${event.away.name}`, p: pH + pA },
      { key: 'x2', label: `Draw or ${event.away.name}`, p: pD + pA },
    ],
  });

  // Team goals.
  markets.push({
    key: 'htg15',
    name: `${event.home.name} Total Goals`,
    type: 'team_total',
    line: 1.5,
    team: 'home',
    outcomes: [
      { key: 'over', label: `${event.home.name} over 1.5`, p: pHomeOver(1.5) },
      { key: 'under', label: `${event.home.name} under 1.5`, p: 1 - pHomeOver(1.5) },
    ],
  });
  markets.push({
    key: 'atg15',
    name: `${event.away.name} Total Goals`,
    type: 'team_total',
    line: 1.5,
    team: 'away',
    outcomes: [
      { key: 'over', label: `${event.away.name} over 1.5`, p: pAwayOver(1.5) },
      { key: 'under', label: `${event.away.name} under 1.5`, p: 1 - pAwayOver(1.5) },
    ],
  });

  return {
    truth: [
      { key: 'home', label: `${event.home.name} to win`, p: pH },
      { key: 'draw', label: 'Draw', p: pD },
      { key: 'away', label: `${event.away.name} to win`, p: pA },
    ],
    markets,
    meta: { expectedHome: round(lh, 2), expectedAway: round(la, 2), likelyScore: `${topScore.i}-${topScore.j}` },
  };
}

/** Pick a handicap line that roughly balances the market. */
function spreadFromProb(pH, pA) {
  const diff = pH - pA;
  if (Math.abs(diff) < 0.22) return null; // near coin flip → books still post a line, but we skip it
  if (diff > 0) return -Math.min(2.5, Math.max(0.25, Math.round(diff * 3.4) * 0.25));
  return Math.min(2.5, Math.max(0.25, Math.round(-diff * 3.4) * 0.25));
}

/** P(home goals + handicap > away goals), half-ball lines have no push. */
function handicapProb(grid, handicap) {
  return sumGrid(grid, (i, j) => i + handicap > j);
}

/* ------------------------------------------------------------------ */

function gaussianSportTruth(event, sport) {
  const base = event.league.base;
  const sigma = event.league.sigma;
  const adv = event.neutral ? 0 : HOME_ADV[sport] ?? 0;
  const muHome = clamp(base + event.home.rtg - event.away.rtg + adv, base * 0.55, base * 1.5);
  const muAway = clamp(base + event.away.rtg - event.home.rtg, base * 0.55, base * 1.5);

  const t = gaussianTruth(muHome, muAway, sigma);
  const markets = [
    {
      key: 'h2h',
      name: sport === 'baseball' ? 'Moneyline' : 'Match Winner',
      type: 'result2',
      outcomes: [
        { key: 'home', label: `${event.home.name} to win`, p: t.pH },
        { key: 'away', label: `${event.away.name} to win`, p: t.pA },
      ],
    },
  ];

  // Point/run line: the number closest to a pick'em given the projected margin.
  const margin = muHome - muAway;
  const lineKeys = Object.keys(t.spread).map(Number);
  const bestLine = lineKeys.reduce((a, b) => (Math.abs(t.spread[b] - 0.5) < Math.abs(t.spread[a] - 0.5) ? b : a));
  markets.push({
    key: `line${bestLine}`,
    name: `${sport === 'baseball' ? 'Run' : 'Point'} Line ${bestLine > 0 ? '+' : ''}${bestLine}`,
    type: 'handicap',
    line: bestLine,
    outcomes: [
      { key: 'home', label: `${event.home.name} ${bestLine > 0 ? '+' : ''}${bestLine}`, p: t.spread[bestLine] },
      { key: 'away', label: `${event.away.name} ${bestLine > 0 ? -bestLine : +bestLine * -1}`, p: 1 - t.spread[bestLine] },
    ],
  });

  const totalKeys = Object.keys(t.totals).map(Number).filter((l) => Math.abs(l - t.totalMu) < 18);
  const totalLine = totalKeys.length
    ? totalKeys.reduce((a, b) => (Math.abs(b - t.totalMu) < Math.abs(a - t.totalMu) ? b : a))
    : Math.round(t.totalMu / 5) * 5;
  const pOverTotal = 1 - normCdfLocal((totalLine + 0.5 - t.totalMu) / (sigma * Math.SQRT2));
  markets.push({
    key: `total${totalLine}`,
    name: `Total ${sport === 'baseball' ? 'Runs' : 'Points'} ${totalLine}`,
    type: 'totals',
    line: totalLine,
    outcomes: [
      { key: 'over', label: `Over ${totalLine}`, p: pOverTotal },
      { key: 'under', label: `Under ${totalLine}`, p: 1 - pOverTotal },
    ],
  });

  return {
    truth: [
      { key: 'home', label: `${event.home.name} to win`, p: t.pH },
      { key: 'away', label: `${event.away.name} to win`, p: t.pA },
    ],
    markets,
    meta: { projectedMargin: round(margin, 1), projectedTotal: round(t.totalMu, 1) },
  };
}

function normCdfLocal(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

/* ------------------------------------------------------------------ */

function h2hSportTruth(event, sport) {
  const scale = event.league.scale ?? 7.5;
  const t = h2hTruth(event.home.rtg, event.away.rtg, scale);
  return {
    truth: [
      { key: 'home', label: `${event.home.name} to win`, p: t.pA },
      { key: 'away', label: `${event.away.name} to win`, p: t.pB },
    ],
    markets: [
      {
        key: 'h2h',
        name: sport === 'mma' ? 'Fight Winner' : 'Match Winner',
        type: 'result2',
        outcomes: [
          { key: 'home', label: `${event.home.name} to win`, p: t.pA },
          { key: 'away', label: `${event.away.name} to win`, p: t.pB },
        ],
      },
    ],
    meta: { skillGap: round(event.home.rtg - event.away.rtg, 1) },
  };
}

/* ------------------------------------------------------------------ *
 * Result simulation — deterministic per (event, seed)
 * ------------------------------------------------------------------ */

/**
 * Simulate the actual result of an event and resolve EVERY market from that
 * single scoreline. One truth per event → a multi-leg slip on the same match
 * can never be internally inconsistent (you can't "win" Over 2.5 and lose
 * Over 1.5 on the same game).
 *
 * @returns {object} { score, winners: { marketKey: Set<outcomeKey> }, summary }
 */
export function simulateResult(event, rng) {
  const sport = event.sport;
  const winners = {};

  if (sport === 'football') {
    const base = event.league.base ?? 1.35;
    const adv = event.neutral ? 1.0 : HOME_ADV.football;
    const lh = clamp(base * event.home.att * event.away.def * adv, 0.12, 5.0);
    const la = clamp(base * event.away.att * event.home.def, 0.1, 4.5);
    const hg = samplePoisson(lh, rng);
    const ag = samplePoisson(la, rng);
    for (const m of event.markets) {
      if (m.type === 'result') winners[m.key] = new Set([hg > ag ? 'home' : hg === ag ? 'draw' : 'away']);
      else if (m.type === 'totals') winners[m.key] = new Set([hg + ag > m.line ? 'over' : 'under']);
      else if (m.type === 'btts') winners[m.key] = new Set([hg > 0 && ag > 0 ? 'yes' : 'no']);
      else if (m.type === 'handicap') winners[m.key] = new Set([hg + m.line > ag ? 'home' : 'away']);
      else if (m.type === 'double_chance') {
        const s = new Set();
        if (hg > ag) s.add('1x'), s.add('12');
        if (hg === ag) s.add('1x'), s.add('x2');
        if (hg < ag) s.add('x2'), s.add('12');
        winners[m.key] = s;
      } else if (m.type === 'team_total') {
        const g = m.team === 'home' ? hg : ag;
        winners[m.key] = new Set([g > m.line ? 'over' : 'under']);
      }
    }
    return {
      score: { home: hg, away: ag },
      display: `${hg} - ${ag}`,
      winners,
      summary: hg > ag ? `${event.home.name} won ${hg}-${ag}` : hg === ag ? `Draw ${hg}-${ag}` : `${event.away.name} won ${ag}-${hg}`,
    };
  }

  if (sport === 'basketball' || sport === 'baseball' || sport === 'hockey') {
    const base = event.league.base;
    const sigma = event.league.sigma;
    const adv = event.neutral ? 0 : HOME_ADV[sport] ?? 0;
    const muHome = clamp(base + event.home.rtg - event.away.rtg + adv, base * 0.55, base * 1.5);
    const muAway = clamp(base + event.away.rtg - event.home.rtg, base * 0.55, base * 1.5);
    // sample two correlated-ish normals via the margin + total
    const margin = (muHome - muAway) + sigma * rng.gauss();
    const total = (muHome + muAway) + sigma * Math.SQRT2 * rng.gauss();
    let hg = (total + margin) / 2;
    let ag = (total - margin) / 2;
    if (sport === 'baseball') {
      hg = Math.max(0, Math.round(hg));
      ag = Math.max(0, Math.round(ag));
      if (hg === ag) (rng.chance(0.5) ? hg++ : ag++); // no ties in baseball
    } else {
      hg = Math.max(20, Math.round(hg));
      ag = Math.max(20, Math.round(ag));
      if (hg === ag) (rng.chance(0.5) ? hg++ : ag++);
    }
    for (const m of event.markets) {
      if (m.type === 'result2') winners[m.key] = new Set([hg > ag ? 'home' : 'away']);
      else if (m.type === 'handicap') winners[m.key] = new Set([hg + m.line > ag ? 'home' : 'away']);
      else if (m.type === 'totals') winners[m.key] = new Set([hg + ag > m.line ? 'over' : 'under']);
    }
    return {
      score: { home: hg, away: ag },
      display: `${hg} - ${ag}`,
      winners,
      summary: hg > ag ? `${event.home.name} won ${hg}-${ag}` : `${event.away.name} won ${ag}-${hg}`,
    };
  }

  // tennis / mma
  const scale = event.league.scale ?? 7.5;
  const t = h2hTruth(event.home.rtg, event.away.rtg, scale);
  const homeWon = rng() < t.pA;
  for (const m of event.markets) {
    if (m.type === 'result2') winners[m.key] = new Set([homeWon ? 'home' : 'away']);
  }
  return {
    score: null,
    display: homeWon ? `${event.home.name} wins` : `${event.away.name} wins`,
    winners,
    summary: homeWon ? `${event.home.name} won` : `${event.away.name} won`,
  };
}

/** Inverse-CDF Poisson sampler (small lambda → few iterations). */
function samplePoisson(lambda, rng) {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L && k < 30);
  return k - 1;
}

/** Resolve a specific market/outcome from an already-simulated result. */
export function isWinner(result, marketKey, outcomeKey) {
  const set = result?.winners?.[marketKey];
  if (!set) return false;
  return set.has ? set.has(outcomeKey) : Array.from(set).includes(outcomeKey);
}
