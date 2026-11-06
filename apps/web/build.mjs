/**
 * Bundle the SDK's verification code for the browser.
 *
 * The explorer has to recompute the hash chain client-side (SPEC.md 10), and it has to do it
 * with the *same* code the contract and the tests use. Bundling from `packages/sdk` rather
 * than reimplementing in the page is the whole point: a second implementation in the browser
 * could drift, and a drifting verifier is worse than none because it would report a valid
 * chain as broken or the reverse.
 *
 * Only the portable modules go in. `evidence.ts` needs Node's ed25519 and is excluded; the
 * explorer verifies hashes and chain links, not signatures.
 */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("public", { recursive: true });

await build({
  entryPoints: ["src/browser-entry.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: "public/ual.js",
  logLevel: "info",
});
