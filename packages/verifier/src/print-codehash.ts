/** `pnpm verifier:codehash`: print the hash a policy must pin. */
import { computeVerifierCodeHash } from "./codehash.js";

const hash = computeVerifierCodeHash();
console.log(hash);
console.error("");
console.error("Put this in a policy as evidence.verifierCodeHash.");
console.error("Changing extract.ts, indicators.ts or verify.ts changes this hash, which");
console.error("invalidates every policy that pinned the old one. That friction is deliberate:");
console.error("the stance rules and tolerances are part of what a desk committed to.");
