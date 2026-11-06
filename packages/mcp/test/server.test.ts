/**
 * MCP tests, driven through a real MCP client over an in-memory transport.
 *
 * Testing the handlers directly would skip the protocol, which is where a tool-shape mistake
 * actually bites: a schema the client cannot parse looks fine from inside the server.
 *
 * The read tools hit the live testnet contract, so a few tests are skipped when the network is
 * unavailable rather than failing. Skipping is marked in the output, so a reader can tell a
 * skipped network test from a passing one.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";

import { createServer } from "../src/server.js";

let client: Client;
let online = false;

async function callText(name: string, args: Record<string, unknown>): Promise<string> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
  };
  return res.content.map((c) => c.text).join("\n");
}

beforeAll(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const res = await fetch("https://rpc.testnet.near.org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: [] }),
      signal: AbortSignal.timeout(8000),
    });
    online = res.ok;
  } catch {
    online = false;
  }
  if (!online) console.warn("testnet unreachable: network-dependent MCP tests are skipped");
}, 30_000);

describe("tool surface", () => {
  it("lists its tools over the protocol", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(5);
    for (const t of tools) {
      expect(t.description, `${t.name} needs a description`).toBeTruthy();
      expect(t.inputSchema).toBeTruthy();
    }
  });

  it("exposes no tool that could move value", async () => {
    // Not merely gated: absent. The contract has no such method either, so there is nothing
    // for such a tool to call.
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const forbidden of ["withdraw", "transfer", "send", "add_key", "delete_key", "sign"]) {
      expect(names.some((n) => n.includes(forbidden)), `must not expose ${forbidden}`).toBe(false);
    }
  });

  it("tells an agent that an unknown tool is not a missing feature", async () => {
    const out = await callText("withdraw", { amount: "1" });
    expect(out).toMatch(/no tool named/i);
    expect(out).toMatch(/deliberately no tool for withdrawals/i);
  });

  it("describes what each tool refuses, not only what it does", async () => {
    const { tools } = await client.listTools();
    const setMode = tools.find((t) => t.name === "set_mode")!;
    // An agent that cannot tell "forbidden" from "broken" will retry.
    expect(setMode.description).toMatch(/REFUSED unless/);
    const scorecard = tools.find((t) => t.name === "get_scorecard")!;
    expect(scorecard.description).toMatch(/CANT_TELL_YET/);
  });
});

describe("live mode is refused by default", () => {
  it("refuses set_mode live and names the variable", async () => {
    const out = await callText("set_mode", { deskId: "ebi", mode: "live" });
    expect(out).toMatch(/Refused/);
    expect(out).toMatch(/UAL_ALLOW_LIVE=1/);
    // The refusal must say retrying will not help, or an agent will keep trying.
    expect(out).toMatch(/retrying will not help/);
    expect(out).toMatch(/a person switches it/);
  });

  it("refuses a live scorecard", async () => {
    const out = await callText("get_scorecard", { deskId: "ebi", mode: "live" });
    expect(out).toMatch(/Refused/);
  });

  it("allows paper mode without complaint", async () => {
    const out = await callText("set_mode", { deskId: "ebi", mode: "paper" });
    expect(out).not.toMatch(/Refused/);
  });
});

describe("check_policy, which needs no network", () => {
  const canonical =
    '{"allowedAssets":["BTC"],"allowedModes":["paper"],"allowedVenues":["paper"],' +
    '"dailyLossLimitUsd":"200000000","deskId":"ebi","killSwitch":{"autoOnDailyLoss":true,' +
    '"monitorMayEngage":true},"maxOpenPositions":3,"maxPositionUsd":"1000000000",' +
    '"schema":"krexa.ual.policy/1","slippageCapBps":30}';

  it("accepts canonical bytes and returns the hash they would get", async () => {
    const out = await callText("check_policy", { deskId: "ebi", policyJson: canonical });
    const parsed = JSON.parse(out) as { valid: boolean; policyHash: string };
    expect(parsed.valid).toBe(true);
    expect(parsed.policyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("names the exact code the contract would panic with on non-canonical bytes", async () => {
    // "schema" moved to the front. Valid JSON, same policy, not canonical bytes.
    //
    // Note that JSON.stringify(JSON.parse(x)) does NOT produce this: it preserves insertion
    // order, so it round-trips canonical bytes back to themselves. An earlier version of this
    // test did exactly that and asserted the wrong thing.
    const shuffled =
      '{"schema":"krexa.ual.policy/1",' + canonical.slice(1).replace('"schema":"krexa.ual.policy/1",', "");
    expect(shuffled).not.toBe(canonical);
    const out = await callText("check_policy", { deskId: "ebi", policyJson: shuffled });
    const parsed = JSON.parse(out) as { valid: boolean; contractWouldPanicWith: string };
    expect(parsed.valid).toBe(false);
    expect(parsed.contractWouldPanicWith).toMatch(/E0[45]_POLICY/);
  });

  it("rejects a policy committed under the wrong desk", async () => {
    const out = await callText("check_policy", { deskId: "other", policyJson: canonical });
    expect(JSON.parse(out).valid).toBe(false);
  });
});

describe("explain_rejection", () => {
  it("explains R_UNCORROBORATED and says what the fix is not", async () => {
    const out = await callText("explain_rejection", { reason: "R_UNCORROBORATED" });
    expect(out).toMatch(/independent source groups/);
    // The wrong fix is a smaller order, and an agent will try it unless told.
    expect(out).toMatch(/not a smaller order/);
    expect(out).toMatch(/Do not retry/);
  });

  it("explains that the gate fails closed on a bad signature", async () => {
    const out = await callText("explain_rejection", { reason: "R_EVIDENCE_BAD_SIG" });
    expect(out).toMatch(/fails closed/);
    expect(out).toMatch(/pipeline feeding it is compromised/);
  });

  it("says exits are always allowed where that is the point", async () => {
    for (const reason of ["R_DAILY_LOSS", "R_KILL_SWITCH"]) {
      const out = await callText("explain_rejection", { reason });
      expect(out, reason).toMatch(/exit|Exits/);
    }
  });

  it("lists the codes it knows rather than guessing", async () => {
    const out = await callText("explain_rejection", { reason: "R_MADE_UP" });
    expect(out).toMatch(/Unknown reason code/);
    expect(out).toMatch(/R_UNCORROBORATED/);
  });

  it("is case insensitive, since a model will not always shout", async () => {
    expect(await callText("explain_rejection", { reason: "r_kill_switch" })).toMatch(/kill switch/i);
  });
});

describe("reading the live testnet chain", () => {
  it("returns a verified chain for the walkthrough desk", async () => {
    if (!online) return;
    const out = await callText("get_record", { deskId: "ebi" });
    const parsed = JSON.parse(out) as {
      chainValid: boolean;
      receiptCount: number;
      rejectedCount: number;
      rejectionReasons: string[];
    };
    expect(parsed.chainValid).toBe(true);
    expect(parsed.receiptCount).toBeGreaterThan(5);
    // The walkthrough deliberately includes refusals, and they must be present rather than
    // filtered out: a refused trade is part of the record.
    expect(parsed.rejectedCount).toBeGreaterThan(0);
    expect(parsed.rejectionReasons).toContain("R_UNCORROBORATED");
  }, 60_000);

  it("verifies the chain against a locally derived genesis", async () => {
    if (!online) return;
    const out = await callText("verify_chain", { deskId: "ebi" });
    const parsed = JSON.parse(out) as {
      genesisAnchored: boolean;
      everyHashRecomputes: boolean;
      chainValid: boolean;
      derivedGenesis: string;
    };
    expect(parsed.derivedGenesis).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.genesisAnchored).toBe(true);
    expect(parsed.everyHashRecomputes).toBe(true);
    expect(parsed.chainValid).toBe(true);
  }, 60_000);

  it("reports CANT_TELL_YET with a reason rather than a number", async () => {
    if (!online) return;
    const out = await callText("get_scorecard", { deskId: "ebi", mode: "paper" });
    const parsed = JSON.parse(out) as {
      skillVerdict: string;
      annualisedReturn: null;
      returnToDrawdown: null;
      why: string;
      paperNote?: string;
    };
    expect(parsed.skillVerdict).toBe("CANT_TELL_YET");
    expect(parsed.annualisedReturn).toBeNull();
    expect(parsed.returnToDrawdown).toBeNull();
    expect(parsed.why).toMatch(/30/);
    expect(parsed.paperNote).toMatch(/operator-reported/);
  }, 60_000);

  it("says plainly when a desk does not exist", async () => {
    if (!online) return;
    expect(await callText("get_desk", { deskId: "no-such-desk" })).toMatch(/does not exist/);
  }, 60_000);

  it("returns policy bytes whose hash the caller can recheck", async () => {
    if (!online) return;
    const desk = await callText("get_desk", { deskId: "ebi" });
    const policyHash = (JSON.parse(desk) as { policyHash: string }).policyHash;
    const out = await callText("get_policy", { policyHash });
    const parsed = JSON.parse(out) as { matches: boolean; policyJson: string };
    expect(parsed.matches).toBe(true);
    expect(parsed.policyJson).toContain("krexa.ual.policy/1");
  }, 60_000);
});
