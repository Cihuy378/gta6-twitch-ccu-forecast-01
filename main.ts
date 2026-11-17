// gta6-twitch-ccu-forecast-01 — forecast GTA VI's launch-day Twitch viewers, hour by hour.
// Node 22, standard library only. Runs offline: everything it knows is in the case file.
//
// Round-2 method (validated on the kit's practice cases and leave-one-out over
// the comparables — see README.md for the numbers):
//
// The shipped round-1 forecaster took a kernel-weighted MEDIAN log-ratio per
// hour. That median is biased low: the launch-size distribution inside the
// kernel window is skewed, the size curve is convex, and a median of ~6
// effective launches is noisy. Round 2 replaces it with an ensemble of two
// estimators, blended 60/40 in log space:
//
//   (1) LOCAL LINEAR (60%). For each hour h = 2..24, a kernel-weighted least
//       squares fit of log-ratio on log10(hour-1 viewers), evaluated at the
//       target's hour-1 size. The size slope is steep in the evening
//       (about -2.1 per dex, R^2 ~0.88) and ~0 in the morning, so the fit
//       adapts per hour instead of assuming one shape. A curvature
//       correction adds back the bias a local-linear fit incurs on a convex
//       curve: half the global quadratic coefficient times the kernel
//       window's weighted variance of log-size. The spread is the weighted
//       residual SD around the local fit, scaled by 0.7 — the raw residual
//       SD overstates the conditional spread (it mixes launches far across
//       the window), and 0.7 is the scale that minimises pinball loss on
//       both the practice cases and leave-one-out big launches.
//   (2) PEAK + SHAPE (40%). The evening peak ratio is fitted by the same
//       local-linear machinery, and each hour's offset below the peak
//       (log-ratio minus peak ratio) is taken as a kernel-weighted median
//       across launches. This preserves the coherent daily shape — the
//       hour-5 US-unlock jump, the evening peak at hours 18-21 — that
//       per-hour fits can blur. Its spread combines the peak uncertainty
//       and the shape IQR in quadrature, also scaled by 0.7.
//
// Both estimators share the kernel (Gaussian over log10(hour-1 viewers),
// bandwidth 0.6 dex, widened until the effective sample is at least 6),
// the platform weight (0.4 for a console-only mismatch) and the tier weight
// (non-clean tiers — early-access-contaminated or weak analogues —
// down-weighted to 0.25; halving was not enough, the contaminated launches
// peak days before release day and drag the evening down).
//
// Round-3 changes (validated the same way — see README.md):
//   (a) NO median smoothing. Smoothing blurs the hour-5 US-unlock jump and
//       the evening peak, both sharp features the per-hour fits get right;
//       removing it improves practice and the big-launch guardrails.
//   (b) SIZE-DEPENDENT LOWER-TAIL SIGMA. Big launches have a much tighter
//       lower tail than small ones (leave-one-out evening error SD 0.33 for
//       v1 > 100k vs 0.96 for v1 < 10k), so the sigma below the median is
//       scaled down for big targets (smoothly, from 1.0 at small sizes to
//       0.7 at huge ones). The upper tail is untouched.
//   (c) CONSOLE-ONLY MEDIAN SHIFT. For console-only targets the forecast
//       is systematically too low in the morning dip (hours 5-9) and the
//       evening peak (hours 17-24): the practice cases and the big
//       console-only leave-one-out launches all peak above the pooled fit
//       (the pooled fit is dominated by multiplatform launches, which peak
//       lower at big sizes). A tapered upward shift (+0.14 log units on the
//       5% and 50% quantiles, +0.175 on the 25% — the most miscalibrated —
//       +0.07 on the 75%, none on the 95%) corrects it, applied only at
//       those hours and only for console-only targets. Hours 2-4 and 10-16
//       are left alone: the bias there has no consistent sign across
//       launches, so a shift would be a coin flip.
//
// Round-4 changes (validated the same way — see README.md):
//   (d) EARLY-HOUR DOWNWARD SHIFT. Hours 2-4 are systematically
//       OVER-predicted for console-only targets — on practice (mean
//       log-error -0.11 to -0.13) and on leave-one-out big console-only
//       launches (-0.08, -0.14, -0.21) alike — so a uniform -0.12 log-unit
//       shift at hours 2-4, console-only only, corrects it. Multiplatform
//       launches show no such bias there, so the shift is gated.
//   (e) SIZE-DEPENDENT UPPER-TAIL SIGMA. The 95% quantile is breached
//       99% of the time on practice (want 95%): the upper tail is too
//       wide for big console-only targets. Mirroring (b), the sigma above
//       the median is scaled down smoothly from 1.0 at small sizes to
//       0.75 at huge ones, console-only only. (The lower-tail threshold
//       also moves from log10 5.0 to 4.25: the lower tail tightens a
//       little earlier, which the 25% quantile's 0.16 breach rate asks
//       for; at huge target sizes the two thresholds nearly agree.)
//   (f) MEDIAN SHIFT 0.14 -> 0.15. The console-only shift grows by 0.01:
//       the median breach rate stays 0.52 (calibrated), and the extra
//       hundredth buys practice loss on every case but Spider-Man 2.
//
// Anchor: the case's hour-1 print p1. Every other hour is forecast as a
// log-ratio to p1, so the forecast scales with whatever launch day turns
// out to be and the log-scale pinball loss is scale-free. The median curve
// is lightly smoothed across neighbouring hours (weight 0.5).
//
// If the case ships no usable comparables, fall back to the house baseline
// (persistence with a widening random-walk spread), so the output is always
// a valid forecast. A case that fails any other way falls back to flat
// persistence (every quantile = hour 1's print).
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
const BANDWIDTH = 0.6;
/** Minimum effective sample size before the kernel widens. */
const MIN_EFFECTIVE_N = 6;
/** Weight of a comparable whose console-only status differs from the target's. */
const PLATFORM_MISMATCH_WEIGHT = 0.4;
/** Weight of a comparable whose Tier is not "comparable" (early-access
 *  contaminated or weak analogue). */
const NON_CLEAN_TIER_WEIGHT = 0.25;
/** Floor and cap of the log-spread sigma (before the 0.7 scale). */
const SIGMA_FLOOR = 0.25;
const SIGMA_CAP = 1.4;
/** Scale applied to every sigma: the raw residual SD overstates the
 *  conditional spread; 0.7 minimises pinball loss on practice + LOO. */
const SIGMA_SCALE = 0.7;
/** Lower-tail sigma scale for very large targets (round-3 (b)): big
 *  launches have a much tighter lower tail than small ones. */
const SIGMA_LO_BIG_SCALE = 0.7;
/** log10(hour-1 viewers) at which the lower-tail scale is halfway from 1.0
 *  down to SIGMA_LO_BIG_SCALE. Round 4 moves this from 5.0 to 4.25: the
 *  lower tail tightens a little earlier (the 25% quantile's 0.16 breach
 *  rate asks for it); at huge target sizes the two thresholds nearly agree. */
const SIGMA_LO_THRESHOLD = 4.25;
/** Upper-tail sigma scale for very large targets (round-4 (e)): the 95%
 *  quantile is breached 99% of the time on practice (want 95%), so the
 *  sigma above the median is scaled down for big console-only targets,
 *  mirroring the lower-tail scale. */
const SIGMA_HI_BIG_SCALE = 0.75;
/** log10(hour-1 viewers) at which the upper-tail scale is halfway from 1.0
 *  down to SIGMA_HI_BIG_SCALE. */
const SIGMA_HI_THRESHOLD = 5;
/** Upward log-shift applied to console-only targets (round-3 (c), round-4
 *  (f) raises it from 0.14 to 0.15: the median breach rate stays 0.52,
 *  calibrated). */
const MEDIAN_SHIFT = 0.15;
/** Downward log-shift applied to console-only targets at hours 2-4
 *  (round-4 (d)): those hours are systematically over-predicted for
 *  console-only targets, on practice and on leave-one-out big
 *  console-only launches alike. Uniform across quantiles (a pure
 *  location correction). */
const EARLY_SHIFT = -0.12;
/** Per-quantile multipliers of MEDIAN_SHIFT, in level order
 *  (5%, 25%, 50%, 75%, 95%): the 25% quantile is the most miscalibrated
 *  (breached only 14% of the time at round 2), the 95% is already fine. */
const MEDIAN_SHIFT_TAPER = [1, 1.25, 1, 0.5, 0];
/** Extra spread per dex the target sits outside the training range. */
const EXTRAPOLATION_SPREAD = 0.15;
/** Weight of a neighbouring hour when smoothing the median curve.
 *  Round 3 sets this to 0 (no smoothing): smoothing blurs the hour-5
 *  unlock jump and the evening peak, and removing it improves practice
 *  and the big-launch guardrails. */
const SMOOTH_WEIGHT = 0;
/** Cap on the fitted size slope (per dex), to bound extrapolation. */
const SLOPE_CAP = 3;
/** Blend weight of the local-linear estimator (peak+shape gets the rest). */
const LOCAL_LINEAR_WEIGHT = 0.6;
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
  /** Peak log-ratio over the day, null when no hour is present. */
  peak: number | null;
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

/**
 * Weighted least squares for a small design (2 or 3 columns): solves
 * (X'WX) beta = X'Wy by Gaussian elimination with partial pivoting.
 * Returns null when the system is singular (caller falls back).
 */
function weightedLeastSquares(rows: number[][], ys: number[], ws: number[]): number[] | null {
  const k = rows[0].length;
  const a: number[][] = Array.from({ length: k }, () => Array(k).fill(0));
  const b: number[] = Array(k).fill(0);
  for (let i = 0; i < rows.length; i++) {
    for (let r = 0; r < k; r++) {
      b[r] += ws[i] * rows[i][r] * ys[i];
      for (let c = 0; c < k; c++) a[r][c] += ws[i] * rows[i][r] * rows[i][c];
    }
  }
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    if (Math.abs(m[piv][col]) < 1e-12) return null;
    const tmp = m[col];
    m[col] = m[piv];
    m[piv] = tmp;
    for (let r = col + 1; r < k; r++) {
      const f = m[r][col] / m[col][col];
      for (let c = col; c <= k; c++) m[r][c] -= f * m[col][c];
    }
  }
  const beta: number[] = Array(k).fill(0);
  for (let r = k - 1; r >= 0; r--) {
    let s = m[r][k];
    for (let c = r + 1; c < k; c++) s -= m[r][c] * beta[c];
    beta[r] = s / m[r][r];
  }
  return beta;
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
    const present = logRatios.filter((r): r is number => r !== null);
    curves.push({
      v1,
      consoleOnly: isConsoleOnly(comp.platforms),
      tier: tierOf(comp.unlock),
      logRatios,
      peak: present.length > 0 ? Math.max(...present) : null,
    });
  }
  return curves;
}

/** Effective sample size of a weight vector: (sum w)^2 / sum w^2. */
function effectiveN(ws: number[]): number {
  const sw = ws.reduce((s, w) => s + w, 0);
  const sw2 = ws.reduce((s, w) => s + w * w, 0);
  return (sw * sw) / Math.max(sw2, 1e-12);
}

/** Non-kernel weights: platform match and Tier, per comparable. */
function baseWeights(curves: LaunchCurve[], targetConsoleOnly: boolean | null): number[] {
  return curves.map((c) => {
    const platform = targetConsoleOnly === null || c.consoleOnly === targetConsoleOnly ? 1 : PLATFORM_MISMATCH_WEIGHT;
    const tier = c.tier === 'comparable' || c.tier === 'unknown' ? 1 : NON_CLEAN_TIER_WEIGHT;
    return platform * tier;
  });
}

/**
 * Kernel weights at bandwidth bw, widened until the effective sample is at
 * least MIN_EFFECTIVE_N (or bw exceeds 3 dex).
 */
function kernelWeights(
  curves: LaunchCurve[],
  x0: number,
  bw0: number[],
  startBw: number,
): number[] {
  let bw = startBw;
  let ws: number[] = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    ws = curves.map((c, i) => bw0[i] * Math.exp(-0.5 * ((Math.log10(c.v1) - x0) / bw) ** 2));
    if (effectiveN(ws) >= MIN_EFFECTIVE_N || bw > 3) break;
    bw *= 1.5;
  }
  return ws;
}

/** Light smoothing of a per-hour curve across neighbouring hours. */
function smoothCurve(values: number[]): number[] {
  return values.map((m, i) => {
    let sum = 0;
    let weight = 0;
    for (let k = -1; k <= 1; k++) {
      const j = i + k;
      if (j >= 0 && j < values.length) {
        const w = k === 0 ? 1 : SMOOTH_WEIGHT;
        sum += values[j] * w;
        weight += w;
      }
    }
    return sum / weight;
  });
}

/** Lower-tail sigma scale for a target of log10 hour-1 size x0 (round-3
 *  (b)): 1.0 for small launches, SIGMA_LO_BIG_SCALE for huge ones, smooth
 *  in between (sigmoid, width 0.5 dex). */
function lowerTailScale(x0: number): number {
  return 1 - (1 - SIGMA_LO_BIG_SCALE) / (1 + Math.exp(-(x0 - SIGMA_LO_THRESHOLD) / 0.5));
}

/** Upper-tail sigma scale for a target of log10 hour-1 size x0 (round-4
 *  (e)): 1.0 for small launches, SIGMA_HI_BIG_SCALE for huge ones, smooth
 *  in between (sigmoid, width 0.5 dex). Mirrors lowerTailScale. */
function upperTailScale(x0: number): number {
  return 1 - (1 - SIGMA_HI_BIG_SCALE) / (1 + Math.exp(-(x0 - SIGMA_HI_THRESHOLD) / 0.5));
}

/** Hours where the console-only median shift applies (round-3 (c)): the
 *  morning dip (5-9) and the evening peak (17-24). Hours 2-4 and 10-16
 *  are left alone — no consistent bias sign there. */
function shiftApplies(hour: number): boolean {
  return (hour >= 5 && hour <= 9) || hour >= 17;
}

/** Hours where the console-only early downward shift applies (round-4
 *  (d)): hours 2-4, systematically over-predicted for console-only
 *  targets. */
function earlyShiftApplies(hour: number): boolean {
  return hour >= 2 && hour <= 4;
}

/** Turn per-hour median log-ratios + sigmas into quantile rows. The sigma
 *  below the median is scaled by sigLoScale (the size-dependent lower-tail
 *  scale); the sigma above the median is used as-is. */
function rowsFromCenters(
  p1: number,
  centers: number[],
  sigmas: number[],
  z: number[],
  sigLoScale = 1,
): Array<{ hour: number; q: number[] }> {
  return centers.map((m, i) => {
    const q = z.map((zi) => Math.max(1, round2(p1 * Math.exp(m + zi * sigmas[i] * (zi < 0 ? sigLoScale : 1)))));
    for (let j = 1; j < q.length; j++) q[j] = Math.max(q[j], q[j - 1]);
    return { hour: i + 2, q };
  });
}

/**
 * Estimator 1 — local linear. For each hour, a kernel-weighted least
 * squares fit of log-ratio on (log10 hour-1 viewers − target), evaluated
 * at the target. The intercept is re-centred on the weighted mean so a
 * capped slope cannot shift the level, and a curvature correction adds
 * back the bias a local-linear fit incurs on a convex curve (half the
 * global quadratic coefficient times the window's weighted variance of
 * log-size). Spread = weighted residual SD around the local fit, floored,
 * capped, widened outside the training range, and scaled by SIGMA_SCALE.
 */
function localLinearForecast(
  p1: number,
  curves: LaunchCurve[],
  targetConsoleOnly: boolean | null,
  z: number[],
): Array<{ hour: number; q: number[] }> {
  const x0 = Math.log10(Math.max(1, p1));
  const xs = curves.map((c) => Math.log10(c.v1));
  const xmin = Math.min(...xs);
  const xmax = Math.max(...xs);
  const bw0 = baseWeights(curves, targetConsoleOnly);
  const outside = Math.max(0, x0 - xmax, xmin - x0);
  const centers: number[] = [];
  const sigmas: number[] = [];

  for (let h = 2; h <= 24; h++) {
    // Global quadratic curvature for this hour (all curves, base weights).
    let curvature = 0;
    {
      const rows: number[][] = [];
      const ys: number[] = [];
      const ws: number[] = [];
      curves.forEach((c, i) => {
        const y = c.logRatios[h - 2];
        if (y === null) return;
        const dx = Math.log10(c.v1) - x0;
        rows.push([1, dx, dx * dx]);
        ys.push(y);
        ws.push(bw0[i]);
      });
      if (rows.length >= 3) {
        const beta = weightedLeastSquares(rows, ys, ws);
        if (beta) curvature = beta[2];
      }
    }

    const ws = kernelWeights(curves, x0, bw0, BANDWIDTH);
    const idx = curves.map((c, i) => i).filter((i) => curves[i].logRatios[h - 2] !== null);
    const rows = idx.map((i) => [1, Math.log10(curves[i].v1) - x0]);
    const ys = idx.map((i) => curves[i].logRatios[h - 2] as number);
    const wsv = idx.map((i) => ws[i]);
    const beta = weightedLeastSquares(rows, ys, wsv);
    const sw = wsv.reduce((s, w) => s + w, 0);
    const my = ys.reduce((s, y, j) => s + wsv[j] * y, 0) / Math.max(sw, 1e-12);
    const mx = idx.reduce((s, i, j) => s + wsv[j] * (Math.log10(curves[i].v1) - x0), 0) / Math.max(sw, 1e-12);
    let slope = beta ? beta[1] : 0;
    slope = Math.max(-SLOPE_CAP, Math.min(SLOPE_CAP, slope));
    // Re-centre the intercept on the weighted mean, so capping the slope
    // cannot shift the fitted level.
    let a = my - slope * mx;
    if (curvature !== 0) {
      const vx =
        idx.reduce((s, i, j) => s + wsv[j] * (Math.log10(curves[i].v1) - x0 - mx) ** 2, 0) / Math.max(sw, 1e-12);
      a += curvature * vx * 0.5;
    }
    // Weighted residual SD around the local fit.
    const swR = wsv.reduce((s, w) => s + w, 0);
    const varR =
      idx.reduce((s, i, j) => {
        const dx = Math.log10(curves[i].v1) - x0;
        return s + wsv[j] * (ys[j] - (a + slope * dx)) ** 2;
      }, 0) / Math.max(swR, 1e-12);
    const sigma = Math.min(SIGMA_CAP, Math.max(SIGMA_FLOOR, Math.sqrt(varR)) + EXTRAPOLATION_SPREAD * outside);
    centers.push(a);
    sigmas.push(sigma * SIGMA_SCALE);
  }

  return rowsFromCenters(p1, smoothCurve(centers), sigmas, z, lowerTailScale(x0));
}

/**
 * Estimator 2 — peak + shape. The evening peak ratio is fitted by the same
 * local-linear machinery; each hour's offset below the peak (log-ratio
 * minus peak ratio) is a kernel-weighted median across launches, which
 * keeps the coherent daily shape. Spread combines the peak uncertainty
 * and the shape IQR in quadrature, then the same floor/cap/scale.
 */
function peakShapeForecast(
  p1: number,
  curves: LaunchCurve[],
  targetConsoleOnly: boolean | null,
  z: number[],
): Array<{ hour: number; q: number[] }> {
  const x0 = Math.log10(Math.max(1, p1));
  const xs = curves.map((c) => Math.log10(c.v1));
  const xmin = Math.min(...xs);
  const xmax = Math.max(...xs);
  const bw0 = baseWeights(curves, targetConsoleOnly);
  const outside = Math.max(0, x0 - xmax, xmin - x0);
  const ws = kernelWeights(curves, x0, bw0, BANDWIDTH);

  const withPeak = curves.map((c, i) => i).filter((i) => curves[i].peak !== null);
  const rows = withPeak.map((i) => [1, Math.log10(curves[i].v1) - x0]);
  const peaks = withPeak.map((i) => curves[i].peak as number);
  const wsv = withPeak.map((i) => ws[i]);
  const beta = weightedLeastSquares(rows, peaks, wsv);
  const sw = wsv.reduce((s, w) => s + w, 0);
  const my = peaks.reduce((s, y, j) => s + wsv[j] * y, 0) / Math.max(sw, 1e-12);
  const mx = withPeak.reduce((s, i, j) => s + wsv[j] * (Math.log10(curves[i].v1) - x0), 0) / Math.max(sw, 1e-12);
  let peakSlope = beta ? beta[1] : 0;
  peakSlope = Math.max(-SLOPE_CAP, Math.min(SLOPE_CAP, peakSlope));
  const peakA = my - peakSlope * mx;
  const peakVar =
    withPeak.reduce((s, i, j) => {
      const dx = Math.log10(curves[i].v1) - x0;
      return s + wsv[j] * (peaks[j] - (peakA + peakSlope * dx)) ** 2;
    }, 0) / Math.max(sw, 1e-12);
  const peakSigma = Math.sqrt(peakVar);

  const centers: number[] = [];
  const sigmas: number[] = [];
  for (let h = 2; h <= 24; h++) {
    const pairs = curves.map(
      (c, i) => [c.logRatios[h - 2] === null || c.peak === null ? null : (c.logRatios[h - 2] as number) - (c.peak as number), ws[i]] as [number | null, number],
    );
    const med = weightedQuantile(pairs, 0.5);
    const q25 = weightedQuantile(pairs, 0.25);
    const q75 = weightedQuantile(pairs, 0.75);
    const shapeSigma = Math.max(0.1, (q75 - q25) / 1.349);
    const sigma = Math.min(
      SIGMA_CAP,
      Math.sqrt(peakSigma ** 2 + shapeSigma ** 2) + EXTRAPOLATION_SPREAD * outside,
    );
    centers.push(peakA + med);
    sigmas.push(sigma * SIGMA_SCALE);
  }

  return rowsFromCenters(p1, smoothCurve(centers), sigmas, z, lowerTailScale(x0));
}

/**
 * Blend two forecasts' quantiles in log space (geometric mean), so the
 * ensemble median is the geometric mean of the two medians and the
 * spreads average rather than compound.
 */
function blendForecasts(
  a: Array<{ hour: number; q: number[] }>,
  b: Array<{ hour: number; q: number[] }>,
  weightA: number,
): Array<{ hour: number; q: number[] }> {
  return a.map((row, i) => {
    const q = row.q.map((qa, j) => {
      const v = Math.exp(weightA * Math.log(Math.max(1e-9, qa)) + (1 - weightA) * Math.log(Math.max(1e-9, b[i].q[j])));
      return Math.max(1, round2(v));
    });
    for (let j = 1; j < q.length; j++) q[j] = Math.max(q[j], q[j - 1]);
    return { hour: row.hour, q };
  });
}

/**
 * Console-only median shift (round-3 (c)): for console-only targets,
 * raise the lower quantiles at the morning-dip and evening-peak hours,
 * where the pooled fit is systematically too low. Monotonicity is
 * re-enforced (the taper is not monotone in j: the 25% quantile gets
 * the largest multiplier). Non-console-only targets pass through
 * untouched.
 */
function applyMedianShift(
  rows: Array<{ hour: number; q: number[] }>,
  targetConsoleOnly: boolean | null,
): Array<{ hour: number; q: number[] }> {
  if (targetConsoleOnly !== true) return rows;
  return rows.map((row) => {
    if (!shiftApplies(row.hour)) return row;
    const q = row.q.map((v, j) =>
      Math.max(1, round2(v * Math.exp(MEDIAN_SHIFT * (MEDIAN_SHIFT_TAPER[j] ?? 0)))),
    );
    for (let j = 1; j < q.length; j++) q[j] = Math.max(q[j], q[j - 1]);
    return { hour: row.hour, q };
  });
}

/**
 * Console-only upper-tail tightening (round-4 (e)): for console-only
 * targets, shrink the log-spread above the median by upperTailScale(x0)
 * — q'_j = median * (q_j / median)^k for the quantiles above the median
 * — at every hour. The lower quantiles pass through untouched (their
 * scale already lives inside the forecasters). Applied post-blend, so it
 * acts on the ensemble's quantiles exactly as validated. Non-console-only
 * targets pass through untouched.
 */
function applyUpperTailScale(
  rows: Array<{ hour: number; q: number[] }>,
  p1: number,
  targetConsoleOnly: boolean | null,
): Array<{ hour: number; q: number[] }> {
  if (targetConsoleOnly !== true) return rows;
  const k = upperTailScale(Math.log10(Math.max(1, p1)));
  if (k >= 1) return rows;
  return rows.map((row) => {
    const med = row.q[2];
    const q = row.q.map((v, j) =>
      j <= 2 ? v : Math.max(1, round2(med * Math.pow(Math.max(v, 1e-9) / med, k))),
    );
    for (let j = 1; j < q.length; j++) q[j] = Math.max(q[j], q[j - 1]);
    return { hour: row.hour, q };
  });
}

/**
 * Console-only early downward shift (round-4 (d)): for console-only
 * targets, shift every quantile down by EARLY_SHIFT log units at hours
 * 2-4, where the forecast is systematically too high. Uniform across
 * quantiles (a pure location correction). Non-console-only targets pass
 * through untouched.
 */
function applyEarlyShift(
  rows: Array<{ hour: number; q: number[] }>,
  targetConsoleOnly: boolean | null,
): Array<{ hour: number; q: number[] }> {
  if (targetConsoleOnly !== true) return rows;
  return rows.map((row) => {
    if (!earlyShiftApplies(row.hour)) return row;
    const q = row.q.map((v) => Math.max(1, round2(v * Math.exp(EARLY_SHIFT))));
    for (let j = 1; j < q.length; j++) q[j] = Math.max(q[j], q[j - 1]);
    return { hour: row.hour, q };
  });
}

/** The house baseline: persistence with a widening random-walk spread. */
function baselineQuantiles(p1: number, hour: number, z: number[]): number[] {
  return z.map((zi) => Math.max(1, round2(p1 * Math.exp(zi * FALLBACK_SIGMA * Math.sqrt(hour - 1)))));
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
      const local = localLinearForecast(p1, curves, targetConsoleOnly, z);
      const peakShape = peakShapeForecast(p1, curves, targetConsoleOnly, z);
      const blended = blendForecasts(local, peakShape, LOCAL_LINEAR_WEIGHT);
      // Post-blend corrections, in the order validated: upper-tail
      // tightening, then the console-only median shift, then the
      // early-hour downward shift (the two shifts touch disjoint hours,
      // so their order between themselves does not matter).
      const rows = applyEarlyShift(
        applyMedianShift(
          applyUpperTailScale(blended, p1, targetConsoleOnly),
          targetConsoleOnly,
        ),
        targetConsoleOnly,
      );
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
