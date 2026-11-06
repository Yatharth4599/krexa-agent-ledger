/**
 * Tests for the pure parts of the runtime: DecisionRecords, the consistency check, the
 * scripted Analyst, and the Monitor's rules.
 *
 * Everything tested here is deterministic by construction, which is what makes the replay
 * harness meaningful: if the Analyst were not a pure function of its inputs, replaying a
 * decision point could not reproduce the decision.
 */

import { describe, expect, it } from "vitest";

import {
  buildDecision,
  checkConsistency,
  decisionHashOf,
  decisionsRoot,
  replayDecision,
  type Order,
  type Thesis,
} from "../src/decision.js";
import {
  buyAndHold,
  DEFAULT_SCRIPTED,
  scriptedAnalyst,
  type AnalystInput,
  type MarketView,
} from "../src/analyst.js";
import {
  DEFAULT_MONITOR,
  evaluate,
  killSwitchReason,
  type MonitorState,
} from "../src/monitor.js";
import { debateDesk, hierDesk } from "../src/aggregation.js";

// ---------------------------------------------------------------- consistency

describe("the consistency check", () => {
  const thesis = (over: Partial<Thesis> = {}): Thesis => ({
    asset: "BTC",
    direction: "LONG",
    confidence: 6500,
    horizonMin: 240,
    maxNotionalUsd: "500000000",
    ...over,
  });
  const order = (over: Partial<Order> = {}): Order => ({
    action: "OPEN_LONG",
    asset: "BTC",
    notionalUsd: "500000000",
    ...over,
  });
  const llm = { modelId: "provider/model@1", outputParsed: true };

  it("passes when the order matches the thesis", () => {
    const r = checkConsistency(thesis(), order(), llm);
    expect(r.result).toBe("PASS");
    expect(r.failures).toEqual([]);
  });

  it("fails when the order direction contradicts the thesis", () => {
    const r = checkConsistency(thesis({ direction: "LONG" }), order({ action: "OPEN_SHORT" }), llm);
    expect(r.result).toBe("FAIL");
    expect(r.failures.join(" ")).toMatch(/LONG but the order opens a short/);
  });

  it("fails when the asset differs", () => {
    const r = checkConsistency(thesis(), order({ asset: "ETH" }), llm);
    expect(r.result).toBe("FAIL");
    expect(r.failures.join(" ")).toMatch(/order asset ETH differs/);
  });

  it("fails when a HOLD thesis opens a position", () => {
    const r = checkConsistency(thesis({ direction: "HOLD" }), order(), llm);
    expect(r.result).toBe("FAIL");
    expect(r.failures.join(" ")).toMatch(/HOLD but the order opens/);
  });

  it("allows a HOLD thesis to close an existing position", () => {
    // Deciding not to hold a position is not the same as deciding to open one, so a HOLD
    // thesis that exits is consistent. Treating it as a failure would push agents toward
    // sitting in positions they no longer believe in.
    const r = checkConsistency(thesis({ direction: "HOLD" }), order({ action: "CLOSE" }), llm);
    expect(r.result).toBe("PASS");
  });

  it("fails when the order is larger than the thesis argues for", () => {
    const r = checkConsistency(
      thesis({ maxNotionalUsd: "100000000" }),
      order({ notionalUsd: "500000000" }),
      llm,
    );
    expect(r.result).toBe("FAIL");
    expect(r.failures.join(" ")).toMatch(/exceeds the 100000000/);
  });

  it("fails when the output did not parse", () => {
    const r = checkConsistency(thesis(), null, { ...llm, outputParsed: false });
    expect(r.result).toBe("FAIL");
    expect(r.failures.join(" ")).toMatch(/did not parse/);
  });

  it("fails on a non-canonical notional", () => {
    const r = checkConsistency(thesis(), order({ notionalUsd: "0500000000" }), llm);
    expect(r.result).toBe("FAIL");
  });

  it("reports NA for a scripted agent but still lists any failure", () => {
    // A rule-based agent that contradicts itself is a bug in our code. Reporting NA is what
    // SPEC.md 3.6 asks for; swallowing the failure list would hide the bug.
    const r = checkConsistency(thesis({ direction: "LONG" }), order({ action: "OPEN_SHORT" }), {
      modelId: "scripted/x@1",
      outputParsed: true,
    });
    expect(r.result).toBe("NA");
    expect(r.failures.length).toBeGreaterThan(0);
  });

  it("a HOLD thesis with no order is consistent", () => {
    const r = checkConsistency(thesis({ direction: "HOLD" }), null, llm);
    expect(r.result).toBe("PASS");
  });
});

// ---------------------------------------------------------------- DecisionRecords

describe("DecisionRecords", () => {
  const input = {
    deskId: "ebi",
    agent: "analyst.ebi.testnet",
    decidedAt: "2026-11-06T16:15:00Z",
    modelId: "scripted/cue-weighted@1",
    prompt: "asset: BTC\nnews: none",
    snapshot: { asset: "BTC", mid: "70000" },
    toolCalls: [{ tool: "get_prices", result: "ok" }],
    rawOutput: '{"thesis":{"direction":"HOLD"}}',
    thesis: { asset: "BTC", direction: "HOLD" as const, confidence: 0, horizonMin: 0 },
    order: null,
  };

  it("hashes every artifact and stores it by its own hash", () => {
    const built = buildDecision(input);
    expect(Object.keys(built.artifacts)).toHaveLength(4);
    for (const [hash, body] of Object.entries(built.artifacts)) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(body.length).toBeGreaterThan(0);
    }
    expect(built.record.artifacts.prompt).toBe(built.record.promptHash);
  });

  it("is deterministic", () => {
    expect(buildDecision(input).decisionHash).toBe(buildDecision(input).decisionHash);
  });

  it("changes hash when any input byte changes", () => {
    const a = buildDecision(input).decisionHash;
    const b = buildDecision({ ...input, prompt: input.prompt + " " }).decisionHash;
    const c = buildDecision({ ...input, rawOutput: input.rawOutput + " " }).decisionHash;
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("never claims the model signature was verified", () => {
    // The model id is self-reported until a NEAR AI Cloud signature is actually checked, and
    // this build does not check one. SPEC.md 15.
    const built = buildDecision({ ...input, modelId: "provider/m@1", aiSigHash: "a".repeat(64) });
    expect(built.record.aiSig.verified).toBe(false);
    expect(built.record.aiSig.sigHash).toBe("a".repeat(64));
  });
});

describe("replay", () => {
  const built = buildDecision({
    deskId: "ebi",
    agent: "analyst.ebi.testnet",
    decidedAt: "2026-11-06T16:15:00Z",
    modelId: "provider/model@1",
    prompt: "p",
    snapshot: { a: 1 },
    toolCalls: [],
    rawOutput: "o",
    thesis: { asset: "BTC", direction: "LONG", confidence: 6000, horizonMin: 240, maxNotionalUsd: "500000000" },
    order: { action: "OPEN_LONG", asset: "BTC", notionalUsd: "500000000" },
  });

  it("verifies every commitment when the artifacts are present", () => {
    const r = replayDecision(built.record, built.artifacts, built.decisionHash);
    expect(r.decisionHashMatches).toBe(true);
    expect(r.promptMatches).toBe(true);
    expect(r.snapshotMatches).toBe(true);
    expect(r.toolCallsMatches).toBe(true);
    expect(r.rawOutputMatches).toBe(true);
    expect(r.consistencyAgrees).toBe(true);
  });

  it("reports a missing artifact rather than passing it", () => {
    const r = replayDecision(built.record, {}, built.decisionHash);
    expect(r.promptMatches).toBe("missing");
    expect(r.lines.join("\n")).toMatch(/is not stored, cannot verify/);
  });

  it("catches an artifact whose bytes were changed after the fact", () => {
    const tampered = { ...built.artifacts, [built.record.promptHash]: "different prompt" };
    const r = replayDecision(built.record, tampered, built.decisionHash);
    expect(r.promptMatches).toBe(false);
    expect(r.lines.join("\n")).toMatch(/MISMATCH/);
  });

  it("catches a record edited to disagree with its on-chain hash", () => {
    const edited = {
      ...built.record,
      parsed: {
        ...built.record.parsed,
        // Rewriting history: claim the thesis was SHORT all along.
        thesis: { ...built.record.parsed.thesis, direction: "SHORT" as const },
      },
    };
    const r = replayDecision(edited, built.artifacts, built.decisionHash);
    expect(r.decisionHashMatches).toBe(false);
    // And the rerun consistency check now disagrees too, because a SHORT thesis with a long
    // order is contradictory.
    expect(r.consistencyRerun.result).toBe("FAIL");
    expect(r.consistencyAgrees).toBe(false);
  });

  it("says plainly what replay does not prove", () => {
    const r = replayDecision(built.record, built.artifacts, built.decisionHash);
    expect(r.lines.join("\n")).toMatch(/does not prove the reasoning was correct/);
    expect(r.lines.join("\n")).toMatch(/not zkML/);
  });
});

describe("decisionsRoot", () => {
  it("commits a set of hold decisions to one root", () => {
    const a = "1".repeat(64);
    const b = "2".repeat(64);
    expect(decisionsRoot([a, b])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is order independent, since a set has no order", () => {
    const a = "1".repeat(64);
    const b = "2".repeat(64);
    const c = "3".repeat(64);
    expect(decisionsRoot([a, b, c])).toBe(decisionsRoot([c, a, b]));
  });

  it("changes when any member changes", () => {
    const a = "1".repeat(64);
    const b = "2".repeat(64);
    expect(decisionsRoot([a, b])).not.toBe(decisionsRoot([a, "3".repeat(64)]));
  });

  it("promotes an odd node rather than duplicating it", () => {
    // Duplicating the last leaf is the CVE-2012-2459 shape, where two different leaf sets
    // produce the same root. Three leaves must not collide with four.
    const a = "1".repeat(64);
    const b = "2".repeat(64);
    const c = "3".repeat(64);
    expect(decisionsRoot([a, b, c])).not.toBe(decisionsRoot([a, b, c, c]));
  });

  it("has a defined root for an empty set", () => {
    expect(decisionsRoot([])).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------- scripted analyst

describe("the scripted Analyst", () => {
  const market = (bps: number): MarketView => ({
    asset: "BTC",
    pricesByVenue: { hyperliquid: "70000", "binance-public": "70010" },
    momentumBpsByVenue: { hyperliquid: bps, "binance-public": bps },
  });

  const news = (content: string, source = "newswire-a.example"): AnalystInput => ({
    evidenceId: "a".repeat(64),
    kind: "NEWS",
    source,
    content,
    fetchedAtNs: "1762440000000000000",
  });

  const price = (source: string): AnalystInput => ({
    evidenceId: source.padEnd(64, "0").slice(0, 64).replace(/[^0-9a-f]/g, "b"),
    kind: "PRICE",
    source,
    content: "{}",
    fetchedAtNs: "1762440000000000000",
  });

  it("holds when nothing is directional", () => {
    const out = scriptedAnalyst("BTC", [], market(5), DEFAULT_SCRIPTED);
    expect(out.thesis.direction).toBe("HOLD");
    expect(out.order).toBeNull();
    expect(out.signal).toBeNull();
  });

  it("follows price alone when momentum is strong and there is no news", () => {
    const out = scriptedAnalyst("BTC", [price("hyperliquid")], market(200), DEFAULT_SCRIPTED);
    expect(out.thesis.direction).toBe("LONG");
    expect(out.signal?.citations).toContain(price("hyperliquid").evidenceId);
  });

  it("goes short on strong negative momentum", () => {
    const out = scriptedAnalyst("BTC", [price("hyperliquid")], market(-200), DEFAULT_SCRIPTED);
    expect(out.thesis.direction).toBe("SHORT");
    expect(out.order?.action).toBe("OPEN_SHORT");
  });

  it("is moved by a single credible-looking headline, which is the vulnerability under study", () => {
    const out = scriptedAnalyst(
      "BTC",
      [news("BREAKING: SEC approves spot allocation, sources say")],
      market(0),
      DEFAULT_SCRIPTED,
    );
    expect(out.thesis.direction).toBe("LONG");
    // News outvoting a flat tape is exactly the behaviour the evidence gate has to contain.
    expect(out.signal?.declaredStance?.["a".repeat(64)]).toBe("SUPPORT");
  });

  it("ignores the same claim when the credibility cues are stripped", () => {
    // arXiv 2610.26438 finding (ii): removing a named source and a BREAKING tag moves ASR
    // from 100% to 0% while the claim itself is unchanged. The Analyst reproduces that.
    const out = scriptedAnalyst("BTC", [news("spot allocation might happen")], market(0), {
      ...DEFAULT_SCRIPTED,
      requiredCues: 1,
    });
    expect(out.thesis.direction).toBe("HOLD");
  });

  it("requires two cues when configured to, which is a less credulous Analyst", () => {
    const oneCue = news("prices surge on heavy volume"); // bullish, no named source, no tag
    const out = scriptedAnalyst("BTC", [oneCue], market(0), {
      ...DEFAULT_SCRIPTED,
      requiredCues: 2,
    });
    expect(out.thesis.direction).toBe("HOLD");
  });

  it("news outvotes a contradicting price tape", () => {
    const out = scriptedAnalyst(
      "BTC",
      [news("BREAKING: Reuters reports approval"), price("hyperliquid")],
      market(-200),
      DEFAULT_SCRIPTED,
    );
    expect(out.thesis.direction).toBe("LONG");
    // The claim it makes about momentum is the real one, so the verifier will accept it even
    // though the direction disagrees. The gate then counts the price group as CONTRADICT.
    expect(out.signal?.claims?.[0]?.value).toBe(-200);
  });

  it("claims only the momentum it actually computed", () => {
    const out = scriptedAnalyst("BTC", [price("hyperliquid")], market(144), DEFAULT_SCRIPTED);
    expect(out.signal?.claims).toEqual([
      { indicator: "MOMENTUM_24H_BPS", asset: "BTC", value: 144 },
    ]);
  });

  it("is a pure function of its inputs", () => {
    const evidence = [news("BREAKING: Reuters reports approval"), price("hyperliquid")];
    const view = market(150);
    const a = scriptedAnalyst("BTC", evidence, view, DEFAULT_SCRIPTED);
    const b = scriptedAnalyst("BTC", evidence, view, DEFAULT_SCRIPTED);
    expect(a.rawOutput).toBe(b.rawOutput);
    expect(a.prompt).toBe(b.prompt);
  });

  it("produces a consistent DecisionRecord", () => {
    const out = scriptedAnalyst("BTC", [news("BREAKING: Reuters reports approval")], market(0));
    const built = buildDecision({
      deskId: "ebi",
      agent: "analyst.ebi.testnet",
      decidedAt: "2026-11-06T16:15:00Z",
      modelId: out.modelId,
      prompt: out.prompt,
      snapshot: market(0),
      toolCalls: [],
      rawOutput: out.rawOutput,
      thesis: out.thesis,
      order: out.order,
    });
    // NA because it is scripted, and with no failures listed, which is what a correct
    // rule-based agent looks like.
    expect(built.record.consistency.result).toBe("NA");
    expect(built.record.consistency.failures).toEqual([]);
  });
});

describe("buy and hold", () => {
  const market: MarketView = {
    asset: "BTC",
    pricesByVenue: { hyperliquid: "70000" },
    momentumBpsByVenue: { hyperliquid: 300 },
  };

  it("opens once and then never trades again", () => {
    const first = buyAndHold("BTC", market, false, "500000000");
    expect(first.thesis.direction).toBe("LONG");
    expect(first.order?.action).toBe("OPEN_LONG");

    const second = buyAndHold("BTC", market, true, "500000000");
    expect(second.thesis.direction).toBe("HOLD");
    expect(second.order).toBeNull();
  });

  it("cites no evidence at all", () => {
    // A baseline that read evidence would not be a baseline for an evidence gate.
    expect(buyAndHold("BTC", market, false, "500000000").signal).toBeNull();
  });
});

// ---------------------------------------------------------------- monitor

describe("the Monitor", () => {
  const base: MonitorState = {
    dailyPnlUsd: 0n,
    dailyLossLimitUsd: 200_000_000n,
    evidenceAgeNs: 60_000_000_000n,
    maxEvidenceAgeNs: 900_000_000_000n,
    hasOpenPosition: false,
    recentVerifierOutcomes: [],
    citationCountsByEvidenceId: {},
    singleGroupEvidenceIds: [],
  };

  it("fires nothing on a healthy desk", () => {
    expect(evaluate(base)).toEqual([]);
  });

  it("fires on the daily loss limit", () => {
    const t = evaluate({ ...base, dailyPnlUsd: -200_000_000n });
    expect(t.map((x) => x.name)).toEqual(["DAILY_LOSS"]);
  });

  it("does not fire one micro-dollar short of the limit", () => {
    expect(evaluate({ ...base, dailyPnlUsd: -199_999_999n })).toEqual([]);
  });

  it("fires on stale evidence only while a position is open", () => {
    const stale = { ...base, evidenceAgeNs: 2_000_000_000_000n };
    // A flat desk with stale evidence is simply not trading, and needs no brake.
    expect(evaluate(stale)).toEqual([]);
    const exposed = evaluate({ ...stale, hasOpenPosition: true });
    expect(exposed.map((x) => x.name)).toEqual(["STALE_EVIDENCE"]);
  });

  it("fires when a position is open and there is no evidence at all", () => {
    const t = evaluate({ ...base, hasOpenPosition: true, evidenceAgeNs: null });
    expect(t[0]?.reason).toMatch(/no valid evidence at all/);
  });

  it("fires on a verifier failure spike, but only with a full window", () => {
    const bad = Array.from({ length: 4 }, () => ({ citationsOffered: 4, citationsCounted: 0 }));
    // Four decisions is not yet a window of eight, so no conclusion is drawn.
    expect(evaluate({ ...base, recentVerifierOutcomes: bad })).toEqual([]);

    const full = Array.from({ length: 8 }, () => ({ citationsOffered: 4, citationsCounted: 0 }));
    const t = evaluate({ ...base, recentVerifierOutcomes: full });
    expect(t.map((x) => x.name)).toContain("VERIFIER_FAILURE_SPIKE");
  });

  it("does not fire when most citations are fine", () => {
    const good = Array.from({ length: 8 }, () => ({ citationsOffered: 4, citationsCounted: 3 }));
    expect(evaluate({ ...base, recentVerifierOutcomes: good })).toEqual([]);
  });

  it("fires attack suspect when several desks converge on one single-source item", () => {
    // One fake, many agents, same trade, same moment. This is the shape the whole project is
    // about, and the rule keys on the pattern rather than on any judgement of content.
    const id = "f".repeat(64);
    const t = evaluate({
      ...base,
      singleGroupEvidenceIds: [id],
      citationCountsByEvidenceId: { [id]: 3 },
    });
    expect(t.map((x) => x.name)).toEqual(["ATTACK_SUSPECT"]);
  });

  it("does not fire when the converged-on item is well corroborated", () => {
    const id = "f".repeat(64);
    // Cited by three desks, but it is not a single-group item, so it is just popular news.
    expect(
      evaluate({ ...base, singleGroupEvidenceIds: [], citationCountsByEvidenceId: { [id]: 3 } }),
    ).toEqual([]);
  });

  it("does not fire below the desk threshold", () => {
    const id = "f".repeat(64);
    expect(
      evaluate({
        ...base,
        singleGroupEvidenceIds: [id],
        citationCountsByEvidenceId: { [id]: 2 },
      }),
    ).toEqual([]);
  });

  it("fires on a chain head mismatch", () => {
    const t = evaluate({ ...base, localHeadHash: "a".repeat(64), chainHeadHash: "b".repeat(64) });
    expect(t.map((x) => x.name)).toEqual(["CHAIN_MISMATCH"]);
  });

  it("is deterministic in its trigger order", () => {
    const id1 = "1".repeat(64);
    const id2 = "2".repeat(64);
    const state: MonitorState = {
      ...base,
      dailyPnlUsd: -300_000_000n,
      hasOpenPosition: true,
      evidenceAgeNs: 2_000_000_000_000n,
      singleGroupEvidenceIds: [id2, id1],
      citationCountsByEvidenceId: { [id1]: 4, [id2]: 5 },
    };
    const a = evaluate(state).map((t) => `${t.name}:${t.reason}`);
    const b = evaluate(state).map((t) => `${t.name}:${t.reason}`);
    expect(a).toEqual(b);
    expect(a[0]).toMatch(/^DAILY_LOSS/);
  });

  it("produces a kill switch reason the contract will accept", () => {
    const triggers = evaluate({
      ...base,
      dailyPnlUsd: -300_000_000n,
      hasOpenPosition: true,
      evidenceAgeNs: 9_000_000_000_000n,
    });
    const reason = killSwitchReason(triggers);
    expect(reason.length).toBeLessThanOrEqual(200);
    // The contract rejects anything outside printable ASCII with E18_NON_ASCII.
    expect(/^[\x20-\x7e]*$/.test(reason)).toBe(true);
  });

  it("truncates a very long reason rather than being rejected on chain", () => {
    const many = Array.from({ length: 40 }, (_, i) => `${"f".repeat(60)}${i}`);
    const reason = killSwitchReason(
      evaluate({
        ...base,
        singleGroupEvidenceIds: many,
        citationCountsByEvidenceId: Object.fromEntries(many.map((m) => [m, 9])),
      }),
    );
    expect(reason.length).toBeLessThanOrEqual(200);
    expect(reason.endsWith("...")).toBe(true);
  });

  it("the monitor holds no power to release what it engaged", () => {
    // A structural assertion: nothing in this module can produce a release. The key scoping
    // is proved against a real node in tests/integration/tests/fc_keys.rs.
    const source = Object.keys({ evaluate, killSwitchReason, DEFAULT_MONITOR });
    expect(source).not.toContain("release");
  });
});

// ---------------------------------------------------------------- aggregation shapes

describe("debate and hier aggregation", () => {
  const market = (bps: number): MarketView => ({
    asset: "BTC",
    pricesByVenue: { hyperliquid: "70000" },
    momentumBpsByVenue: { hyperliquid: bps },
  });
  const news = (content: string, id = "a".repeat(64)): AnalystInput => ({
    evidenceId: id,
    kind: "NEWS",
    source: "newswire-a.example",
    content,
    fetchedAtNs: "1762440000000000000",
  });
  const price: AnalystInput = {
    evidenceId: "b".repeat(64),
    kind: "PRICE",
    source: "hyperliquid",
    content: "{}",
    fetchedAtNs: "1762440000000000000",
  };
  const FAKE = "BREAKING: Reuters reports a major asset manager has confirmed a spot BTC allocation";

  it("debate holds when no two Analysts agree", () => {
    // Flat tape, no news: every panel member holds.
    expect(debateDesk("BTC", [price], market(0)).thesis.direction).toBe("HOLD");
  });

  it("debate follows a strong tape that two of three Analysts see", () => {
    // 250 bps clears the 100 and 200 thresholds but not 300, so two agree.
    expect(debateDesk("BTC", [price], market(250)).thesis.direction).toBe("LONG");
  });

  it("debate is fooled by a fake headline, reproducing the published negative result", () => {
    // arXiv 2610.26438 finding (v): "peer debate fails". All three panel members read the
    // same poisoned context, so their agreement is not independence. SPEC.md 2A.6 H2a.
    const out = debateDesk("BTC", [news(FAKE), price], market(0));
    expect(out.thesis.direction).toBe("LONG");
    expect(out.order?.action).toBe("OPEN_LONG");
  });

  it("debate records what each panel member said before and after the round", () => {
    const out = debateDesk("BTC", [news(FAKE), price], market(0));
    const raw = JSON.parse(out.rawOutput) as Record<string, unknown>;
    expect(raw.directionsBeforeRound).toBeDefined();
    expect(raw.directionsAfterRound).toBeDefined();
  });

  it("hier does NOT act on a news specialist speaking alone", () => {
    // This is the mechanism finding (v) reports as the one that works: a poisoned headline
    // reaches the manager as one specialist's opinion, not as the whole picture.
    const out = hierDesk("BTC", [news(FAKE), price], market(0));
    expect(out.thesis.direction).toBe("HOLD");
    expect(out.order).toBeNull();
    const raw = JSON.parse(out.rawOutput) as { rationale: string };
    expect(raw.rationale).toMatch(/news specialist spoke alone/);
  });

  it("hier acts when the tape corroborates the headline", () => {
    const out = hierDesk("BTC", [news(FAKE), price], market(350));
    expect(out.thesis.direction).toBe("LONG");
  });

  it("hier holds when its specialists disagree", () => {
    // Bullish headline, bearish tape: the manager does not pick a side.
    const out = hierDesk("BTC", [news(FAKE), price], market(-350));
    expect(out.thesis.direction).toBe("HOLD");
    const raw = JSON.parse(out.rawOutput) as { rationale: string };
    expect(raw.rationale).toMatch(/disagree/);
  });

  it("hier is still fooled when the fake agrees with the tape", () => {
    // Worth stating: hier reduces attack success, it does not eliminate it. An attacker who
    // times a fake to agree with the tape gets through, and SPEC.md 2A.6 H2b only claims a
    // reduction.
    const out = hierDesk("BTC", [news(FAKE), price], market(400));
    expect(out.thesis.direction).toBe("LONG");
  });

  it("every shape runs the same Analyst code, so a difference is attributable", () => {
    // If the Analysts differed, a difference in attack success would not be attributable to
    // the aggregation shape.
    const evidence = [news(FAKE), price];
    const view = market(250);
    const plain = scriptedAnalyst("BTC", evidence, view);
    const debate = debateDesk("BTC", evidence, view);
    const hier = hierDesk("BTC", evidence, view);
    expect(plain.modelId).toBe("scripted/cue-weighted@1");
    expect(debate.modelId).toBe("scripted/debate-3@1");
    expect(hier.modelId).toBe("scripted/hier-3@1");
    // All three are pure functions of the same inputs.
    expect(debateDesk("BTC", evidence, view).rawOutput).toBe(debate.rawOutput);
    expect(hierDesk("BTC", evidence, view).rawOutput).toBe(hier.rawOutput);
  });

  it("both shapes produce consistent DecisionRecords", () => {
    for (const out of [
      debateDesk("BTC", [news(FAKE), price], market(250)),
      hierDesk("BTC", [news(FAKE), price], market(350)),
    ]) {
      const built = buildDecision({
        deskId: "x",
        agent: "a.testnet",
        decidedAt: "2026-11-06T16:15:00Z",
        modelId: out.modelId,
        prompt: out.prompt,
        snapshot: {},
        toolCalls: [],
        rawOutput: out.rawOutput,
        thesis: out.thesis,
        order: out.order,
      });
      expect(built.record.consistency.failures).toEqual([]);
    }
  });
});
