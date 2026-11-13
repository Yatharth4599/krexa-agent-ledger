import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// app.js is a browser module (it touches `document` on load), so pull the one pure function
// under test out of the source rather than importing the file.
const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const fn = src.match(/function safeHref\(u\) \{[\s\S]*?\n\}/)![0];
const safeHref = new Function(`${fn}; return safeHref;`)() as (u: string) => string;

test("safeHref keeps http(s) and relative links", () => {
  assert.equal(safeHref("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(safeHref("http://example.com"), "http://example.com");
  assert.equal(safeHref("docs/RESULTS.md"), "docs/RESULTS.md");
  assert.equal(safeHref("/data/runs/x"), "/data/runs/x");
  assert.equal(safeHref("#top"), "#top");
});

test("safeHref blocks other schemes, including whitespace-obfuscated ones", () => {
  for (const bad of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\tscript:alert(1)",
    "  javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:x",
  ]) {
    assert.equal(safeHref(bad), "#", bad);
  }
});

test("every innerHTML interpolation of chain data goes through esc()", () => {
  for (const raw of ["${head?.seq ?? 0}", "${desk.openPositions?.length ?? 0}", "${r.verifierK}"]) {
    assert.ok(!src.includes(raw), `${raw} is interpolated unescaped`);
  }
});
