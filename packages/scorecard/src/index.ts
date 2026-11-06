/**
 * `@krexa-ual/scorecard`
 *
 * Pure statistics for the EBI metrics. No network, no clock, no randomness, and no
 * third-party stats dependency: a reader who has to trust an opaque package to check our
 * p-values is not really checking them.
 */

export {
  erfc,
  excludesZero,
  formatInterval,
  normalQuantile,
  pairedT,
  proportionDifference,
  studentTCdf,
  summarize,
  tStarForK,
  wilson,
  type Interval,
  type SummaryStats,
  type TTest,
} from "./stats.js";
