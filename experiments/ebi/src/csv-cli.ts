/**
 * `pnpm allocator-csv`: write the two allocator files for a desk and mode.
 *
 * Reads receipts from the most recent local run, or from the chain with --chain.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dailyCsv, summaryCsv } from "@krexa-ual/scorecard";
import { sha256Hex, type Receipt } from "@krexa-ual/sdk";

const REPO = join(import.meta.dirname, "..", "..", "..");
const RESULTS = join(REPO, "experiments", "ebi", "results");
const OUT = join(REPO, "experiments", "ebi", "allocator");

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const deskId = arg("desk", "ebi");
const mode = arg("mode", "paper");
const contractId = process.env.UAL_CONTRACT_ID ?? "ual.krexa-ual.testnet";

const runs = existsSync(RESULTS) ? readdirSync(RESULTS).sort() : [];
const runId = arg("run", runs[runs.length - 1] ?? "");
if (!runId) {
  console.error(`no runs in ${RESULTS}. Run one first:\n  pnpm runtime:sim`);
  process.exit(1);
}
const path = join(RESULTS, runId, `${deskId}.receipts.jsonl`);
if (!existsSync(path)) {
  console.error(`no receipts for desk "${deskId}" in ${runId}`);
  process.exit(1);
}
const raw = readFileSync(path, "utf8");
const receipts = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Receipt);

mkdirSync(OUT, { recursive: true });
const daily = join(OUT, `${deskId}_${mode}_daily.csv`);
const summary = join(OUT, `${deskId}_${mode}_summary.csv`);
writeFileSync(daily, dailyCsv(receipts, mode));
writeFileSync(
  summary,
  summaryCsv(receipts, {
    deskId,
    mode,
    contractId,
    dataSnapshotHash: sha256Hex(raw),
    generatedAt: new Date().toISOString(),
  }),
);

console.log(`wrote ${daily}`);
console.log(`wrote ${summary}`);
console.log("");
console.log("The met column reads 'not assessable' until there are 30 days of marks, and the");
console.log("annualised and return-to-drawdown fields stay blank. Nothing in these files claims");
console.log("that any desk meets the allocator bar they cite as a reference.");
