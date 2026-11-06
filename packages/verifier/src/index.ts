/**
 * `@krexa-ual/verifier`
 *
 * The deterministic, offline verifier whose code hash the policy pins.
 * Pure functions only: no network, no clock, no randomness.
 */

export { extractPrice, isKnownVenue, supportedAssets, type PricePoint, type Venue } from "./extract.js";
export {
  checkClaim,
  fundingBps,
  momentumBps,
  rsi,
  SCALE,
  TOLERANCE,
  type IndicatorCheck,
  type IndicatorClaim,
  type IndicatorName,
  type PriceSeriesPoint,
} from "./indicators.js";
export {
  resultHash,
  verify,
  type ItemVerdict,
  type Signal,
  type VerifierPolicy,
  type VerifierResult,
  type VerifyInput,
} from "./verify.js";
export { computeVerifierCodeHash, HASHED_FILES } from "./codehash.js";
