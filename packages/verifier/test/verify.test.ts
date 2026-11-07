/**
 * Verifier tests, including the two SPEC.md 19 beats this package is responsible for:
 * a fabricated indicator panel being caught by recompute, and two sources from one publisher
 * counting once.
 *
 * Real archived payloads are used where possible, so the extractors are tested against what
 * the venues actually send rather than against a fixture someone wrote to match the code.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildEvidencePayload,
  generateFetcherKey,
  signEvidenceItem,
  type SignedEvidenceItem,
} from "@krexa-ual/sdk";

import {
  checkClaim,
  computeVerifierCodeHash,
  extractPrice,
  fundingBps,
  momentumBps,
  resultHash,
  rsi,
  verify,
  type Signal,
  type VerifierPolicy,
} from "../src/index.js";

const REPO = join(import.meta.dirname, "..", "..", "..");
const ARCHIVE = join(REPO, "data", "archive");

const key = generateFetcherKey();
const SEED = Buffer.from(key.secretKeyHex, "hex");

const T0 = 1_762_440_000_000_000_000n;
const NOW = (T0 + 60_000_000_000n).toString();

const POLICY: VerifierPolicy = {
  maxAgeSec: 900,
  groups: [
    { group: "exchange-hl", sources: ["hyperliquid"] },
    { group: "exchange-binance", sources: ["binance-public"] },
    { group: "exchange-coinbase", sources: ["coinbase-public"] },
    { group: "newswire-a", sources: ["newswire-a.example", "newswire-a-markets.example"] },
    { group: "newswire-b", sources: ["newswire-b.example"] },
  ],
  sizeTableBps: [0, 0, 5000, 10000],
  verifierCodeHash: "a".repeat(64),
};

function sign(
  content: string,
  source: string,
  kind: "NEWS" | "PRICE",
  fetchedAtNs: bigint = T0,
): SignedEvidenceItem {
  const group = POLICY.groups.find((g) => g.sources.includes(source))?.group ?? "unknown";
  return signEvidenceItem(
    buildEvidencePayload({
      content,
      kind,
      source,
      sourceGroup: group,
      url: `https://${source}/x`,
      fetchedAtNs: fetchedAtNs.toString(),
    }),
    SEED,
    "NEUTRAL",
  );
}

/** A Hyperliquid payload with a chosen BTC mid and previous-day price. */
function hlBody(mid: string, prevDay: string, funding = "0.0000125"): string {
  return JSON.stringify([
    { universe: [{ name: "BTC", szDecimals: 5 }, { name: "ETH", szDecimals: 4 }] },
    [
      { midPx: mid, markPx: mid, oraclePx: mid, prevDayPx: prevDay, funding, dayBaseVlm: "50000" },
      { midPx: "2200", markPx: "2200", oraclePx: "2200", prevDayPx: "2200", funding: "0", dayBaseVlm: "1" },
    ],
  ]);
}

function binanceBody(last: string, open: string): string {
  return JSON.stringify([
    { symbol: "BTCUSDT", lastPrice: last, openPrice: open, volume: "21000" },
    { symbol: "ETHUSDT", lastPrice: "2200", openPrice: "2200", volume: "100" },
  ]);
}

function coinbaseBody(price: string): string {
  return JSON.stringify({ price, bid: price, ask: price, volume: "11000" });
}

// ---------------------------------------------------------------- extractors

describe("extractors, against real archived payloads", () => {
  const index = existsSync(join(ARCHIVE, "index.jsonl"))
    ? readFileSync(join(ARCHIVE, "index.jsonl"), "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { source: string; ok: boolean; contentHash?: string })
        .filter((l) => l.ok && l.contentHash)
    : [];

  const bySource = new Map<string, string>();
  for (const l of index) {
    if (!bySource.has(l.source)) {
      const p = join(ARCHIVE, "raw", `${l.contentHash}.json`);
      if (existsSync(p)) bySource.set(l.source, readFileSync(p, "utf8"));
    }
  }

  it("the archive has something to test against", () => {
    // Not a hard requirement: a fresh clone has no archive yet. Recorded either way so a
    // reader can tell whether the real-payload tests actually ran.
    if (bySource.size === 0) {
      console.warn("no archived payloads found; real-payload extractor tests skipped");
    }
    expect(bySource.size).toBeGreaterThanOrEqual(0);
  });

  for (const source of ["hyperliquid", "binance-public", "coinbase-public", "kraken-public"]) {
    it(`${source}: extracts a BTC price from a real response`, () => {
      const body = bySource.get(source);
      if (!body) return; // archive not present in this checkout
      const point = extractPrice(source, body, "BTC");
      expect(point, `${source} should yield a BTC price`).toBeDefined();
      expect(Number(point!.price)).toBeGreaterThan(1000);
      expect(point!.venue).toBe(source);
    });
  }

  it("hyperliquid carries funding and a previous-day price; coinbase carries neither", () => {
    const hl = bySource.get("hyperliquid");
    if (hl) {
      const p = extractPrice("hyperliquid", hl, "BTC")!;
      expect(p.funding).toBeDefined();
      expect(p.prevDayPrice).toBeDefined();
    }
    const cb = bySource.get("coinbase-public");
    if (cb) {
      const p = extractPrice("coinbase-public", cb, "BTC")!;
      // A spot ticker has no funding rate, and claiming one would be fabrication.
      expect(p.funding).toBeUndefined();
    }
  });

  it("returns undefined rather than guessing on a malformed body", () => {
    expect(extractPrice("hyperliquid", "not json", "BTC")).toBeUndefined();
    expect(extractPrice("hyperliquid", "[]", "BTC")).toBeUndefined();
    expect(extractPrice("binance-public", "{}", "BTC")).toBeUndefined();
    expect(extractPrice("unknown-venue", hlBody("70000", "69000"), "BTC")).toBeUndefined();
  });

  it("refuses a Hyperliquid payload whose universe and contexts disagree in length", () => {
    // The pairing is positional, so a length mismatch means prices could be attributed to the
    // wrong asset. Better to return nothing than the wrong number.
    const broken = JSON.stringify([{ universe: [{ name: "BTC" }, { name: "ETH" }] }, [{ midPx: "1" }]]);
    expect(extractPrice("hyperliquid", broken, "BTC")).toBeUndefined();
  });

  it("skips a delisted Hyperliquid market", () => {
    const body = JSON.stringify([
      { universe: [{ name: "BTC", isDelisted: true }] },
      [{ midPx: "70000", prevDayPx: "69000" }],
    ]);
    expect(extractPrice("hyperliquid", body, "BTC")).toBeUndefined();
  });

  it("refuses a Kraken payload that is an error report", () => {
    const body = JSON.stringify({ error: ["EQuery:Unknown asset pair"], result: {} });
    expect(extractPrice("kraken-public", body, "BTC")).toBeUndefined();
  });
});

// ---------------------------------------------------------------- indicators

describe("indicator arithmetic", () => {
  it("momentum in basis points", () => {
    expect(momentumBps("110", "100")).toBe(1000); // +10%
    expect(momentumBps("90", "100")).toBe(-1000);
    expect(momentumBps("100", "100")).toBe(0);
    expect(momentumBps("75527.5", "76341.26")).toBe(-106); // real numbers from the archive
  });

  it("refuses a zero or unparseable reference price instead of dividing by it", () => {
    expect(momentumBps("100", "0")).toBeUndefined();
    expect(momentumBps("100", "abc")).toBeUndefined();
  });

  it("funding in basis points", () => {
    expect(fundingBps("0.0001")).toBe(1);
    expect(fundingBps("0.0000125")).toBe(0); // rounds toward zero at bps resolution
    expect(fundingBps("-0.0005")).toBe(-5);
  });

  it("RSI needs period+1 points and will not pad a short series", () => {
    expect(rsi(["1", "2", "3"], 14)).toBeUndefined();
    const rising = Array.from({ length: 15 }, (_, i) => String(100 + i));
    // Monotonically rising with no down bars is RSI 100.
    expect(rsi(rising, 14)).toBe(10000);
    const falling = Array.from({ length: 15 }, (_, i) => String(100 - i));
    expect(rsi(falling, 14)).toBe(0);
  });

  it("a flat series is RSI 50, not a divide by zero", () => {
    expect(rsi(Array.from({ length: 15 }, () => "100"), 14)).toBe(5000);
  });

  it("RSI on a mixed series lands between the extremes", () => {
    const mixed = ["100","101","100","102","101","103","102","104","103","105","104","106","105","107","106"];
    const v = rsi(mixed, 14)!;
    expect(v).toBeGreaterThan(5000);
    expect(v).toBeLessThan(10000);
  });
});

// ---------------------------------------------------------------- claim checks

describe("the fake indicator panel is caught by recompute", () => {
  const series = [
    { ts: T0.toString(), price: "70000", prevDayPrice: "69000", funding: "0.0001" },
  ];

  it("accepts a momentum claim that matches the cited prices", () => {
    // 70000 from 69000 is +144 bps.
    const check = checkClaim({ indicator: "MOMENTUM_24H_BPS", asset: "BTC", value: 144 }, series);
    expect(check.matches).toBe(true);
    expect(check.recomputed).toBe(144);
  });

  it("drops a fabricated momentum claim", () => {
    // The classic injected panel: "BTC up 8% on the day".
    const check = checkClaim({ indicator: "MOMENTUM_24H_BPS", asset: "BTC", value: 800 }, series);
    expect(check.matches).toBe(false);
    expect(check.recomputed).toBe(144);
  });

  it("tolerates small drift but not fabrication", () => {
    expect(checkClaim({ indicator: "MOMENTUM_24H_BPS", asset: "BTC", value: 180 }, series).matches).toBe(true);
    expect(checkClaim({ indicator: "MOMENTUM_24H_BPS", asset: "BTC", value: 400 }, series).matches).toBe(false);
  });

  it("drops a funding claim a spot-only citation cannot support", () => {
    const spotOnly = [{ ts: T0.toString(), price: "70000" }];
    const check = checkClaim({ indicator: "FUNDING_BPS", asset: "BTC", value: 5 }, spotOnly);
    expect(check.matches).toBe(false);
    expect(check.unverifiable).toMatch(/no funding rate/);
  });

  it("drops an RSI claim when too few prices were cited", () => {
    const check = checkClaim({ indicator: "RSI_14", asset: "BTC", value: 2500 }, series);
    expect(check.matches).toBe(false);
    expect(check.unverifiable).toMatch(/needs 15 cited price points/);
  });

  it("drops a fabricated RSI even when enough prices were cited", () => {
    const rising = Array.from({ length: 15 }, (_, i) => ({
      ts: (T0 + BigInt(i) * 1_000_000_000n).toString(),
      price: String(70000 + i * 10),
    }));
    // Prices are rising, so real RSI is 100.00. The injected panel says "RSI 25, oversold,
    // strong buy" to manufacture a reason to go long.
    const check = checkClaim({ indicator: "RSI_14", asset: "BTC", value: 2500 }, rising);
    expect(check.matches).toBe(false);
    expect(check.recomputed).toBe(10000);
  });

  it("will not check a claim about a different asset than the signal", () => {
    const check = checkClaim({ indicator: "MOMENTUM_24H_BPS", asset: "ETH", value: 144 }, []);
    expect(check.matches).toBe(false);
  });
});

// ---------------------------------------------------------------- full verifier

describe("verify", () => {
  const baseSignal = (over: Partial<Signal> = {}): Signal => ({
    asset: "BTC",
    direction: "LONG",
    confidence: 6500,
    horizonMin: 240,
    citations: [],
    ...over,
  });

  it("a single news source gives k=1 and a zero size", () => {
    const news = sign("BTC ETF approval reported", "newswire-a.example", "NEWS");
    const r = verify({
      signal: baseSignal({
        citations: [news.item.contentHash],
        declaredStance: { [news.item.contentHash]: "SUPPORT" },
      }),
      items: [news],
      policy: POLICY,
      nowNs: NOW,
    });
    expect(r.k).toBe(1);
    expect(r.sizeMultiplierBps).toBe(0);
    expect(r.items[0]!.stanceSource).toBe("declared");
  });

  it("two sources from the same publisher count once", () => {
    // SPEC.md 19 beat. Both sources sit in newswire-a, so corroboration does not increase.
    const a1 = sign("BTC ETF approval reported", "newswire-a.example", "NEWS");
    const a2 = sign("ETF approval: what it means", "newswire-a-markets.example", "NEWS");
    const r = verify({
      signal: baseSignal({
        citations: [a1.item.contentHash, a2.item.contentHash],
        declaredStance: {
          [a1.item.contentHash]: "SUPPORT",
          [a2.item.contentHash]: "SUPPORT",
        },
      }),
      items: [a1, a2],
      policy: POLICY,
      nowNs: NOW,
    });
    expect(r.supportGroups).toEqual(["newswire-a"]);
    expect(r.k).toBe(1);
    expect(r.sizeMultiplierBps).toBe(0);
  });

  it("a news item plus a corroborating price gives k=2 and half size", () => {
    const news = sign("BTC rallies on spot demand", "newswire-b.example", "NEWS");
    const hl = sign(hlBody("70000", "69000"), "hyperliquid", "PRICE");
    const r = verify({
      signal: baseSignal({
        citations: [news.item.contentHash, hl.item.contentHash],
        declaredStance: { [news.item.contentHash]: "SUPPORT" },
      }),
      items: [news, hl],
      rawBodies: { [hl.item.contentHash]: hlBody("70000", "69000") },
      policy: POLICY,
      nowNs: NOW,
    });
    expect(r.k).toBe(2);
    expect(r.sizeMultiplierBps).toBe(5000);
    // The price stance was computed, not taken on trust.
    const priceVerdict = r.items.find((i) => i.source === "hyperliquid")!;
    expect(priceVerdict.stanceSource).toBe("recomputed");
    expect(priceVerdict.stance).toBe("SUPPORT");
  });

  it("ignores a raw body that does not hash to its contentHash", () => {
    const news = sign("BTC rallies on spot demand", "newswire-b.example", "NEWS");
    const hl = sign(hlBody("68000", "69000"), "hyperliquid", "PRICE"); // signed: down
    const r = verify({
      signal: baseSignal({
        citations: [news.item.contentHash, hl.item.contentHash],
        declaredStance: { [news.item.contentHash]: "SUPPORT" },
      }),
      items: [news, hl],
      // A fabricated "up" body filed under the genuine item's hash.
      rawBodies: { [hl.item.contentHash]: hlBody("70000", "69000") },
      policy: POLICY,
      nowNs: NOW,
    });
    const priceVerdict = r.items.find((i) => i.source === "hyperliquid")!;
    expect(priceVerdict.stanceSource).toBe("none");
    expect(r.k).toBe(1);
  });

  it("a price that moved the other way CONTRADICTS a long and reduces k", () => {
    const news = sign("BTC rallies", "newswire-a.example", "NEWS");
    const news2 = sign("Second outlet confirms", "newswire-b.example", "NEWS");
    const body = hlBody("68000", "69000"); // down 145 bps
    const hl = sign(body, "hyperliquid", "PRICE");
    const r = verify({
      signal: baseSignal({
        citations: [news.item.contentHash, news2.item.contentHash, hl.item.contentHash],
        declaredStance: {
          [news.item.contentHash]: "SUPPORT",
          [news2.item.contentHash]: "SUPPORT",
        },
      }),
      items: [news, news2, hl],
      rawBodies: { [hl.item.contentHash]: body },
      policy: POLICY,
      nowNs: NOW,
    });
    // Two supporting news groups, one contradicting price group.
    expect(r.supportGroups.sort()).toEqual(["newswire-a", "newswire-b"]);
    expect(r.contradictGroups).toEqual(["exchange-hl"]);
    expect(r.k).toBe(1);
    expect(r.sizeMultiplierBps).toBe(0);
  });

  it("three independent groups give full size", () => {
    const news = sign("BTC rallies", "newswire-a.example", "NEWS");
    const hlB = hlBody("70000", "69000");
    const hl = sign(hlB, "hyperliquid", "PRICE");
    const bnB = binanceBody("70000", "69000");
    const bn = sign(bnB, "binance-public", "PRICE");
    const r = verify({
      signal: baseSignal({
        citations: [news.item.contentHash, hl.item.contentHash, bn.item.contentHash],
        declaredStance: { [news.item.contentHash]: "SUPPORT" },
      }),
      items: [news, hl, bn],
      rawBodies: { [hl.item.contentHash]: hlB, [bn.item.contentHash]: bnB },
      policy: POLICY,
      nowNs: NOW,
    });
    expect(r.k).toBe(3);
    expect(r.sizeMultiplierBps).toBe(10000);
  });

  it("an undeclared source is excluded and counts for nothing", () => {
    const blog = sign("trust me", "random-blog.example", "NEWS");
    const r = verify({
      signal: baseSignal({
        citations: [blog.item.contentHash],
        declaredStance: { [blog.item.contentHash]: "SUPPORT" },
      }),
      items: [blog],
      policy: POLICY,
      nowNs: NOW,
    });
    expect(r.k).toBe(0);
    expect(r.items[0]!.counted).toBe(false);
    expect(r.items[0]!.excluded).toMatch(/not declared in any policy group/);
  });

  it("a stale item is excluded", () => {
    // maxAgeSec is 900; this was fetched 2000 seconds before now.
    const old = sign("old news", "newswire-a.example", "NEWS", T0 - 2_000_000_000_000n);
    const r = verify({
      signal: baseSignal({
        citations: [old.item.contentHash],
        declaredStance: { [old.item.contentHash]: "SUPPORT" },
      }),
      items: [old],
      policy: POLICY,
      nowNs: NOW,
    });
    expect(r.items[0]!.fresh).toBe(false);
    expect(r.k).toBe(0);
    // Excluded items do not reach the bundle, so the contract never sees them.
    expect(r.bundle).toBeUndefined();
  });

  it("an item dated in the future is stale, not extra-fresh", () => {
    const future = sign("tomorrow's news", "newswire-a.example", "NEWS", T0 + 10_000_000_000_000n);
    const r = verify({
      signal: baseSignal({
        citations: [future.item.contentHash],
        declaredStance: { [future.item.contentHash]: "SUPPORT" },
      }),
      items: [future],
      policy: POLICY,
      nowNs: NOW,
    });
    expect(r.items[0]!.fresh).toBe(false);
  });

  it("a forged item is excluded from the bundle entirely", () => {
    const item = sign("BTC rallies", "newswire-a.example", "NEWS");
    const tampered: SignedEvidenceItem = {
      ...item,
      item: { ...item.item, contentHash: "9".repeat(64) },
    };
    const r = verify({
      signal: baseSignal({
        citations: [tampered.item.contentHash],
        declaredStance: { [tampered.item.contentHash]: "SUPPORT" },
      }),
      items: [tampered],
      policy: POLICY,
      nowNs: NOW,
    });
    expect(r.items[0]!.signatureValid).toBe(false);
    expect(r.bundle).toBeUndefined();
  });

  it("an unresolvable citation is reported rather than ignored", () => {
    const r = verify({
      signal: baseSignal({ citations: ["f".repeat(64)] }),
      items: [],
      policy: POLICY,
      nowNs: NOW,
    });
    expect(r.items[0]!.resolved).toBe(false);
    expect(r.items[0]!.excluded).toMatch(/does not resolve/);
  });

  it("a PRICE item with no raw body is NEUTRAL, never taken on the Analyst's word", () => {
    // The verifier is supposed to check price stance itself. If it cannot, it must not fall
    // back to a declared stance, or the one checkable thing becomes forgeable.
    const hl = sign(hlBody("70000", "69000"), "hyperliquid", "PRICE");
    const r = verify({
      signal: baseSignal({
        citations: [hl.item.contentHash],
        declaredStance: { [hl.item.contentHash]: "SUPPORT" },
      }),
      items: [hl],
      policy: POLICY,
      nowNs: NOW,
    });
    expect(r.items[0]!.stance).toBe("NEUTRAL");
    expect(r.items[0]!.stanceSource).toBe("none");
    expect(r.k).toBe(0);
  });

  it("a flat price is NEUTRAL rather than rounded into agreement", () => {
    const body = hlBody("69000", "69000");
    const hl = sign(body, "hyperliquid", "PRICE");
    const r = verify({
      signal: baseSignal({ citations: [hl.item.contentHash] }),
      items: [hl],
      rawBodies: { [hl.item.contentHash]: body },
      policy: POLICY,
      nowNs: NOW,
    });
    expect(r.items[0]!.stance).toBe("NEUTRAL");
  });

  it("the same evidence supports a SHORT when the move is down", () => {
    const body = hlBody("68000", "69000");
    const hl = sign(body, "hyperliquid", "PRICE");
    const bnB = binanceBody("68000", "69000");
    const bn = sign(bnB, "binance-public", "PRICE");
    const r = verify({
      signal: baseSignal({
        direction: "SHORT",
        citations: [hl.item.contentHash, bn.item.contentHash],
      }),
      items: [hl, bn],
      rawBodies: { [hl.item.contentHash]: body, [bn.item.contentHash]: bnB },
      policy: POLICY,
      nowNs: NOW,
    });
    expect(r.k).toBe(2);
    expect(r.sizeMultiplierBps).toBe(5000);
  });

  it("drops a fabricated claim while still counting the honest citations", () => {
    // The gate is not all-or-nothing on claims: a bad claim is dropped, and the trade is then
    // sized by whatever corroboration genuinely exists.
    const hlB = hlBody("70000", "69000");
    const hl = sign(hlB, "hyperliquid", "PRICE");
    const cbB = coinbaseBody("70000");
    const cb = sign(cbB, "coinbase-public", "PRICE");
    const news = sign("BTC rallies", "newswire-a.example", "NEWS");
    const r = verify({
      signal: baseSignal({
        citations: [hl.item.contentHash, cb.item.contentHash, news.item.contentHash],
        declaredStance: { [news.item.contentHash]: "SUPPORT" },
        claims: [{ indicator: "MOMENTUM_24H_BPS", asset: "BTC", value: 900 }],
      }),
      items: [hl, cb, news],
      rawBodies: { [hl.item.contentHash]: hlB, [cb.item.contentHash]: cbB },
      policy: POLICY,
      nowNs: NOW,
    });
    expect(r.droppedClaims).toHaveLength(1);
    expect(r.explanation.some((l) => l.includes("DROPPED"))).toBe(true);
    // Hyperliquid and the newswire still count; coinbase has no prev-day price so it is NEUTRAL.
    expect(r.k).toBeGreaterThanOrEqual(2);
  });

  it("is deterministic: same input, same result hash", () => {
    const hlB = hlBody("70000", "69000");
    const hl = sign(hlB, "hyperliquid", "PRICE");
    const input = {
      signal: baseSignal({ citations: [hl.item.contentHash] }),
      items: [hl],
      rawBodies: { [hl.item.contentHash]: hlB },
      policy: POLICY,
      nowNs: NOW,
    };
    expect(resultHash(verify(input))).toBe(resultHash(verify(input)));
  });

  it("the result hash changes when the verdict changes", () => {
    const upB = hlBody("70000", "69000");
    const up = sign(upB, "hyperliquid", "PRICE");
    const downB = hlBody("68000", "69000");
    const down = sign(downB, "hyperliquid", "PRICE");
    const a = verify({
      signal: baseSignal({ citations: [up.item.contentHash] }),
      items: [up],
      rawBodies: { [up.item.contentHash]: upB },
      policy: POLICY,
      nowNs: NOW,
    });
    const b = verify({
      signal: baseSignal({ citations: [down.item.contentHash] }),
      items: [down],
      rawBodies: { [down.item.contentHash]: downB },
      policy: POLICY,
      nowNs: NOW,
    });
    expect(resultHash(a)).not.toBe(resultHash(b));
  });

  it("explains itself in words, for the attack replay view", () => {
    const news = sign("BTC ETF approved", "newswire-a.example", "NEWS");
    const r = verify({
      signal: baseSignal({
        citations: [news.item.contentHash],
        declaredStance: { [news.item.contentHash]: "SUPPORT" },
      }),
      items: [news],
      policy: POLICY,
      nowNs: NOW,
    });
    expect(r.explanation.join("\n")).toMatch(/k=1/);
    // The explanation must say the news stance was unchecked, or a reader would assume the
    // verifier judged the headline.
    expect(r.explanation.join("\n")).toMatch(/Analyst's claim, not checked/);
  });
});

// ---------------------------------------------------------------- code hash

describe("verifierCodeHash", () => {
  it("is stable across calls", () => {
    expect(computeVerifierCodeHash()).toBe(computeVerifierCodeHash());
  });

  it("is 64 lowercase hex, the form a policy accepts", () => {
    expect(computeVerifierCodeHash()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("covers every behavioural source file in the package", async () => {
    // A new file holding verification logic must be added to HASHED_FILES, or changing it
    // would not change the hash and the policy pin would be a lie.
    const srcDir = join(import.meta.dirname, "..", "src");
    const behavioural = readdirSync(srcDir).filter(
      (f) => f.endsWith(".ts") && !["index.ts", "codehash.ts", "print-codehash.ts"].includes(f),
    );
    const { HASHED_FILES } = await import("../src/codehash.js");
    expect([...behavioural].sort()).toEqual([...HASHED_FILES].sort());
  });
});

// ---------------------------------------------------------------- H4: multi-group planting

describe("the same fake planted across several groups (SPEC.md 2A.6 H4)", () => {
  const FAKE = "BREAKING: Reuters reports major asset manager confirms spot BTC allocation";

  /** The identical text, signed as if fetched from several outlets. */
  function plantedIn(sources: string[]): SignedEvidenceItem[] {
    return sources.map((source) => sign(FAKE, source, "NEWS"));
  }

  const policy: VerifierPolicy = {
    ...POLICY,
    groups: [
      { group: "newswire-a", sources: ["newswire-a.example"] },
      { group: "newswire-b", sources: ["newswire-b.example"] },
      { group: "newswire-c", sources: ["newswire-c.example"] },
    ],
  };

  function signalFor(items: SignedEvidenceItem[]): Signal {
    // All items share one evidenceId, because an evidenceId is a content hash.
    const id = items[0]!.item.contentHash;
    return {
      asset: "BTC",
      direction: "LONG",
      confidence: 6500,
      horizonMin: 240,
      citations: [id],
      declaredStance: { [id]: "SUPPORT" },
    };
  }

  it("identical content from several outlets shares one evidenceId", () => {
    // This is what makes the attack possible, and what made the first implementation of the
    // verifier drop all but one item: it indexed by evidenceId to a single item.
    const items = plantedIn(["newswire-a.example", "newswire-b.example", "newswire-c.example"]);
    const ids = new Set(items.map((i) => i.item.contentHash));
    expect(ids.size).toBe(1);
    expect(new Set(items.map((i) => i.item.source)).size).toBe(3);
  });

  it("one outlet gives k=1 and no size", () => {
    const items = plantedIn(["newswire-a.example"]);
    const r = verify({ signal: signalFor(items), items, policy, nowNs: NOW });
    expect(r.k).toBe(1);
    expect(r.sizeMultiplierBps).toBe(0);
  });

  it("planted in two groups, k rises to 2 and the trade is allowed at half size", () => {
    const items = plantedIn(["newswire-a.example", "newswire-b.example"]);
    const r = verify({ signal: signalFor(items), items, policy, nowNs: NOW });
    expect(r.items).toHaveLength(2);
    expect(r.supportGroups.sort()).toEqual(["newswire-a", "newswire-b"]);
    expect(r.k).toBe(2);
    expect(r.sizeMultiplierBps).toBe(5000);
  });

  it("planted in three groups, the gate allows FULL size on a single fabrication", () => {
    // H4, demonstrated rather than argued. The defence is only as good as source
    // independence, and nothing here detects that the three outlets are repeating one claim.
    const items = plantedIn([
      "newswire-a.example",
      "newswire-b.example",
      "newswire-c.example",
    ]);
    const r = verify({ signal: signalFor(items), items, policy, nowNs: NOW });
    expect(r.k).toBe(3);
    expect(r.sizeMultiplierBps).toBe(10000);
  });

  it("says in the explanation that one claim is carried by several sources", () => {
    // A reader of the attack replay view must be able to see this, not infer it.
    const items = plantedIn(["newswire-a.example", "newswire-b.example", "newswire-c.example"]);
    const r = verify({ signal: signalFor(items), items, policy, nowNs: NOW });
    expect(r.explanation.join("\n")).toMatch(/carried by 3 sources/);
    expect(r.explanation.join("\n")).toMatch(/identical content/);
  });

  it("every planted copy reaches the bundle, so the contract can recount the groups", () => {
    const items = plantedIn(["newswire-a.example", "newswire-b.example"]);
    const r = verify({ signal: signalFor(items), items, policy, nowNs: NOW });
    expect(r.bundle?.items).toHaveLength(2);
    expect(new Set(r.bundle!.items.map((i) => i.item.source)).size).toBe(2);
  });

  it("citing the same content twice is still one source, not two", () => {
    // Otherwise an Analyst could manufacture corroboration by repeating a citation.
    const items = plantedIn(["newswire-a.example"]);
    const id = items[0]!.item.contentHash;
    const r = verify({
      signal: { ...signalFor(items), citations: [id, id, id] },
      items,
      policy,
      nowNs: NOW,
    });
    expect(r.items).toHaveLength(1);
    expect(r.k).toBe(1);
  });

  it("a planted copy from an undeclared outlet buys nothing", () => {
    // The attacker has to reach a source the policy actually declared, which is the one
    // barrier left: the owner's group list is the attack surface.
    const items = plantedIn(["newswire-a.example", "attacker-blog.example"]);
    const r = verify({ signal: signalFor(items), items, policy, nowNs: NOW });
    expect(r.k).toBe(1);
    expect(r.items.some((i) => i.excluded?.includes("not declared"))).toBe(true);
  });

  it("result hashes distinguish items that share an evidenceId", () => {
    const one = plantedIn(["newswire-a.example"]);
    const two = plantedIn(["newswire-a.example", "newswire-b.example"]);
    const a = verify({ signal: signalFor(one), items: one, policy, nowNs: NOW });
    const b = verify({ signal: signalFor(two), items: two, policy, nowNs: NOW });
    expect(resultHash(a)).not.toBe(resultHash(b));
  });
});
