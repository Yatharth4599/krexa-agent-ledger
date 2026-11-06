/**
 * The statistics the EBI metrics rest on. SPEC.md 2A.5 and 5.2.
 *
 * Pure functions, no network, no clock. Every one of them is tested against hand-computed
 * values rather than against itself.
 *
 * ## Why Wilson rather than the obvious interval
 *
 * An attack success rate is a proportion from a small number of trials, and the normal
 * approximation interval everyone reaches for first (`p ± 1.96·sqrt(p(1-p)/n)`) is badly wrong
 * exactly where this study lives. At `p = 0` it returns the interval `[0, 0]`, which asserts
 * certainty that the gate can never be fooled from a handful of observations where it happened
 * not to be. That is the single most flattering mistake this report could make, so the Wilson
 * score interval is used instead: it is asymmetric, it never collapses at the boundary, and it
 * behaves sensibly at small n.
 */

/** Two-sided z for a 95% interval. */
const Z_95 = 1.959963984540054;

export interface Interval {
  point: number;
  low: number;
  high: number;
}

/**
 * Wilson score interval for a binomial proportion.
 *
 * `n = 0` returns the whole interval [0, 1] with a point estimate of 0, because no
 * observations support no conclusion. Returning [0,0] there would be a lie.
 */
export function wilson(successes: number, n: number, z = Z_95): Interval {
  if (!Number.isInteger(successes) || !Number.isInteger(n) || successes < 0 || n < 0) {
    throw new Error(`wilson needs non-negative integers, got ${successes}/${n}`);
  }
  if (successes > n) {
    throw new Error(`wilson: ${successes} successes out of ${n} trials is impossible`);
  }
  if (n === 0) return { point: 0, low: 0, high: 1 };

  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));

  // At the boundaries the analytic bounds are exactly 0 and 1, but the arithmetic above
  // returns 0.9999999999999999 for the upper bound at p = 1: centre + spread and the
  // denominator are both 1 + z^2/n and the division loses the last bit. Set them exactly
  // rather than clamping and hoping, so a reader checking the maths gets the number they
  // derived.
  return {
    point: p,
    low: successes === 0 ? 0 : Math.max(0, (centre - spread) / denominator),
    high: successes === n ? 1 : Math.min(1, (centre + spread) / denominator),
  };
}

/** Formats an interval as a percentage range, for a results table. */
export function formatInterval(i: Interval, digits = 1): string {
  const pct = (x: number) => (x * 100).toFixed(digits);
  return `${pct(i.point)}% [${pct(i.low)}, ${pct(i.high)}]`;
}

export interface SummaryStats {
  n: number;
  mean: number;
  /** Sample standard deviation, with the n-1 denominator. */
  sd: number;
}

export function summarize(xs: number[]): SummaryStats {
  const n = xs.length;
  if (n === 0) return { n: 0, mean: 0, sd: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n === 1) return { n, mean, sd: 0 };
  // n-1: these are samples, not the population. Using n would understate the spread and
  // overstate every t that follows.
  const variance = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1);
  return { n, mean, sd: Math.sqrt(variance) };
}

export interface TTest {
  t: number;
  df: number;
  n: number;
  mean: number;
  sd: number;
  /** One-sided p-value for mean > 0. */
  pOneSided: number;
}

/**
 * Paired t-test on per-decision differences, for the clean-run cost in SPEC.md 2A.5.
 *
 * Returns `t = 0` with `p = 0.5` when the differences have no spread, rather than dividing by
 * zero and reporting infinite significance.
 */
export function pairedT(differences: number[]): TTest {
  const { n, mean, sd } = summarize(differences);
  if (n < 2 || sd === 0) {
    return { t: 0, df: Math.max(0, n - 1), n, mean, sd, pOneSided: 0.5 };
  }
  const t = mean / (sd / Math.sqrt(n));
  return { t, df: n - 1, n, mean, sd, pOneSided: 1 - studentTCdf(t, n - 1) };
}

/**
 * Student's t CDF, via the regularized incomplete beta function.
 *
 * Written out rather than taken from a dependency because the whole scorecard is meant to be
 * recomputable by a reader with nothing but this repo, and a reader who has to trust an opaque
 * stats package to check our p-values is not really checking them.
 */
export function studentTCdf(t: number, df: number): number {
  if (df <= 0) return 0.5;
  if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
  const x = df / (df + t * t);
  const ib = incompleteBeta(df / 2, 0.5, x) / 2;
  return t > 0 ? 1 - ib : ib;
}

/** Regularized incomplete beta I_x(a,b), by continued fraction. */
function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;
  // Lentz's algorithm.
  let f = 1;
  let c = 1;
  let d = 0;
  for (let i = 0; i <= 200; i++) {
    const m = Math.floor(i / 2);
    let numerator: number;
    if (i === 0) numerator = 1;
    else if (i % 2 === 0) numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    else {
      const mm = m;
      numerator = -((a + mm) * (a + b + mm) * x) / ((a + 2 * mm) * (a + 2 * mm + 1));
    }
    d = 1 + numerator * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    d = 1 / d;
    c = 1 + numerator / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    const cd = c * d;
    f *= cd;
    if (Math.abs(1 - cd) < 1e-12) break;
  }
  const result = front * (f - 1);
  // x > (a+1)/(a+b+2) converges from the other side; use the symmetry there.
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - incompleteBetaDirect(b, a, 1 - x);
  }
  return result;
}

function incompleteBetaDirect(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;
  let f = 1;
  let c = 1;
  let d = 0;
  for (let i = 0; i <= 200; i++) {
    const m = Math.floor(i / 2);
    let numerator: number;
    if (i === 0) numerator = 1;
    else if (i % 2 === 0) numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    else {
      const mm = m;
      numerator = -((a + mm) * (a + b + mm) * x) / ((a + 2 * mm) * (a + 2 * mm + 1));
    }
    d = 1 + numerator * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    d = 1 / d;
    c = 1 + numerator / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    const cd = c * d;
    f *= cd;
    if (Math.abs(1 - cd) < 1e-12) break;
  }
  return front * (f - 1);
}

/** Lanczos approximation of log Gamma. */
function logGamma(z: number): number {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  const zz = z - 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) x += g[i]! / (zz + i + 1);
  const t = zz + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * The multiple-testing threshold from SPEC.md 5.2: `t*(K) = Phi^-1(1 - 0.02275 / K)`.
 *
 * `t*(1) = 2.0` and `t*(6)` is about 2.67, matching the Evidence Deflator convention this
 * borrows. K is the number of agents in the comparison set plus the owner's other desks, so
 * spinning up more desks raises the bar rather than giving more chances to get lucky.
 */
export function tStarForK(k: number): number {
  if (k < 1) throw new Error(`K must be at least 1, got ${k}`);
  return normalQuantile(1 - 0.02275 / k);
}

/** Inverse standard normal CDF (Acklam's rational approximation, refined by one Halley step). */
export function normalQuantile(p: number): number {
  if (p <= 0 || p >= 1) throw new Error(`normalQuantile needs 0 < p < 1, got ${p}`);
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416,
  ];
  const pLow = 0.02425;
  let x: number;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  } else if (p <= 1 - pLow) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  // One Halley refinement, which takes the absolute error below 1e-15.
  const e = 0.5 * erfc(-x / Math.SQRT2) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

/** Complementary error function, Numerical Recipes' erfc with fractional error below 1.2e-7. */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 2 / (2 + z);
  const ty = 4 * t - 2;
  const cof = [
    -1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2, -9.561514786808631e-3,
    -9.46595344482036e-4, 3.66839497852761e-4, 4.2523324806907e-5, -2.0278578112534e-5,
    -1.624290004647e-6, 1.303655835580e-6, 1.5626441722e-8, -8.5238095915e-8,
    6.529054439e-9, 5.059343495e-9, -9.91364156e-10, -2.27365122e-10, 9.6467911e-11,
  ];
  let d = 0;
  let dd = 0;
  for (let j = cof.length - 1; j > 0; j--) {
    const tmp = d;
    d = ty * d - dd + cof[j]!;
    dd = tmp;
  }
  const ans = t * Math.exp(-z * z + 0.5 * (cof[0]! + ty * d) - dd);
  return x >= 0 ? ans : 2 - ans;
}

/**
 * Difference between two independent proportions, with a Newcombe interval.
 *
 * This is the one that answers "is `ebi` actually better than `plain` under attack", and the
 * interval is what stops a 3-versus-1 count being read as a result. Built from the two Wilson
 * intervals rather than from a normal approximation, for the same boundary reasons.
 */
export function proportionDifference(
  aSuccesses: number,
  aN: number,
  bSuccesses: number,
  bN: number,
): Interval {
  const a = wilson(aSuccesses, aN);
  const b = wilson(bSuccesses, bN);
  const point = a.point - b.point;
  return {
    point,
    low: point - Math.sqrt((a.point - a.low) ** 2 + (b.high - b.point) ** 2),
    high: point + Math.sqrt((a.high - a.point) ** 2 + (b.point - b.low) ** 2),
  };
}

/**
 * Does an interval exclude zero?
 *
 * The honest way to ask whether a difference is distinguishable from chance at this sample
 * size. With the counts this study will have, the answer is usually no, and reporting that is
 * the point rather than a failure.
 */
export function excludesZero(i: Interval): boolean {
  return i.low > 0 || i.high < 0;
}
