/**
 * The archive recorder. SPEC.md 2A.4.
 *
 * Snapshots the fixed source list on a 15 minute grid, hashes every response, and appends one
 * line per attempt to `data/archive/index.jsonl`. Raw bodies are stored content-addressed
 * under `data/archive/raw/<sha256>.json`.
 *
 * Three properties the replay harness depends on:
 *
 * 1. **Failures are recorded, not skipped.** A line with `ok: false` says the archive tried
 *    and could not. Without that, a gap in the data would be indistinguishable from a period
 *    where nothing happened, and a replay could silently use a stale snapshot as if it were
 *    fresh.
 * 2. **Content addressing.** Identical consecutive responses share one raw file, and a
 *    snapshot's identity is the hash of what it said. This is the same `contentHash` an
 *    evidence item carries, so an archived snapshot can be turned into signed evidence
 *    without re-fetching.
 * 3. **The grid is aligned to the clock**, not to process start, so decision points land on
 *    :00, :15, :30 and :45 regardless of when the recorder was started or restarted.
 *
 * Usage:
 *   pnpm archive:once     one snapshot of every source, then exit
 *   pnpm archive:loop     align to the grid and keep going
 *   pnpm archive:verify   recheck every raw file against the index
 *   pnpm archive:stats    coverage summary
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { sha256Hex } from "@krexa-ual/sdk";

import { isContentHash, readCappedText } from "./net.js";
import { activeSources, SOURCES, type Source } from "./sources.js";

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), "..", "..", "..");
const ARCHIVE_DIR = join(REPO_ROOT, "data", "archive");
const RAW_DIR = join(ARCHIVE_DIR, "raw");
const INDEX = join(ARCHIVE_DIR, "index.jsonl");

const FETCH_TIMEOUT_MS = 20_000;
const GRID_MS = 15 * 60 * 1000;

interface IndexLine {
  /** Nanoseconds since the epoch, decimal string, matching the evidence item format. */
  ts: string;
  /** Human-readable duplicate of ts, so the file is greppable by date. */
  iso: string;
  source: string;
  sourceGroup: string;
  kind: string;
  url: string;
  ok: boolean;
  /** sha256 of the raw body. Absent when ok is false. */
  contentHash?: string;
  bytes?: number;
  httpStatus?: number;
  error?: string;
}

function nowNs(at = Date.now()): string {
  return (BigInt(at) * 1_000_000n).toString();
}

function ensureDirs(): void {
  mkdirSync(RAW_DIR, { recursive: true });
}

async function fetchOne(source: Source, at: number): Promise<IndexLine> {
  const base = {
    ts: nowNs(at),
    iso: new Date(at).toISOString(),
    source: source.id,
    sourceGroup: source.group,
    kind: source.kind,
    url: source.url,
  };

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
    if (!res.ok) {
      return { ...base, ok: false, httpStatus: res.status, error: text.slice(0, 200) };
    }
    const contentHash = sha256Hex(text);
    const rawPath = join(RAW_DIR, `${contentHash}.json`);
    // Content addressed, so an unchanged response costs nothing the second time.
    if (!existsSync(rawPath)) writeFileSync(rawPath, text);
    return {
      ...base,
      ok: true,
      contentHash,
      bytes: Buffer.byteLength(text),
      httpStatus: res.status,
    };
  } catch (e) {
    return { ...base, ok: false, error: String(e).slice(0, 200) };
  }
}

async function snapshot(at = Date.now()): Promise<IndexLine[]> {
  ensureDirs();
  const sources = activeSources();
  // Concurrent: a slow source must not shift the recorded timestamp of a fast one.
  const lines = await Promise.all(sources.map((s) => fetchOne(s, at)));

  // Sources known to be unreachable still get a line, so the gap is explicit in the record
  // rather than being an absence a reader has to notice.
  for (const s of SOURCES.filter((x) => x.unavailable)) {
    lines.push({
      ts: nowNs(at),
      iso: new Date(at).toISOString(),
      source: s.id,
      sourceGroup: s.group,
      kind: s.kind,
      url: s.url,
      ok: false,
      error: `not attempted: ${s.unavailable}`,
    });
  }

  appendFileSync(INDEX, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return lines;
}

function readIndex(): IndexLine[] {
  if (!existsSync(INDEX)) return [];
  return readFileSync(INDEX, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as IndexLine);
}

function printSnapshot(lines: IndexLine[]): void {
  const stamp = lines[0]?.iso ?? new Date().toISOString();
  const good = lines.filter((l) => l.ok);
  const bad = lines.filter((l) => !l.ok);
  console.log(`${stamp}  ${good.length} ok, ${bad.length} failed`);
  for (const l of lines) {
    if (l.ok) {
      console.log(`  ok    ${l.source.padEnd(18)} ${String(l.bytes).padStart(7)} bytes  ${l.contentHash!.slice(0, 16)}`);
    } else {
      console.log(`  gap   ${l.source.padEnd(18)} ${l.error?.slice(0, 80) ?? "unknown"}`);
    }
  }
}

function verify(): number {
  const lines = readIndex().filter((l) => l.ok && l.contentHash);
  let missing = 0;
  let mismatched = 0;
  const seen = new Set<string>();
  for (const l of lines) {
    const hash = l.contentHash!;
    if (seen.has(hash)) continue;
    seen.add(hash);
    if (!isContentHash(hash)) {
      // never join an index-supplied string into a path unless it is 64 hex digits
      mismatched += 1;
      console.log(`MISMATCH    ${JSON.stringify(hash).slice(0, 80)} is not a sha256 hex digest (${l.source} at ${l.iso})`);
      continue;
    }
    const path = join(RAW_DIR, `${hash}.json`);
    if (!existsSync(path)) {
      missing += 1;
      console.log(`missing     ${hash} (${l.source} at ${l.iso})`);
      continue;
    }
    const actual = sha256Hex(readFileSync(path, "utf8"));
    if (actual !== hash) {
      mismatched += 1;
      console.log(`MISMATCH    ${hash} on disk hashes to ${actual}`);
    }
  }
  console.log(
    `\n${lines.length} recorded snapshots, ${seen.size} distinct bodies, ` +
      `${missing} missing, ${mismatched} mismatched`,
  );
  if (mismatched > 0) {
    console.log("A mismatch means a raw file was modified after it was recorded.");
  }
  return missing + mismatched;
}

function stats(): void {
  const lines = readIndex();
  if (lines.length === 0) {
    console.log("archive is empty; run pnpm archive:once");
    return;
  }
  const bySource = new Map<string, { ok: number; fail: number; first: string; last: string }>();
  for (const l of lines) {
    const e = bySource.get(l.source) ?? { ok: 0, fail: 0, first: l.iso, last: l.iso };
    if (l.ok) e.ok += 1;
    else e.fail += 1;
    if (l.iso < e.first) e.first = l.iso;
    if (l.iso > e.last) e.last = l.iso;
    bySource.set(l.source, e);
  }
  console.log(`index.jsonl: ${lines.length} lines\n`);
  console.log("source              ok    gaps   first snapshot        last snapshot");
  for (const [source, e] of [...bySource.entries()].sort()) {
    console.log(
      `${source.padEnd(20)}${String(e.ok).padStart(4)}  ${String(e.fail).padStart(6)}   ` +
        `${e.first.slice(0, 19)}   ${e.last.slice(0, 19)}`,
    );
  }
  const distinct = new Set(lines.filter((l) => l.ok).map((l) => l.contentHash)).size;
  console.log(`\n${distinct} distinct response bodies stored under data/archive/raw/`);
}

/** Milliseconds until the next 15 minute boundary. */
function msToNextGrid(from = Date.now()): number {
  return GRID_MS - (from % GRID_MS);
}

async function loop(): Promise<void> {
  console.log("archive recorder: 15 minute grid, aligned to the clock");
  console.log(`sources: ${activeSources().map((s) => s.id).join(", ")}`);
  const unavailable = SOURCES.filter((s) => s.unavailable);
  if (unavailable.length > 0) {
    console.log(`recording explicit gaps for: ${unavailable.map((s) => s.id).join(", ")}`);
  }
  console.log("stop with Ctrl-C, or kill the pid in data/archive/recorder.pid\n");

  // Take one immediately, so a restart never leaves a 15 minute hole.
  printSnapshot(await snapshot());

  for (;;) {
    const wait = msToNextGrid();
    await new Promise((r) => setTimeout(r, wait));
    try {
      printSnapshot(await snapshot());
    } catch (e) {
      // Never let one bad round kill a recorder that is meant to run for a week.
      console.error(`snapshot round failed: ${String(e)}`);
    }
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "--once";
  switch (mode) {
    case "--once":
      printSnapshot(await snapshot());
      break;
    case "--loop":
      await loop();
      break;
    case "--verify":
      process.exit(verify() === 0 ? 0 : 1);
      break;
    case "--stats":
      stats();
      break;
    default:
      console.error(`unknown mode ${mode}; use --once, --loop, --verify or --stats`);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
