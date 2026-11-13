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

import { createReadStream, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { pipeline } from "node:stream";
import { pathToFileURL } from "node:url";

const REPO = resolve(join(import.meta.dirname, "..", "..", ".."));
const PUBLIC = join(import.meta.dirname, "..", "public");
const RESULTS = join(REPO, "experiments", "ebi", "results");
const RESULTS_MD = join(REPO, "docs", "RESULTS.md");
const PORT = Number(process.env.PORT ?? 3000);
// Loopback by default: this is a local explorer, and the run files it serves are not meant
// for the LAN. Set HOST=0.0.0.0 to opt in.
const HOST = process.env.HOST ?? "127.0.0.1";

/**
 * The page's only network origins: itself, and the NEAR JSON-RPC nodes in the network
 * `<select>` in index.html (testnet, local sandbox), plus mainnet. app.js fetches nothing else,
 * and there are no inline scripts or styles.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; connect-src 'self' https://rpc.testnet.near.org " +
    "https://rpc.mainnet.near.org http://localhost:3030 http://127.0.0.1:3030; " +
    "frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

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

/**
 * A regular file under `root`, or undefined. `safeJoin` is lexical, so a symlink inside the
 * root that points at `/etc/passwd` passes it; the real path has to be checked as well. Any
 * stat error (dangling symlink, EACCES, ELOOP) means "not found", not an uncaught throw.
 */
function resolveFile(root: string, requestPath: string): string | undefined {
  const full = safeJoin(root, requestPath);
  if (!full) return undefined;
  try {
    if (!statSync(full).isFile()) return undefined;
    const real = realpathSync(full);
    return real.startsWith(realpathSync(root) + sep) ? real : undefined;
  } catch {
    return undefined;
  }
}

function send(res: ServerResponse, code: number, body: string, type = "text/plain; charset=utf-8"): void {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function sendFile(res: ServerResponse, full: string, type: string): void {
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
  // pipeline, not .pipe(): a read error (EACCES, file removed mid-read) must not surface as an
  // uncaught 'error' event on the stream.
  pipeline(createReadStream(full), res, () => {});
}

export interface Dirs {
  publicDir: string;
  resultsDir: string;
  resultsMd: string;
}

export function createApp(dirs: Dirs): Server {
  return createServer((req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

    let path: string;
    try {
      path = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      return send(res, 400, "bad request");
    }

    if (req.method !== "GET") return send(res, 405, "read only");

    // --- list the local runs ---
    if (path === "/data/runs") {
      if (!existsSync(dirs.resultsDir)) return send(res, 200, "[]", TYPES[".json"]!);
      const runs = readdirSync(dirs.resultsDir)
        .filter((d) => {
          try {
            const p = join(dirs.resultsDir, d);
            return statSync(p).isDirectory() && realpathSync(p).startsWith(realpathSync(dirs.resultsDir) + sep);
          } catch {
            return false; // dangling symlink
          }
        })
        .sort();
      return send(res, 200, JSON.stringify(runs), TYPES[".json"]!);
    }

    // --- a file inside a run ---
    if (path.startsWith("/data/runs/")) {
      const full = resolveFile(dirs.resultsDir, path.slice("/data/runs/".length));
      if (!full) return send(res, 404, "not found");
      return sendFile(res, full, TYPES[extname(full)] ?? "application/octet-stream");
    }

    // --- the generated results document ---
    if (path === "/data/results-md") {
      try {
        if (!statSync(dirs.resultsMd).isFile()) throw new Error("not a file");
      } catch {
        return send(res, 404, "docs/RESULTS.md not generated yet");
      }
      return sendFile(res, dirs.resultsMd, TYPES[".md"]!);
    }

    // --- static assets ---
    const full = resolveFile(dirs.publicDir, path === "/" ? "index.html" : path.slice(1));
    if (!full) return send(res, 404, "not found");
    sendFile(res, full, TYPES[extname(full)] ?? "application/octet-stream");
  });
}

// Only listen when run as a script, so the test can start its own instance on port 0.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApp({ publicDir: PUBLIC, resultsDir: RESULTS, resultsMd: RESULTS_MD }).listen(PORT, HOST, () => {
    console.log(`UAL web on http://${HOST}:${PORT}`);
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
}
