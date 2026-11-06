/**
 * Evidence signing, checked against the signatures the Rust side actually produced.
 *
 * The vectors in `test-vectors/evidence.json` were generated with ed25519-dalek and the bs58
 * crate. Everything here is a different implementation (Node's crypto, and the hand-written
 * base58 in `src/base58.ts`), so agreement is evidence that both are right rather than that
 * one library agrees with itself.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { base58Decode, base58Encode } from "../src/base58.js";
import { sha256Hex } from "../src/canonical.js";
import {
  buildEvidencePayload,
  contentHashOf,
  generateFetcherKey,
  publicKeyFromSeed,
  signEvidenceItem,
  signingString,
  verifyEvidenceItem,
  type EvidencePayload,
  type SignedEvidenceItem,
} from "../src/evidence.js";

const VECTORS = join(import.meta.dirname, "..", "..", "..", "test-vectors");

const vec = JSON.parse(readFileSync(join(VECTORS, "evidence.json"), "utf8")) as {
  fetcherSecretKeyHex: string;
  fetcherPublicKey: string;
  items: {
    name: string;
    item: EvidencePayload;
    signingString: string;
    signingStringSha256: string;
    evidenceId: string;
    signature: string;
  }[];
};

const seed = Buffer.from(vec.fetcherSecretKeyHex, "hex");

describe("base58", () => {
  it("round-trips", () => {
    for (const n of [0, 1, 31, 32, 64, 100]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37 + 11) % 256);
      expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
    }
  });

  it("preserves leading zero bytes, which positional arithmetic would drop", () => {
    const bytes = new Uint8Array([0, 0, 0, 7, 9]);
    const encoded = base58Encode(bytes);
    expect(encoded.startsWith("111")).toBe(true);
    expect(base58Decode(encoded)).toEqual(bytes);
  });

  it("decodes the public key the bs58 crate encoded", () => {
    // If this implementation disagreed with the Rust crate by one byte, the signature checks
    // below would fail and the contract would reject every item this SDK signed.
    const raw = base58Decode(vec.fetcherPublicKey.slice("ed25519:".length));
    expect(raw.length).toBe(32);
    expect(base58Encode(raw)).toBe(vec.fetcherPublicKey.slice("ed25519:".length));
  });

  it("refuses a character outside the alphabet", () => {
    // '0', 'O', 'I' and 'l' are excluded from base58 precisely because they are confusable.
    expect(() => base58Decode("0OIl")).toThrowError(/not a base58 character/);
  });
});

describe("key derivation", () => {
  it("derives the same public key the Rust side registered", () => {
    expect(publicKeyFromSeed(seed)).toBe(vec.fetcherPublicKey);
  });

  it("generates fresh keys that round-trip", () => {
    const kp = generateFetcherKey();
    expect(kp.publicKey.startsWith("ed25519:")).toBe(true);
    expect(kp.secretKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(publicKeyFromSeed(Buffer.from(kp.secretKeyHex, "hex"))).toBe(kp.publicKey);
  });

  it("refuses a seed that is not 32 bytes", () => {
    expect(() => publicKeyFromSeed(new Uint8Array(16))).toThrowError(/must be 32 bytes/);
  });
});

describe("signing matches the Rust vectors byte for byte", () => {
  for (const c of vec.items) {
    it(`${c.name}: signing string and digest`, () => {
      expect(signingString(c.item)).toBe(c.signingString);
      expect(sha256Hex(c.signingString)).toBe(c.signingStringSha256);
    });

    it(`${c.name}: Node's ed25519 reproduces the dalek signature exactly`, () => {
      // Ed25519 is deterministic, so the same key over the same message must give the same
      // 64 bytes in any correct implementation.
      const signed = signEvidenceItem(c.item, seed, "SUPPORT");
      expect(signed.signature).toBe(c.signature);
      expect(signed.fetcherKey).toBe(vec.fetcherPublicKey);
    });

    it(`${c.name}: the vector signature verifies`, () => {
      const signed: SignedEvidenceItem = {
        item: c.item,
        fetcherKey: vec.fetcherPublicKey,
        signature: c.signature,
        stance: "SUPPORT",
      };
      expect(verifyEvidenceItem(signed)).toBe(true);
    });
  }
});

describe("tampering is detected", () => {
  const original = vec.items[0]!;

  function signedCopy(): SignedEvidenceItem {
    return {
      item: { ...original.item },
      fetcherKey: vec.fetcherPublicKey,
      signature: original.signature,
      stance: "SUPPORT",
    };
  }

  it("rejects a changed contentHash, which is the fake-headline case", () => {
    const s = signedCopy();
    s.item.contentHash = "9".repeat(64);
    expect(verifyEvidenceItem(s)).toBe(false);
  });

  it("rejects a back-dated fetchedAt", () => {
    // Moving the timestamp would be how an attacker made stale evidence look fresh.
    const s = signedCopy();
    s.item.fetchedAt = "1762423999999999999";
    expect(verifyEvidenceItem(s)).toBe(false);
  });

  it("rejects a changed source, which is how an item would be moved between groups", () => {
    const s = signedCopy();
    s.item.source = "newswire-b.example";
    expect(verifyEvidenceItem(s)).toBe(false);
  });

  it("rejects a changed url", () => {
    const s = signedCopy();
    s.item.url = "https://attacker.example/a";
    expect(verifyEvidenceItem(s)).toBe(false);
  });

  it("rejects a signature from a different key", () => {
    const other = generateFetcherKey();
    const s = signedCopy();
    const resigned = signEvidenceItem(original.item, Buffer.from(other.secretKeyHex, "hex"), "SUPPORT");
    s.signature = resigned.signature;
    // The signature is valid, but not for the key the item claims.
    expect(verifyEvidenceItem(s)).toBe(false);
  });

  it("rejects a malformed signature without throwing", () => {
    const s = signedCopy();
    s.signature = "not-base58-at-all-0OIl";
    expect(verifyEvidenceItem(s)).toBe(false);
    s.signature = base58Encode(new Uint8Array(10));
    expect(verifyEvidenceItem(s)).toBe(false);
  });

  it("changing the stance does NOT break the signature, by design", () => {
    // Stance is the verifier's call, not the fetcher's, so it sits outside the signed bytes.
    // Documented in docs/RECEIPTS.md as a trust boundary rather than left as a surprise.
    const s = signedCopy();
    s.stance = "CONTRADICT";
    expect(verifyEvidenceItem(s)).toBe(true);
  });
});

describe("building items from content", () => {
  it("addresses an item by what it said, not by who reported it", () => {
    const content = "BTC ETF approval reported by two outlets";
    const a = buildEvidencePayload({
      content,
      kind: "NEWS",
      source: "newswire-a.example",
      sourceGroup: "newswire-a",
      url: "https://newswire-a.example/x",
      fetchedAtNs: "1762423700000000000",
    });
    const b = buildEvidencePayload({
      content,
      kind: "NEWS",
      source: "newswire-b.example",
      sourceGroup: "newswire-b",
      url: "https://newswire-b.example/y",
      fetchedAtNs: "1762423700000000000",
    });
    // Same content from two sources gives the same evidence id. That is the point: it is how
    // the verifier can tell "two outlets agree" from "one outlet, cited twice".
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).toBe(contentHashOf(content));
  });

  it("refuses to sign an item whose contentHash is not a digest", () => {
    const bad = { ...vec.items[0]!.item, contentHash: "short" };
    expect(() => signEvidenceItem(bad, seed, "SUPPORT")).toThrowError(/64 lowercase hex/);
  });
});
