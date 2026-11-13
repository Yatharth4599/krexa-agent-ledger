/**
 * The evidence fetcher. SPEC.md 2A.2 item 2.
 *
 * Fetches from the fixed source list, hashes what came back, and signs each item with an
 * ed25519 key. The signature binds *what was fetched, from where, and when*. It says nothing
 * about whether the content is true, and no amount of attestation would change that. The gate
 * is built around that limit rather than around a pretence of having solved it.
 *
 * Two builds, as the spec requires:
 *
 * - **local** (this file): the key lives in `.env` as `FETCHER_SECRET_KEY` and the owner
 *   registers it with an attestation hash of 64 zeros. Every receipt downstream then carries
 *   `attested: false`, which is the honest label.
 * - **attested**: the key is generated inside a TEE and never leaves it, and the owner
 *   registers the real attestation report hash. Feasibility is recorded in `docs/TEE.md`.
 *
 * The unattested build is not a placeholder to be quietly swapped later. It is a labelled,
 * working mode, because SPEC.md cut-line 7 says shipping it and documenting the design is an
 * acceptable outcome.
 *
 * Usage:
 *   pnpm fetcher:keygen            generate a key and print what to put in .env
 *   pnpm fetcher:once              fetch, sign, and write a bundle to artifacts/
 *   pnpm fetcher:from-archive      sign the most recent archived snapshot of each source
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  buildEvidencePayload,
  canonical,
  generateFetcherKey,
  publicKeyFromSeed,
  sha256Hex,
  signEvidenceItem,
  UNATTESTED,
  verifyEvidenceItem,
  type SignedEvidenceItem,
  type Stance,
} from "@krexa-ual/sdk";

import { isContentHash, readCappedText } from "./net.js";
import { activeSources, policyGroups, type Source } from "./sources.js";

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), "..", "..", "..");
const ARCHIVE_DIR = join(REPO_ROOT, "data", "archive");
const ARTIFACTS = join(REPO_ROOT, "artifacts");
const FETCH_TIMEOUT_MS = 20_000;

function loadSeed(): Buffer {
  const hex = process.env.FETCHER_SECRET_KEY;
  if (!hex) {
    console.error(
      "FETCHER_SECRET_KEY is not set.\n" +
        "Generate one:  pnpm fetcher:keygen\n" +
        "Then put it in .env (which is gitignored).",
    );
    process.exit(1);
  }
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    console.error("FETCHER_SECRET_KEY must be 64 lowercase hex characters (a 32 byte seed).");
    process.exit(1);
  }
  return Buffer.from(hex, "hex");
}

function keygen(): void {
  const kp = generateFetcherKey();
  console.log("Generated an ed25519 fetcher key.\n");
  console.log("Put this in .env (gitignored, never committed):");
  console.log(`  FETCHER_SECRET_KEY=${kp.secretKeyHex}\n`);
  console.log("Register the public half on chain:");
  console.log(`  pubkey           ${kp.publicKey}`);
  console.log(`  attestation_hash ${UNATTESTED}`);
  console.log("");
  console.log("The 64 zeros are not a placeholder to fill in later. They are the honest");
  console.log("declaration that this key is held by an ordinary process rather than inside an");
  console.log("attested enclave, and they make every receipt downstream say attested: false.");
  console.log("Only pass a real report hash once an attestation has actually been checked.");
}

async function fetchRaw(source: Source): Promise<{ text: string; ok: boolean; error?: string }> {
  try {
    const res = await fetch(source.url, {
      method: source.method,
      headers:
        source.method === "POST"
          ? { "Content-Type": "application/json" }
          : { Accept: "application/json" },
      body: source.method === "POST" ? JSON.stringify(source.body) : undefined,
      // the timeout covers reading the body too; a redirect is an error, not a hop to a host
      // that is not in the source list
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "error",
    });
    const text = await readCappedText(res);
    return res.ok ? { text, ok: true } : { text, ok: false, error: `HTTP ${res.status}` };
  } catch (e) {
    return { text: "", ok: false, error: String(e).slice(0, 200) };
  }
}

/**
 * Sign one item.
 *
 * `stance` is passed in rather than decided here, and that boundary is the point. A fetcher
 * has no idea what trade is being considered, so it cannot know whether what it fetched
 * supports or contradicts it. The deterministic verifier assigns stance, and its code hash is
 * pinned in the policy. See docs/RECEIPTS.md.
 */
function signFrom(
  source: Source,
  content: string,
  fetchedAtNs: string,
  seed: Buffer,
  stance: Stance,
): SignedEvidenceItem {
  const payload = buildEvidencePayload({
    content,
    kind: source.kind === "MARKET" ? "MARKET" : source.kind === "NEWS" ? "NEWS" : "PRICE",
    source: source.id,
    sourceGroup: source.group,
    url: source.url,
    fetchedAtNs,
  });
  return signEvidenceItem(payload, seed, stance);
}

function writeBundle(items: SignedEvidenceItem[], label: string): string {
  mkdirSync(ARTIFACTS, { recursive: true });
  const body = {
    schema: "krexa.ual.evidence-bundle/1",
    fetcher: "local-unattested",
    attested: false,
    items,
  };
  const bytes = canonical(body);
  const hash = sha256Hex(bytes);
  const path = join(ARTIFACTS, `${hash}.json`);
  writeFileSync(path, bytes);
  console.log(`\nwrote ${items.length} signed item(s) to artifacts/${hash}.json  (${label})`);
  return hash;
}

async function once(): Promise<void> {
  const seed = loadSeed();
  console.log(`fetcher key  ${publicKeyFromSeed(seed)}`);
  console.log(`attested     false (local build; see docs/TEE.md)\n`);

  const items: SignedEvidenceItem[] = [];
  for (const source of activeSources()) {
    const { text, ok, error } = await fetchRaw(source);
    if (!ok) {
      console.log(`  gap   ${source.id.padEnd(18)} ${error}`);
      continue;
    }
    const item = signFrom(source, text, (BigInt(Date.now()) * 1_000_000n).toString(), seed, "NEUTRAL");
    // Verify our own signature before claiming it. A fetcher that emits an unverifiable item
    // poisons the whole bundle, because the gate fails closed on one bad signature.
    if (!verifyEvidenceItem(item)) {
      console.error(`  FAIL  ${source.id} produced a signature that does not verify`);
      process.exit(1);
    }
    items.push(item);
    console.log(
      `  ok    ${source.id.padEnd(18)} ${String(Buffer.byteLength(text)).padStart(7)} bytes  ` +
        `evidenceId ${item.item.contentHash.slice(0, 16)}`,
    );
  }

  if (items.length === 0) {
    console.error("\nno source returned anything; nothing signed");
    process.exit(1);
  }
  writeBundle(items, "live fetch");
  console.log("Stance on every item is NEUTRAL: the verifier assigns stance, not the fetcher.");
}

interface IndexLine {
  ts: string;
  iso: string;
  source: string;
  sourceGroup: string;
  kind: string;
  url: string;
  ok: boolean;
  contentHash?: string;
}

/**
 * Sign the latest archived snapshot of each source.
 *
 * This is the path the replay harness uses: the archive already holds the exact bytes that
 * were public at a given moment, so evidence for a past decision point can be reconstructed
 * without re-fetching and without look-ahead. SPEC.md 2A.4.
 */
function fromArchive(): void {
  const seed = loadSeed();
  const indexPath = join(ARCHIVE_DIR, "index.jsonl");
  if (!existsSync(indexPath)) {
    console.error(`no archive at ${indexPath}; run pnpm archive:once first`);
    process.exit(1);
  }
  const lines = readFileSync(indexPath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as IndexLine)
    .filter((l) => l.ok && l.contentHash);

  const latest = new Map<string, IndexLine>();
  for (const l of lines) {
    const prev = latest.get(l.source);
    if (!prev || l.ts > prev.ts) latest.set(l.source, l);
  }
  if (latest.size === 0) {
    console.error("archive has no successful snapshots yet");
    process.exit(1);
  }

  console.log(`fetcher key  ${publicKeyFromSeed(seed)}`);
  console.log(`attested     false (local build)\n`);

  const items: SignedEvidenceItem[] = [];
  for (const [sourceId, line] of [...latest.entries()].sort()) {
    const source = activeSources().find((s) => s.id === sourceId);
    if (!source) continue;
    if (!isContentHash(line.contentHash)) {
      console.log(`  gap   ${sourceId.padEnd(18)} index line has a malformed contentHash, refusing it`);
      continue;
    }
    const raw = join(ARCHIVE_DIR, "raw", `${line.contentHash}.json`);
    if (!existsSync(raw)) {
      console.log(`  gap   ${sourceId.padEnd(18)} raw body missing for ${line.contentHash}`);
      continue;
    }
    const content = readFileSync(raw, "utf8");
    // The archive's hash and the evidence id must be the same number, or the two systems are
    // addressing content differently and the replay would not be verifiable.
    const recomputed = sha256Hex(content);
    if (recomputed !== line.contentHash) {
      console.error(`  FAIL  ${sourceId} archive body does not match its recorded hash`);
      process.exit(1);
    }
    // Signed with the archive's own timestamp, not with now: the item has to claim the moment
    // the data was public, or freshness checks downstream would be meaningless.
    const item = signFrom(source, content, line.ts, seed, "NEUTRAL");
    items.push(item);
    console.log(
      `  ok    ${sourceId.padEnd(18)} ${line.iso.slice(0, 19)}  evidenceId ${item.item.contentHash.slice(0, 16)}`,
    );
  }

  const hash = writeBundle(items, "from archive");
  appendFileSync(
    join(ARTIFACTS, "fetcher-log.jsonl"),
    JSON.stringify({
      at: new Date().toISOString(),
      bundleHash: hash,
      items: items.length,
      attested: false,
    }) + "\n",
  );
  console.log("\nIndependence groups available to a policy from these sources:");
  for (const g of policyGroups()) {
    console.log(`  ${g.group.padEnd(22)} ${g.sources.join(", ")}`);
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "--once";
  switch (mode) {
    case "--keygen":
      keygen();
      break;
    case "--once":
      await once();
      break;
    case "--from-archive":
      fromArchive();
      break;
    default:
      console.error(`unknown mode ${mode}; use --keygen, --once or --from-archive`);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
