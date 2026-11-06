/**
 * Indicator recompute. SPEC.md 2A.2 item 3, first bullet.
 *
 * The Analyst may claim an RSI, a 24 hour momentum or a funding rate. This module recomputes
 * each one from the cited raw PRICE evidence and reports whether the claim survives. A claim
 * that does not match is **dropped**, not flagged: a signal whose stated reason is fabricated
 * does not get to keep the citation that was supposed to justify it.
 *
 * This is the part of the gate that addresses the fake indicator panel attack, which
 * arXiv 2610.26438 finding (iii) reports at 91% against an agent about to hold. A fabricated
 * RSI table is defeated here without any judgement about news content, because arithmetic over
 * attested prices is checkable and a headline is not.
 *
 * Everything is integer arithmetic on fixed-point values. No floats reach a verdict, for the
 * same reason the canonical JSON format forbids them: two implementations must agree exactly.
 */

/** Fixed-point scale for prices and indicator values: 6 decimal places. */
export const SCALE = 1_000_000n;

export type IndicatorName = "RSI_14" | "MOMENTUM_24H_BPS" | "FUNDING_BPS";

export interface IndicatorClaim {
  indicator: IndicatorName;
  asset: string;
  /**
   * The claimed value, as an integer in the indicator's own units:
   * RSI_14 in hundredths (6550 means 65.50), MOMENTUM_24H_BPS and FUNDING_BPS in basis points.
   */
  value: number;
}

export interface IndicatorCheck {
  claim: IndicatorClaim;
  /** What the cited evidence actually supports, in the same units. */
  recomputed?: number;
  /** True when the claim is within tolerance of the recomputed value. */
  matches: boolean;
  /** Why it could not be checked, when `recomputed` is absent. */
  unverifiable?: string;
  /** Tolerance applied, in the claim's units. */
  tolerance: number;
}

/**
 * How far a claim may be from the recomputation and still count.
 *
 * These are not fudge factors. A venue's mid moves between the moment an Analyst read it and
 * the moment the snapshot was taken, and different venues disagree about price at any instant.
 * The tolerance absorbs that and nothing more: it is far tighter than the gap between a real
 * indicator and a fabricated one, which is the distinction that has to survive.
 */
export const TOLERANCE: Record<IndicatorName, number> = {
  // 5 RSI points. A fabricated "RSI 25, deeply oversold" against a real 55 is 30 points out.
  RSI_14: 500,
  // 50 bps of 24h move.
  MOMENTUM_24H_BPS: 50,
  // 2 bps of funding. Funding rates are small, so this is proportionally generous.
  FUNDING_BPS: 2,
};

function toFixed(decimal: string): bigint | undefined {
  if (!/^-?\d+(\.\d+)?$/.test(decimal)) return undefined;
  const neg = decimal.startsWith("-");
  const body = neg ? decimal.slice(1) : decimal;
  const [whole = "0", frac = ""] = body.split(".");
  const padded = (frac + "000000").slice(0, 6);
  const v = BigInt(whole) * SCALE + BigInt(padded || "0");
  return neg ? -v : v;
}

/**
 * 24 hour momentum in basis points, from a price and a previous-day reference price.
 * `(price - prev) / prev * 10000`.
 */
export function momentumBps(price: string, prevDayPrice: string): number | undefined {
  const p = toFixed(price);
  const prev = toFixed(prevDayPrice);
  if (p === undefined || prev === undefined || prev <= 0n) return undefined;
  return Number(((p - prev) * 10_000n) / prev);
}

/** Funding rate in basis points. Hyperliquid reports it as a decimal fraction. */
export function fundingBps(funding: string): number | undefined {
  const f = toFixed(funding);
  if (f === undefined) return undefined;
  // f is scaled by 1e6; bps is fraction * 1e4, so divide by 1e2.
  return Number((f * 10_000n) / SCALE);
}

/**
 * Wilder's RSI over `period` closes, returned in hundredths of a point.
 *
 * Needs `period + 1` prices to produce `period` changes. With 15 minute snapshots, RSI_14
 * covers three and a half hours. Returns undefined rather than padding a short series,
 * because an RSI computed over fewer bars is a different number wearing the same name.
 */
export function rsi(closes: string[], period = 14): number | undefined {
  if (closes.length < period + 1) return undefined;
  const values: bigint[] = [];
  for (const c of closes) {
    const v = toFixed(c);
    if (v === undefined) return undefined;
    values.push(v);
  }
  // Use the most recent period+1 points.
  const window = values.slice(values.length - (period + 1));

  let gain = 0n;
  let loss = 0n;
  for (let i = 1; i < window.length; i++) {
    const diff = window[i]! - window[i - 1]!;
    if (diff > 0n) gain += diff;
    else loss += -diff;
  }
  const p = BigInt(period);
  const avgGain = gain / p;
  const avgLoss = loss / p;

  // All gains and no losses is RSI 100 by definition; the reverse is 0.
  if (avgLoss === 0n) return avgGain === 0n ? 5000 : 10000;
  // RSI = 100 - 100 / (1 + RS) = 100 * avgGain / (avgGain + avgLoss), in hundredths.
  return Number((avgGain * 10_000n) / (avgGain + avgLoss));
}

export interface PriceSeriesPoint {
  /** Nanoseconds, decimal string. */
  ts: string;
  price: string;
  prevDayPrice?: string;
  funding?: string;
}

/**
 * Check one claim against the cited price evidence.
 *
 * `series` must be in ascending time order and must come only from items the signal actually
 * cited. Handing in more data than was cited would let a signal benefit from evidence it never
 * pointed at, which is exactly the accounting the gate exists to prevent.
 */
export function checkClaim(
  claim: IndicatorClaim,
  series: PriceSeriesPoint[],
): IndicatorCheck {
  const tolerance = TOLERANCE[claim.indicator];
  const base: Omit<IndicatorCheck, "matches"> = { claim, tolerance };

  if (series.length === 0) {
    return { ...base, matches: false, unverifiable: "no cited PRICE evidence for this asset" };
  }
  const latest = series[series.length - 1]!;

  let recomputed: number | undefined;
  switch (claim.indicator) {
    case "MOMENTUM_24H_BPS": {
      if (!latest.prevDayPrice) {
        return {
          ...base,
          matches: false,
          unverifiable: "cited evidence carries no previous-day reference price",
        };
      }
      recomputed = momentumBps(latest.price, latest.prevDayPrice);
      break;
    }
    case "FUNDING_BPS": {
      if (!latest.funding) {
        return {
          ...base,
          matches: false,
          unverifiable: "cited evidence carries no funding rate (spot venue?)",
        };
      }
      recomputed = fundingBps(latest.funding);
      break;
    }
    case "RSI_14": {
      recomputed = rsi(series.map((p) => p.price), 14);
      if (recomputed === undefined) {
        return {
          ...base,
          matches: false,
          unverifiable: `RSI_14 needs 15 cited price points, got ${series.length}`,
        };
      }
      break;
    }
  }

  if (recomputed === undefined) {
    return { ...base, matches: false, unverifiable: "could not parse the cited prices" };
  }
  return {
    ...base,
    recomputed,
    matches: Math.abs(recomputed - claim.value) <= tolerance,
  };
}
