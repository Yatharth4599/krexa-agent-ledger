import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createApp } from "../src/server.js";

const tmp = mkdtempSync(join(tmpdir(), "ual-web-"));
const pub = join(tmp, "public");
const results = join(tmp, "results");
let base = "";
let server: ReturnType<typeof createApp>;

before(async () => {
  mkdirSync(pub);
  mkdirSync(join(results, "run1"), { recursive: true });
  writeFileSync(join(tmp, "secret.txt"), "TOP SECRET");
  writeFileSync(join(pub, "index.html"), "<h1>hi</h1>");
  writeFileSync(join(results, "run1", "run.json"), "{}");
  symlinkSync(join(tmp, "secret.txt"), join(pub, "leak.txt")); // escapes the root
  symlinkSync(join(tmp, "nope"), join(pub, "dangling.txt")); // target does not exist
  symlinkSync(join(tmp, "nope"), join(results, "dangling-run")); // breaks the /data/runs listing
  symlinkSync(tmp, join(results, "escape")); // a directory link out of the root
  writeFileSync(join(pub, "noread.txt"), "x");
  chmodSync(join(pub, "noread.txt"), 0o000);
  server = createApp({ publicDir: pub, resultsDir: results, resultsMd: join(tmp, "RESULTS.md") });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

test("serves a page with the security headers", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "<h1>hi</h1>");
  assert.match(res.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.match(res.headers.get("content-security-policy")!, /https:\/\/rpc\.testnet\.near\.org/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
});

test("headers are on error responses too", async () => {
  const res = await fetch(`${base}/missing.txt`);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("a symlink that escapes the root is a 404, not the target's content", async () => {
  const res = await fetch(`${base}/leak.txt`);
  assert.equal(res.status, 404);
  assert.doesNotMatch(await res.text(), /TOP SECRET/);
  assert.equal((await fetch(`${base}/data/runs/escape/secret.txt`)).status, 404);
});

test("a dangling symlink is a 404 and the server survives", async () => {
  assert.equal((await fetch(`${base}/dangling.txt`)).status, 404);
  assert.equal((await fetch(`${base}/data/runs/dangling-run/x`)).status, 404);
  const runs = await fetch(`${base}/data/runs`);
  assert.equal(runs.status, 200);
  assert.deepEqual(await runs.json(), ["run1"]);
  assert.equal((await fetch(`${base}/`)).status, 200);
});

test("an unreadable file does not crash the server", { skip: process.getuid?.() === 0 }, async () => {
  try {
    await fetch(`${base}/noread.txt`);
  } catch {
    // the connection may be cut after the headers; what matters is the next request works
  }
  assert.equal((await fetch(`${base}/`)).status, 200);
});

test("a malformed request URL is a 400, not a crash", async () => {
  const res = await new Promise<number>((resolve, reject) => {
    import("node:http").then(({ request }) => {
      const port = (server.address() as AddressInfo).port;
      const r = request({ host: "127.0.0.1", port, path: "//[", method: "GET" }, (m) => resolve(m.statusCode ?? 0));
      r.on("error", reject);
      r.end();
    });
  });
  assert.equal(res, 400);
  assert.equal((await fetch(`${base}/`)).status, 200);
});
