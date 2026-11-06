/**
 * Statistics tests, against hand-computed and textbook values rather than against the
 * implementation itself.
 *
 * The scorecard is meant to be recomputable by a reader with nothing but this repo, so the
 * reference values here are ones a reader can look up or work out, not ones produced by
 * running the code and pasting the answer.
 */

import { describe, expect, it } from "vitest";

import {
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
} from "../src/stats.js";

describe("wilson", () => {
  it("matches the textbook interval for 1 of 10", () => {
    // Worked by hand: p=0.1, z=1.96, n=10 gives roughly [0.018, 0.404].
    const i = wilson(1, 10);
    expect(i.point).toBeCloseTo(0.1, 10);
    expect(i.low).toBeCloseTo(0.018, 2);
    expect(i.high).toBeCloseTo(0.404, 2);
  });

  it("matches the textbook interval for 5 of 10", () => {
    const i = wilson(5, 10);
    expect(i.point).toBeCloseTo(0.5, 10);
    expect(i.low).toBeCloseTo(0.237, 2);
    expect(i.high).toBeCloseTo(0.763, 2);
  });

  it("does NOT collapse to a point at zero successes", () => {
    // This is the whole reason Wilson is used. The normal approximation gives [0,0] here,
    // which would assert certainty that the gate can never be fooled, from ten observations.
    const i = wilson(0, 10);
    expect(i.point).toBe(0);
    expect(i.low).toBe(0);
    expect(i.high).toBeGreaterThan(0.25);
    expect(i.high).toBeCloseTo(0.278, 2);
  });

  it("does not collapse at full successes either", () => {
    const i = wilson(10, 10);
    expect(i.point).toBe(1);
    expect(i.low).toBeLessThan(0.75);
    expect(i.high).toBe(1);
  });

  it("narrows as n grows, with the proportion held constant", () => {
    const small = wilson(1, 10);
    const large = wilson(100, 1000);
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
  });

  it("returns the whole unit interval for no observations", () => {
    // No data supports no conclusion. [0,0] here would be the most flattering lie available.
    const i = wilson(0, 0);
    expect(i.low).toBe(0);
    expect(i.high).toBe(1);
  });

  it("refuses impossible counts rather than returning nonsense", () => {
    expect(() => wilson(11, 10)).toThrowError(/impossible/);
    expect(() => wilson(-1, 10)).toThrowError(/non-negative/);
    expect(() => wilson(1.5, 10)).toThrowError(/integers/);
  });

  it("stays inside [0,1]", () => {
    for (const [s, n] of [
      [0, 1],
      [1, 1],
      [1, 2],
      [3, 7],
      [0, 3],
    ] as const) {
      const i = wilson(s, n);
      expect(i.low).toBeGreaterThanOrEqual(0);
      expect(i.high).toBeLessThanOrEqual(1);
      expect(i.low).toBeLessThanOrEqual(i.high);
    }
  });

  it("formats readably", () => {
    expect(formatInterval(wilson(1, 10))).toMatch(/^10\.0% \[1\.8, 40\.4\]$/);
  });
});

describe("summarize", () => {
  it("uses the n-1 denominator", () => {
    // [2,4,4,4,5,5,7,9]: mean 5, population sd 2, sample sd 2.138...
    const s = summarize([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(s.mean).toBeCloseTo(5, 10);
    expect(s.sd).toBeCloseTo(2.13809, 4);
  });

  it("handles degenerate inputs without dividing by zero", () => {
    expect(summarize([])).toEqual({ n: 0, mean: 0, sd: 0 });
    expect(summarize([7])).toEqual({ n: 1, mean: 7, sd: 0 });
  });
});

describe("normalQuantile and erfc", () => {
  it("reproduces standard normal quantiles", () => {
    expect(normalQuantile(0.5)).toBeCloseTo(0, 9);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.95)).toBeCloseTo(1.644854, 5);
    expect(normalQuantile(0.99)).toBeCloseTo(2.326348, 5);
    expect(normalQuantile(0.025)).toBeCloseTo(-1.959964, 5);
  });

  it("erfc matches known values", () => {
    expect(erfc(0)).toBeCloseTo(1, 6);
    expect(erfc(1)).toBeCloseTo(0.157299, 5);
    expect(erfc(-1)).toBeCloseTo(1.842701, 5);
  });

  it("rejects out-of-range probabilities", () => {
    expect(() => normalQuantile(0)).toThrow();
    expect(() => normalQuantile(1)).toThrow();
  });
});

describe("tStarForK, the multiple-testing threshold", () => {
  it("gives 2.0 for a single comparison, matching the convention SPEC.md 5.2 borrows", () => {
    expect(tStarForK(1)).toBeCloseTo(2.0, 3);
  });

  it("gives about 2.67 for six, as SPEC.md 5.2 states", () => {
    expect(tStarForK(6)).toBeCloseTo(2.67, 2);
  });

  it("rises with K, so more desks means a higher bar rather than more chances", () => {
    expect(tStarForK(10)).toBeGreaterThan(tStarForK(6));
    expect(tStarForK(6)).toBeGreaterThan(tStarForK(1));
  });

  it("refuses K below 1", () => {
    expect(() => tStarForK(0)).toThrow();
  });
});

describe("studentTCdf", () => {
  it("is symmetric about zero", () => {
    expect(studentTCdf(0, 10)).toBeCloseTo(0.5, 9);
    expect(studentTCdf(1.5, 10) + studentTCdf(-1.5, 10)).toBeCloseTo(1, 8);
  });

  it("matches textbook critical values", () => {
    // t(0.95, df=10) = 1.8125, so the CDF there is 0.95.
    expect(studentTCdf(1.8125, 10)).toBeCloseTo(0.95, 3);
    // t(0.975, df=20) = 2.086.
    expect(studentTCdf(2.086, 20)).toBeCloseTo(0.975, 3);
    // t(0.99, df=5) = 3.3649.
    expect(studentTCdf(3.3649, 5)).toBeCloseTo(0.99, 3);
  });

  it("approaches the normal as df grows", () => {
    expect(studentTCdf(1.96, 10000)).toBeCloseTo(0.975, 3);
  });
});

describe("pairedT", () => {
  it("computes t on a known series", () => {
    // differences [1,2,3,4,5]: mean 3, sd 1.5811, se 0.7071, t = 4.2426
    const r = pairedT([1, 2, 3, 4, 5]);
    expect(r.mean).toBeCloseTo(3, 10);
    expect(r.sd).toBeCloseTo(1.58114, 4);
    expect(r.t).toBeCloseTo(4.24264, 4);
    expect(r.df).toBe(4);
    expect(r.pOneSided).toBeLessThan(0.01);
  });

  it("reports no significance for a mean of zero", () => {
    const r = pairedT([-2, -1, 0, 1, 2]);
    expect(r.mean).toBeCloseTo(0, 10);
    expect(r.t).toBeCloseTo(0, 10);
    expect(r.pOneSided).toBeCloseTo(0.5, 6);
  });

  it("does not report infinite significance when the spread is zero", () => {
    // Every difference identical. Dividing by a zero standard error would give t = Infinity
    // and p = 0, which would be the most dramatic and least true output available.
    const r = pairedT([5, 5, 5, 5]);
    expect(r.sd).toBe(0);
    expect(r.t).toBe(0);
    expect(r.pOneSided).toBe(0.5);
  });

  it("handles fewer than two observations", () => {
    expect(pairedT([]).t).toBe(0);
    expect(pairedT([3]).t).toBe(0);
  });

  it("a negative mean gives a one-sided p above a half", () => {
    expect(pairedT([-1, -2, -3, -4, -5]).pOneSided).toBeGreaterThan(0.99);
  });
});

describe("proportionDifference", () => {
  it("is zero when both proportions are equal", () => {
    expect(proportionDifference(5, 10, 5, 10).point).toBeCloseTo(0, 10);
  });

  it("gives the right sign and point estimate", () => {
    // plain 8/10 attacked successfully, ebi 1/10: a difference of 0.7.
    const d = proportionDifference(8, 10, 1, 10);
    expect(d.point).toBeCloseTo(0.7, 10);
    expect(d.low).toBeGreaterThan(0);
  });

  it("does not exclude zero on the counts this study will actually have", () => {
    // 3 of 10 against 1 of 10 looks like a result and is not one. This is the test that
    // stops the first sim run being written up as a finding.
    const d = proportionDifference(3, 10, 1, 10);
    expect(d.point).toBeCloseTo(0.2, 10);
    expect(excludesZero(d)).toBe(false);
  });

  it("excludes zero once the separation is large enough", () => {
    expect(excludesZero(proportionDifference(90, 100, 10, 100))).toBe(true);
  });

  it("widens when either sample is small", () => {
    const small = proportionDifference(8, 10, 1, 10);
    const large = proportionDifference(80, 100, 10, 100);
    expect(small.high - small.low).toBeGreaterThan(large.high - large.low);
  });
});
