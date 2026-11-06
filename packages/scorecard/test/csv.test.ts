/**
 * Allocator CSV tests.
 *
 * The important ones are about what must NOT appear: a filled-in `met` column, a zero return
 * on a day with no mark, and a verified-fills percentage for paper trading. Each of those
 * would read as a result and would not be one.
 */

import { describe, expect, it } from "vitest";

import { dailyCsv, dailyRows, summaryCsv } from "../src/index.js";
import type { Receipt } from "@krexa-ual/sdk";

const DAY = 86_400_000_000_000n;
const START = 1_762_300_000_000_000_000n;

function receipt(over: Partial<Receipt> & { ts: string }): Receipt {
  return {
    v: 1,
    deskId: "ebi",
    seq: 1,
    kind: "MARK",
    blockHeight: "1",
    agent: "trader.ebi.testnet",
    policyHash: "a".repeat(64),
    mode: "paper",
    intent: null,
    verdict: "NA",
    reasons: [],
    fillRef: null,
    intentSeq: null,
    equityUsd: "10000000000",
    drawdownBps: 0,
    dailyPnlUsd: "0",
    decisionHash: null,
    decisionsRoot: null,
    aiSigHash: null,
    evidenceReceiptSeq: null,
    sizeMultiplierBps: null,
    evidence: null,
    control: null,
    prevHash: "0".repeat(64),
    hash: "1".repeat(64),
    ...over,
  } as Receipt;
}

function markOn(dayOffset: number, equityMicro: string, seq = 1): Receipt {
  return receipt({
    ts: (START + BigInt(dayOffset) * DAY).toString(),
    kind: "MARK",
    equityUsd: equityMicro,
    seq,
  });
}

describe("daily rows", () => {
  it("computes a flow-adjusted return", () => {
    const rows = dailyRows([markOn(0, "10000000000"), markOn(1, "10100000000", 2)], "paper");
    expect(rows).toHaveLength(2);
    // First day has no prior equity, so no return.
    expect(Number(rows[0]!.dailyReturn)).toBe(0);
    expect(Number(rows[1]!.dailyReturn)).toBeCloseTo(0.01, 6);
  });

  it("does NOT treat a deposit as profit", () => {
    // Equity rises from 10,000 to 11,000 entirely because of a 1,000 deposit. The return must
    // be zero, not 10%.
    const flow = receipt({
      ts: (START + DAY).toString(),
      kind: "CONTROL",
      seq: 2,
      control: { action: "flow", detail: "1000000000" },
    });
    const rows = dailyRows([markOn(0, "10000000000"), flow, markOn(1, "11000000000", 3)], "paper");
    expect(Number(rows[1]!.dailyReturn)).toBeCloseTo(0, 6);
    expect(rows[1]!.netFlowUsd).toBe("1000.00");
  });

  it("omits a day with no mark rather than calling it a zero return", () => {
    // SPEC.md 5.1: no history is not 0%. Interpolating a flat day would quietly improve
    // every drawdown figure.
    const rows = dailyRows([markOn(0, "10000000000"), markOn(5, "9000000000", 2)], "paper");
    expect(rows).toHaveLength(2);
    expect(rows[1]!.date).not.toBe(rows[0]!.date);
  });

  it("tracks drawdown against the running peak", () => {
    const rows = dailyRows(
      [markOn(0, "10000000000"), markOn(1, "11000000000", 2), markOn(2, "9900000000", 3)],
      "paper",
    );
    // Up 10%, then down 10% from the peak.
    expect(Number(rows[2]!.drawdown)).toBeGreaterThan(0.09);
  });

  it("never blends modes", () => {
    const live = receipt({ ts: (START + DAY).toString(), mode: "live", seq: 2 });
    const rows = dailyRows([markOn(0, "10000000000"), live], "paper");
    expect(rows).toHaveLength(1);
  });

  it("reports n/a for verified fills in paper mode", () => {
    // A paper fill references an operator-reported price, so there is nothing to verify
    // against a venue. 100% would be a lie.
    const rows = dailyRows([markOn(0, "10000000000")], "paper");
    expect(rows[0]!.fillsVerifiedPct).toBe("n/a");
  });
});

describe("daily csv", () => {
  it("has the header SPEC.md 11 specifies and opens as CSV", () => {
    const csv = dailyCsv([markOn(0, "10000000000")], "paper");
    const [header, first] = csv.split("\n");
    expect(header).toBe(
      "date,mode,equity_usd,net_flow_usd,daily_return,nav_index,drawdown,marks,intents,rejected,fills_verified_pct,head_seq,head_hash",
    );
    expect(first!.split(",")).toHaveLength(13);
  });

  it("formats micro-USD as decimal dollars", () => {
    const csv = dailyCsv([markOn(0, "10000000000")], "paper");
    expect(csv).toContain("10000.00");
  });

  it("produces only a header when there is nothing to report", () => {
    expect(dailyCsv([], "paper").trim().split("\n")).toHaveLength(1);
  });
});

describe("summary csv", () => {
  const opts = {
    deskId: "ebi",
    mode: "paper",
    contractId: "ual.krexa-ual.testnet",
    dataSnapshotHash: "f".repeat(64),
    generatedAt: "2026-11-07T00:00:00Z",
  };

  it("leaves the met column not assessable below 30 days", () => {
    // The single most misleading cell this file could contain.
    const csv = summaryCsv([markOn(0, "10000000000"), markOn(1, "11000000000", 2)], opts);
    const lines = csv.split("\n");
    for (const field of ["annualized_return", "max_drawdown", "return_to_drawdown"]) {
      const row = lines.find((l) => l.startsWith(field))!;
      expect(row, field).toContain("not assessable");
    }
  });

  it("leaves annualized return and return-to-drawdown blank below 30 days", () => {
    const csv = summaryCsv([markOn(0, "10000000000"), markOn(1, "11000000000", 2)], opts);
    const ann = csv.split("\n").find((l) => l.startsWith("annualized_return"))!;
    // field,value,threshold,met -> the value must be empty
    expect(ann.split(",")[1]).toBe("");
  });

  it("fills them in once there are 30 days", () => {
    const marks = Array.from({ length: 30 }, (_, i) =>
      markOn(i, String(10_000_000_000 + i * 20_000_000), i + 1),
    );
    const csv = summaryCsv(marks, opts);
    const ann = csv.split("\n").find((l) => l.startsWith("annualized_return"))!;
    expect(ann.split(",")[1]).not.toBe("");
    expect(ann).not.toContain("not assessable");
  });

  it("always reports CANT_TELL_YET for skill", () => {
    const csv = summaryCsv([markOn(0, "10000000000")], opts);
    expect(csv).toContain("skill_verdict,CANT_TELL_YET");
  });

  it("states that nothing here claims the allocator bar is met", () => {
    const csv = summaryCsv([markOn(0, "10000000000")], opts);
    expect(csv).toMatch(/Nothing in this file claims that this desk or Krexa meets that bar/);
    expect(csv).toMatch(/reference values/);
  });

  it("declares that evidence is unattested and the contract unaudited", () => {
    const csv = summaryCsv([markOn(0, "10000000000")], opts);
    expect(csv).toContain("attested_evidence,false");
    expect(csv).toContain("audited,false");
  });

  it("carries the data snapshot hash, so a reader can tell which data it came from", () => {
    expect(summaryCsv([markOn(0, "10000000000")], opts)).toContain("f".repeat(64));
  });

  it("counts blocked breaches and the breach rate", () => {
    const approved = receipt({ ts: START.toString(), kind: "INTENT", verdict: "APPROVED", seq: 2 });
    const refused = receipt({
      ts: START.toString(),
      kind: "INTENT",
      verdict: "REJECTED",
      reasons: ["R_UNCORROBORATED"],
      seq: 3,
    });
    const csv = summaryCsv([markOn(0, "10000000000"), approved, refused], opts);
    expect(csv).toContain("intents,2");
    expect(csv).toContain("breaches_blocked,1");
    expect(csv).toContain("breach_rate,0.500000");
  });
});
