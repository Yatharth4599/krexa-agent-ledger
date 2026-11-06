/**
 * What the page is allowed to use.
 *
 * Deliberately narrow: canonical form, hashing, receipt hashing and chain verification. These
 * are the same functions the contract mirrors and the test vectors pin, so a chain this page
 * calls valid is valid by the same rule the chain itself used.
 *
 * Imported from the individual modules rather than from the package barrel on purpose. The
 * barrel re-exports `evidence.ts`, which needs Node's ed25519 and does not bundle for a
 * browser. The explorer verifies hashes and chain links, not signatures, so it needs none of
 * that, and importing narrowly keeps the bundle to what is actually portable.
 */
export {
  canonical,
  canonicalHash,
  genesisHash,
  sha256Hex,
} from "../../../packages/sdk/src/canonical.js";

export {
  receiptHash,
  receiptHashValid,
  verifyChain,
  type ChainResult,
  type Receipt,
} from "../../../packages/sdk/src/receipts.js";
