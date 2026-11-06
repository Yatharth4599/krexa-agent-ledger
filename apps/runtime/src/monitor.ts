/**
 * The Monitor. SPEC.md 2A.2 item 5 and RULES.md section 5.
 *
 * Rule-based, pure, and containing no LLM call of any kind. That is the point rather than a
 * simplification: arXiv 2609.19705 urges deployers to "keep interrupts that bypass the model",
 * and reports that across 15 academic schemes no paper describes one. An interrupt that asked
 * a model whether to interrupt could be talked out of firing by the same injected text it is
 * supposed to protect against.
 *
 * The Monitor can only ever tighten. It holds a function-call key scoped to
 * `engage_kill_switch` and `record_mark`, and `release_kill_switch` is deliberately absent, so
 * only a human holding the desk's full-access key can start the desk again. That asymmetry is
 * what makes it safe to let a rule hold the brake.
 */

export type TriggerName =
  | "DAILY_LOSS"
  | "STALE_EVIDENCE"
  | "VERIFIER_FAILURE_SPIKE"
  | "ATTACK_SUSPECT"
  | "CHAIN_MISMATCH";

export interface Trigger {
  name: TriggerName;
  reason: string;
}

export interface MonitorState {
  /** Micro-USD, current UTC day, as reported by the latest MARK. */
  dailyPnlUsd: bigint;
  /** The desk's committed daily loss limit, micro-USD. */
  dailyLossLimitUsd: bigint;
  /** Nanoseconds since the newest valid evidence item was fetched, or null if none exists. */
  evidenceAgeNs: bigint | null;
  /** The policy's freshness window in nanoseconds. */
  maxEvidenceAgeNs: bigint;
  /** Whether the desk currently holds any open position. */
  hasOpenPosition: boolean;
  /** Verifier outcomes over the recent window, newest last. */
  recentVerifierOutcomes: { citationsOffered: number; citationsCounted: number }[];
  /** Per decision window: how many distinct desks cited each evidence id. */
  citationCountsByEvidenceId: Record<string, number>;
  /** Evidence ids that resolved to exactly one independence group. */
  singleGroupEvidenceIds: string[];
  /** The head the Trader believes is current, and what the chain says. */
  localHeadHash?: string;
  chainHeadHash?: string;
}

export interface MonitorConfig {
  /** Verifier rejection rate above which the pipeline is treated as broken. */
  verifierFailureRate: number;
  /** How many recent decisions the failure rate is computed over. */
  verifierWindow: number;
  /** How many desks citing one single-source item counts as an attack. */
  attackSuspectDesks: number;
}

export const DEFAULT_MONITOR: MonitorConfig = {
  // More than half the citations failing means something upstream is wrong, not that the news
  // happened to be thin.
  verifierFailureRate: 0.5,
  verifierWindow: 8,
  // Three or more desks converging on one uncorroborated item is the signature of the attack
  // this whole project is about: one fake, many agents, same trade, same moment.
  attackSuspectDesks: 3,
};

/**
 * Evaluate every rule. Returns the triggers that fired, in a fixed order so the output is
 * deterministic and two Monitors on the same state agree.
 */
export function evaluate(state: MonitorState, config: MonitorConfig = DEFAULT_MONITOR): Trigger[] {
  const triggers: Trigger[] = [];

  // --- daily loss ---
  if (state.dailyLossLimitUsd > 0n && state.dailyPnlUsd <= -state.dailyLossLimitUsd) {
    triggers.push({
      name: "DAILY_LOSS",
      reason: `daily PnL ${state.dailyPnlUsd} reached the limit of -${state.dailyLossLimitUsd}`,
    });
  }

  // --- stale evidence while exposed ---
  //
  // Only while a position is open. A flat desk with stale evidence is simply not trading,
  // which needs no brake; an exposed desk with stale evidence is flying blind.
  if (state.hasOpenPosition) {
    if (state.evidenceAgeNs === null) {
      triggers.push({
        name: "STALE_EVIDENCE",
        reason: "a position is open and there is no valid evidence at all",
      });
    } else if (state.evidenceAgeNs > state.maxEvidenceAgeNs) {
      triggers.push({
        name: "STALE_EVIDENCE",
        reason: `a position is open and the newest evidence is ${state.evidenceAgeNs / 1_000_000_000n}s old, past the ${state.maxEvidenceAgeNs / 1_000_000_000n}s window`,
      });
    }
  }

  // --- verifier failure spike ---
  const window = state.recentVerifierOutcomes.slice(-config.verifierWindow);
  if (window.length >= config.verifierWindow) {
    const offered = window.reduce((a, o) => a + o.citationsOffered, 0);
    const counted = window.reduce((a, o) => a + o.citationsCounted, 0);
    if (offered > 0) {
      const failureRate = (offered - counted) / offered;
      if (failureRate > config.verifierFailureRate) {
        triggers.push({
          name: "VERIFIER_FAILURE_SPIKE",
          reason: `${Math.round(failureRate * 100)}% of citations failed verification over the last ${window.length} decisions`,
        });
      }
    }
  }

  // --- attack suspect ---
  //
  // Many agents citing one item that stands alone in its group. The rule fires on the
  // *pattern*, not on any judgement about the content, which is why it cannot be argued with.
  for (const evidenceId of [...state.singleGroupEvidenceIds].sort()) {
    const desks = state.citationCountsByEvidenceId[evidenceId] ?? 0;
    if (desks >= config.attackSuspectDesks) {
      triggers.push({
        name: "ATTACK_SUSPECT",
        reason: `${desks} desks cited single-source item ${evidenceId.slice(0, 16)} in one window`,
      });
    }
  }

  // --- chain mismatch ---
  if (
    state.localHeadHash !== undefined &&
    state.chainHeadHash !== undefined &&
    state.localHeadHash !== state.chainHeadHash
  ) {
    triggers.push({
      name: "CHAIN_MISMATCH",
      reason: `local head ${state.localHeadHash.slice(0, 16)} disagrees with the chain's ${state.chainHeadHash.slice(0, 16)}`,
    });
  }

  return triggers;
}

/** The reason string to pass to `engage_kill_switch`, capped at the contract's 200 chars. */
export function killSwitchReason(triggers: Trigger[]): string {
  const text = triggers.map((t) => `${t.name}: ${t.reason}`).join("; ");
  // Printable ASCII only, per the contract's E18_NON_ASCII check.
  const ascii = text.replace(/[^\x20-\x7e]/g, "?");
  return ascii.length <= 200 ? ascii : `${ascii.slice(0, 197)}...`;
}
