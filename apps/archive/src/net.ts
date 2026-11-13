/**
 * Two small guards shared (by copy, see the sibling app's net.ts) by the recorder and the
 * fetcher: what counts as a content hash, and how much of a response body we will read.
 */

/** A response larger than this is refused. Every real source here is well under 100 KB. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * `contentHash` comes out of `index.jsonl` and is joined into a file path, so anything but 64
 * lowercase hex digits (`../../.env`, an absolute path) must never reach `join`.
 */
export function isContentHash(h: unknown): h is string {
  return typeof h === "string" && /^[0-9a-f]{64}$/.test(h);
}

/**
 * Read a response body, refusing more than `cap` bytes. Checks `content-length` up front and
 * then counts what actually arrives, because the header is optional and can lie.
 */
export async function readCappedText(res: Response, cap = MAX_BODY_BYTES): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel();
    throw new Error(`response body too large: content-length ${declared} > ${cap}`);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new Error(`response body too large: more than ${cap} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
