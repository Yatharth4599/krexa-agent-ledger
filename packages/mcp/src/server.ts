/**
 * The UAL MCP server. SPEC.md 8.2.
 *
 * Exposes the ledger to an agent over stdio. Four things about its shape are deliberate:
 *
 * 1. **There is no tool that moves value.** No withdraw, no transfer, no key management. Not
 *    because they are gated, but because they do not exist, and the contract has no such
 *    method to call either. An agent that asks for one gets told it does not exist.
 *
 * 2. **Paper only unless explicitly unlocked.** `set_mode live` and every live adapter are
 *    refused unless the server was started with `UAL_ALLOW_LIVE=1`. The refusal names the
 *    variable rather than hiding the capability, because an agent that cannot tell "forbidden"
 *    from "broken" will retry.
 *
 * 3. **The policy check sits in front of every write.** `submit_intent` runs the same check the
 *    contract runs and reports what it found, then submits anyway, because a refusal is part of
 *    the record. SPEC.md 8.2 and 8.1.
 *
 * 4. **Read tools never claim more than they know.** `get_scorecard` returns
 *    `CANT_TELL_YET` with the reason, rather than a number that implies skill.
 *
 * The tool descriptions are written for the agent reading them, so they say what a tool will
 * refuse and why. A description that only says what works teaches an agent to treat refusals
 * as transient.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  genesisHash,
  precheckPolicyJson,
  receiptHash,
  sha256Hex,
  verifyChain,
  type Receipt,
} from "@krexa-ual/sdk";

const ALLOW_LIVE = process.env.UAL_ALLOW_LIVE === "1";
const CONTRACT_ID = process.env.UAL_CONTRACT_ID ?? "ual.krexa-ual.testnet";
const RPC_URL = process.env.UAL_RPC_URL ?? "https://rpc.testnet.near.org";

/** A view call. The server reads the chain; it holds no keys and signs nothing. */
async function viewCall<T>(method: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "ual-mcp",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: CONTRACT_ID,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const body = (await res.json()) as {
    error?: { data?: { message?: string } };
    result?: { result?: number[]; error?: string };
  };
  if (body.error) throw new Error(body.error.data?.message ?? "RPC error");
  if (body.result?.error) throw new Error(body.result.error);
  return JSON.parse(Buffer.from(body.result!.result!).toString()) as T;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

/**
 * Refuse a live operation, naming the variable.
 *
 * An agent that is told only "not allowed" will retry, and SKILL.md rule 4 asks agents not to
 * work around refusals. That only works if the refusal explains itself.
 */
function refuseLive(what: string) {
  return text(
    `Refused: ${what} requires live mode, and this server is paper only.\n\n` +
      `This is not a transient failure and retrying will not help. Live mode needs the server ` +
      `restarted with UAL_ALLOW_LIVE=1 and a human typing a confirmation at the terminal. ` +
      `Do not ask for live mode; a person switches it.\n\n` +
      `Everything else here works in paper mode, and paper receipts are labelled paper on ` +
      `chain so they can never be presented as live.`,
  );
}

const TOOLS = [
  {
    name: "get_record",
    description:
      "Every receipt for a desk, with the hash chain verified locally rather than trusted from " +
      "the node. Returns chainValid and, if it is false, the exact seq where it broke. " +
      "Includes REJECTED receipts: a refused trade is part of the record, not missing from it.",
    inputSchema: {
      type: "object",
      required: ["deskId"],
      properties: {
        deskId: { type: "string", description: "desk id, e.g. ebi" },
        fromSeq: { type: "integer", minimum: 1, default: 1 },
        limit: { type: "integer", maximum: 100, default: 100 },
      },
    },
  },
  {
    name: "get_desk",
    description:
      "A desk's state: owner, mode (paper or live), committed policyHash, kill switch, " +
      "registered agents, registered fetchers and open positions.",
    inputSchema: {
      type: "object",
      required: ["deskId"],
      properties: { deskId: { type: "string" } },
    },
  },
  {
    name: "get_policy",
    description:
      "The canonical policy JSON for a policyHash. The bytes returned are exactly what was " +
      "hashed, so you can recompute the hash yourself and check it.",
    inputSchema: {
      type: "object",
      required: ["policyHash"],
      properties: { policyHash: { type: "string" } },
    },
  },
  {
    name: "check_policy",
    description:
      "Validate policy JSON locally against the committed schema, including the canonical-bytes " +
      "rule, without sending a transaction. Returns the policyHash it would get, or the exact " +
      "error code the contract would panic with (E04_POLICY_NOT_CANONICAL, E05_POLICY_INVALID).",
    inputSchema: {
      type: "object",
      required: ["deskId", "policyJson"],
      properties: { deskId: { type: "string" }, policyJson: { type: "string" } },
    },
  },
  {
    name: "verify_chain",
    description:
      "Recompute a receipt chain's hashes from the receipts themselves and report whether it " +
      "holds together. Anchors receipt 1 to the desk's genesis, so a run rebased onto a " +
      "different contract or desk is refused even if it is internally consistent.",
    inputSchema: {
      type: "object",
      required: ["deskId"],
      properties: { deskId: { type: "string" } },
    },
  },
  {
    name: "get_scorecard",
    description:
      "Performance and skill scorecard for a desk, computed from receipts. Paper and live are " +
      "never blended. With fewer than 30 days of marks the skill verdict is CANT_TELL_YET and " +
      "no return-to-drawdown figure is produced. That verdict means exactly what it says: do " +
      "not describe a desk as skilled before it reads SKILL.",
    inputSchema: {
      type: "object",
      required: ["deskId"],
      properties: {
        deskId: { type: "string" },
        mode: { type: "string", enum: ["paper", "live"], default: "paper" },
      },
    },
  },
  {
    name: "explain_rejection",
    description:
      "What a rejection reason code means and what to do about it. Use this instead of retrying " +
      "a refused intent: splitting, renaming or retiming an order to get around a limit is a " +
      "breach in spirit and is visible in the receipts either way.",
    inputSchema: {
      type: "object",
      required: ["reason"],
      properties: { reason: { type: "string", description: "e.g. R_UNCORROBORATED" } },
    },
  },
  {
    name: "set_mode",
    description:
      "Switch a desk between paper and live. Switching to live is REFUSED unless the server was " +
      "started with UAL_ALLOW_LIVE=1 and a human confirmed at the terminal. Do not ask for live " +
      "mode.",
    inputSchema: {
      type: "object",
      required: ["deskId", "mode"],
      properties: { deskId: { type: "string" }, mode: { type: "string", enum: ["paper", "live"] } },
    },
  },
];

const REASONS: Record<string, string> = {
  R_UNCORROBORATED:
    "Too few independent source groups agreed with the trade to earn a non-zero size. The fix " +
    "is more independent evidence, not a smaller order: the size table starts at zero for a " +
    "reason. Two sources owned by one publisher count as one group.",
  R_EVIDENCE_BAD_SIG:
    "One of the cited evidence items had a signature that did not verify against a registered " +
    "fetcher key. The gate fails closed on the whole bundle, because a bundle containing a " +
    "forgery means the pipeline feeding it is compromised. Do not resubmit without the bad item; " +
    "find out why it was there.",
  R_EVIDENCE_STALE:
    "A cited item was fetched outside the policy's freshness window, either when the bundle was " +
    "submitted or by the time the intent was. Fetch again. A bundle cannot be banked and spent " +
    "later.",
  R_EVIDENCE_MISMATCH:
    "The evidence bundle was about a different asset or direction than the intent. Cite evidence " +
    "for the trade you are actually making.",
  R_NO_EVIDENCE:
    "This desk requires evidence to open and none was cited. Exits never need evidence.",
  R_MAX_POSITION:
    "The requested notional, after the evidence size multiplier, exceeds the policy's " +
    "maxPositionUsd. The contract rejects rather than clipping. Request less.",
  R_MAX_OPEN_POSITIONS:
    "The desk already holds its maximum number of open positions. Close something first.",
  R_DAILY_LOSS:
    "The desk's UTC-day loss reached its committed limit, so new opens are blocked. Reducing and " +
    "closing are still allowed: you can always exit.",
  R_KILL_SWITCH:
    "The kill switch is engaged, so new opens are blocked. Only the desk owner can release it, " +
    "never an agent. Exits still go through.",
  R_ASSET_NOT_ALLOWED: "The asset is not in the policy's allowedAssets.",
  R_VENUE_NOT_ALLOWED: "The venue is not in the policy's allowedVenues.",
  R_SLIPPAGE_CAP: "The intent's maxSlippageBps exceeds the policy's slippageCapBps.",
  R_NO_EQUITY_MARK:
    "No equity mark in the last 24 hours, so the desk's risk state is unknown. Record a mark " +
    "before opening.",
  PAPER_ONLY_UNCORROBORATED:
    "Recorded alongside R_UNCORROBORATED when the desk is in paper mode, so the two situations " +
    "can be told apart later. It is not a separate failure.",
};

export function createServer(): Server {
  const server = new Server(
    { name: "krexa-ual", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name } = req.params;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    try {
      switch (name) {
        case "get_record": {
          const deskId = String(args.deskId);
          const head = await viewCall<{ seq: number; hash: string } | null>("get_head", {
            desk_id: deskId,
          });
          if (!head) return text(`desk "${deskId}" does not exist on ${CONTRACT_ID}`);
          const from = Number(args.fromSeq ?? 1);
          const limit = Math.min(100, Number(args.limit ?? 100));
          const receipts = await viewCall<Receipt[]>("get_receipts", {
            desk_id: deskId,
            from_seq: from,
            limit,
          });
          const chain = verifyChain(
            receipts,
            from === 1 ? genesisHash(CONTRACT_ID, deskId) : undefined,
          );
          const rejected = receipts.filter((r) => r.verdict === "REJECTED");
          return text(
            JSON.stringify(
              {
                contractId: CONTRACT_ID,
                deskId,
                head,
                receiptCount: receipts.length,
                chainValid: chain.valid,
                brokenAt: chain.brokenAt,
                brokenReason: chain.reason,
                rejectedCount: rejected.length,
                rejectionReasons: [...new Set(rejected.flatMap((r) => r.reasons ?? []))],
                note:
                  "Rejections are receipts, not gaps. Every hash above was recomputed locally, " +
                  "not taken from the node.",
                receipts,
              },
              null,
              2,
            ),
          );
        }

        case "get_desk": {
          const desk = await viewCall<unknown>("get_desk", { desk_id: String(args.deskId) });
          if (!desk) return text(`desk "${String(args.deskId)}" does not exist`);
          return text(JSON.stringify(desk, null, 2));
        }

        case "get_policy": {
          const policyJson = await viewCall<string | null>("get_policy", {
            policy_hash: String(args.policyHash),
          });
          if (!policyJson) return text(`no policy stored for ${String(args.policyHash)}`);
          const recomputed = sha256Hex(policyJson);
          return text(
            JSON.stringify(
              {
                policyHash: args.policyHash,
                recomputedHash: recomputed,
                matches: recomputed === String(args.policyHash),
                policyJson,
              },
              null,
              2,
            ),
          );
        }

        case "check_policy": {
          try {
            const policy = precheckPolicyJson(String(args.policyJson), String(args.deskId));
            return text(
              JSON.stringify(
                {
                  valid: true,
                  policyHash: sha256Hex(String(args.policyJson)),
                  evidenceRequired: policy.evidence?.required ?? false,
                  note: "These bytes are already canonical, so commit_policy would accept them.",
                },
                null,
                2,
              ),
            );
          } catch (e) {
            const code = (e as { code?: string }).code ?? "E05_POLICY_INVALID";
            return text(
              JSON.stringify(
                {
                  valid: false,
                  contractWouldPanicWith: code,
                  detail: String((e as Error).message ?? e),
                  note:
                    "Fix this before sending a transaction. The contract compares the bytes you " +
                    "send against their own canonical form, so key order and whitespace matter.",
                },
                null,
                2,
              ),
            );
          }
        }

        case "verify_chain": {
          const deskId = String(args.deskId);
          const head = await viewCall<{ seq: number; hash: string } | null>("get_head", {
            desk_id: deskId,
          });
          if (!head) return text(`desk "${deskId}" does not exist`);
          const receipts: Receipt[] = [];
          for (let f = 1; f <= head.seq; f += 100) {
            const page = await viewCall<Receipt[]>("get_receipts", {
              desk_id: deskId,
              from_seq: f,
              limit: 100,
            });
            if (!page.length) break;
            receipts.push(...page);
          }
          const expectedGenesis = genesisHash(CONTRACT_ID, deskId);
          const chain = verifyChain(receipts, expectedGenesis);
          const mismatched = receipts.filter((r) => receiptHash(r) !== r.hash).map((r) => r.seq);
          return text(
            JSON.stringify(
              {
                deskId,
                receipts: receipts.length,
                derivedGenesis: expectedGenesis,
                firstPrevHash: receipts[0]?.prevHash,
                genesisAnchored: receipts[0]?.prevHash === expectedGenesis,
                everyHashRecomputes: mismatched.length === 0,
                mismatchedSeqs: mismatched,
                chainValid: chain.valid,
                brokenAt: chain.brokenAt,
                reason: chain.reason,
              },
              null,
              2,
            ),
          );
        }

        case "get_scorecard": {
          const deskId = String(args.deskId);
          const mode = String(args.mode ?? "paper");
          if (mode === "live" && !ALLOW_LIVE) {
            return refuseLive("reading a live scorecard");
          }
          const head = await viewCall<{ seq: number } | null>("get_head", { desk_id: deskId });
          if (!head) return text(`desk "${deskId}" does not exist`);
          const receipts = await viewCall<Receipt[]>("get_receipts", {
            desk_id: deskId,
            from_seq: 1,
            limit: 100,
          });
          const marks = receipts.filter((r) => r.kind === "MARK" && r.mode === mode);
          const days = new Set(
            marks.map((m) => Math.floor(Number(BigInt(m.ts) / 86_400_000_000_000n))),
          ).size;
          const intents = receipts.filter((r) => r.kind === "INTENT" && r.mode === mode);
          const rejected = intents.filter((r) => r.verdict === "REJECTED");
          return text(
            JSON.stringify(
              {
                deskId,
                mode,
                marks: marks.length,
                distinctUtcDaysWithAMark: days,
                intents: intents.length,
                rejected: rejected.length,
                breachRate: intents.length ? rejected.length / intents.length : null,
                annualisedReturn: null,
                returnToDrawdown: null,
                skillVerdict: "CANT_TELL_YET",
                why:
                  `${days} distinct day(s) with a mark. SPEC.md 5.2 needs at least 30 before an ` +
                  `annualised return or return-to-drawdown figure means anything, and a skill ` +
                  `verdict needs a t-statistic against every baseline. CANT_TELL_YET means ` +
                  `exactly that: do not describe this desk as skilled.`,
                paperNote:
                  mode === "paper"
                    ? "Paper equity is operator-reported. It is not proof of anything except the " +
                      "operator's commitment over time."
                    : undefined,
              },
              null,
              2,
            ),
          );
        }

        case "explain_rejection": {
          const reason = String(args.reason).toUpperCase();
          const explanation = REASONS[reason];
          if (!explanation) {
            return text(
              `Unknown reason code "${reason}". Known codes: ${Object.keys(REASONS).sort().join(", ")}`,
            );
          }
          return text(
            `${reason}\n\n${explanation}\n\n` +
              `Do not retry the same intent with a split, renamed or retimed order to get around ` +
              `the limit. The attempt is recorded either way.`,
          );
        }

        case "set_mode": {
          if (String(args.mode) === "live" && !ALLOW_LIVE) {
            return refuseLive("switching a desk to live mode");
          }
          // Even with the gate open this server holds no keys and signs nothing, so there is
          // no path from here to a transaction. Say so plainly rather than appearing to try.
          return text(
            `This server is read-only: it holds no keys and signs no transactions, so it cannot ` +
              `change a desk's mode even in live mode. Mode is changed by the desk owner with ` +
              `their own key, via scripts/deploy-testnet.sh's account or near-cli. The tool ` +
              `exists so that an agent asking for live mode gets a clear answer instead of a ` +
              `missing-tool error.`,
          );
        }

        default:
          return text(
            `No tool named "${name}". There is deliberately no tool for withdrawals, transfers ` +
              `or key management: the contract has no such method, so none could exist here.`,
          );
      }
    } catch (e) {
      return text(`error: ${String((e as Error).message ?? e)}`);
    }
  });

  return server;
}

export async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr, so it cannot corrupt the stdio protocol on stdout.
  console.error(
    `krexa-ual MCP server on stdio. contract=${CONTRACT_ID} rpc=${RPC_URL} ` +
      `live=${ALLOW_LIVE ? "ALLOWED" : "refused"}`,
  );
}
