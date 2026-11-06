/**
 * DecisionRecords and the consistency check. SPEC.md 3.6.
 *
 * A DecisionRecord commits an agent to the exact prompt, the exact market snapshot, the exact
 * tool calls and the exact raw model output that produced a decision, by hash, **before** the
 * outcome is known. Its hash goes on chain as `decisionHash` for a trade, or inside
 * `decisionsRoot` for a hold.
 *
 * What that proves and what it does not, stated here because it is the single most
 * over-claimable idea in the repo:
 *
 * - **Proves**: the agent had committed to this reasoning before the result existed. It cannot
 *   retrofit a thesis to a trade that happened to work, and it cannot delete the holds that
 *   would have embarrassed it, because `decisionsRoot` covers those too.
 * - **Does not prove**: that the reasoning was any good, that the model really was the one
 *   named (self-reported unless a NEAR AI Cloud signature is verified), or that the output
 *   followed from the prompt. Hashes prove commitment, not correctness. **This is not zkML.**
 *
 * The consistency check is deliberately mechanical. No LLM judges another LLM: it compares the
 * stated thesis against the order actually submitted and fails on contradiction. An agent that
 * says "bearish, stay flat" and then opens a long has malfunctioned in a way arithmetic can
 * catch, and the failure is recorded rather than hidden. SPEC.md 5.2 reports the failure rate.
 */

import { canonical, sha256Hex } from "@krexa-ual/sdk";

export type ThesisDirection = "LONG" | "SHORT" | "HOLD";
export type OrderAction = "OPEN_LONG" | "OPEN_SHORT" | "REDUCE" | "CLOSE";

export interface Thesis {
  asset: string;
  direction: ThesisDirection;
  /** Basis points of stated probability the trade is profitable at `horizonMin`. */
  confidence: number;
  horizonMin: number;
  /** The largest notional the thesis itself argues for, micro-USD decimal string. */
  maxNotionalUsd?: string;
}

export interface Order {
  action: OrderAction;
  asset: string;
  notionalUsd: string;
}

export type ConsistencyResult = "PASS" | "FAIL" | "NA";

export interface ConsistencyReport {
  result: ConsistencyResult;
  checker: "krexa.consistency/1";
  failures: string[];
}

export interface DecisionRecord {
  schema: "krexa.ual.decision/1";
  deskId: string;
  agent: string;
  /** ISO 8601 UTC. */
  decidedAt: string;
  /** `provider/model-name@version`, or `scripted/<name>@<version>` for a rule-based agent. */
  modelId: string;
  promptHash: string;
  dataSnapshotHash: string;
  toolCallsHash: string;
  rawOutputHash: string;
  parsed: {
    thesis: Thesis;
    order: Order | null;
  };
  consistency: ConsistencyReport;
  aiSig: {
    provider: string;
    sigHash: string | null;
    verified: boolean;
  };
  artifacts: {
    prompt: string;
    snapshot: string;
    toolCalls: string;
    rawOutput: string;
  };
}

/** A scripted agent cannot be inconsistent with itself, so its verdict is NA. SPEC.md 3.6. */
export function isScripted(modelId: string): boolean {
  return modelId.startsWith("scripted/");
}

/**
 * The deterministic consistency check.
 *
 * Runs on every record regardless of agent type. For a scripted agent the reported result is
 * `NA`, but the check still runs and a failure is still listed: a rule-based agent that
 * contradicts itself is a bug in our code, and silencing it would hide that.
 */
export function checkConsistency(
  thesis: Thesis,
  order: Order | null,
  opts: { modelId: string; outputParsed: boolean },
): ConsistencyReport {
  const failures: string[] = [];

  if (!opts.outputParsed) {
    failures.push("model output did not parse into a thesis and an order");
  }

  if (order) {
    if (order.asset !== thesis.asset) {
      failures.push(`order asset ${order.asset} differs from thesis asset ${thesis.asset}`);
    }

    // A HOLD thesis may still close or reduce an existing position: deciding not to hold a
    // position is not the same as deciding to open one. Only a new open contradicts a HOLD.
    const isOpen = order.action === "OPEN_LONG" || order.action === "OPEN_SHORT";
    if (thesis.direction === "HOLD" && isOpen) {
      failures.push(`thesis says HOLD but the order opens a position (${order.action})`);
    }

    if (thesis.direction === "LONG" && order.action === "OPEN_SHORT") {
      failures.push("thesis is LONG but the order opens a short");
    }
    if (thesis.direction === "SHORT" && order.action === "OPEN_LONG") {
      failures.push("thesis is SHORT but the order opens a long");
    }

    if (thesis.maxNotionalUsd && isOpen) {
      try {
        if (BigInt(order.notionalUsd) > BigInt(thesis.maxNotionalUsd)) {
          failures.push(
            `order notional ${order.notionalUsd} exceeds the ${thesis.maxNotionalUsd} the thesis argues for`,
          );
        }
      } catch {
        failures.push(`order notional ${order.notionalUsd} is not an integer micro-USD string`);
      }
    }

    if (!/^(0|[1-9][0-9]*)$/.test(order.notionalUsd)) {
      failures.push(`order notional ${order.notionalUsd} is not a canonical amount`);
    }
  }

  const passed = failures.length === 0;
  return {
    result: isScripted(opts.modelId) ? "NA" : passed ? "PASS" : "FAIL",
    checker: "krexa.consistency/1",
    failures,
  };
}

export interface BuildDecisionInput {
  deskId: string;
  agent: string;
  decidedAt: string;
  modelId: string;
  /** The exact bytes sent to the model, or the scripted agent's rule description. */
  prompt: string;
  /** Canonical market snapshot the prompt was built from. */
  snapshot: unknown;
  /** Canonical array of tool calls and their results. */
  toolCalls: unknown[];
  /** The exact raw model output bytes. */
  rawOutput: string;
  thesis: Thesis;
  order: Order | null;
  outputParsed?: boolean;
  aiSigHash?: string | null;
}

export interface BuiltDecision {
  record: DecisionRecord;
  /** sha256(canonical(record)). This is what goes on chain. */
  decisionHash: string;
  /** Content-addressed artifacts to store, keyed by their own hash. */
  artifacts: Record<string, string>;
}

export function buildDecision(input: BuildDecisionInput): BuiltDecision {
  const promptBytes = input.prompt;
  const snapshotBytes = canonical(input.snapshot);
  const toolCallsBytes = canonical(input.toolCalls);
  const rawOutputBytes = input.rawOutput;

  const promptHash = sha256Hex(promptBytes);
  const dataSnapshotHash = sha256Hex(snapshotBytes);
  const toolCallsHash = sha256Hex(toolCallsBytes);
  const rawOutputHash = sha256Hex(rawOutputBytes);

  const record: DecisionRecord = {
    schema: "krexa.ual.decision/1",
    deskId: input.deskId,
    agent: input.agent,
    decidedAt: input.decidedAt,
    modelId: input.modelId,
    promptHash,
    dataSnapshotHash,
    toolCallsHash,
    rawOutputHash,
    parsed: { thesis: input.thesis, order: input.order },
    consistency: checkConsistency(input.thesis, input.order, {
      modelId: input.modelId,
      outputParsed: input.outputParsed ?? true,
    }),
    aiSig: {
      provider: isScripted(input.modelId) ? "none" : "near-ai-cloud",
      sigHash: input.aiSigHash ?? null,
      // Never claimed true unless a signature was actually checked, which this build does not
      // do. SPEC.md 15: the model id is self-reported until it is.
      verified: false,
    },
    artifacts: {
      prompt: promptHash,
      snapshot: dataSnapshotHash,
      toolCalls: toolCallsHash,
      rawOutput: rawOutputHash,
    },
  };

  return {
    record,
    decisionHash: decisionHashOf(record),
    artifacts: {
      [promptHash]: promptBytes,
      [dataSnapshotHash]: snapshotBytes,
      [toolCallsHash]: toolCallsBytes,
      [rawOutputHash]: rawOutputBytes,
    },
  };
}

export function decisionHashOf(record: DecisionRecord): string {
  return sha256Hex(canonical(record as unknown as Record<string, unknown>));
}

/**
 * Recompute every hash in a record from its stored artifacts.
 *
 * This is what `pnpm ual replay` runs. It reports commitment verification separately from
 * anything else, because those are different claims: that the agent committed to these bytes
 * is checkable, and whether the reasoning was sound is not.
 */
export interface ReplayReport {
  decisionHashMatches: boolean;
  promptMatches: boolean | "missing";
  snapshotMatches: boolean | "missing";
  toolCallsMatches: boolean | "missing";
  rawOutputMatches: boolean | "missing";
  consistencyRerun: ConsistencyReport;
  consistencyAgrees: boolean;
  lines: string[];
}

export function replayDecision(
  record: DecisionRecord,
  artifacts: Record<string, string>,
  expectedDecisionHash?: string,
): ReplayReport {
  const lines: string[] = [];

  const check = (label: string, hash: string): boolean | "missing" => {
    const body = artifacts[hash];
    if (body === undefined) {
      lines.push(`${label}: artifact ${hash.slice(0, 16)} is not stored, cannot verify`);
      return "missing";
    }
    const actual = sha256Hex(body);
    const ok = actual === hash;
    lines.push(
      ok
        ? `${label}: commitment verified (${hash.slice(0, 16)})`
        : `${label}: MISMATCH, stored bytes hash to ${actual.slice(0, 16)}`,
    );
    return ok;
  };

  const promptMatches = check("prompt", record.promptHash);
  const snapshotMatches = check("snapshot", record.dataSnapshotHash);
  const toolCallsMatches = check("toolCalls", record.toolCallsHash);
  const rawOutputMatches = check("rawOutput", record.rawOutputHash);

  const recomputed = decisionHashOf(record);
  const decisionHashMatches =
    expectedDecisionHash === undefined ? true : recomputed === expectedDecisionHash;
  lines.push(
    expectedDecisionHash === undefined
      ? `decisionHash: ${recomputed.slice(0, 16)} (nothing to compare against)`
      : decisionHashMatches
        ? `decisionHash: matches the on-chain receipt (${recomputed.slice(0, 16)})`
        : `decisionHash: MISMATCH, receipt says ${expectedDecisionHash.slice(0, 16)}, record hashes to ${recomputed.slice(0, 16)}`,
  );

  const consistencyRerun = checkConsistency(record.parsed.thesis, record.parsed.order, {
    modelId: record.modelId,
    outputParsed: true,
  });
  const consistencyAgrees = consistencyRerun.result === record.consistency.result;
  lines.push(
    consistencyAgrees
      ? `consistency: rerun agrees (${consistencyRerun.result})`
      : `consistency: rerun says ${consistencyRerun.result}, record claims ${record.consistency.result}`,
  );

  lines.push(
    "replay proves the agent committed to this prompt, data and output before the outcome.",
  );
  lines.push("it does not prove the reasoning was correct, and it is not zkML.");

  return {
    decisionHashMatches,
    promptMatches,
    snapshotMatches,
    toolCallsMatches,
    rawOutputMatches,
    consistencyRerun,
    consistencyAgrees,
    lines,
  };
}

/**
 * Merkle root over DecisionRecord hashes, so HOLD decisions are committed in a MARK receipt.
 *
 * Without this an agent could decide not to trade a thousand times and later claim whichever
 * of those decisions flattered it. SPEC.md 3.5.
 *
 * Odd nodes are promoted rather than duplicated. Duplicating the last leaf is the classic
 * CVE-2012-2459 shape, where two different leaf sets produce one root.
 */
export function decisionsRoot(hashes: string[]): string {
  if (hashes.length === 0) return sha256Hex("krexa.ual.decisions-root/empty");
  let level = [...hashes].sort();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) next.push(sha256Hex(level[i]! + level[i + 1]!));
      else next.push(level[i]!);
    }
    level = next;
  }
  return level[0]!;
}
