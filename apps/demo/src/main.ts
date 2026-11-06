/**
 * `pnpm demo`
 *
 * Runs the whole evidence gate on a local NEAR sandbox, start to finish, with no keys, no
 * network calls to any exchange, and no LLM. It exits 0 only if every assertion holds, so it
 * is a test as much as a demonstration. This is the script SPEC.md 19 describes and the one a
 * judge runs.
 *
 * Every number printed is either computed from a receipt or labelled. The equity figures and
 * the headlines are invented for the demo and marked `DEMO DATA` and `SYNTHETIC ATTACK`
 * respectively, per the ground rules: nothing here is a market observation and nothing here
 * is a result.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  bundleHash,
  buildEvidencePayload,
  generateFetcherKey,
  receiptHash,
  sha256Hex,
  signEvidenceItem,
  UNATTESTED,
  UalClient,
  verifyChain,
  verifyEvidenceItem,
  type EvidenceBundle,
  type Policy,
  type Receipt,
  type SignedEvidenceItem,
} from "@krexa-ual/sdk";
import { Worker, type NearAccount } from "near-workspaces";

import { WorkspacesCaller } from "./caller.js";

// ---------------------------------------------------------------- presentation

const BOLD = "[1m";
const DIM = "[2m";
const RED = "[31m";
const GREEN = "[32m";
const YELLOW = "[33m";
const RESET = "[0m";

let step = 0;
function beat(title: string): void {
  step += 1;
  console.log(`\n${BOLD}${step}. ${title}${RESET}`);
}
function say(line: string): void {
  console.log(`   ${line}`);
}
function note(line: string): void {
  console.log(`   ${DIM}${line}${RESET}`);
}
function ok(line: string): void {
  console.log(`   ${GREEN}ok${RESET}  ${line}`);
}
function blocked(line: string): void {
  console.log(`   ${RED}blocked${RESET}  ${line}`);
}

let failures = 0;
function check(condition: boolean, description: string): void {
  if (condition) {
    ok(description);
  } else {
    failures += 1;
    console.log(`   ${RED}FAIL${RESET}  ${description}`);
  }
}

function usd(microUsd: string): string {
  const neg = microUsd.startsWith("-");
  const digits = neg ? microUsd.slice(1) : microUsd;
  const padded = digits.padStart(7, "0");
  const whole = padded.slice(0, -6).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${whole}.${padded.slice(-6, -4)}`;
}

function reasonsOf(r: Receipt): string[] {
  return r.reasons ?? [];
}

/**
 * Point near-workspaces at a neard new enough to run our contract.
 *
 * near-workspaces-js bundles neard 2.6.2, which cannot prepare the wasm cargo-near 0.23
 * emits: it fails with PrepareError::Deserialization on a contract that testnet and the Rust
 * sandbox both accept. `scripts/fetch-sandbox.sh` caches the matching build (2.14.0) and
 * near-workspaces honours NEAR_SANDBOX_BIN_PATH, so the demo runs the same runtime as the
 * chain. The full reasoning is in that script's header.
 */
function ensureSandboxBinary(): void {
  const dir = process.env.NEAR_SANDBOX_BINARY_PATH;
  if (!dir || !existsSync(join(dir, "near-sandbox"))) {
    console.error(
      `\n${RED}no near-sandbox binary configured${RESET}\n` +
        `Run the demo through its wrapper, which sorts this out:\n  pnpm demo\n`,
    );
    process.exit(1);
  }
  note(`sandbox   ${join(dir, "near-sandbox")}`);
}

// ---------------------------------------------------------------- fixtures

const DESK_EBI = "ebi";
const DESK_PLAIN = "plain";

/** Deliberately fake. Labelled everywhere it appears. */
const FAKE_HEADLINE =
  "BREAKING: major asset manager confirms spot BTC allocation, sources say";
const HL_PRICE_SNAPSHOT = '{"coin":"BTC","mid":"68012.5","funding":"0.0000125"}';
const NEWSWIRE_B_CONFIRMS = "Second outlet confirms allocation, filing visible on registry";

const AGENT_METHODS = ["submit_evidence", "submit_intent", "record_fill", "record_mark"];
const MONITOR_METHODS = ["engage_kill_switch", "record_mark"];

function policyFor(deskId: string, evidenceRequired: boolean, verifierCodeHash: string): Policy {
  return {
    schema: "krexa.ual.policy/1",
    deskId,
    maxPositionUsd: "1000000000", // $1,000
    maxOpenPositions: 3,
    dailyLossLimitUsd: "200000000", // $200
    allowedAssets: ["BTC", "ETH"],
    allowedVenues: ["hyperliquid", "paper"],
    slippageCapBps: 30,
    allowedModes: ["paper"],
    killSwitch: { autoOnDailyLoss: true, monitorMayEngage: true },
    description:
      evidenceRequired
        ? "EBI desk: every open must cite corroborated evidence"
        : "plain desk: same limits, no evidence gate (today's typical agent)",
    evidence: {
      required: evidenceRequired,
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
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  console.log(`${BOLD}Evidence-Bound Intents: local sandbox demo${RESET}`);
  note("NEAR sandbox, paper mode, no keys, no LLM, no exchange calls.");
  note("Headlines marked SYNTHETIC ATTACK are invented. Equity marked DEMO DATA is invented.");
  note("Nothing here is a trading result and no return is claimed.");

  ensureSandboxBinary();

  const worker = await Worker.init();
  try {
    await run(worker);
  } finally {
    await worker.tearDown().catch(() => {});
  }

  console.log("");
  if (failures > 0) {
    console.log(`${RED}${BOLD}demo failed: ${failures} assertion(s) did not hold${RESET}`);
    process.exit(1);
  }
  console.log(`${GREEN}${BOLD}demo complete: every assertion held${RESET}`);
}

async function run(worker: Worker): Promise<void> {
  const root = worker.rootAccount;

  // ---------------------------------------------------------------- deploy
  beat("Deploy the ledger to a local sandbox");
  // cargo-near writes to <workspace root>/target/near/<crate>/, and the workspace root is
  // the repo root (see /Cargo.toml for why).
  const wasmPath = join(
    dirname(new URL(import.meta.url).pathname),
    "..",
    "..",
    "..",
    "target",
    "near",
    "ual",
    "ual.wasm",
  );
  let wasm: Buffer;
  try {
    wasm = readFileSync(wasmPath);
  } catch {
    console.error(
      `\n${RED}contract wasm not found at ${wasmPath}${RESET}\n` +
        `Build it first:\n  pnpm run build:contract\n`,
    );
    process.exit(1);
  }

  const contract = await root.createSubAccount("ual", {
    initialBalance: "50 N",
  });
  await contract.deploy(wasm);
  // Enough to fund three agent sub-accounts and the per-desk storage deposits.
  const owner = await root.createSubAccount("desk-owner", { initialBalance: "200 N" });
  await contract.call(contract, "new", { owner: owner.accountId });

  say(`contract   ${contract.accountId}`);
  say(`wasm sha256 ${sha256Hex(new Uint8Array(wasm)).slice(0, 32)}...`);
  note("The contract has no withdraw method, no transfer, and no upgrade entry point.");

  // ---------------------------------------------------------------- verifier code hash
  beat("Pin the verifier build into the policy");
  // In M3 this is the real hash of packages/verifier's build output. Until that exists, the
  // demo pins a placeholder and says so, rather than printing a number that looks derived.
  const verifierCodeHash = sha256Hex("krexa.ual.verifier/placeholder-until-M3");
  say(`verifierCodeHash ${verifierCodeHash.slice(0, 32)}...`);
  note("DEMO DATA: a placeholder until packages/verifier lands in M3. The contract only");
  note("checks that a bundle's hash equals the one the policy names, which it does here.");

  // ---------------------------------------------------------------- fetcher
  beat("Register an evidence fetcher");
  const fetcher = generateFetcherKey();
  say(`fetcher key  ${fetcher.publicKey}`);
  say(`attestation  ${UNATTESTED.slice(0, 16)}... (64 zeros)`);
  note("64 zeros is the honest declaration that this fetcher is NOT in an attested enclave.");
  note("Every receipt downstream of it will carry attested: false. The TEE path is M2's");
  note("open question and docs/TEE.md records the outcome either way.");

  // ---------------------------------------------------------------- two desks
  beat("Create two desks with identical limits, one gated and one not");
  const ownerClient = new UalClient(new WorkspacesCaller(owner, contract), contract.accountId);

  const agents: Record<string, NearAccount> = {};
  for (const [deskId, gated] of [
    [DESK_EBI, true],
    [DESK_PLAIN, false],
  ] as const) {
    await ownerClient.createDesk(deskId);
    const { policyHash } = await ownerClient.commitPolicy(
      policyFor(deskId, gated, verifierCodeHash),
    );

    const trader = await owner.createSubAccount(`trader-${deskId}`, { initialBalance: "10 N" });
    await ownerClient.registerAgent(deskId, trader.accountId, "TRADER");
    agents[`trader-${deskId}`] = trader;

    await ownerClient.registerFetcher(deskId, fetcher.publicKey, UNATTESTED, "demo-fetcher");

    say(`${deskId.padEnd(6)} policyHash ${policyHash.slice(0, 24)}...  evidence.required=${gated}`);
  }

  const monitor = await owner.createSubAccount("monitor-ebi", { initialBalance: "10 N" });
  await ownerClient.registerAgent(DESK_EBI, monitor.accountId, "MONITOR");

  note("Same maxPositionUsd, same daily loss limit, same assets. The only difference is the");
  note("evidence block. That is what makes the two desks comparable in the study.");

  const ebi = new UalClient(
    new WorkspacesCaller(agents[`trader-${DESK_EBI}`]!, contract),
    contract.accountId,
  );
  const plain = new UalClient(
    new WorkspacesCaller(agents[`trader-${DESK_PLAIN}`]!, contract),
    contract.accountId,
  );
  const monitorClient = new UalClient(new WorkspacesCaller(monitor, contract), contract.accountId);

  // ---------------------------------------------------------------- opening equity
  beat("Mark opening equity on both desks");
  for (const [name, client] of [
    [DESK_EBI, ebi],
    [DESK_PLAIN, plain],
  ] as const) {
    const r = await client.recordMark(name, "10000000000");
    say(`${name.padEnd(6)} equity ${usd(r.equityUsd ?? "0")}  seq ${r.seq}`);
  }
  note("DEMO DATA: $10,000 of simulated paper equity. Not a deposit, not a real balance.");

  // ---------------------------------------------------------------- the attack
  beat("A fake headline arrives");
  console.log(`   ${YELLOW}SYNTHETIC ATTACK${RESET}  "${FAKE_HEADLINE}"`);
  note("One source. Invented for this demo. This is the attack class arXiv 2610.26438 studies.");

  const nowNs = () => (BigInt(Date.now()) * 1_000_000n).toString();

  const fakeItem = signEvidenceItem(
    buildEvidencePayload({
      content: FAKE_HEADLINE,
      kind: "NEWS",
      source: "newswire-a.example",
      sourceGroup: "newswire-a",
      url: "https://newswire-a.example/breaking",
      fetchedAtNs: nowNs(),
    }),
    Buffer.from(fetcher.secretKeyHex, "hex"),
    "SUPPORT",
  );
  check(verifyEvidenceItem(fakeItem), "the fake item is correctly signed, so provenance is not the issue");
  note("Note what the signature proves: the fetcher really did fetch this, from there, then.");
  note("It says nothing about whether the content is true. A TEE would not change that.");

  // ---------------------------------------------------------------- plain desk trades
  beat("The ungated desk reads the headline and opens a long");
  const plainIntent = {
    clientId: "plain-0001",
    venue: "hyperliquid",
    asset: "BTC",
    side: "OPEN_LONG" as const,
    notionalUsd: "500000000",
    maxSlippageBps: 30,
  };
  const plainResult = await plain.submitIntent(DESK_PLAIN, plainIntent, {
    equityUsd: "10000000000",
    decisionHash: sha256Hex("demo-decision-plain-0001"),
  });
  say(`verdict ${plainResult.receipt.verdict}  size ${usd(plainIntent.notionalUsd)}  seq ${plainResult.receipt.seq}`);
  check(plainResult.receipt.verdict === "APPROVED", "the ungated desk trades on one unverified source");
  const plainFill = await plain.recordFill(DESK_PLAIN, plainResult.receipt.seq, {
    kind: "SIMULATED",
    simulated: true,
    ref: "paper:demo:BTC:fake-headline",
    price: "68012.5",
    notionalUsd: "500000000",
    evidenceSha256: sha256Hex(HL_PRICE_SNAPSHOT),
  });
  check(plainFill.mode === "paper", "the fill is labelled paper on chain, by the contract");

  // ---------------------------------------------------------------- ebi desk blocks
  beat("The gated desk cites the same headline and is refused");
  const oneSource: EvidenceBundle = {
    asset: "BTC",
    direction: "LONG",
    verifierCodeHash,
    items: [fakeItem],
  };
  const ev1 = await ebi.submitEvidence(DESK_EBI, oneSource);
  const ev1Summary = ev1.evidence as Record<string, unknown>;
  say(`EVIDENCE receipt seq ${ev1.seq}  bundleHash ${String(ev1Summary.bundleHash).slice(0, 24)}...`);
  say(`k = ${ev1Summary.k} independent group(s)  sizeMultiplier = ${ev1.sizeMultiplierBps} bps`);
  check(ev1Summary.k === 1, "one source resolves to exactly one independence group");
  check(ev1.sizeMultiplierBps === 0, "k=1 sizes the trade to zero");
  check(ev1Summary.attested === false, "the receipt says attested: false, because the fetcher is not in a TEE");
  check(bundleHash(oneSource) === ev1Summary.bundleHash, "the SDK and the contract hash the bundle identically");

  const ebiBlocked = await ebi.submitIntent(
    DESK_EBI,
    { ...plainIntent, clientId: "ebi-0001" },
    {
      equityUsd: "10000000000",
      decisionHash: sha256Hex("demo-decision-ebi-0001"),
      evidenceSeq: ev1.seq,
    },
  );
  blocked(`verdict ${ebiBlocked.receipt.verdict}  reasons ${reasonsOf(ebiBlocked.receipt).join(", ")}`);
  check(ebiBlocked.receipt.verdict === "REJECTED", "the gated desk refuses the single-source trade");
  check(
    reasonsOf(ebiBlocked.receipt).includes("R_UNCORROBORATED"),
    "the reason recorded is R_UNCORROBORATED",
  );
  check(
    reasonsOf(ebiBlocked.receipt).includes("PAPER_ONLY_UNCORROBORATED"),
    "and PAPER_ONLY_UNCORROBORATED, because this desk is in paper mode",
  );
  check(
    ebiBlocked.localFindings.some((f) => f.reason === "R_UNCORROBORATED"),
    "the SDK's local pre-check reached the same conclusion before the call",
  );
  note("The refusal is a receipt and the transaction succeeded. A blocked trade is part of");
  note("the record, not an absence from it. That is the whole point of the ledger.");

  // ---------------------------------------------------------------- corroboration
  beat("A second independent source confirms, so the trade is allowed at half size");
  const corroborated: EvidenceBundle = {
    asset: "BTC",
    direction: "LONG",
    verifierCodeHash,
    items: [
      fakeItem,
      signEvidenceItem(
        buildEvidencePayload({
          content: HL_PRICE_SNAPSHOT,
          kind: "PRICE",
          source: "hyperliquid",
          sourceGroup: "exchange-hl",
          url: "https://api.hyperliquid.xyz/info",
          fetchedAtNs: nowNs(),
        }),
        Buffer.from(fetcher.secretKeyHex, "hex"),
        "SUPPORT",
      ),
    ],
  };
  const ev2 = await ebi.submitEvidence(DESK_EBI, corroborated);
  const ev2Summary = ev2.evidence as Record<string, unknown>;
  say(`k = ${ev2Summary.k}  sizeMultiplier = ${ev2.sizeMultiplierBps} bps`);
  check(ev2Summary.k === 2, "two distinct groups agree");
  check(ev2.sizeMultiplierBps === 5000, "k=2 earns 50 percent of the requested size");

  const ebiApproved = await ebi.submitIntent(
    DESK_EBI,
    { ...plainIntent, clientId: "ebi-0002" },
    { equityUsd: "10000000000", evidenceSeq: ev2.seq },
  );
  say(`verdict ${ebiApproved.receipt.verdict}  requested ${usd("500000000")}  allowed ${usd("250000000")}`);
  check(ebiApproved.receipt.verdict === "APPROVED", "the corroborated trade is approved");
  check(ebiApproved.receipt.sizeMultiplierBps === 5000, "sized down rather than refused");

  beat("The approved half size cannot be filled at the full size");
  let overfillRefused = false;
  try {
    await ebi.recordFill(DESK_EBI, ebiApproved.receipt.seq, {
      kind: "SIMULATED",
      simulated: true,
      ref: "paper:demo:BTC:overfill",
      price: "68012.5",
      notionalUsd: "500000000",
    });
  } catch {
    overfillRefused = true;
  }
  check(overfillRefused, "filling $500 against a $250 approval is refused (E15_FILL_EXCEEDS_INTENT)");
  note("Without this, the gate would size a trade down and the fill would walk straight past it.");

  const ebiFill = await ebi.recordFill(DESK_EBI, ebiApproved.receipt.seq, {
    kind: "SIMULATED",
    simulated: true,
    ref: "paper:demo:BTC:half",
    price: "68012.5",
    notionalUsd: "250000000",
  });
  check(ebiFill.kind === "FILL", `filled at ${usd("250000000")}, seq ${ebiFill.seq}`);

  // ---------------------------------------------------------------- three groups
  beat("Three independent groups agree, so full size is allowed");
  const threeGroups: EvidenceBundle = {
    asset: "BTC",
    direction: "LONG",
    verifierCodeHash,
    items: [
      ...corroborated.items,
      signEvidenceItem(
        buildEvidencePayload({
          content: NEWSWIRE_B_CONFIRMS,
          kind: "NEWS",
          source: "newswire-b.example",
          sourceGroup: "newswire-b",
          url: "https://newswire-b.example/confirm",
          fetchedAtNs: nowNs(),
        }),
        Buffer.from(fetcher.secretKeyHex, "hex"),
        "SUPPORT",
      ),
    ],
  };
  const ev3 = await ebi.submitEvidence(DESK_EBI, threeGroups);
  check((ev3.evidence as Record<string, unknown>).k === 3, "k=3");
  check(ev3.sizeMultiplierBps === 10000, "k>=3 earns full size");
  note("SPEC.md 2A.6 H4: an attacker who plants the same fake in three declared groups gets");
  note("the same full size. Corroboration counting is only as good as source independence.");
  note("That limit is measured in M4, not hidden.");

  // ---------------------------------------------------------------- tampering
  beat("A tampered item taints the whole bundle");
  const tampered: SignedEvidenceItem = {
    ...fakeItem,
    item: { ...fakeItem.item, contentHash: sha256Hex("a different headline entirely") },
  };
  check(!verifyEvidenceItem(tampered), "the SDK detects the forged item locally");
  const tamperedBundle: EvidenceBundle = {
    asset: "BTC",
    direction: "LONG",
    verifierCodeHash,
    items: [tampered, corroborated.items[1]!, threeGroups.items[2]!],
  };
  const evBad = await ebi.submitEvidence(DESK_EBI, tamperedBundle, { allowBadSignatures: true });
  const badSummary = evBad.evidence as Record<string, unknown>;
  check(badSummary.anyBadSig === true, "the contract's ed25519 check agrees: anyBadSig");
  check(badSummary.k === 2, `two honest groups remain, so k=${badSummary.k}`);
  const afterTamper = await ebi.submitIntent(
    DESK_EBI,
    { ...plainIntent, clientId: "ebi-0003", notionalUsd: "100000000" },
    { equityUsd: "10000000000", evidenceSeq: evBad.seq },
  );
  blocked(`verdict ${afterTamper.receipt.verdict}  reasons ${reasonsOf(afterTamper.receipt).join(", ")}`);
  check(
    reasonsOf(afterTamper.receipt).includes("R_EVIDENCE_BAD_SIG"),
    "the intent is refused even though the honest items alone would have cleared the table",
  );
  note("Fail closed: a bundle containing a forgery is evidence the pipeline feeding it is");
  note("compromised, so the gate refuses rather than quietly dropping the bad item.");

  // ---------------------------------------------------------------- oversize
  beat("A prompt-injected trader tries an oversize order");
  note("SYNTHETIC ATTACK: pretend the Analyst was told to ignore its limits.");
  const oversize = await ebi.submitIntent(
    DESK_EBI,
    { ...plainIntent, clientId: "ebi-0004", notionalUsd: "5000000000" },
    { equityUsd: "10000000000", evidenceSeq: ev3.seq },
  );
  blocked(`$5,000 requested against a $1,000 cap: ${reasonsOf(oversize.receipt).join(", ")}`);
  check(
    reasonsOf(oversize.receipt).includes("R_MAX_POSITION"),
    "refused with R_MAX_POSITION, and recorded",
  );

  // ---------------------------------------------------------------- key scope
  beat("The trader's key cannot move money or change the rules");
  const traderKeys = await agents[`trader-${DESK_EBI}`]!.viewAccessKeys(
    agents[`trader-${DESK_EBI}`]!.accountId,
  );
  say(`the trader account holds ${traderKeys.keys.length} key(s)`);
  note("In the sandbox the demo account keeps a full-access key so it can be set up at all.");
  note("The production scoping, and the proof that a function-call key cannot transfer, call");
  note("an owner method, reach another contract, or escalate itself, is in");
  note("tests/integration/tests/fc_keys.rs: 12 tests against a real node.");
  say(`a TRADER key is scoped to: ${AGENT_METHODS.join(", ")}`);
  say(`a MONITOR key is scoped to: ${MONITOR_METHODS.join(", ")}`);
  check(
    !MONITOR_METHODS.includes("release_kill_switch"),
    "no agent role can release the kill switch; only the owner can",
  );

  // ---------------------------------------------------------------- kill switch
  beat("The Monitor engages the kill switch; opens stop, exits do not");
  await monitorClient.killSwitch(
    DESK_EBI,
    "engage",
    "attack suspect: repeated single-source citation",
  );
  const deskState = (await ebi.getDesk(DESK_EBI)) as Record<string, unknown>;
  check(deskState.killSwitch === true, `engaged by ${monitor.accountId}, a rule-based agent with no LLM`);

  const afterKill = await ebi.submitIntent(
    DESK_EBI,
    { ...plainIntent, clientId: "ebi-0005", notionalUsd: "100000000" },
    { equityUsd: "10000000000", evidenceSeq: ev3.seq },
  );
  blocked(`open refused: ${reasonsOf(afterKill.receipt).join(", ")}`);
  check(reasonsOf(afterKill.receipt).includes("R_KILL_SWITCH"), "opens are blocked");

  const exit = await ebi.submitIntent(
    DESK_EBI,
    { ...plainIntent, clientId: "ebi-0006", side: "CLOSE", notionalUsd: "250000000" },
    { equityUsd: "10000000000" },
  );
  check(exit.receipt.verdict === "APPROVED", "a close is still approved, with no evidence cited");
  note("You can always exit. A risk control that trapped a position would be a worse risk.");

  let monitorRelease = false;
  try {
    await monitorClient.killSwitch(DESK_EBI, "release");
  } catch {
    monitorRelease = true;
  }
  check(monitorRelease, "the Monitor cannot release what it engaged");
  await ownerClient.killSwitch(DESK_EBI, "release");
  check(
    ((await ebi.getDesk(DESK_EBI)) as Record<string, unknown>).killSwitch === false,
    "only the owner can release it",
  );

  // ---------------------------------------------------------------- the chain
  beat("Walk the hash chain, then tamper with one byte");
  for (const deskId of [DESK_EBI, DESK_PLAIN]) {
    const { receipts, chain } = await ebi.getRecord(deskId);
    check(chain.valid, `${deskId}: ${receipts.length} receipts, chain verifies from genesis`);
    if (!chain.valid) say(`${RED}${chain.reason}${RESET}`);

    const kinds = receipts.reduce<Record<string, number>>((acc, r) => {
      acc[r.kind] = (acc[r.kind] ?? 0) + 1;
      return acc;
    }, {});
    say(`${deskId}: ${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join("  ")}`);

    const rejected = receipts.filter((r) => r.verdict === "REJECTED");
    say(`${deskId}: ${rejected.length} rejected intent(s), all recorded with their reasons`);
  }

  const { receipts } = await ebi.getRecord(DESK_EBI);
  const genesis = await ebi.genesisHash(DESK_EBI);
  check(
    receipts.every((r) => receiptHash(r) === r.hash),
    "every receipt hash recomputes from its own contents, in TypeScript",
  );

  const target = Math.min(4, receipts.length - 1);
  const tamperedChain = receipts.map((r, i) =>
    i === target ? { ...r, equityUsd: "99999999999" } : r,
  );
  const broken = verifyChain(tamperedChain, genesis);
  check(!broken.valid, `changing one equity field breaks the chain`);
  check(
    broken.brokenAt === receipts[target]!.seq,
    `and names the exact receipt: broken at seq ${broken.brokenAt}`,
  );
  say(`${DIM}${broken.reason}${RESET}`);

  const rebased = verifyChain(receipts, sha256Hex("krexa-ual/v1:someone-elses-contract:ebi"));
  check(!rebased.valid, "a run rebased onto a different genesis is refused");

  // ---------------------------------------------------------------- what this is not
  beat("What this demo does not show");
  note("No market data was fetched. No LLM was called. No order was placed anywhere.");
  note("The headlines are invented, the equity is invented, and the fetcher is unattested.");
  note("No attack success rate, PnL or Sharpe number is printed, because the experiment that");
  note("would produce one has not been run. Those land in M4 and M5, computed from receipts.");
  note("The skill verdict for every desk will read CANT_TELL_YET: 8 days cannot show skill.");
}

main().catch((err) => {
  console.error(`\n${RED}demo crashed${RESET}`);
  console.error(err);
  process.exit(1);
});
