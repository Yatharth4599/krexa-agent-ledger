/**
 * Security regressions for the SDK: chain anchoring, getRecord truncation, evidence shape,
 * policy hash check. Each test failed before its fix.
 */

import { createPrivateKey, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import { base58Encode } from "../src/base58.js";

import { UalClient } from "../src/client.js";
import { genesisHash, sha256Hex } from "../src/canonical.js";
import {
  generateFetcherKey,
  signEvidenceItem,
  signingBytes,
  verifyEvidenceItem,
  type EvidencePayload,
} from "../src/evidence.js";
import { receiptHash, verifyChain, type Receipt } from "../src/receipts.js";

const G = genesisHash("c.near", "desk-a");

function mk(seq: number, prev: string): Receipt {
  const r = {
    v: 1, deskId: "desk-a", seq, kind: "MARK", ts: "1", blockHeight: "1", agent: "a",
    policyHash: null, mode: "paper", intent: null, verdict: "NA", reasons: [], fillRef: null,
    intentSeq: null, equityUsd: "1000000", drawdownBps: 0, dailyPnlUsd: "0", decisionHash: null,
    decisionsRoot: null, aiSigHash: null, evidenceReceiptSeq: null, sizeMultiplierBps: null,
    evidence: null, control: null, prevHash: prev, hash: "",
  } as Receipt;
  r.hash = receiptHash(r);
  return r;
}
function chainOf(n: number): Receipt[] {
  const out: Receipt[] = [];
  let prev = G;
  for (let i = 1; i <= n; i++) {
    const r = mk(i, prev);
    out.push(r);
    prev = r.hash;
  }
  return out;
}

describe("verifyChain anchoring", () => {
  const chain = chainOf(5);
  it("accepts the full chain with genesis and head", () => {
    const head = { seq: 5, hash: chain[4]!.hash };
    expect(verifyChain(chain, G, head).valid).toBe(true);
  });
  it("rejects a run whose first receipts were dropped when genesis is given", () => {
    const r = verifyChain(chain.slice(2), G);
    expect(r.valid).toBe(false);
    expect(r.brokenAt).toBe(3);
  });
  it("rejects a truncated tail when expectedHead is given", () => {
    const r = verifyChain(chain.slice(0, 3), G, { seq: 5, hash: chain[4]!.hash });
    expect(r.valid).toBe(false);
  });
  it("rejects a tail with the right seq but a different hash", () => {
    expect(verifyChain(chain, G, { seq: 5, hash: "f".repeat(64) }).valid).toBe(false);
  });
  it("rejects an empty run when the head is above zero", () => {
    expect(verifyChain([], G, { seq: 5, hash: chain[4]!.hash }).valid).toBe(false);
  });
  it("never throws on hostile input", () => {
    expect(verifyChain([null as unknown as Receipt], G).valid).toBe(false);
    const nonAscii = { ...chain[0]!, reasons: ["é"] };
    expect(() => verifyChain([nonAscii], G)).not.toThrow();
    expect(verifyChain([nonAscii], G).valid).toBe(false);
    expect(verifyChain([{ ...chain[0]!, seq: "1" as unknown as number }], G).valid).toBe(false);
  });
});

function callerFor(opts: {
  chain: Receipt[];
  head: { seq: number; hash: string };
  policy?: Record<string, string>;
}) {
  return {
    accountId: "x",
    async call() {
      throw new Error("no call");
    },
    async view(method: string, args: Record<string, unknown>) {
      if (method === "get_head") return opts.head;
      if (method === "genesis_hash") return G;
      if (method === "get_receipts") {
        const from = args.from_seq as number;
        return opts.chain.filter((r) => r.seq >= from).slice(0, args.limit as number);
      }
      if (method === "get_receipt") return opts.chain.find((r) => r.seq === args.seq) ?? null;
      if (method === "get_policy") return opts.policy?.[args.policy_hash as string] ?? null;
      if (method === "get_desk") return { policyHash: Object.keys(opts.policy ?? {})[0] ?? null };
      return null;
    },
  } as never;
}

describe("getRecord", () => {
  const chain = chainOf(5);
  const head = { seq: 5, hash: chain[4]!.hash };
  it("returns a valid record when node serves the whole chain", async () => {
    const rec = await new UalClient(callerFor({ chain, head }), "c.near").getRecord("desk-a");
    expect(rec.chain.valid).toBe(true);
    expect(rec.receipts).toHaveLength(5);
  });
  it("flags a node that serves fewer receipts than the head claims", async () => {
    const rec = await new UalClient(callerFor({ chain: chain.slice(0, 3), head }), "c.near").getRecord("desk-a");
    expect(rec.chain.valid).toBe(false);
  });
  it("flags a node that ignores fromSeq", async () => {
    const lying = {
      accountId: "x",
      call: async () => undefined,
      view: async (m: string, a: Record<string, unknown>) =>
        m === "get_receipts" ? chain : (callerFor({ chain, head }) as never as { view: (m: string, a: unknown) => unknown }).view(m, a),
    } as never;
    const rec = await new UalClient(lying, "c.near").getRecord("desk-a", { fromSeq: 3 });
    expect(rec.chain.valid).toBe(false);
  });
  it("anchors a fromSeq>1 run to the receipt before it", async () => {
    const ok = await new UalClient(callerFor({ chain, head }), "c.near").getRecord("desk-a", { fromSeq: 3 });
    expect(ok.chain.valid).toBe(true);
    // The tail re-chained onto a fabricated predecessor is internally consistent and ends at
    // the real head hash only if it is the real tail, so forge the predecessor instead.
    const forgedPrev = chain.map((r) => (r.seq === 2 ? { ...r, equityUsd: "7" } : r));
    forgedPrev[1]!.hash = receiptHash(forgedPrev[1]!);
    const bad = await new UalClient(callerFor({ chain: forgedPrev, head }), "c.near").getRecord("desk-a", { fromSeq: 3 });
    expect(bad.chain.valid).toBe(false);
  });
  it("rejects a non-integer fromSeq", async () => {
    await expect(
      new UalClient(callerFor({ chain, head }), "c.near").getRecord("desk-a", { fromSeq: 1.5 }),
    ).rejects.toThrow(/fromSeq/);
  });
});

describe("policy served by a node", () => {
  it("refuses policy JSON that does not hash to the stated hash", async () => {
    const chain = chainOf(1);
    const hash = "a".repeat(64);
    const client = new UalClient(
      callerFor({ chain, head: { seq: 1, hash: chain[0]!.hash }, policy: { [hash]: "{\"evil\":true}" } }),
      "c.near",
    );
    await expect(client.groupForSource("desk-a", "s1")).rejects.toThrow(/refusing/);
    void sha256Hex;
  });
});

describe("precheckIntent evidence k", () => {
  it("throws on a non-integer k instead of sizing from it", async () => {
    const policy = JSON.stringify({
      allowedAssets: ["BTC"], allowedVenues: ["v"], slippageCapBps: 100, maxOpenPositions: 5,
      maxPositionUsd: "1000000", evidence: { required: true, sizeTableBps: [0, 5000, 10000] },
    });
    const ph = sha256Hex(policy);
    const ev = { ...mk(1, G), kind: "EVIDENCE", evidence: { asset: "BTC", direction: "LONG", k: 1.5 } } as Receipt;
    const caller = {
      accountId: "x",
      call: async () => undefined,
      view: async (m: string) =>
        m === "get_desk" ? { policyHash: ph } : m === "get_policy" ? policy : m === "get_receipt" ? ev : [],
    } as never;
    const intent = { side: "OPEN_LONG", asset: "BTC", venue: "v", maxSlippageBps: 10, notionalUsd: "1" };
    await expect(new UalClient(caller, "c.near").precheckIntent("desk-a", intent as never, 1)).rejects.toThrow(/non-integer k/);
  });
});

describe("verifyEvidenceItem shape", () => {
  const key = generateFetcherKey();
  const seed = Buffer.from(key.secretKeyHex, "hex");
  const good: EvidencePayload = {
    contentHash: "a".repeat(64), fetchedAt: "1", kind: "NEWS", source: "s", sourceGroup: "g", url: "u",
  };
  it("accepts a well-formed item", () => {
    expect(verifyEvidenceItem(signEvidenceItem(good, seed, "SUPPORT"))).toBe(true);
  });
  it("rejects an item with an extra signed key", () => {
    const it2 = signEvidenceItem({ ...good, extra: "x" } as EvidencePayload, seed, "SUPPORT");
    expect(verifyEvidenceItem(it2)).toBe(false);
  });
  it("rejects an unknown kind", () => {
    const it2 = signEvidenceItem({ ...good, kind: "RUMOUR" as never }, seed, "SUPPORT");
    expect(verifyEvidenceItem(it2)).toBe(false);
  });
  it("rejects a non-hex contentHash", () => {
    // signEvidenceItem refuses a bad hash, so sign by hand as a hostile fetcher would.
    const bad = { ...good, contentHash: "A".repeat(64) };
    const priv = createPrivateKey({
      key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
      format: "der",
      type: "pkcs8",
    });
    const sig = base58Encode(new Uint8Array(sign(null, signingBytes(bad), priv)));
    const forged = { item: bad, fetcherKey: key.publicKey, signature: sig, stance: "SUPPORT" as const };
    expect(verifyEvidenceItem(forged)).toBe(false);
  });
  it("rejects an oversized signature quickly", () => {
    const it2 = { ...signEvidenceItem(good, seed, "SUPPORT"), signature: "z".repeat(200_000) };
    const t = Date.now();
    expect(verifyEvidenceItem(it2)).toBe(false);
    expect(Date.now() - t).toBeLessThan(100);
  });
});
