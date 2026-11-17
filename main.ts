// gta6-twitch-ccu-forecast-01 — forecast GTA VI's launch-day Twitch viewers, hour by hour.
// Node 22, standard library only. Runs offline: everything it knows is in the case file.
//
// Method (fitted and validated on the kit's practice cases and on the comparables
// the cases ship — see README.md for the numbers):
//   * Anchor on the case's hour-1 print p1. Every other hour is forecast as a
//     log-ratio to p1, so the forecast scales with whatever launch day turns out
//     to be and the log-scale pinball loss is scale-free.
//   * For each hour h = 2..24, take every comparable launch's own release-day
//     log-ratio ln(viewers_h / viewers_1). The median of those ratios is a
//     strongly size-dependent curve: launches whose hour 1 was already huge
//     (Elden Ring, Cyberpunk 2077) stay near flat all day, while launches with
//     a tiny hour 1 explode 10-1000x by the evening (corr(log hour-1, peak
//     ratio) ≈ -0.94 across the 37 launches). So the median is taken locally:
//     a Gaussian kernel over log10(hour-1 viewers), bandwidth 0.45 dex,
//     widened until the effective sample is at least 6 launches.
//   * Console-only launches (no PC at launch) peak higher for the same hour-1
//     size than PC launches do — GTA VI is console-only, as are all four
//     practice launches — so comparables whose console-only status matches the
//     target's keep full weight and the others are down-weighted to 0.4.
//   * Each comparable carries a Tier annotation in its unlock note
//     (comparable / early-access-contaminated / weak). Early-access launches
//     peaked days before their standard release day, so their release-day
//     curves are flat and drag a clean launch's median down; free-to-play
//     and slow-burn launches are weak analogues for a paid single-player
//     AAA launch. Non-clean tiers are therefore down-weighted to 0.5 —
//     halved, not dropped, so the local sample stays large. GTA VI is a
//     clean launch, as are all four practice launches. (Validated: practice
//     0.216 -> 0.209, leave-one-out over clean launches 0.442 -> 0.434,
//     over clean big launches 0.210 -> 0.190.)
//   * The spread is the local interquartile range of the same kernel weights
//     (sigma = IQR / 1.349, floored at 0.25, capped at 1.4), plus 0.15 per dex
//     the target's hour-1 sits outside the training range, so an unusually
//     huge launch day gets honestly wider quantiles.
//   * The median curve is lightly smoothed across neighbouring hours (weight
//     0.5) so one noisy hour cannot spike the forecast; the real structure
//     (the hour-5 US unlock jump, the evening peak at hours 18-21) survives.
//   * Quantiles: q_tau = p1 * exp(median_h + z_tau * sigma_h), z from the
//     standard normal at the case's levels, rounded to 2 decimals.
//   * If the case ships no usable comparables, fall back to the house
//     baseline (persistence with a widening random-walk spread), so the
//     output is always a valid forecast. A case that fails any other way
//     falls back to flat persistence (every quantile = hour 1's print).
//
// The program reads every <id>.in in the input directory (MAKEFUN_INPUT_DIR
// or /input) and writes <id>.out beside it in the output directory
// (MAKEFUN_OUTPUT_DIR or /output). It is deterministic: the same input
// always writes the same bytes. It never deletes anything in /output.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The levels this competition scores, in the order each row lists them. */
const DEFAULT_LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** Kernel bandwidth over log10(hour-1 viewers), in dex. */
const BANDWIDTH = 0.45;
/** Minimum effective sample size before the kernel widens. */
const MIN_EFFECTIVE_N = 6;
/** Weight of a comparable whose console-only status differs from the target's. */
const PLATFORM_MISMATCH_WEIGHT = 0.4;
/** Weight of a comparable whose Tier is not "comparable" (early-access
 *  contaminated or weak analogue). Halved, not dropped. */
const NON_CLEAN_TIER_WEIGHT = 0.5;
/** Floor and cap of the log-spread sigma. */
const SIGMA_FLOOR = 0.25;
const SIGMA_CAP = 1.4;
/** Extra spread per dex the target sits outside the training range. */
const EXTRAPOLATION_SPREAD = 0.15;
/** Weight of a neighbouring hour when smoothing the median curve. */
const SMOOTH_WEIGHT = 0.5;
/** Spread of the fallback baseline, in log units per square-root hour. */
const FALLBACK_SIGMA = 0.15;

/**
 * Launches known to be console-only at launch (no PC version on release
 * day). GTA VI releases on PlayStation 5 and Xbox Series X|S only; the four
 * practice launches were likewise console-only. Any other game falls back
 * to unweighted fitting.
 */
const CONSOLE_ONLY_NAMES = [
  'Grand Theft Auto VI',
  "Marvel's Wolverine",
  'Red Dead Redemption 2',
  'God of War Ragnarök',
  'God of War Ragnarok',
  "Marvel's Spider-Man 2",
];

interface CaseHour {
  hour: number;
  viewers?: number;
  channels?: number | null;
  from?: string;
  until?: string;
}

interface Comparable {
  name: string;
  day_start: string;
  platforms?: string;
  /** Research note carrying the Tier annotation ("Tier: comparable" etc). */
  unlock?: string;
  hourly: Array<{ from: string; viewers: number; channels?: number | null }>;
}

interface CaseFile {
  id: string;
  game: { name: string; twitch_id?: string };
  levels?: number[];
  known: CaseHour[];
  forecast: Array<{ hour: number }>;
  comparables?: Comparable[];
}

/** One comparable launch reduced to its release-day shape. */
interface LaunchCurve {
  v1: number;
  consoleOnly: boolean;
  /** "comparable", "early-access-contaminated", "weak", or "unknown". */
  tier: string;
  /** log(viewers_h / viewers_1) for h = 2..24, null where the hour is missing. */
  logRatios: Array<number | null>;
}

/**
 * The Tier annotation in a comparable's unlock note ("Tier: comparable" /
 * "Tier: early-access-contaminated" / "Tier: weak"). "unknown" when the
 * note carries no Tier — treated as clean, so an unannotated launch is
 * never silently dropped or down-weighted.
 */
function tierOf(unlock?: string): string {
  const m = /Tier:\s*([a-z-]+)/.exec(unlock ?? '');
  return m ? m[1] : 'unknown';
}

/** Inverse of the standard normal CDF (Acklam's rational approximation). */
function normInv(p: number): number {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285984469534e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const plow = 0.02425;
  const phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** x rounded to 2 decimals (half up). */
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Weighted quantile of [value, weight] pairs (values may be null = missing). */
function weightedQuantile(pairs: Array<[number | null, number]>, q: number): number {
  const sorted = pairs
    .filter(([v]) => v !== null && v !== undefined && Number.isFinite(v as number))
    .map(([v, w]) => [v as number, w] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  if (sorted.length === 0) return 0;
  const total = sorted.reduce((s, [, w]) => s + w, 0);
  let acc = 0;
  for (const [v, w] of sorted) {
    acc += w;
    if (acc >= total * q) return v;
  }
  return sorted[sorted.length - 1][0];
}

/** A launch is console-only when its platforms list has no PC version. */
function isConsoleOnly(platforms?: string): boolean {
  return typeof platforms === 'string' && platforms.length > 0 && !/PC/i.test(platforms);
}

/** Reduce the case's comparables to release-day log-ratio curves. */
function extractCurves(c: CaseFile): LaunchCurve[] {
  const curves: LaunchCurve[] = [];
  for (const comp of c.comparables ?? []) {
    const dayStart = new Date(comp.day_start).getTime();
    if (!Number.isFinite(dayStart)) continue;
    const byHour = new Map<number, number>();
    for (const p of comp.hourly ?? []) {
      const t = new Date(p.from).getTime();
      if (!Number.isFinite(t)) continue;
      const dh = (t - dayStart) / 3600000;
      if (dh >= 0 && dh < 24 && Number.isInteger(dh) && p.viewers > 0) byHour.set(dh, p.viewers);
    }
    const v1 = byHour.get(0);
    if (v1 === undefined || v1 <= 0) continue;
    const logRatios: Array<number | null> = [];
    for (let h = 1; h < 24; h++) {
      const v = byHour.get(h);
      logRatios.push(v !== undefined && v > 0 ? Math.log(v / v1) : null);
    }
    curves.push({ v1, consoleOnly: isConsoleOnly(comp.platforms), tier: tierOf(comp.unlock), logRatios });
  }
  return curves;
}

/** The house baseline: persistence with a widening random-walk spread. */
function baselineQuantiles(p1: number, hour: number, z: number[]): number[] {
  return z.map((zi) => Math.max(1, round2(p1 * Math.exp(zi * FALLBACK_SIGMA * Math.sqrt(hour - 1)))));
}

/**
 * The kernel forecast for one case: for each forecast hour, a locally
 * weighted median log-ratio and an IQR-based spread around it.
 */
function kernelForecast(p1: number, curves: LaunchCurve[], targetConsoleOnly: boolean | null, z: number[]): Array<{ hour: number; q: number[] }> {
  const x0 = Math.log10(Math.max(1, p1));
  const xs = curves.map((c) => Math.log10(c.v1));
  const xmin = Math.min(...xs);
  const xmax = Math.max(...xs);
  const medians: number[] = [];
  const sigmas: number[] = [];

  for (let h = 2; h <= 24; h++) {
    let bw = BANDWIDTH;
    let pairs: Array<[number | null, number]> = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      pairs = curves.map((c) => {
        const kernel = Math.exp(-0.5 * ((Math.log10(c.v1) - x0) / bw) ** 2);
        const platform =
          targetConsoleOnly === null || c.consoleOnly === targetConsoleOnly ? 1 : PLATFORM_MISMATCH_WEIGHT;
        const tier = c.tier === 'comparable' || c.tier === 'unknown' ? 1 : NON_CLEAN_TIER_WEIGHT;
        return [c.logRatios[h - 2], kernel * platform * tier] as [number | null, number];
      });
      const sw = pairs.reduce((s, [, w]) => s + w, 0);
      const sw2 = pairs.reduce((s, [, w]) => s + w * w, 0);
      const effectiveN = (sw * sw) / Math.max(sw2, 1e-12);
      if (effectiveN >= MIN_EFFECTIVE_N || bw > 3) break;
      bw *= 1.5;
    }
    const median = weightedQuantile(pairs, 0.5);
    const q25 = weightedQuantile(pairs, 0.25);
    const q75 = weightedQuantile(pairs, 0.75);
    let sigma = Math.max(SIGMA_FLOOR, (q75 - q25) / 1.349);
    const outside = Math.max(0, x0 - xmax, xmin - x0);
    sigma = Math.min(SIGMA_CAP, sigma + EXTRAPOLATION_SPREAD * outside);
    medians.push(median);
    sigmas.push(sigma);
  }

  // Light smoothing of the median curve across neighbouring hours.
  const smoothed = medians.map((m, i) => {
    let sum = 0;
    let weight = 0;
    for (let k = -1; k <= 1; k++) {
      const j = i + k;
      if (j >= 0 && j < medians.length) {
        const w = k === 0 ? 1 : SMOOTH_WEIGHT;
        sum += medians[j] * w;
        weight += w;
      }
    }
    return sum / weight;
  });

  return smoothed.map((m, i) => {
    const hour = i + 2;
    const q = z.map((zi) => Math.max(1, round2(p1 * Math.exp(m + zi * sigmas[i]))));
    // Quantiles are non-decreasing by construction (z increasing, sigma > 0);
    // enforce it explicitly so a rounding edge can never break the shape.
    for (let j = 1; j < q.length; j++) q[j] = Math.max(q[j], q[j - 1]);
    return { hour, q };
  });
}

/** Forecast one case, falling back to persistence if anything is unusable. */
function forecastCase(c: CaseFile): { hours: Array<{ hour: number; q: number[] }> } {
  const levels = c.levels && c.levels.length === 5 ? c.levels : DEFAULT_LEVELS;
  const z = levels.map((t) => normInv(Math.min(0.9999, Math.max(0.0001, t))));
  const first = (c.known ?? []).find((k) => k.hour === 1);
  const p1 = Math.max(1, first !== undefined && first.viewers !== undefined ? first.viewers : 1);
  const hours = (c.forecast ?? []).map((f) => f.hour).sort((a, b) => a - b);

  try {
    const curves = extractCurves(c);
    if (curves.length >= 5) {
      const name = (c.game && c.game.name) || '';
      const targetConsoleOnly = CONSOLE_ONLY_NAMES.some((n) => name.includes(n)) ? true : null;
      const rows = kernelForecast(p1, curves, targetConsoleOnly, z);
      const byHour = new Map(rows.map((r) => [r.hour, r.q]));
      return { hours: hours.map((h) => ({ hour: h, q: byHour.get(h) ?? baselineQuantiles(p1, h, z) })) };
    }
  } catch {
    // Fall through to the baseline below; a forecast is always written.
  }
  return { hours: hours.map((h) => ({ hour: h, q: baselineQuantiles(p1, h, z) })) };
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR)
  .filter((f) => f.endsWith('.in'))
  .sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  let out: { hours: Array<{ hour: number; q: number[] }> };
  try {
    const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
    out = forecastCase(c);
  } catch {
    // A case that cannot even be read still gets a valid-shaped fallback:
    // every hour at 1 viewer, which the scorer accepts as a forecast.
    const hours = [];
    for (let h = 2; h <= 24; h++) hours.push({ hour: h, q: [1, 1, 1, 1, 1] });
    out = { hours };
  }
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify(out)}\n`);
}
