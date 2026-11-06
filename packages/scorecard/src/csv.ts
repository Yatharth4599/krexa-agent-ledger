/**
 * Allocator CSV export. SPEC.md 11.
 *
 * Two files per desk and mode: a daily series and a summary. They open in Excel, which is the
 * actual requirement, and every column is computed from receipts.
 *
 * ## The one thing this must not do
 *
 * SPEC.md 11 mentions a public allocator bar (15% annualised, max drawdown under 10%,
 * return-to-drawdown at least 1.5x). Those thresholds appear in the summary as **reference
 * values only**, with the computed figure beside them and a `met` column that stays
 * `not assessable` until there are at least 30 days of marks.
 *
 * Nothing in this repo claims that Krexa or any desk meets that bar. With days rather than
 * months of data, a filled-in `met` column would be the single most misleading cell we could
 * produce, so it is left explicitly unassessable rather than computed from too little data.
 */

import type { Receipt } from "@krexa-ual/sdk";

/** Days in nanoseconds, for the UTC day bucket. */
const NS_PER_DAY = 86_400_000_000_000n;

export interface DailyRow {
  date: string;
  mode: string;
  equityUsd: string;
  netFlowUsd: string;
  dailyReturn: string;
  navIndex: string;
  drawdown: string;
  marks: number;
  intents: number;
  rejected: number;
  fillsVerifiedPct: string;
  headSeq: number;
  headHash: string;
}

function microUsdToDecimal(micro: string): string {
  const neg = micro.startsWith("-");
  const digits = (neg ? micro.slice(1) : micro).padStart(7, "0");
  const whole = digits.slice(0, -6);
  const frac = digits.slice(-6, -4);
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

function utcDate(tsNs: string): string {
  const ms = Number(BigInt(tsNs) / 1_000_000n);
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Build the daily series for one desk and mode.
 *
 * A day with no MARK is a **gap**, not a zero return. SPEC.md 5.1 is explicit about this, and
 * it matters: treating a missing day as flat would quietly improve every drawdown figure.
 * Gap days are simply absent from the output rather than interpolated.
 */
export function dailyRows(receipts: Receipt[], mode: string): DailyRow[] {
  const inMode = receipts.filter((r) => r.mode === mode);
  if (inMode.length === 0) return [];

  const byDay = new Map<string, Receipt[]>();
  for (const r of inMode) {
    const day = (BigInt(r.ts) / NS_PER_DAY).toString();
    const list = byDay.get(day) ?? [];
    list.push(r);
    byDay.set(day, list);
  }

  const rows: DailyRow[] = [];
  let navIndex = 1;
  let peak = 1;
  let prevEquity: number | null = null;

  for (const [, dayReceipts] of [...byDay.entries()].sort((a, b) =>
    BigInt(a[0]) < BigInt(b[0]) ? -1 : 1,
  )) {
    const marks = dayReceipts.filter((r) => r.kind === "MARK");
    if (marks.length === 0) continue; // a day with no mark is a gap, not a zero

    const last = marks[marks.length - 1]!;
    const equityMicro = last.equityUsd ?? "0";
    const equity = Number(equityMicro) / 1_000_000;

    const flows = dayReceipts
      .filter((r) => r.kind === "CONTROL" && (r.control as { action?: string })?.action === "flow")
      .map((r) => Number((r.control as { detail: string }).detail) / 1_000_000);
    const netFlow = flows.reduce((a, b) => a + b, 0);

    // Flow-adjusted daily return, SPEC.md 5.1: r_d = (E_d - F_d) / E_{d-1} - 1.
    // A deposit must not read as profit.
    let dailyReturn = 0;
    if (prevEquity !== null && prevEquity !== 0) {
      dailyReturn = (equity - netFlow) / prevEquity - 1;
    }
    navIndex *= 1 + dailyReturn;
    peak = Math.max(peak, navIndex);
    const drawdown = peak > 0 ? 1 - navIndex / peak : 0;

    const intents = dayReceipts.filter((r) => r.kind === "INTENT");
    const rejected = intents.filter((r) => r.verdict === "REJECTED");
    const fills = dayReceipts.filter((r) => r.kind === "FILL");

    rows.push({
      date: utcDate(last.ts),
      mode,
      equityUsd: microUsdToDecimal(equityMicro),
      netFlowUsd: netFlow.toFixed(2),
      dailyReturn: dailyReturn.toFixed(6),
      navIndex: navIndex.toFixed(6),
      drawdown: drawdown.toFixed(6),
      marks: marks.length,
      intents: intents.length,
      rejected: rejected.length,
      // Paper fills reference an operator-reported price, so there is nothing to verify
      // against a venue. Saying n/a is honest; 100% would not be.
      fillsVerifiedPct: mode === "paper" ? "n/a" : fills.length ? "0" : "n/a",
      headSeq: last.seq,
      headHash: last.hash,
    });
    prevEquity = equity;
  }
  return rows;
}

const DAILY_HEADER = [
  "date",
  "mode",
  "equity_usd",
  "net_flow_usd",
  "daily_return",
  "nav_index",
  "drawdown",
  "marks",
  "intents",
  "rejected",
  "fills_verified_pct",
  "head_seq",
  "head_hash",
].join(",");

export function dailyCsv(receipts: Receipt[], mode: string): string {
  const rows = dailyRows(receipts, mode);
  const body = rows.map((r) =>
    [
      r.date,
      r.mode,
      r.equityUsd,
      r.netFlowUsd,
      r.dailyReturn,
      r.navIndex,
      r.drawdown,
      r.marks,
      r.intents,
      r.rejected,
      r.fillsVerifiedPct,
      r.headSeq,
      r.headHash,
    ].join(","),
  );
  return `${DAILY_HEADER}\n${body.join("\n")}${body.length ? "\n" : ""}`;
}

export interface SummaryOptions {
  deskId: string;
  mode: string;
  contractId: string;
  dataSnapshotHash: string;
  generatedAt: string;
}

/** The public reference thresholds from SPEC.md 11. Reference values, never claims. */
const REFERENCE_BAR = [
  { metric: "annualized_return", threshold: ">= 15%" },
  { metric: "max_drawdown", threshold: "<= 10%" },
  { metric: "return_to_drawdown", threshold: ">= 1.5x" },
];

/**
 * The summary CSV.
 *
 * Fields that need 30 days of marks are left **blank** rather than computed from fewer. A
 * number there would be arithmetic performed on too little data, which looks like a result and
 * is not one.
 */
export function summaryCsv(receipts: Receipt[], opts: SummaryOptions): string {
  const rows = dailyRows(receipts, opts.mode);
  const days = rows.length;
  const enough = days >= 30;

  const cumulative = rows.length ? Number(rows[rows.length - 1]!.navIndex) - 1 : 0;
  const maxDrawdown = rows.reduce((m, r) => Math.max(m, Number(r.drawdown)), 0);
  const annualized = enough ? (1 + cumulative) ** (365 / days) - 1 : null;
  const rtd = enough && maxDrawdown > 0 ? (annualized as number) / maxDrawdown : null;

  const intents = receipts.filter((r) => r.kind === "INTENT" && r.mode === opts.mode);
  const rejected = intents.filter((r) => r.verdict === "REJECTED");

  const out: string[] = [];
  out.push("field,value,reference_threshold,met");
  const line = (field: string, value: string, threshold = "", met = "") =>
    out.push(`${field},${value},${threshold},${met}`);

  line("desk_id", opts.deskId);
  line("mode", opts.mode);
  line("contract_id", opts.contractId);
  line("days_with_a_mark", String(days));
  line("cumulative_return", rows.length ? cumulative.toFixed(6) : "");
  line(
    "annualized_return",
    annualized === null ? "" : annualized.toFixed(6),
    REFERENCE_BAR[0]!.threshold,
    enough ? (annualized !== null && annualized >= 0.15 ? "yes" : "no") : "not assessable",
  );
  line(
    "max_drawdown",
    rows.length ? maxDrawdown.toFixed(6) : "",
    REFERENCE_BAR[1]!.threshold,
    enough ? (maxDrawdown <= 0.1 ? "yes" : "no") : "not assessable",
  );
  line(
    "return_to_drawdown",
    rtd === null ? "" : rtd.toFixed(6),
    REFERENCE_BAR[2]!.threshold,
    enough ? (rtd !== null && rtd >= 1.5 ? "yes" : "no") : "not assessable",
  );
  line("intents", String(intents.length));
  line("breaches_blocked", String(rejected.length));
  line(
    "breach_rate",
    intents.length ? (rejected.length / intents.length).toFixed(6) : "",
  );
  line("skill_verdict", "CANT_TELL_YET");
  line("days_needed_for_significance", "not reachable at the current rate");
  line("receipts", String(receipts.filter((r) => r.mode === opts.mode).length));
  line("data_snapshot_sha256", opts.dataSnapshotHash);
  line("generated_at", opts.generatedAt);
  line("attested_evidence", "false");
  line("audited", "false");

  out.push("");
  out.push("# Notes, which are part of the data and not decoration");
  out.push(
    "# The reference thresholds above are a public allocator bar cited in SPEC.md 11. They are " +
      "reference values.",
  );
  out.push(
    "# Nothing in this file claims that this desk or Krexa meets that bar. With fewer than 30 " +
      "days of marks the",
  );
  out.push(
    "# met column reads 'not assessable' and the annualised and return-to-drawdown fields are " +
      "left blank, because",
  );
  out.push("# computing them from days rather than months would look like a result and would not be one.");
  out.push(
    `# ${opts.mode === "paper" ? "Paper equity is operator-reported. It is not proof of anything except the operator's commitment over time." : "Live fills must reference settlement; see fills_verified_pct."}`,
  );
  out.push("# A day with no equity mark is a gap, not a zero return, and is absent from the daily file.");
  out.push("# Evidence in this build is unattested. Every receipt carries attested: false.");
  out.push("# This contract is unaudited and runs on testnet only.");
  out.push("# Records of what agents did. Not investment advice.");
  out.push("");

  return out.join("\n");
}
