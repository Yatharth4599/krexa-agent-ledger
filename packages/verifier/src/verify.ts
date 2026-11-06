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
  /** Every signed item available, keyed by nothing: looked up by contentHash. */
  items: SignedEvidenceItem[];
  /** Raw bodies by contentHash, for indicator recompute and price stance. */
  rawBodies?: Record<string, string>;
  policy: VerifierPolicy;
  /** The moment to judge freshness against, in nanoseconds. Injected, never read from a clock. */
  nowNs: string;
}

export function verify(input: VerifyInput): VerifierResult {
  const { signal, items, policy, nowNs } = input;
  const rawBodies = input.rawBodies ?? {};
  const explanation: string[] = [];
  const byId = new Map(items.map((i) => [i.item.contentHash, i]));
  const maxAgeNs = BigInt(policy.maxAgeSec) * 1_000_000_000n;
  const now = BigInt(nowNs);

  // ---- indicator claims, recomputed from cited PRICE evidence only ----
  //
  // The series is assembled from the citations alone. A signal may not benefit from prices it
  // did not point at.
  const citedPriceSeries: PriceSeriesPoint[] = [];
  for (const id of signal.citations) {
    const item = byId.get(id);
    if (!item || item.item.kind !== "PRICE") continue;
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
  citedPriceSeries.sort((a, b) => (BigInt(a.ts) < BigInt(b.ts) ? -1 : 1));

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

  for (const id of signal.citations) {
    const item = byId.get(id);
    if (!item) {
      verdicts.push({
        evidenceId: id,
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

    const signatureValid = verifyEvidenceItem(item);
    const fetchedAt = BigInt(item.item.fetchedAt);
    // A timestamp in the future is treated as stale, not extra-fresh, so a fetcher cannot buy
    // itself a longer window by lying forward. Matches the contract.
    const fresh = fetchedAt > 0n && fetchedAt <= now && now - fetchedAt <= maxAgeNs;
    const group = groupForSource(policy, item.item.source);

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
    if (!signatureValid) excluded = "signature does not verify";
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
  const bundleItems = verdicts
    .filter((v) => v.resolved && v.signatureValid && v.fresh)
    .map((v) => {
      const item = byId.get(v.evidenceId)!;
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
