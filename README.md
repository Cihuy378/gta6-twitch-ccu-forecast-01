# GTA VI launch-day Twitch viewers — hour-by-hour forecast

Entry for make.fun competition `gta6-twitch-ccu-forecast-01`.

`main.ts` (Node 22, standard library only) reads one case (`/input/<id>.in`)
and writes `/output/<id>.out`: for each of hours 2–24 of GTA VI's release day
(2026-11-19 UTC), five quantiles (5%, 25%, 50%, 75%, 95%) of that hour's mean
Twitch concurrent viewers in the "Grand Theft Auto VI" category. It runs
offline — everything it knows is in the case file, including the 38–42 past
launches shipped as `comparables`.

## Method (round 3)

**Anchor on hour 1.** Every hour is forecast as a log-ratio to the case's
hour-1 print, so the forecast scales with whatever launch day turns out to be
and the log-scale pinball loss is scale-free.

**The shape of a launch day depends on how big hour 1 already is.** Across
the 37 comparable launches with a release-day hour 1, the correlation between
log(hour-1 viewers) and the day's peak log-ratio is −0.94: launches whose
hour 1 was already huge (Elden Ring 875k, Cyberpunk 2077 852k) stay near flat
all day, while launches with a tiny hour 1 (Hollow Knight: Silksong 164,
Kingdom Come: Deliverance II 414) explode 100–1000× by the evening. The
evening slope is about −2.1 log-ratio per dex of hour-1 size (R² ≈ 0.88 at
hours 18–24) and near zero in the morning (hours 2–7), so each hour is
fitted separately.

**Round 1's kernel median was biased low.** A median over ~6 effective
launches inside a skewed size window sits below the true conditional median
— on practice, the 50% quantile was breached only 22% of the time and the
evening median ran 0.3–1.0 log units low. Round 2 replaces it with an
ensemble of two estimators, blended 60/40 in log space (geometric mean of
the quantiles):

1. **Local linear (60%).** For each hour, a kernel-weighted least squares
   fit of log-ratio on log10(hour-1 viewers), evaluated at the target's
   hour-1 size — the regression uses the −0.94 size structure instead of
   fighting it. The intercept is re-centred on the weighted mean so the
   slope cap (±3/dex) cannot shift the level, and a **curvature
   correction** adds back the bias a local-linear fit incurs on a convex
   curve: half the global quadratic coefficient for that hour times the
   kernel window's weighted variance of log-size.
2. **Peak + shape (40%).** The evening peak ratio is fitted by the same
   local-linear machinery, and each hour's offset below the peak is a
   kernel-weighted median across launches. This keeps the coherent daily
   shape — the hour-5 US-unlock jump, the evening peak at hours 18–21 —
   that per-hour fits can blur.

Both share the kernel (Gaussian over log10(hour-1 viewers), bandwidth
0.6 dex, widened until the effective sample is at least 6 launches), the
platform weight (0.4 for a console-only mismatch — GTA VI is console-only,
as are all four practice launches) and the tier weight (see below).

**Contaminated launches are quartered, not halved.** Each comparable
carries a Tier annotation in its unlock note. Nine launches are
`early-access-contaminated` — they peaked days before their standard release
day, so their release-day curves are flat and drag a clean launch's median
down — and two are `weak` analogues (free-to-play / slow-burn). Round 1
down-weighted those eleven to 0.5; round 2 found 0.25 better on practice
(local-linear estimator: 0.179 → 0.173) and on the leave-one-out
guardrails (clean-big 0.186 → 0.183, clean-big console-only 0.153 →
0.143). The weight is read from the case file at run time, never
hard-coded per game, and an unannotated comparable is treated as clean.

**Calibrated spreads.** The spread is the weighted residual SD around the
local fit (local linear) or the peak-plus-shape uncertainties combined in
quadrature (peak + shape), floored at 0.25, capped at 1.4, plus 0.15 per dex
the target's hour 1 sits outside the training range — then **scaled by
0.7**. The raw residual SD overstates the conditional spread (it mixes
launches far across the kernel window); 0.7 is the scale that minimises
pinball loss on the practice cases and on leave-one-out big launches alike.
Round 3 adds a **size-dependent lower-tail sigma**: big launches have a
much tighter lower tail than small ones (leave-one-out evening error SD
0.33 for hour-1 > 100k vs 0.96 below 10k), so the sigma below the median
is scaled down smoothly from 1.0 at small sizes to 0.7 at huge ones.
The upper tail is untouched.

**No median smoothing.** Round 2 smoothed the median curve across
neighbouring hours (weight 0.5). Round 3 removes it: smoothing blurs the
hour-5 US-unlock jump and the evening peak, both sharp features the
per-hour fits get right, and removing it improves practice and the
big-launch guardrails.

**Console-only median shift.** Round 2's forecast was systematically too
low for console-only targets in the morning dip (hours 5–9) and the
evening peak (hours 17–24): all four practice cases and all three big
console-only leave-one-out launches peak above the pooled fit, which is
dominated by multiplatform launches (at big sizes, console-only launches
peak *higher* than multiplatform ones at the same hour-1 size — the
opposite of the small-launch pattern). Round 3 corrects it with a tapered
upward shift for console-only targets only: +0.14 log units on the 5%
and 50% quantiles, +0.175 on the 25% (the most miscalibrated quantile —
breached only 14% of the time at round 2), +0.07 on the 75%, none on the
95%, applied only at hours 5–9 and 17–24. Hours 2–4 and 10–16 are left
alone: the bias there has no consistent sign across launches (Spider-Man
2's midday is over-predicted by up to +0.95, Red Dead 2's under-predicted
by −0.26), so a shift there would be a coin flip. The shift is a
post-blend correction, so it cannot disturb the ensemble's shape.

**Fallbacks.** If a case ships fewer than 5 usable comparables, the program
falls back to the house baseline (persistence with a widening random-walk
spread). A case that fails any other way falls back to flat persistence, so a
valid forecast is always written.

## Validation (local, against the historical source)

Practice answers were taken from the same source the kit names
(SullyGnome.com's "Average viewers" series, verified: hour-1 values match the
cases exactly). Pinball loss is the competition's own score — mean pinball
loss on the log scale over every hour and quantile, lower is better.

| Model | Practice (4 cases) | LOO clean (26) | LOO clean-big (10) | LOO clean-big console-only (3) |
|---|---|---|---|---|
| House baseline (starter) | 0.387 | — | 0.261 | — |
| Round 1 (kernel median + tier 0.5) | 0.209 | 0.434 | 0.190 | 0.166 |
| Round 2 local linear only | 0.151 | 0.426 | 0.179 | 0.128 |
| Round 2 peak + shape only | 0.150 | 0.491 | 0.190 | 0.120 |
| Round 2 ensemble | 0.145 | 0.435 | 0.179 | 0.119 |
| **Round 3 ensemble (this entry)** | **0.122** | **0.444** | **0.175** | **0.102** |

Per practice case, this entry: Wolverine 0.132, Red Dead Redemption 2
0.116, God of War Ragnarök 0.077, Spider-Man 2 0.164 (round 2: 0.159 /
0.151 / 0.100 / 0.170). 90% coverage on practice is 0.95; the median's
mean absolute log-error is 0.18 (round 2: 0.23). Per-quantile breach
rates on practice are 0.04 / 0.18 / 0.52 / 0.77 / 0.99 for the 5% / 25% /
50% / 75% / 95% quantiles (want 0.05 / 0.25 / 0.50 / 0.75 / 0.95) —
the median is now calibrated, where round 2's was breached only 35% of
the time. The biggest single gain over round 2 is Red Dead Redemption 2
(0.151 → 0.116) and God of War Ragnarök (0.100 → 0.077), the two
largest practice launches, where the console-only shift and the tighter
lower tail both bite.

Ideas tested and rejected (each measured on practice + the leave-one-out
subsets): local quadratic fits (variance beats the curvature gain),
global quadratic fits, empirical residual quantiles instead of a normal
spread, k-nearest-neighbour whole curves, unlock-hour alignment of the
early hours, pre-launch diurnal profiles and pre-launch evening levels as
extra features (correlations ≈ 0 with the size-removed peak residual),
uniform lower-tail-only sigma tightening (helps practice, hurts
leave-one-out — round 3's *size-dependent* version, which only tightens
for big targets, helps both), LAD and Huber median regression, quantile
regression instead of the normal spread, a platform×size interaction
model (helps small launches only, too noisy for big targets), hourly
blend weights, a three-way console-only blend, a morning-only median
shift (the evening shift carries most of the gain), a full-hours median
shift (the midday bias has no consistent sign), and wider sigmas on top
of the shift. The final target is a huge clean console-only launch, so
the leave-one-out clean-big and clean-big console-only subsets are the
guardrails that matter — both improve over round 2 (0.179 → 0.175 and
0.119 → 0.102), while leave-one-out over all clean launches worsens
slightly (0.435 → 0.444): the console-only shift is tuned for big
launches and small console-only launches are already over-predicted, so
the shift costs them. That trade is accepted — the final is a huge
launch, not a small one.

Sanity check on the final's shape: if GTA VI's hour 1 prints 500,000
viewers, the entry forecasts a median dip to ~0.51× by hour 10, rising to
a ~1.35× evening peak at hour 19 (median ≈ 675k), and ~1.11× at hour 24.
A 1,500,000 hour 1 — beyond the largest comparable (Elden Ring, 875k) —
flattens further (median peak ≈ 1.39M at hour 19, ~0.93× hour 1) with
honestly wider quantiles from the extrapolation term: the saturation the
local-linear fit learns from Elden Ring and Cyberpunk, extrapolated
smoothly rather than clipped.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=<kit>/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Deterministic: two runs on the same input write identical bytes. Runtime is
well under the 8-second cap (about 0.1 s per case on the practice set).
