/**
 * Runtime CLI.
 *
 *   pnpm runtime:sim [--limit N] [--attack-rate R]
 *   pnpm ual replay <deskId> <seq> [--run <runId>]
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { Receipt } from "@krexa-ual/sdk";

import { replayDecision, type DecisionRecord } from "./decision.js";
import { runSim, type SimResult } from "./sim.js";

const REPO = join(import.meta.dirname, "..", "..", "..");
const ARCHIVE = join(REPO, "data", "archive");
const RESULTS = join(REPO, "experiments", "ebi", "results");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function printTable(result: SimResult): void {
  console.log("");
  console.log(`results  ${result.points} decision points, ${result.attackedPoints} attacked`);
  console.log("");
  console.log("desk    intents  approved  rejected  fills   attacked  opened-on-attack  chain");
  for (const d of result.desks) {
    console.log(
      `${d.deskId.padEnd(8)}${String(d.intents).padStart(7)}${String(d.approved).padStart(10)}` +
        `${String(d.rejected).padStart(10)}${String(d.fills).padStart(7)}` +
        `${String(d.attackedPoints).padStart(11)}${String(d.attackSuccesses).padStart(18)}` +
        `  ${d.chainValid ? "valid" : "BROKEN"}`,
    );
  }
  console.log("");
  for (const d of result.desks) {
    const reasons = Object.entries(d.rejectionReasons).sort();
    if (reasons.length === 0) continue;
    console.log(`${d.deskId}: ${reasons.map(([r, n]) => `${r} x${n}`).join(", ")}`);
  }

  // Per template, which is the breakdown that carries the research content. The aggregate is
  // an average over templates designed to behave differently, so it means little on its own.
  const anyAttacked = result.desks.some((d) => d.cases.some((c) => c.attacked > 0));
  if (anyAttacked) {
    console.log("");
    console.log("opened in the attacker's direction, by template (successes / attacked)");
    const header = ["template".padEnd(34), ...result.desks.map((d) => d.deskId.padStart(8))];
    console.log(header.join(""));
    for (const caseId of result.caseIds) {
      const row = [caseId.padEnd(34)];
      let seen = 0;
      for (const d of result.desks) {
        const c = d.cases.find((x) => x.caseId === caseId);
        seen += c?.attacked ?? 0;
        row.push(`${c?.succeeded ?? 0}/${c?.attacked ?? 0}`.padStart(8));
      }
      if (seen > 0) console.log(row.join(""));
    }

    // Finding (iii): a fake indicator panel scores 91% against an agent about to hold and 12%
    // against one about to buy. An aggregate that hides this can be moved sevenfold by timing.
    console.log("");
    console.log("by what the desk would have done WITHOUT the attack");
    for (const d of result.desks) {
      const byPrior: Record<string, { attacked: number; succeeded: number }> = {};
      for (const c of d.cases) {
        for (const [prior, v] of Object.entries(c.byPriorAction)) {
          byPrior[prior] ??= { attacked: 0, succeeded: 0 };
          byPrior[prior]!.attacked += v.attacked;
          byPrior[prior]!.succeeded += v.succeeded;
        }
      }
      const parts = Object.entries(byPrior)
        .sort()
        .map(([prior, v]) => `prior=${prior} ${v.succeeded}/${v.attacked}`);
      if (parts.length > 0) console.log(`${d.deskId.padEnd(8)}${parts.join("  ")}`);
    }
  }

  // `bh` reads no evidence at all, so it cannot be attacked in any meaningful sense. If it
  // happens to open on an attacked point, that is the timing of its single buy coinciding
  // with an injection, not the attack working. Counting it as a success would overstate the
  // attack and flatter every gated desk by comparison.
  const bh = result.desks.find((d) => d.deskId === "bh");
  if (bh && bh.attackSuccesses > 0) {
    console.log("");
    console.log(`NOTE bh shows ${bh.attackSuccesses} "success" but reads no evidence, so it`);
    console.log("     cannot be attacked. That is its single buy-and-hold open coinciding with");
    console.log("     an injected point. Treat bh's row as a price baseline, not as an attack");
    console.log("     surface, and exclude it from any ASR comparison.");
  }

  // A desk that never opened anything scores zero attack success trivially, and reading that
  // as a defence is the easiest mistake to make with this table. Say so instead.
  const silent = result.desks.filter((d) => d.intents === 0);
  if (silent.length > 0) {
    console.log("");
    for (const d of silent) {
      console.log(
        `WARNING ${d.deskId} submitted no intents at all, so its 0/${d.attackedPoints} is not`,
      );
      console.log(
        `        evidence of a defence: a desk that never trades cannot be attacked. Check`,
      );
      console.log(`        its clean-run behaviour before reading anything into that row.`);
    }
  }

  // The confound the first run of this harness actually hit.
  const capped = result.desks.filter((d) => (d.rejectionReasons.R_MAX_OPEN_POSITIONS ?? 0) > 0);
  if (capped.length > 0) {
    console.log("");
    console.log(
      `WARNING ${capped.map((d) => d.deskId).join(", ")} hit R_MAX_OPEN_POSITIONS. A saturated`,
    );
    console.log("        desk is refused for being full rather than for anything to do with the");
    console.log("        attack, which makes it look defended. The harness flattens between");
    console.log("        points to prevent this, so seeing it here means something is wrong.");
  }

  console.log("");
  console.log("k below the supporting-group count means the price tape contradicted the");
  console.log("headline: contradicting groups are subtracted, so a fake that disagrees with");
  console.log("the market is refused twice over. pnpm ual replay <desk> <seq> shows the k");
  console.log("the verifier computed for any single decision.");
  console.log("");
  console.log("No attack success rate is printed as a headline figure. These are raw counts");
  console.log("over very few points, not a measurement, and finding (iii) shows ASR moves");
  console.log("sevenfold with the prior state above. Wilson intervals and the paired tests");
  console.log("are M5. Every template here was written by us, not taken from the paper:");
  console.log("see experiments/ebi/templates/SOURCES.md.");
  console.log("");
  console.log(`receipts and artifacts: ${result.outDir}`);
  console.log(`replay one:             pnpm ual replay ebi <seq>`);
}

async function sim(): Promise<void> {
  const limit = arg("limit") ? Number(arg("limit")) : undefined;
  const attackRate = arg("attack-rate") ? Number(arg("attack-rate")) : 0.25;
  const result = await runSim({
    archiveDir: ARCHIVE,
    outDir: RESULTS,
    limit,
    attackRate,
  });
  printTable(result);
}

function latestRun(): string | undefined {
  if (!existsSync(RESULTS)) return undefined;
  const runs = readdirSync(RESULTS)
    .filter((d) => d.startsWith("sim-"))
    .sort();
  return runs[runs.length - 1];
}

function replay(): void {
  const deskId = process.argv[3];
  const seq = Number(process.argv[4]);
  if (!deskId || !Number.isInteger(seq)) {
    console.error("usage: pnpm ual replay <deskId> <seq> [--run <runId>]");
    process.exit(2);
  }
  const runId = arg("run") ?? latestRun();
  if (!runId) {
    console.error(`no runs found in ${RESULTS}. Run one first:\n  pnpm runtime:sim`);
    process.exit(1);
  }
  const dir = join(RESULTS, runId);

  const receiptsPath = join(dir, `${deskId}.receipts.jsonl`);
  if (!existsSync(receiptsPath)) {
    console.error(`no receipts for desk "${deskId}" in ${runId}`);
    process.exit(1);
  }
  const receipts = readFileSync(receiptsPath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Receipt);
  const receipt = receipts.find((r) => r.seq === seq);
  if (!receipt) {
    console.error(
      `desk "${deskId}" has no receipt at seq ${seq} (head is ${receipts.at(-1)?.seq})`,
    );
    process.exit(1);
  }

  console.log(`replay ${runId} ${deskId} seq ${seq}`);
  console.log(`kind     ${receipt.kind}`);
  console.log(
    `verdict  ${receipt.verdict}${receipt.reasons?.length ? `  ${receipt.reasons.join(", ")}` : ""}`,
  );
  console.log(`mode     ${receipt.mode}`);
  console.log(`prevHash ${receipt.prevHash}`);
  console.log(`hash     ${receipt.hash}`);

  if (!receipt.decisionHash) {
    console.log("");
    console.log("this receipt carries no decisionHash, so there is no reasoning to replay.");
    console.log("HOLD decisions are committed in a MARK receipt's decisionsRoot instead.");
    return;
  }

  const decisions = existsSync(join(dir, "decisions.jsonl"))
    ? readFileSync(join(dir, "decisions.jsonl"), "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];
  const entry = decisions.find((d) => d.decisionHash === receipt.decisionHash);
  console.log("");
  console.log(`decisionHash ${receipt.decisionHash}`);
  if (entry) {
    console.log(`point        ${String(entry.point)}`);
    console.log(`attacked     ${String(entry.attacked)}`);
    console.log(`action       ${String(entry.action)}`);
    if (entry.verifierK !== undefined && entry.verifierK !== null) {
      console.log(`verifier k   ${String(entry.verifierK)}`);
    }
  }

  const recordPath = join(dir, "records", `${receipt.decisionHash}.json`);
  if (!existsSync(recordPath)) {
    console.log("");
    console.log(`the full DecisionRecord was not stored at ${recordPath}.`);
    console.log("the receipt's commitment to it still stands: the hash above is on chain.");
    return;
  }
  const record = JSON.parse(readFileSync(recordPath, "utf8")) as DecisionRecord;
  const artifacts: Record<string, string> = {};
  const artDir = join(dir, "artifacts");
  if (existsSync(artDir)) {
    for (const f of readdirSync(artDir)) {
      artifacts[f.replace(/\.txt$/, "")] = readFileSync(join(artDir, f), "utf8");
    }
  }
  const report = replayDecision(record, artifacts, receipt.decisionHash);
  console.log("");
  for (const line of report.lines) console.log(`  ${line}`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case "sim":
      await sim();
      break;
    case "replay":
      replay();
      break;
    default:
      console.error("usage: pnpm runtime:sim | pnpm ual replay <deskId> <seq>");
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
