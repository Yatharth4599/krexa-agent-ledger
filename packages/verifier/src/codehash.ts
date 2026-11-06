/**
 * The verifier's own code hash, which the policy pins as `evidence.verifierCodeHash`.
 *
 * SPEC.md 2A.2 item 3 requires the verifier's code hash to be part of the hashed policy, so a
 * bundle can be tied to the exact build that produced it. The contract refuses a bundle whose
 * `verifierCodeHash` is not the one the policy names (E13_BAD_HASH), which means changing the
 * verifier's logic invalidates every policy that pinned the old one. That is the intended
 * friction: the stance assignments and indicator tolerances in this package are part of the
 * rules a desk committed to, not an implementation detail to be swapped silently.
 *
 * Computed over the source files rather than a bundler's output, so it is reproducible with
 * nothing but this repo and sha256.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { sha256Hex } from "@krexa-ual/sdk";

/** Source files that define verifier behaviour, in a fixed order. */
export const HASHED_FILES = ["extract.ts", "indicators.ts", "verify.ts"] as const;

/**
 * Hash of the verifier's behavioural source.
 *
 * `codehash.ts` itself is excluded: it describes how the hash is taken and contains no
 * verification logic, so including it would make the hash change whenever this comment did.
 */
export function computeVerifierCodeHash(srcDir = dirname(new URL(import.meta.url).pathname)): string {
  const present = new Set(readdirSync(srcDir));
  const parts: string[] = [];
  for (const file of HASHED_FILES) {
    if (!present.has(file)) {
      throw new Error(`verifier source file ${file} is missing from ${srcDir}`);
    }
    const body = readFileSync(join(srcDir, file), "utf8");
    // Name and length are included so that moving code between files changes the hash.
    parts.push(`${file}:${Buffer.byteLength(body)}:${sha256Hex(body)}`);
  }
  return sha256Hex(parts.join("\n"));
}
