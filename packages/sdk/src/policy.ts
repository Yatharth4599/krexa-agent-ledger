/**
 * Policy types and the local pre-check, SPEC.md 3.2 and 8.1.
 *
 * The pre-check mirrors `contracts/ual/src/policy.rs` rule for rule. Its job is to tell a
 * caller what the contract would say, before a transaction is spent finding out. That only
 * helps if the two agree, so `test-vectors/policies.json` holds the same accept and reject
 * cases for both and `packages/sdk/test/policy.test.ts` runs them here.
 *
 * Where the two deliberately differ is noted inline. There is one such place: the contract
 * sees already-parsed JSON and cannot detect float *syntax*, so the byte-level checks live in
 * `parseCanonicalJson`.
 */

import {
  assertPolicyBytesCanonical,
  canonical,
  isHex64,
  parseCanonicalJson,
  CanonicalError,
} from "./canonical.js";

export type Venue = "hyperliquid" | "polymarket" | "near-intents-1click" | "paper";
export type PolicyMode = "paper" | "live";

export interface EvidenceGroup {
  group: string;
  sources: string[];
}

export interface EvidenceBlock {
  /** true for EBI desks, false for the plain, debate and hier baselines. */
  required: boolean;
  maxAgeSec: number;
  groups: EvidenceGroup[];
  /** index k = agreeing groups net of contradicting, value = size multiplier in bps. */
  sizeTableBps: number[];
  verifierCodeHash: string;
}

export interface VenueAccount {
  venue: string;
  address: string;
}

export interface Policy {
  schema: "krexa.ual.policy/1";
  deskId: string;
  /** micro-USD, decimal string */
  maxPositionUsd: string;
  maxOpenPositions: number;
  /** micro-USD, decimal string */
  dailyLossLimitUsd: string;
  allowedAssets: string[];
  allowedVenues: Venue[];
  slippageCapBps: number;
  allowedModes: PolicyMode[];
  killSwitch: { autoOnDailyLoss: boolean; monitorMayEngage: boolean };
  venueAccounts?: VenueAccount[];
  evidence?: EvidenceBlock;
  description?: string;
}

const ALLOWED_KEYS = new Set([
  "schema",
  "deskId",
  "maxPositionUsd",
  "maxOpenPositions",
  "dailyLossLimitUsd",
  "allowedAssets",
  "allowedVenues",
  "slippageCapBps",
  "allowedModes",
  "killSwitch",
  "venueAccounts",
  "evidence",
  "description",
]);

const REQUIRED_KEYS = [
  "schema",
  "deskId",
  "maxPositionUsd",
  "maxOpenPositions",
  "dailyLossLimitUsd",
  "allowedAssets",
  "allowedVenues",
  "slippageCapBps",
  "allowedModes",
  "killSwitch",
];

const VENUES = ["hyperliquid", "polymarket", "near-intents-1click", "paper"];
const MODES = ["paper", "live"];

function invalid(detail: string): never {
  throw new CanonicalError("E05_POLICY_INVALID", detail);
}

/** `^[a-z0-9][a-z0-9-]{1,47}$` */
export function isValidDeskId(s: unknown): s is string {
  return typeof s === "string" && /^[a-z0-9][a-z0-9-]{1,47}$/.test(s);
}

/** `^[A-Z0-9:._-]{1,32}$` */
function isValidAsset(s: unknown): s is string {
  return typeof s === "string" && /^[A-Z0-9:._-]{1,32}$/.test(s);
}

/** `^[0-9]{1,15}$`, and no leading zero, so a value has exactly one hashable spelling. */
function isUnsignedAmount(s: unknown): s is string {
  return typeof s === "string" && /^(0|[1-9][0-9]{0,14})$/.test(s);
}

/** Sets must be sorted and deduplicated, SPEC.md 3.1, so their canonical form is unique. */
function assertSortedUnique(arr: unknown, name: string, min: number, max: number): string[] {
  if (!Array.isArray(arr)) invalid(`${name} must be an array`);
  if (arr.length < min || arr.length > max) {
    invalid(`${name} must have between ${min} and ${max} entries, got ${arr.length}`);
  }
  let prev: string | undefined;
  for (const item of arr) {
    if (typeof item !== "string") invalid(`${name} entries must be strings`);
    if (prev !== undefined && item <= prev) {
      invalid(`${name} must be sorted and deduplicated: "${item}" follows "${prev}"`);
    }
    prev = item;
  }
  return arr as string[];
}

/**
 * Validate a parsed policy against SPEC.md 3.2. Throws `CanonicalError` with the code the
 * contract would panic with.
 */
export function validatePolicy(value: unknown, deskId: string): Policy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid("policy must be a JSON object");
  }
  const p = value as Record<string, unknown>;

  for (const key of Object.keys(p)) {
    if (!ALLOWED_KEYS.has(key)) invalid(`unknown key "${key}"; additionalProperties is false`);
  }
  for (const key of REQUIRED_KEYS) {
    if (!(key in p)) invalid(`missing required key "${key}"`);
  }

  if (p.schema !== "krexa.ual.policy/1") invalid(`schema must be krexa.ual.policy/1`);

  if (!isValidDeskId(p.deskId)) invalid(`deskId "${String(p.deskId)}" does not match the pattern`);
  // A policy names the desk it governs. Committing desk A's policy under desk B would make
  // the hash meaningless as a binding.
  if (p.deskId !== deskId) {
    invalid(`policy deskId "${p.deskId}" does not match the desk being committed, "${deskId}"`);
  }

  if (!isUnsignedAmount(p.maxPositionUsd)) invalid("maxPositionUsd must be 1 to 15 digits, no leading zero");
  if (!isUnsignedAmount(p.dailyLossLimitUsd)) invalid("dailyLossLimitUsd must be 1 to 15 digits, no leading zero");

  if (!Number.isInteger(p.maxOpenPositions) || (p.maxOpenPositions as number) < 1 || (p.maxOpenPositions as number) > 50) {
    invalid("maxOpenPositions must be an integer from 1 to 50");
  }
  if (!Number.isInteger(p.slippageCapBps) || (p.slippageCapBps as number) < 0 || (p.slippageCapBps as number) > 1000) {
    invalid("slippageCapBps must be an integer from 0 to 1000");
  }

  const assets = assertSortedUnique(p.allowedAssets, "allowedAssets", 1, 64);
  for (const a of assets) if (!isValidAsset(a)) invalid(`asset "${a}" does not match the pattern`);

  const venues = assertSortedUnique(p.allowedVenues, "allowedVenues", 1, 4);
  for (const v of venues) if (!VENUES.includes(v)) invalid(`venue "${v}" is not one of ${VENUES.join(", ")}`);

  const modes = assertSortedUnique(p.allowedModes, "allowedModes", 1, 2);
  for (const m of modes) if (!MODES.includes(m)) invalid(`mode "${m}" is not paper or live`);

  {
    const ks = p.killSwitch;
    if (typeof ks !== "object" || ks === null) invalid("killSwitch must be an object");
    const k = ks as Record<string, unknown>;
    for (const key of Object.keys(k)) {
      if (key !== "autoOnDailyLoss" && key !== "monitorMayEngage") invalid(`unknown killSwitch key "${key}"`);
    }
    if (typeof k.autoOnDailyLoss !== "boolean") invalid("killSwitch.autoOnDailyLoss must be a boolean");
    if (typeof k.monitorMayEngage !== "boolean") invalid("killSwitch.monitorMayEngage must be a boolean");
  }

  if (p.venueAccounts !== undefined) {
    if (!Array.isArray(p.venueAccounts)) invalid("venueAccounts must be an array");
    if (p.venueAccounts.length > 8) invalid("venueAccounts allows at most 8 entries");
    for (const entry of p.venueAccounts) {
      if (typeof entry !== "object" || entry === null) invalid("venueAccounts entries must be objects");
      const e = entry as Record<string, unknown>;
      for (const key of Object.keys(e)) {
        if (key !== "venue" && key !== "address") invalid(`unknown venueAccounts key "${key}"`);
      }
      if (typeof e.venue !== "string" || e.venue.length === 0) invalid("venueAccounts.venue must be a non-empty string");
      if (typeof e.address !== "string" || e.address.length === 0 || e.address.length > 128) {
        invalid("venueAccounts.address must be 1 to 128 characters");
      }
    }
  }

  if (p.description !== undefined) {
    if (typeof p.description !== "string" || p.description.length > 280) {
      invalid("description must be a string of at most 280 characters");
    }
  }

  if (p.evidence !== undefined) validateEvidenceBlock(p.evidence);

  return p as unknown as Policy;
}

function validateEvidenceBlock(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid("evidence must be an object");
  }
  const e = value as Record<string, unknown>;
  const keys = ["required", "maxAgeSec", "groups", "sizeTableBps", "verifierCodeHash"];
  for (const key of Object.keys(e)) {
    if (!keys.includes(key)) invalid(`unknown evidence key "${key}"`);
  }
  for (const key of keys) {
    if (!(key in e)) invalid(`evidence is missing "${key}"`);
  }

  if (typeof e.required !== "boolean") invalid("evidence.required must be a boolean");
  if (!Number.isInteger(e.maxAgeSec) || (e.maxAgeSec as number) < 1 || (e.maxAgeSec as number) > 86400) {
    invalid("evidence.maxAgeSec must be an integer from 1 to 86400");
  }

  if (!Array.isArray(e.groups)) invalid("evidence.groups must be an array");
  if (e.groups.length > 32) invalid("evidence.groups allows at most 32 entries");
  const groupNames = new Set<string>();
  const allSources = new Set<string>();
  for (const g of e.groups) {
    if (typeof g !== "object" || g === null) invalid("evidence.groups entries must be objects");
    const go = g as Record<string, unknown>;
    for (const key of Object.keys(go)) {
      if (key !== "group" && key !== "sources") invalid(`unknown group key "${key}"`);
    }
    const name = go.group;
    if (typeof name !== "string" || name.length === 0 || name.length > 64) {
      invalid("group name must be 1 to 64 characters");
    }
    if (groupNames.has(name)) invalid(`duplicate group "${name}"`);
    groupNames.add(name);

    if (!Array.isArray(go.sources) || go.sources.length === 0) invalid(`group "${name}" needs at least one source`);
    for (const s of go.sources) {
      if (typeof s !== "string" || s.length === 0 || s.length > 128) {
        invalid(`source in group "${name}" must be 1 to 128 characters`);
      }
      // One source may not sit in two groups, or counting independent groups would be
      // ambiguous and an attacker could pick whichever reading helps them.
      if (allSources.has(s)) invalid(`source "${s}" appears in more than one group`);
      allSources.add(s);
    }
  }

  const table = e.sizeTableBps;
  if (!Array.isArray(table) || table.length === 0 || table.length > 33) {
    invalid("evidence.sizeTableBps must have 1 to 33 entries");
  }
  let prev = 0;
  for (let i = 0; i < table.length; i++) {
    const n = table[i];
    if (!Number.isInteger(n) || (n as number) < 0 || (n as number) > 10000) {
      invalid("sizeTableBps entries must be integers from 0 to 10000");
    }
    // More corroboration must never buy a smaller position. A table that dipped would leave
    // a hole at one specific k while still looking like a gate.
    if (i > 0 && (n as number) < prev) invalid("sizeTableBps must not decrease");
    prev = n as number;
  }
  // k = 0 means nothing agreed, which must size to zero.
  if (table[0] !== 0) invalid("sizeTableBps[0] must be 0: k=0 means nothing agreed");

  if (!isHex64(e.verifierCodeHash)) invalid("evidence.verifierCodeHash must be 64 lowercase hex characters");
}

/**
 * Turn a policy object into the exact bytes `commit_policy` accepts, and check them.
 *
 * Returns the canonical JSON string. Pass this to the contract verbatim: re-serializing it
 * any other way risks changing the bytes, and the bytes are the policy.
 */
export function serializePolicy(policy: Policy): string {
  validatePolicy(policy, policy.deskId);
  const bytes = canonical(policy);
  // Belt and braces: prove the output survives a round trip through the contract's own rule.
  assertPolicyBytesCanonical(bytes);
  return bytes;
}

/**
 * Full local pre-check of policy bytes, in the order the contract applies it.
 * Throws with the code the contract would panic with; returns the parsed policy on success.
 */
export function precheckPolicyJson(policyJson: string, deskId: string): Policy {
  const parsed = parseCanonicalJson(policyJson);
  const policy = validatePolicy(parsed, deskId);
  assertPolicyBytesCanonical(policyJson);
  return policy;
}

/** Size multiplier in bps for k agreeing groups. Indices past the table reuse the last. */
export function sizeMultiplierBps(evidence: EvidenceBlock, k: number): number {
  const table = evidence.sizeTableBps;
  if (table.length === 0) return 0;
  return table[Math.min(k, table.length - 1)]!;
}

/** The smallest k the table gives a non-zero size to, or undefined if none does. */
export function minKForNonZero(evidence: EvidenceBlock): number | undefined {
  const i = evidence.sizeTableBps.findIndex((m) => m > 0);
  return i === -1 ? undefined : i;
}

/** The independence group a source belongs to, or undefined if the policy never declared it. */
export function groupForSource(evidence: EvidenceBlock, source: string): string | undefined {
  for (const g of evidence.groups) {
    if (g.sources.includes(source)) return g.group;
  }
  return undefined;
}
