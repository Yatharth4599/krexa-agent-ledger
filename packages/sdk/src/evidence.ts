/**
 * Evidence items: what gets signed, how, and how to check a signature.
 * SPEC.md 2A.2 items 1 and 2.
 *
 * A fetcher signs `canonical(item)` as UTF-8 bytes with an ed25519 key. The contract verifies
 * the same bytes with `env::ed25519_verify`. `test-vectors/evidence.json` pins the signing
 * string, its digest and a real signature, so this module and the contract cannot drift.
 *
 * `stance` is deliberately **not** part of the signed payload. The fetcher reports what it
 * fetched; whether that supports or contradicts a particular trade is a judgement the
 * deterministic verifier makes, and its code hash is pinned in the policy. Signing a stance
 * would mean the fetcher had an opinion about a trade it knows nothing about. The practical
 * consequence is recorded in docs/RECEIPTS.md: the on-chain gate proves provenance, freshness
 * and group counting, and cannot judge semantics.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

import { base58Decode, base58Encode } from "./base58.js";
import { canonical, isHex64, sha256Hex } from "./canonical.js";

export type EvidenceItemKind = "NEWS" | "PRICE" | "MARKET" | "ONCHAIN";
export type Stance = "SUPPORT" | "CONTRADICT" | "NEUTRAL";
export type Direction = "LONG" | "SHORT";

/** Exactly the object a fetcher signs. Key order is irrelevant: canonical form sorts it. */
export interface EvidencePayload {
  /** sha256 of the raw fetched content. This is also the evidence id. */
  contentHash: string;
  /** nanoseconds since the epoch, decimal string */
  fetchedAt: string;
  kind: EvidenceItemKind;
  source: string;
  /** The fetcher's claim. The hashed policy is what actually decides the group. */
  sourceGroup: string;
  url: string;
}

export interface SignedEvidenceItem {
  item: EvidencePayload;
  /** `ed25519:<base58>` */
  fetcherKey: string;
  /** base58 of the 64 byte signature */
  signature: string;
  stance: Stance;
}

export interface EvidenceBundle {
  asset: string;
  direction: Direction;
  verifierCodeHash: string;
  items: SignedEvidenceItem[];
}

/** Maximum items in one bundle. The contract panics with E20_BUNDLE_TOO_LARGE past this. */
export const MAX_BUNDLE_ITEMS = 16;

// ---------------------------------------------------------------- keys
//
// Node's crypto handles ed25519, but it wants DER rather than raw bytes. These are the fixed
// PKCS#8 and SPKI prefixes for Ed25519 (OID 1.3.101.112), so a raw 32 byte seed or public key
// can be wrapped without pulling in a third-party crypto library. The alternative was an npm
// dependency on the evidence-signing path, which is the one place in this repo where that
// trade is clearly not worth it.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface FetcherKeyPair {
  /** `ed25519:<base58>`, the form `register_fetcher` takes. */
  publicKey: string;
  /** 32 byte seed, hex. Goes in .env as FETCHER_SECRET_KEY and is never committed. */
  secretKeyHex: string;
}

export function generateFetcherKey(): FetcherKeyPair {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  // The seed is the last 32 bytes of the PKCS#8 encoding.
  const seed = Buffer.from(der.subarray(der.length - 32));
  return {
    publicKey: publicKeyFromSeed(seed),
    secretKeyHex: seed.toString("hex"),
  };
}

export function publicKeyFromSeed(seed: Uint8Array): string {
  const priv = privateKeyObjectFromSeed(seed);
  const pub = createPublicKey(priv);
  const spki = pub.export({ format: "der", type: "spki" });
  const raw = Buffer.from(spki.subarray(spki.length - 32));
  return `ed25519:${base58Encode(raw)}`;
}

function privateKeyObjectFromSeed(seed: Uint8Array) {
  if (seed.length !== 32) {
    throw new Error(`ed25519 seed must be 32 bytes, got ${seed.length}`);
  }
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
}

function publicKeyObjectFromNearKey(nearKey: string) {
  if (!nearKey.startsWith("ed25519:")) {
    throw new Error(`expected an ed25519: prefixed key, got "${nearKey}"`);
  }
  const raw = base58Decode(nearKey.slice("ed25519:".length));
  if (raw.length !== 32) {
    throw new Error(`ed25519 public key must be 32 bytes, got ${raw.length}`);
  }
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(raw)]),
    format: "der",
    type: "spki",
  });
}

// ---------------------------------------------------------------- signing

/** The exact bytes a fetcher signs: `canonical(item)` as UTF-8. */
export function signingBytes(item: EvidencePayload): Buffer {
  return Buffer.from(canonical(item), "utf8");
}

/** The signing string, for diagnostics and for the test vectors. */
export function signingString(item: EvidencePayload): string {
  return canonical(item);
}

export function signEvidenceItem(
  item: EvidencePayload,
  secretKeySeed: Uint8Array,
  stance: Stance,
): SignedEvidenceItem {
  if (!isHex64(item.contentHash)) {
    throw new Error(`contentHash must be 64 lowercase hex characters, got "${item.contentHash}"`);
  }
  const key = privateKeyObjectFromSeed(secretKeySeed);
  const sig = sign(null, signingBytes(item), key);
  return {
    item,
    fetcherKey: publicKeyFromSeed(secretKeySeed),
    signature: base58Encode(new Uint8Array(sig)),
    stance,
  };
}

/**
 * Verify an item's signature exactly as the contract does.
 *
 * Used by `packages/verifier` to drop forged items before they are ever submitted, and by the
 * demo to show that a tampered item fails. Returns false rather than throwing on malformed
 * input, because a malformed signature is a verification failure, not a programming error.
 */
export function verifyEvidenceItem(signed: SignedEvidenceItem): boolean {
  try {
    const { item } = signed;
    // Shape first, so the signed bytes are exactly what the contract's six-field struct would
    // produce. An extra key would verify here and be dropped by serde there.
    if (item === null || typeof item !== "object") return false;
    if (Object.keys(item).sort().join(",") !== "contentHash,fetchedAt,kind,source,sourceGroup,url") {
      return false;
    }
    if (!isHex64(item.contentHash)) return false;
    if (!EVIDENCE_KINDS.includes(item.kind)) return false;
    for (const f of ["fetchedAt", "source", "sourceGroup", "url"] as const) {
      if (typeof item[f] !== "string") return false;
    }
    // Cap before decoding: base58 decode is quadratic. A valid signature is 86-88 chars and a
    // valid key about 44 (plus the "ed25519:" prefix).
    if (typeof signed.signature !== "string" || signed.signature.length > MAX_SIGNATURE_CHARS) {
      return false;
    }
    if (typeof signed.fetcherKey !== "string" || signed.fetcherKey.length > MAX_KEY_CHARS) {
      return false;
    }
    const pub = publicKeyObjectFromNearKey(signed.fetcherKey);
    const sig = base58Decode(signed.signature);
    if (sig.length !== 64) return false;
    return verify(null, signingBytes(item), pub, Buffer.from(sig));
  } catch {
    return false;
  }
}

const EVIDENCE_KINDS: readonly string[] = ["NEWS", "PRICE", "MARKET", "ONCHAIN"];
const MAX_SIGNATURE_CHARS = 90;
const MAX_KEY_CHARS = "ed25519:".length + 50;

/** sha256 of raw fetched content, which is the item's id. */
export function contentHashOf(raw: string | Uint8Array): string {
  return sha256Hex(raw);
}

/**
 * Build an item from fetched content. The caller supplies the clock, so a replay harness can
 * reconstruct exactly what was available at a past decision point.
 */
export function buildEvidencePayload(opts: {
  content: string | Uint8Array;
  kind: EvidenceItemKind;
  source: string;
  sourceGroup: string;
  url: string;
  fetchedAtNs: bigint | string;
}): EvidencePayload {
  return {
    contentHash: contentHashOf(opts.content),
    fetchedAt: typeof opts.fetchedAtNs === "string" ? opts.fetchedAtNs : opts.fetchedAtNs.toString(),
    kind: opts.kind,
    source: opts.source,
    sourceGroup: opts.sourceGroup,
    url: opts.url,
  };
}

/** `sha256(canonical(bundle))`, which the EVIDENCE receipt records as `bundleHash`. */
export function bundleHash(bundle: EvidenceBundle): string {
  return sha256Hex(canonical(bundle as unknown as Record<string, unknown>));
}
