/**
 * Security regressions for the scorecard: CSV annualisation, bad numbers, spreadsheet
 * formula injection, and prototype-keyed accumulators. Each failed before its fix.
 */

import { describe, expect, it } from "vitest";
import type { Receipt } from "@krexa-ual/sdk";

import {
  attackInfluence,
  cleanBlockRates,
  dailyCsv,
  dailyRows,
  pairedOpeningDifference,
  summaryCsv,
  type DecisionRow,
} from "../src/index.js";
import { pairedT, summarize, tStarForK } from "../src/stats.js";

const NS = 86_400_000_000_000n;
const OPTS = { deskId: "d", mode: "paper", contractId: "c", dataSnapshotHash: "x", generatedAt: "t" };

function mark(day: number, equity: string, over: Partial<Receipt> = {}): Receipt {
  return {
    v: 1, deskId: "d", seq: day, kind: "MARK", ts: (BigInt(day) * NS + 1n).toString(), mode: "paper",
    equityUsd: equity, control: null, hash: "h" + day, verdict: "NA", ...over,
  } as unknown as Receipt;
}
const field = (csv: string, name: string) =>
  csv.split("\n").find((l) => l.startsWith(name + ","))!.split(",");

describe("summaryCsv annualisation", () => {
  // 30 marks, one every 10 days, +1% per mark: 291 days elapsed, not 30.
  const sparse = Array.from({ length: 30 }, (_, i) => mark(20000 + i * 10, String(Math.round(1e9 * 1.01 ** i))));
  const dense = Array.from({ length: 30 }, (_, i) => mark(20000 + i, String(Math.round(1e9 * 1.01 ** i))));

  it("annualises over elapsed days, not the number of marks", () => {
    const csv = summaryCsv(sparse, OPTS);
    const ann = Number(field(csv, "annualized_return")[1]);
    const cumulative = 1.01 ** 29 - 1;
    expect(ann).toBeCloseTo((1 + cumulative) ** (365 / 291) - 1, 3);
    expect(field(csv, "days_spanned")[1]).toBe("291");
  });
  it("still reads 30 dense days as enough", () => {
    expect(field(summaryCsv(dense, OPTS), "annualized_return")[1]).not.toBe("");
  });
  it("is not assessable below 30 elapsed days", () => {
    const few = [mark(20000, "1000000000"), mark(20001, "1010000000")];
    expect(field(summaryCsv(few, OPTS), "annualized_return")[1]).toBe("");
  });
});

describe("receipt number validation", () => {
  it("throws clearly on a junk equity instead of producing NaN", () => {
    expect(() => dailyRows([mark(1, "1000000"), mark(2, "junk")], "paper")).toThrow(/equityUsd/);
    expect(() => dailyRows([mark(1, "1e9")], "paper")).toThrow(/equityUsd/);
  });
  it("throws clearly on an out-of-range ts", () => {
    expect(() => dailyRows([mark(1, "1000000", { ts: "99999999999999999999999" })], "paper")).toThrow(/ts/);
    expect(() => dailyRows([mark(1, "1000000", { ts: "0x10" })], "paper")).toThrow(/ts/);
  });
  it("throws on a junk flow detail", () => {
    const flow = mark(1, "1", { kind: "CONTROL", control: { action: "flow", detail: "abc" } as never });
    expect(() => dailyRows([flow], "paper")).toThrow(/flow/);
  });
  it("accepts negative integer equity text", () => {
    expect(() => dailyRows([mark(1, "-5")], "paper")).not.toThrow();
  });
});

describe("csv output safety", () => {
  it("quotes a desk id holding a newline and commas, so it stays one cell", () => {
    const rows = summaryCsv([], { ...OPTS, deskId: "x\nmet,yes,," }).split("\n");
    expect(rows[1]).toBe('desk_id,"x');
    expect(rows[2]).toBe('met,yes,,",,');
  });
  it("defuses formula prefixes in text cells", () => {
    for (const bad of ["=1+1", "+1", "-1", "@SUM(A1)"]) {
      const line = summaryCsv([], { ...OPTS, deskId: bad }).split("\n")[1]!;
      expect(line).toBe(`desk_id,'${bad},,`);
    }
  });
  it("defuses a hostile mode and head hash in the daily file but leaves negative returns alone", () => {
    const rs = [
      mark(1, "1000000", { mode: "=cmd" as never, hash: "@x" }),
      mark(2, "500000", { mode: "=cmd" as never, hash: "@y" }),
    ];
    const lines = dailyCsv(rs, "=cmd").trim().split("\n");
    expect(lines[2]).toContain(",'=cmd,");
    expect(lines[2]).toContain(",'@y");
    expect(lines[2]).toContain(",-0.500000,"); // a real negative number, not text
  });
});

const row = (over: Partial<DecisionRow>): DecisionRow => ({
  point: "p", deskId: "a", attack: null, priorAction: "HOLD", action: "OPEN_LONG", verdict: "REJECTED", ...over,
});

describe("prototype-keyed accumulators", () => {
  it("counts a reason named after an Object.prototype member as a count", () => {
    const br = cleanBlockRates([row({ reasons: ["toString", "R_X", "R_X", "constructor"] })]);
    expect(br[0]!.reasons.toString).toBe(1);
    expect(br[0]!.reasons.constructor).toBe(1);
    expect(br[0]!.reasons.R_X).toBe(2);
  });
  it("does not invent a paired point for a desk named after a prototype member", () => {
    const rows = [row({ deskId: "b", verdict: "APPROVED" })];
    expect(pairedOpeningDifference(rows, "constructor", "b").n).toBe(0);
  });
  it("does not read priorAction 'constructor' as a moved decision", () => {
    const r = row({ attack: "x", priorAction: "constructor" as never, action: "OPEN_LONG", verdict: "APPROVED" });
    expect(attackInfluence([r])[0]!.moved).toBe(0);
  });
});

describe("finite guards", () => {
  it("summarize and pairedT refuse NaN and Infinity", () => {
    expect(() => summarize([1, NaN])).toThrow(/finite/);
    expect(() => pairedT([1, Infinity, 2])).toThrow(/finite/);
  });
  it("tStarForK refuses NaN", () => {
    expect(() => tStarForK(NaN)).toThrow();
    expect(() => tStarForK(Infinity)).toThrow();
  });
});
