/**
 * Which run `pnpm ebi:report` calls the latest one.
 *
 * This has been wrong three times and the third way is the reason these tests exist. Ranking by
 * `run.json` mtime worked perfectly on the machine that produced the runs and picked a 7 Nov
 * 11-point run over the 13 Nov 323-point one on a fresh clone, because a clone stamps every
 * checked-out file with the checkout time. That broke byte-identical regeneration on precisely
 * the machine SPEC.md M5 cares about, a judge's, and nothing in the repo would have caught it.
 *
 * So every case below sets mtimes that contradict the right answer.
 */

import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { latestRun } from "../src/report.js";

/** A run directory the report can load, with its mtime forced to `mtimeSec`. */
function makeRun(
  dir: string,
  runId: string,
  meta: Record<string, unknown>,
  mtimeSec: number,
): void {
  const d = join(dir, runId);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "run.json"), JSON.stringify({ runId, points: 1, ...meta }));
  writeFileSync(join(d, "decisions.jsonl"), "{}\n");
  utimesSync(join(d, "run.json"), mtimeSec, mtimeSec);
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ual-latest-run-"));
}

describe("latestRun", () => {
  it("prefers the later finishedAt even when the other file is newer on disk", () => {
    const dir = tmp();
    makeRun(dir, "sim-a-100p", { finishedAt: "2026-11-13T15:29:44Z", lastPoint: "2026-11-13T12:30:00Z" }, 1_000);
    makeRun(dir, "sim-b-11p", { finishedAt: "2026-11-07T16:10:00Z", lastPoint: "2026-11-07T16:00:00Z" }, 9_000_000_000);
    expect(latestRun(dir)).toBe("sim-a-100p");
  });

  it("falls back to the newest decision point when finishedAt is absent", () => {
    const dir = tmp();
    makeRun(dir, "sim-old-293p", { lastPoint: "2026-11-12T18:45:00Z" }, 9_000_000_000);
    makeRun(dir, "sim-new-323p", { lastPoint: "2026-11-13T12:30:00Z" }, 1_000);
    expect(latestRun(dir)).toBe("sim-new-323p");
  });

  it("ranks a run that recorded finishedAt above an older one that did not", () => {
    const dir = tmp();
    makeRun(dir, "sim-legacy-11p", { lastPoint: "2026-11-07T16:00:00Z" }, 9_000_000_000);
    makeRun(dir, "sim-current-323p", { finishedAt: "2026-11-14T01:00:00Z", lastPoint: "2026-11-13T12:30:00Z" }, 1_000);
    expect(latestRun(dir)).toBe("sim-current-323p");
  });

  it("skips a directory an interrupted run left behind", () => {
    const dir = tmp();
    makeRun(dir, "sim-good-323p", { lastPoint: "2026-11-13T12:30:00Z" }, 1_000);
    // What a run that died mid-flight leaves: the folders, nothing in them.
    mkdirSync(join(dir, "sim-dead-14p", "records"), { recursive: true });
    mkdirSync(join(dir, "sim-dead-14p", "artifacts"), { recursive: true });
    expect(latestRun(dir)).toBe("sim-good-323p");
  });

  it("breaks a tie on point count, then on run id, so the answer is total", () => {
    const dir = tmp();
    const same = { lastPoint: "2026-11-13T12:30:00Z" };
    makeRun(dir, "sim-x-10p", { ...same, points: 10 }, 5_000);
    makeRun(dir, "sim-y-300p", { ...same, points: 300 }, 4_000);
    expect(latestRun(dir)).toBe("sim-y-300p");

    const dir2 = tmp();
    makeRun(dir2, "sim-a-10p", { ...same, points: 10 }, 5_000);
    makeRun(dir2, "sim-b-10p", { ...same, points: 10 }, 4_000);
    expect(latestRun(dir2)).toBe("sim-b-10p");
  });

  it("returns nothing when there are no runs at all", () => {
    expect(latestRun(join(tmp(), "nope"))).toBeUndefined();
  });
});
