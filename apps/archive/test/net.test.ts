import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { isContentHash, readCappedText } from "../src/net.js";

test("isContentHash accepts only 64 lowercase hex", () => {
  assert.equal(isContentHash("a".repeat(64)), true);
  for (const bad of ["../../.env", "/etc/passwd", "A".repeat(64), "a".repeat(63), "a".repeat(65), `${"a".repeat(64)}/..`, 7, undefined]) {
    assert.equal(isContentHash(bad), false, String(bad));
  }
});

test("readCappedText reads a small body and refuses a large one", async () => {
  const srv = createServer((req, res) => {
    if (req.url === "/big") {
      res.write("x".repeat(100)); // no content-length: chunked, so only the counted read can catch it
      res.end("x".repeat(100));
    } else if (req.url === "/declared") {
      res.setHeader("content-length", "200");
      res.end("x".repeat(200));
    } else {
      res.end("hello");
    }
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    assert.equal(await readCappedText(await fetch(`${base}/`), 150), "hello");
    await assert.rejects(readCappedText(await fetch(`${base}/big`), 150), /too large/);
    await assert.rejects(readCappedText(await fetch(`${base}/declared`), 150), /content-length/);
  } finally {
    srv.close();
  }
});
