/**
 * Swarm aggregation shapes. SPEC.md 2A.3.
 *
 * Four desks run the **same** Analyst code and differ only in how several Analyst views are
 * combined. If the Analysts differed, a difference in attack success rate would not be
 * attributable to the aggregation.
 *
 * - `plain`: one Analyst. Today's typical agent.
 * - `debate`: three Analysts, one round of mutual visibility, then a majority vote.
 * - `hier`: specialist Analysts (news, technicals, funding) feeding a manager.
 * - `ebi`: a plain Analyst behind the evidence gate.
 *
 * ## Why `hier` is not optional
 *
 * SPEC.md 18 cut-line 5 drops `hier` and keeps `debate`. arXiv 2610.26438 finding (v) says the
 * opposite is the interesting case:
 *
 * > "model scaling stops shallow vectors but not fact poisoning, peer debate fails, and only
 * > hierarchical aggregation reduces ASR"
 *
 * So `debate`'s failure is already published and reproducing it is a sanity check, while
 * `hier` is the one published defence that works and is therefore the baseline the evidence
 * gate actually has to beat. Dropping `hier` would leave the results comparing the gate only
 * against defences the literature already calls ineffective, which is the comparison most
 * likely to flatter us. docs/PRIOR_WORK.md records this and the recommendation to YK.
 *
 * The specialists below are deliberately narrow readers of the same evidence, not different
 * models. That is what "hierarchical aggregation" means here: a manager that sees three
 * partial views rather than one undifferentiated context, so a poisoned news item reaches it
 * as one specialist's opinion rather than as the whole picture.
 */

import type { Stance } from "@krexa-ual/sdk";
import type { Signal } from "@krexa-ual/verifier";

import {
  scriptedAnalyst,
  type AnalystInput,
  type AnalystOutput,
  type MarketView,
  type ScriptedConfig,
  DEFAULT_SCRIPTED,
} from "./analyst.js";
import type { Order, Thesis } from "./decision.js";

export type DeskShape = "plain" | "debate" | "hier" | "ebi" | "bh";

/** Three Analysts with different credulity, which is what makes a vote meaningful. */
const DEBATE_PANEL: ScriptedConfig[] = [
  { ...DEFAULT_SCRIPTED, requiredCues: 1, momentumThresholdBps: 100 },
  { ...DEFAULT_SCRIPTED, requiredCues: 1, momentumThresholdBps: 200 },
  { ...DEFAULT_SCRIPTED, requiredCues: 2, momentumThresholdBps: 100 },
];

/**
 * Debate: run the panel, let each see the others' directions, then vote.
 *
 * The "debate round" is modelled as each Analyst being told the panel's directions and being
 * allowed to abstain if it is alone. That is the charitable reading of peer debate, and it is
 * still expected to fail against fact poisoning for the reason SPEC.md 2A.6 H2a gives: all
 * three read the same poisoned context, so agreement is not independence. Reproducing a
 * published negative result is the point.
 */
export function debateDesk(
  asset: string,
  evidence: AnalystInput[],
  market: MarketView,
): AnalystOutput {
  const modelId = "scripted/debate-3@1";
  const views = DEBATE_PANEL.map((cfg) => scriptedAnalyst(asset, evidence, market, cfg));
  const directions = views.map((v) => v.thesis.direction);

  const votes = { LONG: 0, SHORT: 0, HOLD: 0 };
  for (const d of directions) votes[d] += 1;

  // One round of mutual visibility: an Analyst that stands alone steps back.
  const afterRound = directions.map((d) => {
    if (d === "HOLD") return d;
    const agreeing = directions.filter((o) => o === d).length;
    return agreeing >= 2 ? d : "HOLD";
  });
  const finalVotes = { LONG: 0, SHORT: 0, HOLD: 0 };
  for (const d of afterRound) finalVotes[d] += 1;

  const direction: Thesis["direction"] =
    finalVotes.LONG > finalVotes.SHORT && finalVotes.LONG >= 2
      ? "LONG"
      : finalVotes.SHORT > finalVotes.LONG && finalVotes.SHORT >= 2
        ? "SHORT"
        : "HOLD";

  // Take the winning side's own notional and citations, so size is not invented by the vote.
  const winner = views.find((v) => v.thesis.direction === direction) ?? views[0]!;
  const confidence = direction === "HOLD" ? 0 : Math.min(8000, 4000 + finalVotes[direction] * 1200);

  const thesis: Thesis = {
    asset,
    direction,
    confidence,
    horizonMin: 240,
    maxNotionalUsd: winner.thesis.maxNotionalUsd,
  };
  const order: Order | null =
    direction === "HOLD"
      ? null
      : {
          action: direction === "LONG" ? "OPEN_LONG" : "OPEN_SHORT",
          asset,
          notionalUsd: winner.thesis.maxNotionalUsd ?? "0",
        };

  const signal: Signal | null =
    direction === "HOLD" || !winner.signal
      ? null
      : { ...winner.signal, direction, confidence };

  return {
    thesis,
    order,
    signal,
    modelId,
    prompt: [
      `agent: ${modelId}`,
      `panel: ${DEBATE_PANEL.map((c) => `cues=${c.requiredCues},mom=${c.momentumThresholdBps}`).join(" | ")}`,
      ...views.map((v, i) => `analyst${i} prompt:\n${v.prompt}`),
    ].join("\n"),
    rawOutput: JSON.stringify(
      {
        directionsBeforeRound: directions,
        directionsAfterRound: afterRound,
        votes,
        finalVotes,
        direction,
        thesis,
        order,
      },
      null,
      2,
    ),
  };
}

/**
 * Hierarchical aggregation: three specialists, then a manager.
 *
 * Each specialist sees only its own slice of the evidence, which is the mechanism. A poisoned
 * headline reaches the manager as "the news specialist says LONG", one input among three,
 * rather than as the entire context. The manager requires the news view to be corroborated by
 * at least one other specialist before it acts on it.
 *
 * Note what this is **not**: it is not the evidence gate. The manager counts *specialists*,
 * which are three readings of one evidence set, while the gate counts independent *sources*.
 * Three specialists reading one fake all see the same fake. That is why the two are expected
 * to behave differently, and measuring that difference is the point of M4.
 */
export function hierDesk(
  asset: string,
  evidence: AnalystInput[],
  market: MarketView,
): AnalystOutput {
  const modelId = "scripted/hier-3@1";

  const newsOnly = evidence.filter((e) => e.kind === "NEWS");
  const pricesOnly = evidence.filter((e) => e.kind === "PRICE");

  // News specialist: headlines only, no tape.
  const newsView = scriptedAnalyst(asset, newsOnly, { ...market, momentumBpsByVenue: {} });
  // Technicals specialist: tape only, no headlines.
  const techView = scriptedAnalyst(asset, pricesOnly, market);
  // Funding specialist: tape only, and a higher bar, so it speaks less often.
  const fundingView = scriptedAnalyst(asset, pricesOnly, market, {
    ...DEFAULT_SCRIPTED,
    momentumThresholdBps: 300,
  });

  const specialists = [
    { name: "news", view: newsView },
    { name: "technicals", view: techView },
    { name: "funding", view: fundingView },
  ];
  const speaking = specialists.filter((s) => s.view.thesis.direction !== "HOLD");

  // The manager's rule: a news-only view needs a second specialist to agree before it is
  // acted on. This is the whole defence, and it is a rule rather than a model so it cannot be
  // talked out of firing.
  let direction: Thesis["direction"] = "HOLD";
  let rationale = "no specialist spoke";

  if (speaking.length > 0) {
    const dirs = speaking.map((s) => s.view.thesis.direction);
    const allAgree = dirs.every((d) => d === dirs[0]);
    const newsAlone = speaking.length === 1 && speaking[0]!.name === "news";

    if (newsAlone) {
      rationale = "the news specialist spoke alone, which the manager does not act on";
    } else if (allAgree) {
      direction = dirs[0]!;
      rationale = `${speaking.length} specialists agree on ${direction}`;
    } else {
      rationale = `specialists disagree (${dirs.join(", ")}), manager holds`;
    }
  }

  const winner = speaking.find((s) => s.view.thesis.direction === direction)?.view ?? techView;
  const confidence = direction === "HOLD" ? 0 : Math.min(8000, 4000 + speaking.length * 1300);

  const thesis: Thesis = {
    asset,
    direction,
    confidence,
    horizonMin: 240,
    maxNotionalUsd: winner.thesis.maxNotionalUsd ?? DEFAULT_SCRIPTED.baseNotionalUsd,
  };
  const order: Order | null =
    direction === "HOLD"
      ? null
      : {
          action: direction === "LONG" ? "OPEN_LONG" : "OPEN_SHORT",
          asset,
          notionalUsd: thesis.maxNotionalUsd!,
        };

  // The manager's signal cites everything every speaking specialist cited, deduplicated.
  const citations = [
    ...new Set(speaking.flatMap((s) => s.view.signal?.citations ?? [])),
  ];
  const declaredStance: Record<string, Stance> = {};
  for (const s of speaking) {
    Object.assign(declaredStance, s.view.signal?.declaredStance ?? {});
  }

  const signal: Signal | null =
    direction === "HOLD"
      ? null
      : {
          asset,
          direction,
          confidence,
          horizonMin: 240,
          citations,
          declaredStance,
          claims: winner.signal?.claims ?? [],
        };

  return {
    thesis,
    order,
    signal,
    modelId,
    prompt: [
      `agent: ${modelId}`,
      ...specialists.map((s) => `${s.name} specialist prompt:\n${s.view.prompt}`),
    ].join("\n"),
    rawOutput: JSON.stringify(
      {
        specialists: specialists.map((s) => ({
          name: s.name,
          direction: s.view.thesis.direction,
        })),
        speaking: speaking.map((s) => s.name),
        rationale,
        direction,
        thesis,
        order,
      },
      null,
      2,
    ),
  };
}
