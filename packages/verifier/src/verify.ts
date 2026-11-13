/**
 * The deterministic verifier. SPEC.md 2A.2 item 3, first bullet.
 *
 * Pure, offline, no clock of its own, no randomness. Given a signal, the signed evidence items
 * it cites, and the committed policy, it produces the bundle the Trader submits on chain.
 * Running it twice on the same inputs produces the same bytes, which is what makes
 * `verifierCodeHash` in the policy worth pinning.
 *
 * ## What it can and cannot establish, precisely
 *
 * This is the most over-claimable component in the system, so the boundary is stated here and
 * carried into every receipt.
 *
 * **Checked by arithmetic, so not forgeable:**
 * - the citation resolves to an item signed by a registered fetcher key
 * - the item was fetched inside the policy's freshness window
 * - the item's source is one the policy declared, and which group it belongs to
 * - any claimed RSI, momentum or funding figure, recomputed from the cited raw prices
 *
 * **Taken on the Analyst's word:**
 * - whether a *news* item supports or contradicts the thesis
 *
 * That second line matters. A deterministic function cannot read a headline and decide what it
 * implies for a trade; doing so would need an LLM, and an LLM in the verifier is exactly the
 * thing an injected fake would attack. So for NEWS the verifier records the Analyst's declared
 * stance and marks it `declared` rather than `recomputed`.
 *
 * The consequence is worth being blunt about: **the gate does not detect fake news.** An
 * injected headline that the Analyst believes supports a long will be counted as SUPPORT. What
 * the gate does is refuse to size a trade on one such item, and demand that independent groups
 * agree. Protection comes from corroboration, not from detection. This is the design
 * arXiv 2609.19705 asks for ("corroborate sources"), and its limit is SPEC.md 2A.6 H4: plant
 * the same fake in three declared groups and the trade goes through at full size.
 *
 * PRICE claims are different and genuinely checked, which is why the fake indicator panel
 * attack is defeated here rather than merely diluted.
 */

import { canonical, sha256Hex, verifyEvidenceItem } from "@krexa-ual/sdk";
import type {
  Direction,
  EvidenceBundle,
  SignedEvidenceItem,
  Stance,
} from "@krexa-ual/sdk";

import { extractPrice } from "./extract.js";
import { checkClaim, type IndicatorCheck, type IndicatorClaim, type PriceSeriesPoint } from "./indicators.js";

export interface VerifierPolicy {
  maxAgeSec: number;
  groups: { group: string; sources: string[] }[];
  sizeTableBps: number[];
  verifierCodeHash: string;
}

/** What an Analyst emits. SPEC.md 2A.2 item 1. */
export interface Signal {
  asset: string;
  direction: Direction;
  /** Basis points of stated probability that the trade is profitable at `horizonMin`. */
  confidence: number;
  horizonMin: number;
  /** evidenceIds, which are contentHashes. */
  citations: string[];
  /** Per-citation stance, for items the verifier cannot judge itself. */
  declaredStance?: Record<string, Stance>;
  /** Indicator figures the thesis rests on. Each one is recomputed. */
  claims?: IndicatorClaim[];
}

export interface ItemVerdict {
  evidenceId: string;
  /**
   * Which item bearing this `evidenceId` this verdict is about.
   *
   * An evidenceId is a **content** hash (SPEC.md 2A.2 item 1), so the same text reported by
   * three outlets produces three signed items that share one id and differ only in `source`.
   * That is precisely the H4 attack: plant one fake widely and corroboration counting is
   * satisfied. A verdict therefore has to be per item, not per id.
   */
  itemIndex: number;
  /** False when the citation does not resolve to a supplied item at all. */
  resolved: boolean;
  signatureValid: boolean;
  fresh: boolean;
  /** The group the policy assigns, or undefined when the source is undeclared. */
  group?: string;
  source?: string;
  stance: Stance;
  /** Where the stance came from. `recomputed` is checkable; `declared` is not. */
  stanceSource: "recomputed" | "declared" | "none";
  /** Whether this item contributed to k. */
  counted: boolean;
  /** Why it did not, when it did not. */
  excluded?: string;
}

export interface VerifierResult {
  /** The bundle to submit, or undefined when nothing survived. */
  bundle?: EvidenceBundle;
  items: ItemVerdict[];
  claimChecks: IndicatorCheck[];
  /** Claims that were dropped because the cited prices did not support them. */
  droppedClaims: IndicatorClaim[];
  supportGroups: string[];
  contradictGroups: string[];
  /** Agreeing groups net of contradicting, floored at zero. */
  k: number;
  sizeMultiplierBps: number;
  /** Plain-language account of the decision, for the attack replay view. */
  explanation: string[];
}

function groupForSource(policy: VerifierPolicy, source: string): string | undefined {
  for (const g of policy.groups) if (g.sources.includes(source)) return g.group;
  return undefined;
}

function sizeMultiplier(policy: VerifierPolicy, k: number): number {
  const t = policy.sizeTableBps;
  if (t.length === 0) return 0;
  return t[Math.min(k, t.length - 1)]!;
}

/**
 * Decide the stance of a PRICE item by arithmetic.
 *
 * A price item supports a LONG if the asset's 24 hour move is positive, and a SHORT if it is
 * negative. Deliberately crude, and deliberately checkable: anyone can recompute it from the
 * same bytes. A flat move is NEUTRAL rather than being rounded into agreement.
 */
function priceStance(
  item: SignedEvidenceItem,
  rawBody: string | undefined,
  asset: string,
  direction: Direction,
): { stance: Stance; detail: string } | undefined {
  if (!rawBody) return undefined;
  const point = extractPrice(item.item.source, rawBody, asset);
  if (!point?.prevDayPrice) return undefined;
  const prev = Number(point.prevDayPrice);
  const now = Number(point.price);
  if (!Number.isFinite(prev) || !Number.isFinite(now) || prev === 0) return undefined;
  const bps = Math.round(((now - prev) / prev) * 10_000);
  // Flat is flat. 10 bps either way is noise, not a direction.
  if (Math.abs(bps) < 10) {
    return { stance: "NEUTRAL", detail: `${point.venue} 24h move ${bps} bps, flat` };
  }
  const supportsLong = bps > 0;
  const agrees = direction === "LONG" ? supportsLong : !supportsLong;
  return {
    stance: agrees ? "SUPPORT" : "CONTRADICT",
    detail: `${point.venue} 24h move ${bps} bps, ${agrees ? "agrees with" : "contradicts"} ${direction}`,
  };
}

export interface VerifyInput {
  signal: Signal;
  /**
   * The fetcher keys registered on the contract (`ed25519:...`). An item signed by any other
   * key is not counted: a valid signature from a key nobody registered proves nothing.
   */
  fetchers: string[];
  /** Every signed item available, keyed by nothing: looked up by contentHash. */
  items: SignedEvidenceItem[];
  /** Raw bodies by contentHash, for indicator recompute and price stance. */
  rawBodies?: Record<string, string>;
  policy: VerifierPolicy;
  /** The moment to judge freshness against, in nanoseconds. Injected, never read from a clock. */
  nowNs: string;
}

const U64_MAX = (1n << 64n) - 1n;

/** Decimal u64, no sign, no hex, no leading zeros, no whitespace. Anything else is undefined. */
function parseU64(s: unknown): bigint | undefined {
  if (typeof s !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(s)) return undefined;
  const n = BigInt(s);
  return n <= U64_MAX ? n : undefined;
}

export function verify(input: VerifyInput): VerifierResult {
  const { signal, policy, nowNs } = input;
  const registered = new Set(input.fetchers);
  // Hostile items (null, no `item`, non-string hash) cannot be indexed; drop them up front.
  const items = input.items.filter((i) => typeof i?.item?.contentHash === "string");
  // A raw body counts only if it hashes to the contentHash it is filed under. Otherwise a
  // caller could pair a genuine signed item with fabricated prices and have the verifier
  // "recompute" whatever stance or indicator it liked.
  const rawBodies: Record<string, string> = {};
  for (const [id, body] of Object.entries(input.rawBodies ?? {})) {
    if (sha256Hex(body) === id) rawBodies[id] = body;
  }
  const explanation: string[] = [];
  // An evidenceId is a content hash, so several signed items can share one. Indexing to a
  // single item would silently discard every duplicate but one, which would make the same
  // fake planted across three outlets look like a single source and make the gate appear far
  // stronger than it is. Index to a list.
  const byId = new Map<string, SignedEvidenceItem[]>();
  for (const i of items) {
    const list = byId.get(i.item.contentHash) ?? [];
    list.push(i);
    byId.set(i.item.contentHash, list);
  }
  // Stable order, so the verifier stays deterministic whatever order the caller supplied.
  for (const list of byId.values()) {
    list.sort((a, b) => (a.item.source < b.item.source ? -1 : a.item.source > b.item.source ? 1 : 0));
  }
  // An unparseable window or clock makes everything stale rather than throwing.
  const maxAgeSecN = Number.isSafeInteger(policy.maxAgeSec) && policy.maxAgeSec >= 0 ? policy.maxAgeSec : undefined;
  const maxAgeNs = maxAgeSecN === undefined ? undefined : BigInt(maxAgeSecN) * 1_000_000_000n;
  const now = parseU64(nowNs);

  // The one predicate for "this item may count": signed by a registered key, fresh, and from
  // a declared source. Used for the indicator series and for the verdicts alike.
  const status = (item: SignedEvidenceItem) => {
    const signatureValid = registered.has(item.fetcherKey) && verifyEvidenceItem(item);
    const fetchedAt = parseU64(item.item.fetchedAt);
    // A timestamp in the future is treated as stale, not extra-fresh, so a fetcher cannot buy
    // itself a longer window by lying forward. Matches the contract.
    const fresh =
      fetchedAt !== undefined && now !== undefined && maxAgeNs !== undefined &&
      fetchedAt > 0n && fetchedAt <= now && now - fetchedAt <= maxAgeNs;
    const group = groupForSource(policy, item.item.source);
    return { signatureValid, fetchedAt, fresh, group, eligible: signatureValid && fresh && group !== undefined };
  };

  // ---- indicator claims, recomputed from cited PRICE evidence only ----
  //
  // The series is assembled from the citations alone. A signal may not benefit from prices it
  // did not point at.
  const citedPriceSeries: PriceSeriesPoint[] = [];
  for (const id of signal.citations) {
    for (const item of byId.get(id) ?? []) {
      if (item.item.kind !== "PRICE" || !status(item).eligible) continue;
      const body = rawBodies[id];
      if (!body) continue;
      const point = extractPrice(item.item.source, body, signal.asset);
      if (!point) continue;
      citedPriceSeries.push({
        ts: item.item.fetchedAt,
        price: point.price,
        prevDayPrice: point.prevDayPrice,
        funding: point.funding,
      });
    }
  }
  citedPriceSeries.sort((a, b) => {
    const x = BigInt(a.ts);
    const y = BigInt(b.ts);
    return x < y ? -1 : x > y ? 1 : 0;
  });

  const claimChecks: IndicatorCheck[] = (signal.claims ?? []).map((c) =>
    checkClaim(c, c.asset === signal.asset ? citedPriceSeries : []),
  );
  const droppedClaims = claimChecks.filter((c) => !c.matches).map((c) => c.claim);

  for (const c of claimChecks) {
    if (c.matches) {
      explanation.push(
        `claim ${c.claim.indicator}=${c.claim.value} checks out (recomputed ${c.recomputed}, tolerance ${c.tolerance})`,
      );
    } else if (c.recomputed !== undefined) {
      explanation.push(
        `claim ${c.claim.indicator}=${c.claim.value} DROPPED: cited prices give ${c.recomputed}, ` +
          `outside the tolerance of ${c.tolerance}`,
      );
    } else {
      explanation.push(`claim ${c.claim.indicator}=${c.claim.value} DROPPED: ${c.unverifiable}`);
    }
  }

  // ---- per-citation verdicts ----
  const verdicts: ItemVerdict[] = [];
  const supportGroups: string[] = [];
  const contradictGroups: string[] = [];

  // Citations are deduplicated: citing the same content twice is one citation, not two. The
  // multiplicity that matters is how many *sources* carried that content, which is the list
  // under the id and not the number of times it was mentioned.
  const citedIds = [...new Set(signal.citations)];

  for (const id of citedIds) {
    const matching = byId.get(id) ?? [];
    if (matching.length === 0) {
      verdicts.push({
        evidenceId: id,
        itemIndex: 0,
        resolved: false,
        signatureValid: false,
        fresh: false,
        stance: "NEUTRAL",
        stanceSource: "none",
        counted: false,
        excluded: "citation does not resolve to any supplied evidence item",
      });
      explanation.push(`citation ${id.slice(0, 12)} does not resolve to any item`);
      continue;
    }

    if (matching.length > 1) {
      // Worth saying out loud in the explanation: this is the shape of the H4 attack, and a
      // reader of the attack replay view needs to see it rather than infer it.
      explanation.push(
        `citation ${id.slice(0, 12)} is carried by ${matching.length} sources ` +
          `[${matching.map((m) => m.item.source).join(", ")}]: identical content, so one ` +
          `planted claim can satisfy several groups`,
      );
    }

    for (let itemIndex = 0; itemIndex < matching.length; itemIndex++) {
      const item = matching[itemIndex]!;
      const { signatureValid, fresh, group } = status(item);

      let stance: Stance = "NEUTRAL";
      let stanceSource: ItemVerdict["stanceSource"] = "none";

      if (item.item.kind === "PRICE") {
        const computed = priceStance(item, rawBodies[id], signal.asset, signal.direction);
        if (computed) {
          stance = computed.stance;
          stanceSource = "recomputed";
          explanation.push(`${item.item.source}: ${computed.detail}`);
        } else {
          // No raw body, or an unparseable one. The verifier will not fall back to the
          // Analyst's word for something it is supposed to check itself.
          stance = "NEUTRAL";
          stanceSource = "none";
          explanation.push(
            `${item.item.source}: PRICE item could not be recomputed, counted as NEUTRAL`,
          );
        }
      } else {
        const declared = signal.declaredStance?.[id];
        if (declared) {
          stance = declared;
          stanceSource = "declared";
          explanation.push(
            `${item.item.source}: ${item.item.kind} stance ${declared} is the Analyst's claim, not checked`,
          );
        }
      }

      let counted = false;
      let excluded: string | undefined;
      if (!signatureValid) excluded = "signature does not verify, or the fetcher key is not registered";
      else if (!fresh) excluded = `fetched outside the ${policy.maxAgeSec}s freshness window`;
      else if (!group) excluded = `source "${item.item.source}" is not declared in any policy group`;
      else if (stance === "NEUTRAL") excluded = "neither supports nor contradicts the thesis";
      else {
        counted = true;
        const bucket = stance === "SUPPORT" ? supportGroups : contradictGroups;
        if (!bucket.includes(group)) bucket.push(group);
      }
      if (excluded) explanation.push(`${item.item.source}: not counted, ${excluded}`);

      verdicts.push({
        evidenceId: id,
        itemIndex,
        resolved: true,
        signatureValid,
        fresh,
        group,
        source: item.item.source,
        stance,
        stanceSource,
        counted,
        excluded,
      });
    }
  }

  const k = Math.max(0, supportGroups.length - contradictGroups.length);
  const sizeMultiplierBps = sizeMultiplier(policy, k);

  explanation.push(
    `${supportGroups.length} supporting group(s) [${supportGroups.join(", ")}] minus ` +
      `${contradictGroups.length} contradicting [${contradictGroups.join(", ")}] gives k=${k}, ` +
      `size multiplier ${sizeMultiplierBps} bps`,
  );

  // ---- the bundle ----
  //
  // Only items that passed signature and freshness go on chain. An item excluded merely for
  // being NEUTRAL is still included, because the contract recounts groups itself and the
  // receipt should show what was offered.
  // One bundle entry per surviving *item*, not per citation. When the same content came from
  // three sources, all three go on chain so the contract can recount the groups itself.
  const bundleItems = verdicts
    .filter((v) => v.resolved && v.signatureValid && v.fresh)
    .map((v) => {
      const item = byId.get(v.evidenceId)![v.itemIndex]!;
      return { ...item, stance: v.stance };
    });

  const bundle: EvidenceBundle | undefined =
    bundleItems.length > 0
      ? {
          asset: signal.asset,
          direction: signal.direction,
          verifierCodeHash: policy.verifierCodeHash,
          items: bundleItems,
        }
      : undefined;

  return {
    bundle,
    items: verdicts,
    claimChecks,
    droppedClaims,
    supportGroups,
    contradictGroups,
    k,
    sizeMultiplierBps,
    explanation,
  };
}

/** Hash of a verifier result, so a DecisionRecord can commit to the reasoning it used. */
export function resultHash(result: VerifierResult): string {
  return sha256Hex(
    canonical({
      items: result.items.map((i) => ({
        evidenceId: i.evidenceId,
        itemIndex: i.itemIndex,
        source: i.source ?? null,
        counted: i.counted,
        group: i.group ?? null,
        stance: i.stance,
        stanceSource: i.stanceSource,
      })),
      k: result.k,
      sizeMultiplierBps: result.sizeMultiplierBps,
      droppedClaims: result.droppedClaims.map((c) => ({
        indicator: c.indicator,
        asset: c.asset,
        value: c.value,
      })),
    }),
  );
}
