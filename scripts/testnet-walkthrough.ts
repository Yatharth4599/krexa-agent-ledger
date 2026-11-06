/**
 * Write a real, publicly verifiable receipt chain to NEAR testnet.
 *
 * Until this runs, `ual.krexa-ual.testnet` holds a desk with zero receipts, so the explorer
 * has nothing to verify and the README's testnet link proves only that a contract exists.
 * SPEC.md 8 and 10 want a chain anyone can walk, which means a real sequence of real
 * transactions: policy, agents, fetcher, mark, evidence, intent, fill, refusal, kill switch.
 *
 * This generates the argument files and prints the exact `near` commands, then runs them. It
 * is deliberately a thin driver over near-cli-rs rather than a second signing path: the key
 * lives in `~/.near-credentials` and this script never reads it.
 *
 * Testnet only. Every account here ends in `.testnet`, the mode is `paper`, and the contract
 * has no method that could move value anywhere.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildEvidencePayload,
  canonical,
  generateFetcherKey,
  serializePolicy,
  sha256Hex,
  signEvidenceItem,
  UNATTESTED,
  type Policy,
  type SignedEvidenceItem,
} from "@krexa-ual/sdk";
import { computeVerifierCodeHash } from "@krexa-ual/verifier";

const CONTRACT = process.env.UAL_CONTRACT_ID ?? "ual.krexa-ual.testnet";
const OWNER = process.env.UAL_OWNER_ACCOUNT ?? "krexa-ual.testnet";
const TRADER = `trader-ebi.${OWNER}`;
const DESK = "ebi";
const NETWORK = "testnet";

if (!CONTRACT.endsWith(".testnet") || !OWNER.endsWith(".testnet")) {
  console.error("refusing to run: this script is testnet only.");
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "ual-testnet-"));
let step = 0;

function near(args: string[], label: string): string {
  step += 1;
  console.log(`\n[${step}] ${label}`);
  console.log(`    near ${args.join(" ")}`);
  try {
    const out = execFileSync("near", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const event = out.split("\n").find((l) => l.includes("EVENT_JSON"));
    if (event) console.log(`    ${event.trim().slice(0, 160)}`);
    return out;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    console.error(`    FAILED: ${(err.stderr ?? err.stdout ?? String(e)).slice(0, 400)}`);
    throw e;
  }
}

function call(
  method: string,
  args: unknown,
  opts: { signAs?: string; deposit?: string; gas?: string } = {},
): string {
  const file = join(tmp, `${method}-${step}.json`);
  writeFileSync(file, JSON.stringify(args));
  return near(
    [
      "contract",
      "call-function",
      "as-transaction",
      CONTRACT,
      method,
      "file-args",
      file,
      "prepaid-gas",
      opts.gas ?? "100 Tgas",
      "attached-deposit",
      opts.deposit ?? "0 NEAR",
      "sign-as",
      opts.signAs ?? OWNER,
      "network-config",
      NETWORK,
      "sign-with-legacy-keychain",
      "send",
    ],
    `${method}(${JSON.stringify(args).slice(0, 90)})`,
  );
}

function view(method: string, args: unknown): unknown {
  const file = join(tmp, `view-${method}-${step}.json`);
  writeFileSync(file, JSON.stringify(args));
  const out = near(
    [
      "contract",
      "call-function",
      "as-read-only",
      CONTRACT,
      method,
      "file-args",
      file,
      "network-config",
      NETWORK,
      "now",
    ],
    `view ${method}`,
  );
  // near-cli-rs prints the JSON result after a banner line.
  const start = out.indexOf("{");
  const arrStart = out.indexOf("[");
  const from = start >= 0 && (arrStart < 0 || start < arrStart) ? start : arrStart;
  if (from < 0) return null;
  try {
    return JSON.parse(out.slice(from).split("\n").filter(Boolean).join(""));
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  console.log("Writing a verifiable receipt chain to NEAR testnet.");
  console.log(`contract ${CONTRACT}`);
  console.log(`owner    ${OWNER}`);
  console.log(`desk     ${DESK}  (paper)`);
  console.log(`args in  ${tmp}`);

  const verifierCodeHash = computeVerifierCodeHash();
  const fetcher = generateFetcherKey();
  const seed = Buffer.from(fetcher.secretKeyHex, "hex");

  // Nine hundred seconds of freshness, as a live desk would use. The archive is not involved
  // here: the evidence is minted now, so it is genuinely fresh.
  const policy: Policy = {
    schema: "krexa.ual.policy/1",
    deskId: DESK,
    maxPositionUsd: "1000000000",
    maxOpenPositions: 3,
    dailyLossLimitUsd: "200000000",
    allowedAssets: ["BTC", "ETH"],
    allowedVenues: ["hyperliquid", "paper"],
    slippageCapBps: 30,
    allowedModes: ["paper"],
    killSwitch: { autoOnDailyLoss: true, monitorMayEngage: true },
    description: "testnet walkthrough desk: evidence gated, paper only",
    evidence: {
      required: true,
      maxAgeSec: 900,
      groups: [
        { group: "exchange-hl", sources: ["hyperliquid"] },
        { group: "newswire-a", sources: ["newswire-a.example"] },
        { group: "newswire-b", sources: ["newswire-b.example"] },
      ],
      sizeTableBps: [0, 0, 5000, 10000],
      verifierCodeHash,
    },
  };
  const policyJson = serializePolicy(policy);
  console.log(`\npolicyHash will be ${sha256Hex(policyJson)}`);

  // --- the desk already exists from the earlier deploy check, so tolerate E08 ---
  try {
    call("create_desk", { desk_id: DESK }, { deposit: "0.2 NEAR" });
  } catch {
    console.log("    (desk already exists, continuing)");
  }

  call("commit_policy", { desk_id: DESK, policy_json: policyJson });

  // --- the trader sub-account, holding only a function-call key ---
  //
  // This is the headline NEAR feature: the account that trades cannot move value, because the
  // protocol refuses anything outside the four methods. Proven exhaustively against a real
  // node in tests/integration/tests/fc_keys.rs; done here so the public chain shows it too.
  try {
    near(
      [
        "account",
        "create-account",
        "fund-myself",
        TRADER,
        "1 NEAR",
        "autogenerate-new-keypair",
        "save-to-legacy-keychain",
        "sign-as",
        OWNER,
        "network-config",
        NETWORK,
        "sign-with-legacy-keychain",
        "send",
      ],
      `create ${TRADER}`,
    );
  } catch {
    console.log(`    (${TRADER} already exists, continuing)`);
  }

  call("register_agent", { desk_id: DESK, agent: TRADER, role: "TRADER" });
  call("register_fetcher", {
    desk_id: DESK,
    pubkey: fetcher.publicKey,
    // Sixty-four zeros: the honest declaration that this fetcher is not in an enclave.
    attestation_hash: UNATTESTED,
    label: "testnet-walkthrough-unattested",
  });

  const head = () => {
    const h = view("get_head", { desk_id: DESK }) as { seq: number; hash: string } | null;
    if (!h) throw new Error("could not read the desk head");
    return h;
  };

  // --- an equity mark, so opens are not refused for want of one ---
  call(
    "record_mark",
    { desk_id: DESK, equity_usd: "10000000000", prev_hash: head().hash, decisions_root: null },
    { signAs: TRADER },
  );

  const nowNs = () => (BigInt(Date.now()) * 1_000_000n).toString();
  const sign = (content: string, source: string, kind: "NEWS" | "PRICE", group: string): SignedEvidenceItem =>
    signEvidenceItem(
      buildEvidencePayload({
        content,
        kind,
        source,
        sourceGroup: group,
        url: `https://${source}/x`,
        fetchedAtNs: nowNs(),
      }),
      seed,
      "SUPPORT",
    );

  const FAKE = "SYNTHETIC ATTACK: BREAKING, Reuters reports a spot BTC allocation";
  const PRICE = JSON.stringify([
    { universe: [{ name: "BTC", szDecimals: 5 }] },
    [{ midPx: "70000.0", markPx: "70000.0", oraclePx: "70000.0", prevDayPx: "69000.0", funding: "0.0000125", dayBaseVlm: "50000" }],
  ]);

  // --- beat one: one source, refused ---
  const one = [sign(FAKE, "newswire-a.example", "NEWS", "newswire-a")];
  call(
    "submit_evidence",
    {
      desk_id: DESK,
      bundle: { asset: "BTC", direction: "LONG", verifierCodeHash, items: one },
      prev_hash: head().hash,
    },
    { signAs: TRADER },
  );
  const evOneSeq = head().seq;
  call(
    "submit_intent",
    {
      desk_id: DESK,
      intent: {
        clientId: "testnet-walkthrough-1",
        venue: "hyperliquid",
        asset: "BTC",
        side: "OPEN_LONG",
        notionalUsd: "500000000",
        maxSlippageBps: 30,
        quoteRef: null,
      },
      prev_hash: head().hash,
      equity_usd: "10000000000",
      decision_hash: sha256Hex("testnet-walkthrough-decision-1"),
      ai_sig_hash: null,
      evidence_seq: evOneSeq,
    },
    { signAs: TRADER },
  );

  // --- beat two: a second independent group, allowed at half size ---
  const two = [
    sign(FAKE, "newswire-a.example", "NEWS", "newswire-a"),
    sign(PRICE, "hyperliquid", "PRICE", "exchange-hl"),
  ];
  call(
    "submit_evidence",
    {
      desk_id: DESK,
      bundle: { asset: "BTC", direction: "LONG", verifierCodeHash, items: two },
      prev_hash: head().hash,
    },
    { signAs: TRADER },
  );
  const evTwoSeq = head().seq;
  call(
    "submit_intent",
    {
      desk_id: DESK,
      intent: {
        clientId: "testnet-walkthrough-2",
        venue: "hyperliquid",
        asset: "BTC",
        side: "OPEN_LONG",
        notionalUsd: "500000000",
        maxSlippageBps: 30,
        quoteRef: null,
      },
      prev_hash: head().hash,
      equity_usd: "10000000000",
      decision_hash: sha256Hex("testnet-walkthrough-decision-2"),
      ai_sig_hash: null,
      evidence_seq: evTwoSeq,
    },
    { signAs: TRADER },
  );
  const approvedSeq = head().seq;

  // Half of $500 is $250. Filling the full amount would walk past the gate after it had
  // already sized the trade down, and the contract refuses it.
  call(
    "record_fill",
    {
      desk_id: DESK,
      intent_seq: approvedSeq,
      fill: {
        kind: "SIMULATED",
        simulated: true,
        ref: "paper:testnet-walkthrough:BTC",
        price: "70000",
        notionalUsd: "250000000",
        evidenceSha256: sha256Hex(PRICE),
      },
      prev_hash: head().hash,
    },
    { signAs: TRADER },
  );

  // --- beat three: an oversize open, refused and recorded ---
  call(
    "submit_intent",
    {
      desk_id: DESK,
      intent: {
        clientId: "testnet-walkthrough-oversize",
        venue: "hyperliquid",
        asset: "BTC",
        side: "OPEN_LONG",
        notionalUsd: "5000000000",
        maxSlippageBps: 30,
        quoteRef: null,
      },
      prev_hash: head().hash,
      equity_usd: "10000000000",
      decision_hash: null,
      ai_sig_hash: null,
      evidence_seq: evTwoSeq,
    },
    { signAs: TRADER },
  );

  // --- beat four: the kill switch, then an exit that still goes through ---
  call("engage_kill_switch", { desk_id: DESK, reason: "walkthrough: demonstrating the brake" });
  call(
    "submit_intent",
    {
      desk_id: DESK,
      intent: {
        clientId: "testnet-walkthrough-blocked",
        venue: "hyperliquid",
        asset: "BTC",
        side: "OPEN_LONG",
        notionalUsd: "100000000",
        maxSlippageBps: 30,
        quoteRef: null,
      },
      prev_hash: head().hash,
      equity_usd: "10000000000",
      decision_hash: null,
      ai_sig_hash: null,
      evidence_seq: evTwoSeq,
    },
    { signAs: TRADER },
  );
  call(
    "submit_intent",
    {
      desk_id: DESK,
      intent: {
        clientId: "testnet-walkthrough-exit",
        venue: "hyperliquid",
        asset: "BTC",
        side: "CLOSE",
        notionalUsd: "250000000",
        maxSlippageBps: 30,
        quoteRef: null,
      },
      prev_hash: head().hash,
      equity_usd: "10000000000",
      decision_hash: null,
      ai_sig_hash: null,
      evidence_seq: null,
    },
    { signAs: TRADER },
  );
  call("release_kill_switch", { desk_id: DESK });

  const final = head();
  console.log("");
  console.log("=".repeat(70));
  console.log(`done. ${final.seq} receipts on ${CONTRACT}, desk "${DESK}".`);
  console.log(`head hash ${final.hash}`);
  console.log("");
  console.log("Verify it yourself, without trusting us:");
  console.log(`  pnpm web          then Explorer, contract ${CONTRACT}, desk ${DESK}`);
  console.log(`  https://testnet.nearblocks.io/address/${CONTRACT}`);
  console.log("");
  console.log("The explorer recomputes every hash in your browser from the receipt's own");
  console.log("contents, and anchors the first one to sha256(\"krexa-ual/v1:\" + contract + \":\" + desk).");
  console.log("=".repeat(70));

  // Leave a record in the repo of what was written, so the README can cite it.
  writeFileSync(
    join(import.meta.dirname, "..", "docs", "testnet-walkthrough.json"),
    `${canonical({
      contractId: CONTRACT,
      deskId: DESK,
      owner: OWNER,
      trader: TRADER,
      receipts: final.seq,
      headHash: final.hash,
      policyHash: sha256Hex(policyJson),
      verifierCodeHash,
      fetcherPublicKey: fetcher.publicKey,
      attested: false,
      explorer: `https://testnet.nearblocks.io/address/${CONTRACT}`,
    })}\n`,
  );
}

main().catch((e) => {
  console.error(`\nwalkthrough failed: ${String(e).slice(0, 300)}`);
  console.error(`argument files are in ${tmp} if you want to retry a step by hand.`);
  process.exit(1);
});
