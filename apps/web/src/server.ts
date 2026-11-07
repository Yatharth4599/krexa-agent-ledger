/**
 * `pnpm web`: a static file server, and nothing more.
 *
 * SPEC.md 10 asks for a page that reads the chain via view calls with no private backend. So
 * this serves `public/` and read-only access to two things already in the repo: the generated
 * `docs/RESULTS.md` and the run directories under `experiments/ebi/results`. It holds no state,
 * signs nothing, has no database, and cannot write.
 *
 * Everything about the chain is fetched by the browser directly from a public NEAR node. If
 * this process were switched off mid-session the explorer would keep working.
 */

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const REPO = resolve(join(import.meta.dirname, "..", "..", ".."));
const PUBLIC = join(import.meta.dirname, "..", "public");
const RESULTS = join(REPO, "experiments", "ebi", "results");
const RESULTS_MD = join(REPO, "docs", "RESULTS.md");
const PORT = Number(process.env.PORT ?? 3000);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
};

/**
 * Resolve a request path inside a root, refusing anything that escapes it.
 *
 * The server only ever reads, but `../../.env` is still a path a request can ask for, and
 * "it only reads" is exactly the reasoning behind most directory-traversal bugs.
 */
function safeJoin(root: string, requestPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return undefined; // a malformed escape such as `/%` used to throw and kill the server
  }
  const clean = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const full = resolve(join(root, clean));
  if (full !== resolve(root) && !full.startsWith(resolve(root) + sep)) return undefined;
  return full;
}

function send(
  res: import("node:http").ServerResponse,
  code: number,
  body: string,
  type = "text/plain; charset=utf-8",
): void {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method !== "GET") return send(res, 405, "read only");

  // --- list the local runs ---
  if (path === "/data/runs") {
    if (!existsSync(RESULTS)) return send(res, 200, "[]", TYPES[".json"]!);
    const runs = readdirSync(RESULTS)
      .filter((d) => statSync(join(RESULTS, d)).isDirectory())
      .sort();
    return send(res, 200, JSON.stringify(runs), TYPES[".json"]!);
  }

  // --- a file inside a run ---
  if (path.startsWith("/data/runs/")) {
    const full = safeJoin(RESULTS, path.slice("/data/runs/".length));
    if (!full || !existsSync(full) || statSync(full).isDirectory()) {
      return send(res, 404, "not found");
    }
    res.writeHead(200, {
      "Content-Type": TYPES[extname(full)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    return void createReadStream(full).pipe(res);
  }

  // --- the generated results document ---
  if (path === "/data/results-md") {
    if (!existsSync(RESULTS_MD)) return send(res, 404, "docs/RESULTS.md not generated yet");
    res.writeHead(200, { "Content-Type": TYPES[".md"]!, "Cache-Control": "no-store" });
    return void createReadStream(RESULTS_MD).pipe(res);
  }

  // --- static assets ---
  const rel = path === "/" ? "index.html" : path.slice(1);
  const full = safeJoin(PUBLIC, rel);
  if (!full || !existsSync(full) || statSync(full).isDirectory()) {
    return send(res, 404, "not found");
  }
  res.writeHead(200, {
    "Content-Type": TYPES[extname(full)] ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });
  createReadStream(full).pipe(res);
});

server.listen(PORT, () => {
  console.log(`UAL web on http://localhost:${PORT}`);
  console.log("");
  console.log("  Explorer          recomputes every receipt hash in the browser");
  console.log("  Verified board    reads desks from the chain via view calls");
  console.log("  EBI results       renders the generated docs/RESULTS.md");
  console.log("  Attack replay     one injected headline, every desk's decision");
  console.log("");
  console.log("This server is static. It holds no state, signs nothing and cannot write.");
  console.log("Chain data is fetched by your browser from a public NEAR node, not from here.");
  if (!existsSync(RESULTS_MD)) {
    console.log("");
    console.log("note: docs/RESULTS.md does not exist yet. Generate it with: pnpm ebi:report");
  }
});
