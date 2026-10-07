# RolloverEngine

An edge-aware engine for a multi-day rollover: stake ₦500, build an accumulator
that lands on ~2.00 every day, roll the whole balance forward, and see whether
seven sequential days survive.

It scans a multi-sport market pool, de-vigs every book it can see, works out
what each outcome actually costs versus what it is actually worth, and then
searches the combination space for the slip inside your odds band with the
**highest win probability** — not the one with the biggest names on it.

```
npm start          # dashboard + API on http://localhost:3000
npm run cli        # the same engine on the command line
npm test           # 101 tests, no dependencies
```

Zero dependencies. Node 20+. `node:http`, `node:test`, a JSON file, and a
browser that can do arithmetic.

---

## Read this first

**This completes about 1 time in 100.** That is not a bug and it is not
pessimism; it is what seven sequential ~54% events multiply out to, and the
dashboard shows you the 1-in-N *before* you stake rather than after you lose.

Measured over 1,250 simulated seven-day rollovers:

| | daily win rate | runs completed | EV per unit staked | true EV per leg |
|---|---|---|---|---|
| **this engine** | **53.70%** | **1.04%** | **+22.0%** | **+3.14%** |
| random legs, same odds target | 48.65% | 0.64% | −22.6% | −1.25% |
| stack the shortest prices | 45.56% | 7.92% | −31.8% | −1.79% |

The median outcome is **₦0**. The mean is positive only because the rare
complete run pays 128×. Both of those are true at once, and you will feel the
first one far more often than the second.

What the table actually says is narrower than "this wins": the engine finds legs
worth **+3.14% true EV per unit**, while picking at random costs you **−1.25%**
and stacking favourites costs you **−1.79%**. Those two negative numbers are the
vig. The engine is on the right side of it and the folk strategies are not. Over
a rollover that is worth **+5.05 percentage points a day**, and it is the entire
reason to use a system instead of betting on whatever is on screen.

If you want the honest one-line version: *this makes the losing cheaper and the
winning more likely, and it will still lose nearly every time.*

---

## Where the edge comes from

Not from a model that is smarter than the market. That was the first design and
it was measurably wrong.

### 1. De-vig the price

A book quotes every outcome so the implied probabilities sum to more than 100%.
That excess is its margin — 5–9% on a football 1X2, more on thin leagues. Divide
each implied probability by the sum and you have the book's own opinion with the
toll removed. Free, works on every market, and almost nobody does it
consistently.

### 2. Trust the sharp books most

This is the step that matters, and it was **fitted, not guessed**. Sweeping every
weighting of the three available signals across 3,550 priced legs and scoring
each against ground truth:

| estimate | mean absolute error vs truth |
|---|---|
| sharp books, de-vigged | **0.19pp** |
| all books, de-vigged | 0.54pp |
| the best single price you could bet | 1.11pp |
| our ratings model | 6.68pp |
| **the blend this engine uses** | **0.25pp** |

So the blend is weighted `0.30 consensus + 0.62 sharp + 0.08 ratings`.

The earlier weighting was `0.50 / 0.22 / 0.28`. It produced a **2.14pp** error —
eight times worse — and cut the true value of the legs it flagged from **+19.6%**
to **+6.7%**. Three lines of arithmetic, most of the product.

### 3. Accept that the ratings model is the weak signal

Uncomfortable but load-bearing. The market knows things a ratings model does not:
the injury announced this morning, the rotated squad, the waterlogged pitch, where
the money is going. Ratings now earn an 8% weight as a tie-breaker and as the
fallback on thinly quoted markets, and that is all.

The consequence worth stating plainly: **the engine's edge is not predictive
genius.** It is that we extract the market's own best information more completely
than a punter reading one book does — de-vigging, weighting the sharp books,
line-shopping the best price per outcome — and then optimise the whole
combination for win probability instead of grabbing a game that looks good.

### 4. Edge is what the price charges versus what is true

```
edge = P_model − (1 / best_odds_across_all_books)
EV   = P·(odds − 1) − (1 − P)
```

Measured on a live scan: legs flagged at ≥1.2pp of edge carry **+11.9% true
expected value** per unit. Betting everything indiscriminately carries **−0.4%**.
The filter is doing real work.

### 5. Optimise the slip, not the legs

Two slips can both pay 2.00 and have very different chances of winning. The
builder searches the whole combination space with a bucketed depth-wise DP over
log-odds — one leg per event, a small haircut when legs share a league and
kickoff window — and picks the product inside your band with the highest win
probability.

Stacking short prices instead looks sensible and is not: **45.56%** a day versus
**53.70%**. It does complete more often (7.92%), because six legs at 1.15 reach
2.00 with less variance — but it pays 1.79% vig per leg to do it, and its run EV
is **−31.8%**.

### 6. Compound, and let the arithmetic be honest

Day 2 stakes whatever day 1 returned, at whatever odds day 1 actually gave you.
If it came back 2.14, the next day is priced off 2.14 — the projection uses your
**realised** odds (1.996⁷ = 126.22×), never the round target (2.00⁷ = 128×).

---

## How you can trust any of it

Three things, because a number you cannot audit is worth nothing.

**The model is not secretly omniscient.** `lib/truth.js` keeps three layers
strictly apart: what our ratings can compute, what is actually true (ratings plus
the information the market holds and we don't), and what the books quote. Only
the second one settles bets. Collapsing these was the original design and it made
every "edge" a measure of the engine's own clairvoyance — the Lab then showed it
beating a naive picker purely from a favourable noise draw.

**Calibration is reported next to every claim.** The engine claimed **54.34%** a
day and realised **53.70%** — a gap of **0.64pp**. A probability you cannot trust
is worse than no probability at all, so this is the number to check before
believing any other.

**The Lab compares against honest controls.** `naive` is *random legs in the same
odds band* — same universe, same target, no model, no edge, no optimisation.
Markets are re-priced each iteration (`marketVariants: 3`), because freezing them
let the naive baseline match the engine. Both of those were real dead ends and
both are recorded in `lib/simulate.js`.

Run it yourself — this is verbatim output, and your numbers will move a little
with the seed, which is itself the point:

```
npm run cli lab -- --iters 1000 --seed 4242
```

```
  1,000 runs · 8154ms · settled against ground truth

  strategy      completed   daily win   avg legs   edge/leg   TRUE EV/leg      run EV    median final
  engine            1.40%      56.04%       3.51    +1.18pp        +2.49%       +55.6%         ₦0.00
  naive             0.30%      48.45%       1.94    -1.02pp        -1.34%       -68.5%         ₦0.00
  favourites       13.40%      43.40%        5.9    -1.86pp        -1.93%       -38.1%         ₦0.00

  calibration engine      claimed 53.76%  realised 56.04%  gap -2.28pp  → under-confident

  LIFT over picking at random: +7.59pp per day · +124.1pp run EV · +3.83pp true EV per leg
```

The report also states how much of that is signal, in its own words:

> The per-leg numbers are measured over 7,774 settled legs, so they are tight
> (±0.13pp at 95% confidence on true EV). The run-level numbers are not: with a
> completion rate near 1.4% this batch contains only about 14 completed runs,
> which puts a ±0.73pp confidence interval on it. Read the per-leg EV as the
> finding and the completion comparison as a hint.

Notice that the single-seed calibration gap above is −2.28pp while the five-seed
mean is +0.64pp. Neither is a failure; one batch of 1,000 is just not enough to
pin a 1.4% event. That is why the headline table is a mean over five seeds.

---

## What it does

**Dashboard** — set your stake, target odds, run length, currency and timezone.
It scans the day, shows you the slip with every leg's price, the model's belief,
what the sharp books say, and the edge; shows the 1-in-N and the ladder before
you commit; tracks the run day by day with an equity curve; and lets you switch
to an alternative slip, retune a day's odds target, or skip a thin day.

**Verdicts.** Complete all seven days:

> CONGRATULATIONS 🏆 — You turned ₦500.00 into ₦58,552.98 — a 117.11× return in
> 7 days, profit of ₦58,052.98.

…and it suggests the next day and time to start again, scored by real fixture
density across the following twelve days, never a day that has already happened.

Lose one:

> Sorry — unfortunately we lost this time. We go again.

…with a diagnosis (was the model wrong, or was one selection wrong?) and four
priced recovery options — same, lower odds, shorter run, safety reserve — all
derived from one measured daily win probability so they cannot contradict each
other. Plus a discipline note, because a double-stake "get it back" slip is the
single most expensive decision in rollover betting.

**Confidence is data quality, not edge size.** It used to include edge, which
made it *anti-correlated* with accuracy — big edges happen precisely where the
books disagree with the model, i.e. where the model is likeliest to be wrong. Now
it is book agreement, liquidity, tier and time-to-kickoff, and high-confidence
legs really are more accurate (0.84pp error at band 0.3 versus 0.27pp at 0.8).

**CLI** — the same engine, same store, no browser:

```
npm run cli create --stake 500 --days 7 --odds 2.0
npm run cli stake  --day 1
npm run cli settle --day 1 --result won
npm run cli calendar
npm run cli lab --iters 500
```

---

## Running it

### Local (persistent)

```
npm install   # nothing to install, but it creates the directory
npm start
```

Runs are stored in `data/store.json` (gitignored). The CLI shares that file, and
the store is invalidated by mtime so the two processes cannot clobber each other.

### Vercel (serverless)

```
npm i -g vercel
vercel deploy            # or: vercel --prod
```

`vercel.json` sets `buildCommand: npm run bundle && node scripts/vercel-dist.mjs`
and `outputDirectory: dist`. `/api/*` is rewritten to the one function in
`api/index.js`.

**A serverless function has no disk that outlives the invocation.** `/tmp` is
discarded, so a rollover created in one request would be gone by the next — and a
rollover is a seven-day object. Rather than fake it, `api/index.js` reports
`persistent: false`, the dashboard reads that and runs the engine **in your
browser tab** against `localStorage`. Same code, same numbers, same route table;
only the transport changes, and a badge in the top bar tells you where your runs
live.

That works because `lib/http-core.js` defines the API once, with no runtime
attached — no `node:http`, no `Buffer`, no filesystem. Three hosts wrap it:

| host | transport | storage |
|---|---|---|
| `server/index.js` | `node:http` | `data/store.json` |
| `api/index.js` | Web `Response` | memory (ephemeral, says so) |
| `public/local-api.js` | none — runs in the tab | `localStorage` |

The browser build needs `public/vendor/engine.bundle.mjs`, produced by
`scripts/bundle.mjs`: 15 modules concatenated in dependency order, each in its
own block scope, with every cross-module import hoisted out under a unique alias.
`npm run bundle` builds it **and** imports it and drives the real route table, so
a broken bundle fails the build instead of failing a user. It is committed
because Vercel's static output has to contain it.

Preview that exact deployment locally, without deploying:

```
npm run build && npm run preview:static   # http://localhost:4173
```

### Real odds

The simulator is the default so everything works out of the box. Two ways to use
live prices:

- **Paste your own odds.** Provider `manual` de-vigs whatever you give it — you
  are the book aggregation layer.
- **The Odds API.** Set `ODDS_API_KEY` or paste a key in settings. The free tier
  is enough.

---

## Layout

```
lib/
  math.js         seeded RNG, Poisson grids, devig/fair/implied/EV/Kelly, stats
  ratings.js      the ratings seed (a plain ES module — see below)
  truth.js        RATINGS / TRUTH / PRICES kept strictly apart
  model.js        ratings → market tree; one scoreline resolves every market
  markets.js      per-book distortion, de-vigging, blending, edge, confidence
  fixtures.js     the day's scan universe, day-of-week shape, tz handling
  builder.js      bucketed depth-wise DP over the combination space
  scan.js         the scan pipeline and its diagnostics
  settle.js       settlement; unknown fixtures fail safe, never as a win
  rollover.js     the state machine, verdicts and progress maths
  suggestions.js  when to go again, and what to change after a loss
  simulate.js     the Monte-Carlo Lab and closed-form projection
  http-core.js    the API, with no runtime attached
  store.js        flat-file JSON persistence
  store-shared.js defaults + run summary, shared by all three backends
  memory-store.js the pluggable adapter behind memory and localStorage
server/index.js   node:http transport + static files
api/index.js      Vercel serverless transport
bin/rollover.mjs  the CLI
public/           the dashboard
scripts/          the bundler and the Vercel dist assembler
test/             101 tests + a forked worker for the cross-process store test
```

`lib/ratings.js` used to be `ratings.json` loaded through `node:module`'s
`createRequire`. That works in Node and nowhere else — a Vercel bundle and a
browser bundle both have to resolve it too, and JSON import attributes are not
supported consistently across the bundlers involved. Same data (verified
byte-for-byte before the `.json` was deleted, so there is one source of truth
rather than two that can drift), plain ES module, no loader hooks, no build
step.

Coverage: 15 football leagues / 284 clubs from the Premier League down to the
NPFL, 3 basketball leagues, MLB, and ATP/WTA and UFC player fields.

---

## Things that were wrong and how they were found

Kept here because each one was a design that looked correct, and the only reason
they are fixed is that something was measured.

- **Model = truth.** Made every edge a measure of the engine's own omniscience.
  Fixed by the three-layer split in `lib/truth.js`. Do not collapse them back.
- **Edge inside `confidence()`.** Produced a metric *anti-correlated* with
  accuracy — the 0.7 band had 6.63pp of error against 2.15pp for the 0.3 band.
- **A hard edge floor gating the search.** Positive-edge legs are
  disproportionately longshots, so a floor starves the pool of the sub-1.6 prices
  needed to build a 2.00 accumulator and the day silently degrades into one long
  leg. The floor is applied at *selection* time with tiered relaxation, and
  defaults to 0 — raising it makes rollovers worse, which is why the settings
  panel says so.
- **A 3.5%-per-leg correlation haircut.** Seven times the model's own 0.5pp
  error, so it dominated the model and caused a −3.5pp calibration gap. Sized to
  1.2% per leg, capped at 6%.
- **Ratings weighted at 28%.** See the table above: 2.14pp error instead of
  0.25pp.
- **`diagnostics.books` was a Set of quote objects, not names.** Never
  deduplicated, cost ~71 KB per persisted day, made a seven-day run 544 KB — a
  ninth of the browser's whole localStorage quota — and displayed "1087 books
  compared". Now 8 names plus a quote count; a run is 83 KB.
- **The file store cached its snapshot forever.** The server and the CLI are two
  processes over one file, so whichever wrote second resurrected everything the
  first had deleted. Now invalidated by mtime, with a forked-worker test that
  fails if the invalidation is removed.
- **`persist()` returned the previous link in its write chain.** Awaiting it
  resolved before the file was written, so every caller believed a write had
  landed when it had only been queued.
- **A greedy beam sorted by win probability.** Collapsed onto short-odds
  partials. Replaced by the bucketed DP.
- **Frozen markets across Lab iterations.** Let the naive baseline match the
  engine. Prices now vary per iteration.

---

## Caveats, plainly

- Ratings are a seed prior, not a live feed. The market layer carries the model,
  which is the point — but on a thinly quoted league there is less market to
  carry it, and confidence drops to say so.
- The simulator settles against modelled truth. It is a test of *method*, not a
  claim about any real bookmaker, and it cannot know about the limits, voids,
  price movements and account closures that a real one applies to anyone who
  starts winning.
- The Lab's completion rate near 1% means run-level statistics are noisy at small
  iteration counts. Every report states its own confidence intervals for exactly
  that reason.
- Nothing here is betting advice. A rollover is a lottery ticket you get to
  assemble yourself; the engine makes it a cheaper one and tells you the true
  odds before you buy it.

MIT.
