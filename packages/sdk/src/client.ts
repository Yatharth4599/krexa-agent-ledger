/**
 * The ledger client, SPEC.md 8.1.
 *
 * Two deliberate design choices:
 *
 * 1. **The transport is injected.** `UalClient` talks to a `LedgerCaller`, not to a specific
 *    NEAR library. The demo drives it with near-workspaces against a local sandbox; the
 *    runtime drives it with near-api-js against testnet; a test can drive it with a fake. The
 *    SDK therefore carries no NEAR dependency of its own, which keeps `pnpm install` small
 *    for anyone who only wants to verify a chain.
 *
 * 2. **A rejected intent is still sent.** `submitIntent` runs the same policy check the
 *    contract will run, reports what it found, and then submits anyway unless the caller
 *    opts out. Refusals are the most interesting rows in an agent's record, so an SDK that
 *    quietly dropped them would be falsifying the ledger by omission. SPEC.md 8.1 says this
 *    explicitly and it is worth repeating here, because "don't waste a transaction" is the
 *    natural instinct and it is wrong.
 */

import { canonical, isHex64, sha256Hex } from "./canonical.js";
import {
  MAX_BUNDLE_ITEMS,
  verifyEvidenceItem,
  type Direction,
  type EvidenceBundle,
} from "./evidence.js";
import {
  groupForSource,
  minKForNonZero,
  precheckPolicyJson,
  serializePolicy,
  sizeMultiplierBps,
  type Policy,
} from "./policy.js";
import { verifyChain, type ChainResult, type Receipt } from "./receipts.js";

export type Side = "OPEN_LONG" | "OPEN_SHORT" | "REDUCE" | "CLOSE";
export type FillKind =
  | "SIMULATED"
  | "ONECLICK_DRY_QUOTE"
  | "ONECLICK_SETTLED"
  | "HYPERLIQUID_FILL"
  | "POLYMARKET_TX";

export interface Intent {
  clientId: string;
  venue: string;
  asset: string;
  side: Side;
  /** micro-USD, decimal string */
  notionalUsd: string;
  maxSlippageBps: number;
  quoteRef?: { kind: string; sha256: string; signature: string } | null;
}

export interface FillRef {
  kind: FillKind;
  simulated: boolean;
  ref: string;
  price: string;
  notionalUsd: string;
  evidenceSha256?: string | null;
}

/** Gas for one agent write. Not the maximum: see tests/integration AGENT_GAS for why. */
export const DEFAULT_GAS = 30_000_000_000_000n;

export interface CallOptions {
  gas?: bigint;
  /** yoctoNEAR */
  deposit?: bigint;
}

/**
 * The only thing the client needs from a NEAR library.
 * Implementations live with their transport, not here.
 */
export interface LedgerCaller {
  readonly accountId: string;
  call<T = unknown>(
    method: string,
    args: Record<string, unknown>,
    opts?: CallOptions,
  ): Promise<T>;
  view<T = unknown>(method: string, args: Record<string, unknown>): Promise<T>;
}

export interface PrecheckFinding {
  /** The reason code the contract would record, e.g. R_MAX_POSITION. */
  reason: string;
  detail: string;
}

export class UalClient {
  constructor(
    private readonly caller: LedgerCaller,
    readonly contractId: string,
  ) {}

  get accountId(): string {
    return this.caller.accountId;
  }

  // ------------------------------------------------------------ desk setup

  /** `create_desk`. The attached deposit funds storage; the caller becomes desk owner. */
  async createDesk(deskId: string, depositYocto = 200_000_000_000_000_000_000_000n): Promise<void> {
    await this.caller.call("create_desk", { desk_id: deskId }, { deposit: depositYocto });
  }

  /**
   * `commit_policy`. Serializes canonically, pre-checks locally, then commits.
   * Returns the policyHash the contract computed, and asserts it matches ours.
   */
  async commitPolicy(policy: Policy): Promise<{ policyHash: string; localHash: string }> {
    const bytes = serializePolicy(policy);
    const localHash = sha256Hex(bytes);
    const policyHash = await this.caller.call<string>("commit_policy", {
      desk_id: policy.deskId,
      policy_json: bytes,
    });
    if (policyHash !== localHash) {
      // Would mean the contract canonicalised differently from the SDK, which is the one
      // failure this whole design cannot tolerate quietly.
      throw new Error(
        `policyHash disagreement: contract says ${policyHash}, SDK computed ${localHash}. ` +
          `Canonical form has diverged; do not trust this ledger until it is resolved.`,
      );
    }
    return { policyHash, localHash };
  }

  async commitPolicyJson(deskId: string, policyJson: string): Promise<string> {
    precheckPolicyJson(policyJson, deskId);
    return this.caller.call<string>("commit_policy", {
      desk_id: deskId,
      policy_json: policyJson,
    });
  }

  async setMode(deskId: string, mode: "paper" | "live"): Promise<void> {
    await this.caller.call("set_mode", { desk_id: deskId, mode });
  }

  async registerAgent(
    deskId: string,
    agent: string,
    role: "DATA" | "ANALYST" | "TRADER" | "MONITOR" | "BASELINE",
  ): Promise<void> {
    await this.caller.call("register_agent", { desk_id: deskId, agent, role });
  }

  async retireAgent(deskId: string, agent: string): Promise<void> {
    await this.caller.call("retire_agent", { desk_id: deskId, agent });
  }

  /**
   * `register_fetcher`.
   *
   * `attestationHash` of 64 zeros is the honest declaration that this fetcher is **not**
   * running in an attested enclave, which makes every downstream receipt carry
   * `attested: false`. Pass a real report hash only when one has actually been checked.
   */
  async registerFetcher(
    deskId: string,
    pubkey: string,
    attestationHash: string,
    label: string,
  ): Promise<void> {
    if (!isHex64(attestationHash)) {
      throw new Error("attestationHash must be 64 lowercase hex characters (use 64 zeros for unattested)");
    }
    await this.caller.call("register_fetcher", {
      desk_id: deskId,
      pubkey,
      attestation_hash: attestationHash,
      label,
    });
  }

  async revokeFetcher(deskId: string, pubkey: string): Promise<void> {
    await this.caller.call("revoke_fetcher", { desk_id: deskId, pubkey });
  }

  // ------------------------------------------------------------ writes

  /**
   * `submit_evidence`. Checks every signature locally first and refuses to submit a bundle
   * carrying a forgery, because the contract would reject the following intent anyway and the
   * local check names the offending item.
   */
  async submitEvidence(
    deskId: string,
    bundle: EvidenceBundle,
    opts?: { allowBadSignatures?: boolean },
  ): Promise<Receipt> {
    if (bundle.items.length > MAX_BUNDLE_ITEMS) {
      throw new Error(
        `bundle has ${bundle.items.length} items; the contract panics with E20_BUNDLE_TOO_LARGE above ${MAX_BUNDLE_ITEMS}`,
      );
    }
    if (!opts?.allowBadSignatures) {
      const bad = bundle.items
        .map((item, i) => ({ i, ok: verifyEvidenceItem(item) }))
        .filter((x) => !x.ok);
      if (bad.length > 0) {
        throw new Error(
          `evidence items ${bad.map((b) => b.i).join(", ")} have signatures that do not verify. ` +
            `The gate fails closed on a tainted bundle, so submitting this would only produce a ` +
            `rejected intent. Pass allowBadSignatures to record it anyway.`,
        );
      }
    }
    const prevHash = await this.head(deskId).then((h) => h.hash);
    return this.caller.call<Receipt>("submit_evidence", {
      desk_id: deskId,
      bundle,
      prev_hash: prevHash,
    });
  }

  /**
   * `submit_intent`, with the same policy check the contract runs.
   *
   * The findings are returned alongside the receipt so a caller can see that the local check
   * and the chain agreed. They should always agree; if they do not, the pre-check is wrong
   * and that is worth knowing loudly.
   */
  async submitIntent(
    deskId: string,
    intent: Intent,
    args: {
      equityUsd: string;
      decisionHash?: string | null;
      aiSigHash?: string | null;
      evidenceSeq?: number | null;
    },
  ): Promise<{ receipt: Receipt; localFindings: PrecheckFinding[] }> {
    const localFindings = await this.precheckIntent(deskId, intent, args.evidenceSeq ?? null);
    const prevHash = await this.head(deskId).then((h) => h.hash);

    const receipt = await this.caller.call<Receipt>("submit_intent", {
      desk_id: deskId,
      intent,
      prev_hash: prevHash,
      equity_usd: args.equityUsd,
      decision_hash: args.decisionHash ?? null,
      ai_sig_hash: args.aiSigHash ?? null,
      evidence_seq: args.evidenceSeq ?? null,
    });

    return { receipt, localFindings };
  }

  async recordFill(deskId: string, intentSeq: number, fill: FillRef): Promise<Receipt> {
    const prevHash = await this.head(deskId).then((h) => h.hash);
    return this.caller.call<Receipt>("record_fill", {
      desk_id: deskId,
      intent_seq: intentSeq,
      fill,
      prev_hash: prevHash,
    });
  }

  async recordMark(
    deskId: string,
    equityUsd: string,
    decisionsRoot?: string | null,
  ): Promise<Receipt> {
    const prevHash = await this.head(deskId).then((h) => h.hash);
    return this.caller.call<Receipt>("record_mark", {
      desk_id: deskId,
      equity_usd: equityUsd,
      prev_hash: prevHash,
      decisions_root: decisionsRoot ?? null,
    });
  }

  async recordFlow(deskId: string, amountUsd: string): Promise<Receipt> {
    const prevHash = await this.head(deskId).then((h) => h.hash);
    return this.caller.call<Receipt>("record_flow", {
      desk_id: deskId,
      amount_usd: amountUsd,
      prev_hash: prevHash,
    });
  }

  /** Engage (owner or a MONITOR the policy permits) or release (owner only). */
  async killSwitch(deskId: string, action: "engage" | "release", reason = ""): Promise<void> {
    if (action === "engage") {
      await this.caller.call("engage_kill_switch", { desk_id: deskId, reason });
    } else {
      await this.caller.call("release_kill_switch", { desk_id: deskId });
    }
  }

  // ------------------------------------------------------------ reads

  async head(deskId: string): Promise<{ seq: number; hash: string }> {
    const head = await this.caller.view<{ seq: number; hash: string } | null>("get_head", {
      desk_id: deskId,
    });
    if (!head) throw new Error(`desk "${deskId}" does not exist on ${this.contractId}`);
    return head;
  }

  async genesisHash(deskId: string): Promise<string> {
    const g = await this.caller.view<string | null>("genesis_hash", { desk_id: deskId });
    if (!g) throw new Error(`desk "${deskId}" does not exist on ${this.contractId}`);
    return g;
  }

  async getDesk(deskId: string): Promise<Record<string, unknown> | null> {
    return this.caller.view("get_desk", { desk_id: deskId });
  }

  async getPolicy(policyHash: string): Promise<string | null> {
    return this.caller.view("get_policy", { policy_hash: policyHash });
  }

  async getReceipt(deskId: string, seq: number): Promise<Receipt | null> {
    return this.caller.view("get_receipt", { desk_id: deskId, seq });
  }

  async getOpenPositions(deskId: string): Promise<Record<string, unknown>[]> {
    return this.caller.view("get_open_positions", { desk_id: deskId });
  }

  /**
   * Every receipt for a desk, with the chain verified against the desk's genesis.
   *
   * The verification is done here rather than trusted from the node, which is the entire
   * reason the chain exists. `chainValid: false` means the data you were served does not hang
   * together, and `brokenAt` says where.
   */
  async getRecord(
    deskId: string,
    opts?: { fromSeq?: number },
  ): Promise<{ receipts: Receipt[]; chain: ChainResult }> {
    const from = opts?.fromSeq ?? 1;
    if (!Number.isSafeInteger(from) || from < 1) {
      throw new Error(`fromSeq must be an integer >= 1, got ${String(from)}`);
    }
    const head = await this.head(deskId);
    const headSeq = head.seq;
    const receipts: Receipt[] = [];
    // get_receipts caps limit at 100, so page through rather than silently truncating.
    for (let start = from; start <= headSeq; start += 100) {
      const page = await this.caller.view<Receipt[]>("get_receipts", {
        desk_id: deskId,
        from_seq: start,
        limit: 100,
      });
      if (!Array.isArray(page) || page.length === 0) break;
      receipts.push(...page);
    }
    // The head was read first; a desk that grew meanwhile must not make the tail mismatch.
    if (receipts.length > headSeq - from + 1) receipts.length = Math.max(0, headSeq - from + 1);

    if (from > headSeq) return { receipts, chain: { valid: true } };
    if (receipts.length === 0 || receipts[0]?.seq !== from) {
      return {
        receipts,
        chain: {
          valid: false,
          brokenAt: from,
          reason: `asked for receipts from seq ${from} but the node served ${receipts[0]?.seq ?? "none"}`,
        },
      };
    }
    if (from > 1) {
      // Without genesis the run floats; tie its first receipt to the one before it.
      const before = await this.getReceipt(deskId, from - 1);
      if (!before || before.seq !== from - 1 || verifyChain([before]).valid === false) {
        return {
          receipts,
          chain: { valid: false, brokenAt: from, reason: `receipt ${from - 1} is missing or does not hash` },
        };
      }
      if (receipts[0]!.prevHash !== before.hash) {
        return {
          receipts,
          chain: {
            valid: false,
            brokenAt: from,
            reason: `receipt ${from} chains to ${receipts[0]!.prevHash} but receipt ${from - 1} hashes to ${before.hash}`,
          },
        };
      }
    }
    const genesis = from === 1 ? await this.genesisHash(deskId) : undefined;
    return { receipts, chain: verifyChain(receipts, genesis, head) };
  }

  /** The policy JSON for a hash, checked: a node must not serve bytes that hash to something else. */
  private async policyChecked(policyHash: string): Promise<string | null> {
    const policyJson = await this.getPolicy(policyHash);
    if (policyJson === null || policyJson === undefined) return null;
    if (sha256Hex(policyJson) !== policyHash) {
      throw new Error(`policy served for ${policyHash} hashes to ${sha256Hex(policyJson)}; refusing it`);
    }
    return policyJson;
  }

  // ------------------------------------------------------------ local pre-check

  /**
   * The contract's own checks, run locally. Mirrors `submit_intent` in
   * `contracts/ual/src/lib.rs`. Differentially tested against it in the sandbox tests.
   */
  async precheckIntent(
    deskId: string,
    intent: Intent,
    evidenceSeq: number | null,
  ): Promise<PrecheckFinding[]> {
    const findings: PrecheckFinding[] = [];
    const desk = (await this.getDesk(deskId)) as Record<string, unknown> | null;
    if (!desk) throw new Error(`desk "${deskId}" does not exist`);

    const policyHash = desk.policyHash as string | null;
    if (!policyHash) throw new Error(`desk "${deskId}" has no committed policy (E06_NO_POLICY)`);
    const policyJson = await this.policyChecked(policyHash);
    if (!policyJson) throw new Error(`policy ${policyHash} is missing from the contract`);
    const policy = JSON.parse(policyJson) as Policy;

    const requested = BigInt(intent.notionalUsd);

    // Allowlists and the slippage cap apply to every side, exits included: a venue or asset
    // the policy never named is outside the desk's declared mandate.
    if (!policy.allowedAssets.includes(intent.asset)) {
      findings.push({
        reason: "R_ASSET_NOT_ALLOWED",
        detail: `${intent.asset} is not in [${policy.allowedAssets.join(", ")}]`,
      });
    }
    if (!(policy.allowedVenues as string[]).includes(intent.venue)) {
      findings.push({
        reason: "R_VENUE_NOT_ALLOWED",
        detail: `${intent.venue} is not in [${policy.allowedVenues.join(", ")}]`,
      });
    }
    if (intent.maxSlippageBps > policy.slippageCapBps) {
      findings.push({
        reason: "R_SLIPPAGE_CAP",
        detail: `${intent.maxSlippageBps} bps exceeds the cap of ${policy.slippageCapBps}`,
      });
    }

    const isOpen = intent.side === "OPEN_LONG" || intent.side === "OPEN_SHORT";
    if (!isOpen) return findings; // You can always exit.

    if (desk.killSwitch === true) {
      findings.push({
        reason: "R_KILL_SWITCH",
        detail: `kill switch engaged: ${String(desk.killReason ?? "")}`,
      });
    }

    const positions = await this.getOpenPositions(deskId);
    if (positions.length >= policy.maxOpenPositions) {
      findings.push({
        reason: "R_MAX_OPEN_POSITIONS",
        detail: `${positions.length} open, limit ${policy.maxOpenPositions}`,
      });
    }

    let multiplier = 10_000;
    if (policy.evidence?.required) {
      if (evidenceSeq === null) {
        findings.push({
          reason: "R_NO_EVIDENCE",
          detail: "this desk requires evidence to open and no evidence receipt was cited",
        });
        multiplier = 0;
      } else {
        const ev = await this.getReceipt(deskId, evidenceSeq);
        const summary = (ev?.evidence ?? null) as Record<string, unknown> | null;
        if (!ev || ev.kind !== "EVIDENCE" || !summary) {
          findings.push({
            reason: "R_NO_EVIDENCE",
            detail: `receipt ${evidenceSeq} is not an EVIDENCE receipt`,
          });
          multiplier = 0;
        } else {
          const direction: Direction | null =
            intent.side === "OPEN_LONG" ? "LONG" : intent.side === "OPEN_SHORT" ? "SHORT" : null;
          if (summary.asset !== intent.asset || summary.direction !== direction) {
            findings.push({
              reason: "R_EVIDENCE_MISMATCH",
              detail: `bundle is ${String(summary.asset)}/${String(summary.direction)}, intent is ${intent.asset}/${direction}`,
            });
          }
          if (summary.anyBadSig === true) {
            findings.push({
              reason: "R_EVIDENCE_BAD_SIG",
              detail: "the bundle contains an item whose signature does not verify",
            });
          }
          if (summary.anyStale === true) {
            findings.push({
              reason: "R_EVIDENCE_STALE",
              detail: "the bundle contains an item that was already past maxAgeSec",
            });
          }
          const k = Number(summary.k ?? 0);
          if (!Number.isInteger(k) || k < 0) {
            throw new Error(`evidence receipt ${evidenceSeq} has a non-integer k: ${String(summary.k)}`);
          }
          const minK = minKForNonZero(policy.evidence);
          if (minK !== undefined && k < minK) {
            findings.push({
              reason: "R_UNCORROBORATED",
              detail: `${k} independent group(s) agreed; ${minK} needed for a non-zero size`,
            });
          }
          multiplier = sizeMultiplierBps(policy.evidence, k);
        }
      }
    }

    const effective = (requested * BigInt(multiplier)) / 10_000n;
    if (effective > BigInt(policy.maxPositionUsd)) {
      findings.push({
        reason: "R_MAX_POSITION",
        detail:
          `${intent.notionalUsd} at ${multiplier} bps is ${effective}, over the cap of ` +
          `${policy.maxPositionUsd}. The contract rejects rather than clipping.`,
      });
    }

    return findings;
  }

  /**
   * Which independence group the policy assigns a source to, or undefined.
   * Exposed so a runtime can explain to itself why a citation earned nothing.
   */
  async groupForSource(deskId: string, source: string): Promise<string | undefined> {
    const desk = (await this.getDesk(deskId)) as Record<string, unknown> | null;
    const policyHash = desk?.policyHash as string | null;
    if (!policyHash) return undefined;
    const policyJson = await this.policyChecked(policyHash);
    if (!policyJson) return undefined;
    const policy = JSON.parse(policyJson) as Policy;
    return policy.evidence ? groupForSource(policy.evidence, source) : undefined;
  }
}

/** Convenience: the canonical bytes of anything, for logging a hash next to a value. */
export function canonicalOf(value: unknown): string {
  return canonical(value);
}
