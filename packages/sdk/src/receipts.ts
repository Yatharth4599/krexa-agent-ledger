/**
 * Receipt hashing and chain verification, SPEC.md 3.1 and 3.5.
 *
 * Everything here is pure and offline. The point is that a reader with nothing but a list of
 * receipts can decide for themselves whether the chain is intact, without trusting the
 * operator, an RPC node, or this SDK's author. `apps/web` runs exactly these functions in the
 * browser, which is why canonical form has to be reproducible outside Rust.
 */

import { canonical, sha256Hex } from "./canonical.js";

export type Mode = "paper" | "live";
export type Verdict = "APPROVED" | "REJECTED" | "NA";
export type ReceiptKind = "POLICY" | "CONTROL" | "EVIDENCE" | "INTENT" | "FILL" | "MARK";

/** The receipt as the contract returns it. Every key is always present. */
export interface Receipt {
  v: number;
  deskId: string;
  seq: number;
  kind: ReceiptKind;
  ts: string;
  blockHeight: string;
  agent: string;
  policyHash: string | null;
  mode: Mode;
  intent: unknown;
  verdict: Verdict;
  reasons: string[];
  fillRef: unknown;
  intentSeq: number | null;
  equityUsd: string | null;
  drawdownBps: number;
  dailyPnlUsd: string;
  decisionHash: string | null;
  decisionsRoot: string | null;
  aiSigHash: string | null;
  evidenceReceiptSeq: number | null;
  sizeMultiplierBps: number | null;
  evidence: unknown;
  control: unknown;
  prevHash: string;
  hash: string;
}

/**
 * Recompute a receipt's hash from its own contents.
 *
 * `receipt.hash = sha256(canonical(receipt without "hash"))`. The `hash` key is removed
 * rather than blanked, because a blank would still be part of the hashed bytes.
 */
export function receiptHash(receipt: Receipt | Record<string, unknown>): string {
  const body: Record<string, unknown> = { ...(receipt as Record<string, unknown>) };
  delete body.hash;
  return sha256Hex(canonical(body));
}

/** True when the receipt's stated hash matches what its contents hash to. */
export function receiptHashValid(receipt: Receipt): boolean {
  return receiptHash(receipt) === receipt.hash;
}

export interface ChainResult {
  valid: boolean;
  /** The sequence number where verification first failed, if it did. */
  brokenAt?: number;
  /** Why it failed, in plain words, for the explorer to print. */
  reason?: string;
}

/**
 * Verify a run of receipts: contiguous sequence numbers, each hash recomputing from its own
 * contents, and each `prevHash` equal to the previous receipt's `hash`.
 *
 * Pass `expectedGenesis` (from `genesisHash(contractId, deskId)`) when the list starts at
 * seq 1: the first receipt must then be seq 1 and chain to that genesis, so a run with its
 * first receipts dropped does not pass. Pass `expectedHead` (from the contract's `get_head`)
 * to also pin the tail: a truncated run fails. Never throws: hostile input is `valid: false`.
 */
export function verifyChain(
  receipts: Receipt[],
  expectedGenesis?: string,
  expectedHead?: { seq: number; hash: string },
): ChainResult {
  try {
    return verifyChainInner(receipts, expectedGenesis, expectedHead);
  } catch (e) {
    return { valid: false, reason: `malformed receipt: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function verifyChainInner(
  receipts: Receipt[],
  expectedGenesis?: string,
  expectedHead?: { seq: number; hash: string },
): ChainResult {
  if (!Array.isArray(receipts)) return { valid: false, reason: "receipts is not a list" };
  if (receipts.length === 0) {
    if (expectedHead !== undefined && expectedHead.seq > 0) {
      return { valid: false, reason: `no receipts, but the desk head is seq ${expectedHead.seq}` };
    }
    return { valid: true };
  }
  for (const r of receipts) {
    if (r === null || typeof r !== "object" || !Number.isSafeInteger(r.seq)) {
      return { valid: false, reason: "a receipt is null, not an object, or has no integer seq" };
    }
  }

  const first = receipts[0]!;
  if (expectedGenesis !== undefined) {
    if (first.seq !== 1) {
      return {
        valid: false,
        brokenAt: first.seq,
        reason: `the run starts at receipt ${first.seq}, not 1; the first receipts are missing`,
      };
    }
    if (first.prevHash !== expectedGenesis) {
      return {
        valid: false,
        brokenAt: first.seq,
        reason: `receipt 1 chains to ${first.prevHash}, not to this desk's genesis ${expectedGenesis}`,
      };
    }
  }

  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i]!;

    const recomputed = receiptHash(r);
    if (recomputed !== r.hash) {
      return {
        valid: false,
        brokenAt: r.seq,
        reason: `receipt ${r.seq} states hash ${r.hash} but its contents hash to ${recomputed}`,
      };
    }

    if (i > 0) {
      const prev = receipts[i - 1]!;
      if (r.seq !== prev.seq + 1) {
        return {
          valid: false,
          brokenAt: r.seq,
          reason: `sequence jumps from ${prev.seq} to ${r.seq}; a receipt is missing`,
        };
      }
      if (r.prevHash !== prev.hash) {
        return {
          valid: false,
          brokenAt: r.seq,
          reason: `receipt ${r.seq} chains to ${r.prevHash} but receipt ${prev.seq} hashes to ${prev.hash}`,
        };
      }
    }
  }

  const last = receipts[receipts.length - 1]!;
  if (expectedHead !== undefined && (last.seq !== expectedHead.seq || last.hash !== expectedHead.hash)) {
    return {
      valid: false,
      brokenAt: last.seq,
      reason: `the run ends at receipt ${last.seq} (${last.hash}) but the desk head is ${expectedHead.seq} (${expectedHead.hash}); the tail is missing or forged`,
    };
  }

  return { valid: true };
}
