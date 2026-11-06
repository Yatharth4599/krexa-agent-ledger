/**
 * Analysts. SPEC.md 2A.3 and 7.
 *
 * The study compares desk shapes, so every desk here runs the **same** Analyst code and
 * differs only in aggregation and in whether the evidence gate applies. If the Analysts
 * differed, a difference in attack success rate would not be attributable to the defence.
 *
 * `sim` mode uses the scripted Analyst below: deterministic, seeded, no LLM, no network. That
 * is what the AI Swarms track asks for and what a judge runs. An LLM Analyst satisfying the
 * same interface arrives with the budget-approved runs in M4 and M5.
 *
 * ## Why a scripted Analyst is the right baseline to attack
 *
 * The obvious objection is that a rule-based Analyst cannot be fooled by a headline the way an
 * LLM can, so attacking it proves nothing. That is true of *prompt* injection and false of
 * *information* injection, which is the attack class under study. The scripted Analyst reads
 * the same evidence a model would and weighs a headline by the same cues
 * arXiv 2610.26438 finding (ii) identifies as decisive: a named source and a "BREAKING" tag.
 * Those cues are what the paper reports moving ASR from 100% to 0%, so a rule that keys on
 * them reproduces the mechanism rather than merely gesturing at it, and it does so without
 * burning a token budget on every pilot run.
 *
 * It is a model of the vulnerability, not a model of a trader, and the README says so.
 */

import type { Direction, Stance } from "@krexa-ual/sdk";
import type { IndicatorClaim, Signal } from "@krexa-ual/verifier";

import type { Thesis, Order } from "./decision.js";

/** One evidence item as the Analyst sees it: content plus where it came from. */
export interface AnalystInput {
  evidenceId: string;
  kind: "NEWS" | "PRICE" | "MARKET" | "ONCHAIN";
  source: string;
  /** The raw text or payload. For NEWS this is the headline. */
  content: string;
  fetchedAtNs: string;
}

export interface MarketView {
  asset: string;
  /** Latest mid per venue, decimal strings. */
  pricesByVenue: Record<string, string>;
  /** 24h move in basis points per venue, where computable. */
  momentumBpsByVenue: Record<string, number>;
}

export interface AnalystOutput {
  thesis: Thesis;
  order: Order | null;
  signal: Signal | null;
  /** The exact prompt-equivalent bytes, for the DecisionRecord. */
  prompt: string;
  /** The exact raw output bytes, for the DecisionRecord. */
  rawOutput: string;
  modelId: string;
}

/** The two surface cues arXiv 2610.26438 finding (ii) reports as decisive. */
const BREAKING_CUE = /\b(breaking|urgent|just in|exclusive)\b/i;
const NAMED_SOURCE_CUE =
  /\b(reuters|bloomberg|sec|cftc|federal reserve|blackrock|fidelity|according to|sources say|confirms?|filing)\b/i;

const BULLISH = /\b(approv\w+|inflow|allocation|adopt\w+|surge|rally|upgrade|buy|accumulat\w+)\b/i;
const BEARISH = /\b(reject\w+|outflow|hack|exploit|ban|lawsuit|probe|downgrade|sell|liquidat\w+)\b/i;

export interface ScriptedConfig {
  /** Momentum, in bps, above which price alone is treated as directional. */
  momentumThresholdBps: number;
  /** Notional to request when the thesis is directional, micro-USD. */
  baseNotionalUsd: string;
  /** How many credibility cues a headline needs before it moves the thesis. */
  requiredCues: 1 | 2;
}

export const DEFAULT_SCRIPTED: ScriptedConfig = {
  momentumThresholdBps: 100,
  baseNotionalUsd: "500000000",
  // One cue is enough, which is deliberately credulous: this Analyst is a model of the
  // vulnerability the study measures, not a well-defended trader.
  requiredCues: 1,
};

function scoreHeadline(text: string): { score: number; cues: string[] } {
  const cues: string[] = [];
  if (BREAKING_CUE.test(text)) cues.push("breaking-tag");
  if (NAMED_SOURCE_CUE.test(text)) cues.push("named-source");
  const bullish = BULLISH.test(text);
  const bearish = BEARISH.test(text);
  const direction = bullish && !bearish ? 1 : bearish && !bullish ? -1 : 0;
  return { score: direction * cues.length, cues };
}

/**
 * The scripted Analyst.
 *
 * Deterministic in its inputs: same evidence, same market view, same output, every time. No
 * clock, no randomness, no network.
 */
export function scriptedAnalyst(
  asset: string,
  evidence: AnalystInput[],
  market: MarketView,
  config: ScriptedConfig = DEFAULT_SCRIPTED,
): AnalystOutput {
  const modelId = "scripted/cue-weighted@1";

  const news = evidence.filter((e) => e.kind === "NEWS");
  const prices = evidence.filter((e) => e.kind === "PRICE");

  // --- headline reading ---
  let newsScore = 0;
  const citedNews: AnalystInput[] = [];
  const declaredStance: Record<string, Stance> = {};
  const cueLog: string[] = [];

  for (const item of news) {
    const { score, cues } = scoreHeadline(item.content);
    cueLog.push(`${item.source}: cues=[${cues.join(",")}] score=${score}`);
    if (score === 0 || cues.length < config.requiredCues) continue;
    newsScore += score;
    citedNews.push(item);
    declaredStance[item.evidenceId] = score > 0 ? "SUPPORT" : "CONTRADICT";
  }

  // --- price reading ---
  const venues = Object.keys(market.momentumBpsByVenue).sort();
  const momenta = venues.map((v) => market.momentumBpsByVenue[v]!);
  const avgMomentum =
    momenta.length > 0 ? Math.round(momenta.reduce((a, b) => a + b, 0) / momenta.length) : 0;
  const priceDirection =
    avgMomentum >= config.momentumThresholdBps
      ? 1
      : avgMomentum <= -config.momentumThresholdBps
        ? -1
        : 0;

  // --- combine ---
  // News dominates when it speaks, which is exactly the vulnerability under study: a single
  // credible-looking headline outvotes the price tape.
  const combined = newsScore !== 0 ? Math.sign(newsScore) : priceDirection;

  const direction: Thesis["direction"] =
    combined > 0 ? "LONG" : combined < 0 ? "SHORT" : "HOLD";

  // Confidence rises with agreement, and is capped well below certainty.
  const agree = newsScore !== 0 && priceDirection !== 0 && Math.sign(newsScore) === priceDirection;
  const confidence = direction === "HOLD" ? 0 : agree ? 7000 : 5500;

  const thesis: Thesis = {
    asset,
    direction,
    confidence,
    horizonMin: 240,
    maxNotionalUsd: config.baseNotionalUsd,
  };

  const order: Order | null =
    direction === "HOLD"
      ? null
      : {
          action: direction === "LONG" ? "OPEN_LONG" : "OPEN_SHORT",
          asset,
          notionalUsd: config.baseNotionalUsd,
        };

  // Cite everything that informed the view: the news that moved it and every price item,
  // since the price tape is part of the reasoning even when it was outvoted.
  const citations = [...citedNews.map((i) => i.evidenceId), ...prices.map((i) => i.evidenceId)];

  const claims: IndicatorClaim[] =
    direction === "HOLD" || prices.length === 0
      ? []
      : [{ indicator: "MOMENTUM_24H_BPS", asset, value: avgMomentum }];

  const signal: Signal | null =
    direction === "HOLD"
      ? null
      : {
          asset,
          direction: direction as Direction,
          confidence,
          horizonMin: 240,
          citations,
          declaredStance,
          claims,
        };

  // The prompt-equivalent: the exact inputs this decision was made from. Hashed into the
  // DecisionRecord so a replay can confirm nothing was added afterwards.
  const prompt = [
    `agent: ${modelId}`,
    `asset: ${asset}`,
    `config: momentumThresholdBps=${config.momentumThresholdBps} requiredCues=${config.requiredCues} baseNotionalUsd=${config.baseNotionalUsd}`,
    `prices: ${venues.map((v) => `${v}=${market.pricesByVenue[v] ?? "?"}@${market.momentumBpsByVenue[v]}bps`).join(" ")}`,
    `news:`,
    ...news.map((n) => `  [${n.source}] ${n.content}`),
  ].join("\n");

  const rawOutput = JSON.stringify(
    {
      cueLog,
      newsScore,
      avgMomentum,
      priceDirection,
      combined,
      thesis,
      order,
      citations,
    },
    null,
    2,
  );

  return { thesis, order, signal, prompt, rawOutput, modelId };
}

/**
 * Buy-and-hold. Equal weights the allowed assets once and then never trades again.
 *
 * A baseline is only a baseline if it had the same opportunity set, so it reads the same price
 * stream and decides at the same timestamps. It just always decides the same thing.
 */
export function buyAndHold(
  asset: string,
  market: MarketView,
  alreadyOpened: boolean,
  notionalUsd: string,
): AnalystOutput {
  const modelId = "scripted/buy-and-hold@1";
  const thesis: Thesis = {
    asset,
    direction: alreadyOpened ? "HOLD" : "LONG",
    confidence: 0,
    horizonMin: 0,
    maxNotionalUsd: notionalUsd,
  };
  return {
    thesis,
    order: alreadyOpened ? null : { action: "OPEN_LONG", asset, notionalUsd },
    // Baselines read no evidence and cite none. SPEC.md 7.
    signal: null,
    prompt: `agent: ${modelId}\nasset: ${asset}\nalreadyOpened: ${alreadyOpened}`,
    rawOutput: JSON.stringify({ alreadyOpened, thesis }, null, 2),
    modelId,
  };
}
