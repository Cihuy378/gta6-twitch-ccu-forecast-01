# GTA VI launch-day Twitch viewers — hour-by-hour forecast

Entry for make.fun competition `gta6-twitch-ccu-forecast-01`.

`main.ts` (Node 22, standard library only) reads one case (`/input/<id>.in`)
and writes `/output/<id>.out`: for each of hours 2–24 of GTA VI's release day
(2026-11-19 UTC), five quantiles (5%, 25%, 50%, 75%, 95%) of that hour's mean
Twitch concurrent viewers in the "Grand Theft Auto VI" category. It runs
offline — everything it knows is in the case file, including the 38–42 past
launches shipped as `comparables`.

## Method

**Anchor on hour 1.** Every hour is forecast as a log-ratio to the case's
hour-1 print, so the forecast scales with whatever launch day turns out to be
and the log-scale pinball loss is scale-free.

**The shape of a launch day depends on how big hour 1 already is.** Across
the 37 comparable launches with a release-day hour 1, the correlation between
log(hour-1 viewers) and the day's peak log-ratio is −0.94: launches whose
hour 1 was already huge (Elden Ring 875k, Cyberpunk 2077 852k) stay near flat
all day, while launches with a tiny hour 1 (Hollow Knight: Silksong 164,
Kingdom Come: Deliverance II 414) explode 100–1000× by the evening. A single
global median curve would be wrong for both ends, so each hour's median
log-ratio is taken **locally**: a Gaussian kernel over log10(hour-1 viewers),
bandwidth 0.45 dex, widened until the effective sample is at least 6 launches.

**Console-only launches peak higher.** For the same hour-1 size, launches
with no PC version at launch peak higher in the evening than PC launches do.
GTA VI is console-only (PS5 + Xbox Series X|S), as are all four practice
launches, so comparables whose console-only status matches the target's keep
full weight and the others are down-weighted to 0.4.

**Contaminated launches are halved, not trusted.** Each comparable carries a
Tier annotation in its unlock note. Nine launches are
`early-access-contaminated` — they peaked days before their standard release
day, so their release-day curves are flat and drag a clean launch's median
down — and two are `weak` analogues (free-to-play / slow-burn). Those
eleven are down-weighted to 0.5; the 26 clean comparables keep full weight.
The weight is read from the case file at run time, never hard-coded per
game, and an unannotated comparable is treated as clean. This is the one
revision after the first build: it fixes the diagnosis that the forecast's
median sat systematically low in the evening (the 50% quantile was breached
only 22% of the time on practice). Validated on the target-like subsets —
practice, leave-one-out over clean launches, and over clean big launches —
it improves all three, while leave-one-out over all 37 launches is
unchanged (0.385 → 0.386); it only scores worse on contaminated targets,
whose flat release days a clean-shape model is *supposed* to overshoot.

**Honest spreads.** The spread is the local interquartile range of the same
kernel weights (σ = IQR / 1.349, floored at 0.25, capped at 1.4), plus 0.15
per dex the target's hour 1 sits outside the training range — an unusually
huge launch day gets honestly wider quantiles. The median curve is lightly
smoothed across neighbouring hours (weight 0.5) so one noisy hour cannot spike
the forecast; the real structure survives (the hour-5 US-unlock jump, the
evening peak at hours 18–21, the overnight dip at hours 3–4 and 9–12).

**Fallbacks.** If a case ships fewer than 5 usable comparables, the program
falls back to the house baseline (persistence with a widening random-walk
spread). A case that fails any other way falls back to flat persistence, so a
valid forecast is always written.

## Validation (local, against the historical source)

Practice answers were taken from the same source the kit names
(SullyGnome.com's "Average viewers" series, verified: hour-1 values match the
cases exactly). Pinball loss is the competition's own score — mean pinball
loss on the log scale over every hour and quantile, lower is better.

| Model | Practice (4 cases) | Leave-one-out (37 launches) | LOO, big launches (hour-1 > 100k) |
|---|---|---|---|
| House baseline (starter) | 0.387 | 0.930 | 0.261 |
| Global median curve | 0.310 | 0.793 | 0.346 |
| First build (kernel + platform) | 0.216 | 0.385 | 0.215 |
| **This entry (kernel + platform + tier weight)** | **0.209** | **0.386** | **0.190** |

Per practice case, this entry: Wolverine 0.352, Red Dead Redemption 2 0.165,
God of War Ragnarök 0.139, Spider-Man 2 0.182 (baseline: 0.744 / 0.287 /
0.215 / 0.303). 90% coverage on practice is 0.89 (honest ≈ 0.9); typical
median miss ≈ 40% vs the baseline's 90%. On the target-like subsets the
revision also helps: leave-one-out over clean launches 0.442 → 0.434, over
clean big launches 0.210 → 0.190, over clean console-only launches
0.195 → 0.188.

Sanity check on the final's shape: if GTA VI's hour 1 prints 500,000
viewers, the entry forecasts a median dip to ~0.53× by hour 10, rising to a
~1.32× evening peak at hour 20 (median ≈ 658k, 90% interval ≈ 230k–1.88M),
and ~1.17× at hour 24. A 1,000,000 hour 1 flattens the day further (peak
≈ 1.19×) — the saturation the kernel learns from Elden Ring and Cyberpunk.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=<kit>/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Deterministic: two runs on the same input write identical bytes. Runtime is
well under the 8-second cap (tens of milliseconds on the practice cases).
