/**
 * Turning the archive into decision points. SPEC.md 2A.4.
 *
 * A decision point is one 15 minute grid slot with every source's snapshot for that slot. The
 * replay harness steps through them in order, and every desk sees the identical point, which
 * is the only way a difference in outcome can be attributed to the desk's design rather than
 * to one desk having seen better data.
 *
 * The strict rule here is **no look-ahead**: a decision point contains only snapshots whose
 * `fetchedAt` is at or before the point's own timestamp. arXiv 2601.13770 (Look-Ahead-Bench)
 * is the reason SPEC.md 2A.4 insists on this, and it is easy to violate by accident, for
 * example by taking "the latest price" from the whole archive while replaying a past moment.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { sha256Hex } from "@krexa-ual/sdk";
import { extractPrice } from "@krexa-ual/verifier";

import type { MarketView } from "./analyst.js";

export interface ArchiveLine {
  ts: string;
  iso: string;
  source: string;
  sourceGroup: string;
  kind: string;
  url: string;
  ok: boolean;
  contentHash?: string;
}

export interface SnapshotAtPoint {
  source: string;
  sourceGroup: string;
  kind: string;
  url: string;
  contentHash: string;
  /** The exact archived bytes. */
  body: string;
  /** The archive's own timestamp for this snapshot, nanoseconds. */
  fetchedAtNs: string;
}

export interface DecisionPoint {
  /** Grid slot, nanoseconds. */
  ts: string;
  iso: string;
  snapshots: SnapshotAtPoint[];
  /** Sources that were expected at this slot but failed, so a gap is visible. */
  gaps: string[];
}

export function loadArchive(archiveDir: string): ArchiveLine[] {
  const indexPath = join(archiveDir, "index.jsonl");
  if (!existsSync(indexPath)) return [];
  return readFileSync(indexPath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ArchiveLine);
}

/**
 * Group archive lines into decision points.
 *
 * Lines written in one snapshot round share a timestamp, so the grouping key is the timestamp
 * itself rather than a rounded bucket. A round that straddled a boundary would otherwise be
 * split across two points.
 */
export function decisionPoints(archiveDir: string, lines?: ArchiveLine[]): DecisionPoint[] {
  const all = lines ?? loadArchive(archiveDir);
  const byTs = new Map<string, ArchiveLine[]>();
  for (const l of all) {
    const list = byTs.get(l.ts) ?? [];
    list.push(l);
    byTs.set(l.ts, list);
  }

  const points: DecisionPoint[] = [];
  for (const [ts, group] of [...byTs.entries()].sort((a, b) =>
    BigInt(a[0]) < BigInt(b[0]) ? -1 : 1,
  )) {
    const snapshots: SnapshotAtPoint[] = [];
    const gaps: string[] = [];
    for (const l of group) {
      if (!l.ok || !l.contentHash) {
        gaps.push(l.source);
        continue;
      }
      // The hash becomes a file name, so it must be 64 hex digits and nothing else.
      if (!/^[0-9a-f]{64}$/.test(l.contentHash)) {
        gaps.push(`${l.source} (malformed contentHash)`);
        continue;
      }
      const raw = join(archiveDir, "raw", `${l.contentHash}.json`);
      if (!existsSync(raw)) {
        // The index says this body was stored and it is not there. A gap, not a silent skip.
        gaps.push(`${l.source} (raw body missing)`);
        continue;
      }
      const body = readFileSync(raw, "utf8");
      // The file name is only a claim. Re-hash what is on disk: a replay on edited bytes would
      // be signed as evidence under the hash of bytes that were never fetched.
      if (sha256Hex(body) !== l.contentHash) {
        gaps.push(`${l.source} (raw body does not match its hash)`);
        continue;
      }
      snapshots.push({
        source: l.source,
        sourceGroup: l.sourceGroup,
        kind: l.kind,
        url: l.url,
        contentHash: l.contentHash,
        body,
        fetchedAtNs: l.ts,
      });
    }
    points.push({ ts, iso: group[0]!.iso, snapshots, gaps });
  }
  return points;
}

/**
 * Build the market view for a point, using only snapshots at or before it.
 *
 * `history` is every earlier point, needed for indicators over a series. Nothing later than
 * `point` is ever consulted.
 */
export function marketViewAt(
  asset: string,
  point: DecisionPoint,
  history: DecisionPoint[],
): MarketView {
  const pricesByVenue: Record<string, string> = {};
  const momentumBpsByVenue: Record<string, number> = {};

  for (const snap of point.snapshots) {
    if (snap.kind !== "PRICE") continue;
    const p = extractPrice(snap.source, snap.body, asset);
    if (!p) continue;
    pricesByVenue[snap.source] = p.price;
    if (p.prevDayPrice) {
      const prev = Number(p.prevDayPrice);
      const now = Number(p.price);
      if (Number.isFinite(prev) && Number.isFinite(now) && prev !== 0) {
        momentumBpsByVenue[snap.source] = Math.round(((now - prev) / prev) * 10_000);
      }
    }
  }

  // A venue with no previous-day field (Coinbase's spot ticker) gets its momentum from the
  // archive's own history instead, which is the honest substitute: our own earlier snapshot
  // rather than a number the venue did not publish.
  const earliest = history.length > 0 ? history[0] : undefined;
  if (earliest) {
    for (const snap of point.snapshots) {
      if (snap.kind !== "PRICE" || momentumBpsByVenue[snap.source] !== undefined) continue;
      const nowP = extractPrice(snap.source, snap.body, asset);
      const thenSnap = earliest.snapshots.find((s) => s.source === snap.source);
      if (!nowP || !thenSnap) continue;
      const thenP = extractPrice(thenSnap.source, thenSnap.body, asset);
      if (!thenP) continue;
      const prev = Number(thenP.price);
      const now = Number(nowP.price);
      if (Number.isFinite(prev) && Number.isFinite(now) && prev !== 0) {
        momentumBpsByVenue[snap.source] = Math.round(((now - prev) / prev) * 10_000);
      }
    }
  }

  return { asset, pricesByVenue, momentumBpsByVenue };
}

/**
 * Move one archived timestamp into the frame of the replay, preserving its age.
 *
 * The contract judges evidence freshness against block time and `maxAgeSec` is capped at 86400
 * by the policy schema, so an archive spanning more than a day cannot be replayed under any
 * legal policy without its older points arriving stale. The run of 13 Nov 2026 showed what that
 * costs: 112 of `ebi`'s 121 refusals were `R_NO_EVIDENCE` at k=0, and the boundary sat exactly
 * 24 hours before the run started. The gate was reporting the age of the archive.
 *
 * `anchorNs` is the moment the decision is being replayed and `pointNs` is the decision point it
 * stands for, so `anchorNs - pointNs` is the offset between the two clocks. Applying it to every
 * item of one point keeps each item's age *relative to its own decision* exactly as recorded,
 * which is the quantity `maxAgeSec` is about, and keeps the spacing between items intact, which
 * is what the indicator recompute walks.
 *
 * Nothing lands in the future as long as `fetchedAtNs <= pointNs`, which `assertNoLookAhead`
 * establishes for every snapshot before a run starts.
 */
export function replayFetchedAt(fetchedAtNs: string, pointNs: string, anchorNs: bigint): string {
  return (BigInt(fetchedAtNs) + (anchorNs - BigInt(pointNs))).toString();
}

/** Assert no snapshot in a point is dated after the point itself. */
export function assertNoLookAhead(point: DecisionPoint): void {
  const ts = BigInt(point.ts);
  for (const s of point.snapshots) {
    if (BigInt(s.fetchedAtNs) > ts) {
      throw new Error(
        `look-ahead: ${s.source} snapshot at ${s.fetchedAtNs} is later than decision point ${point.ts}`,
      );
    }
  }
}
