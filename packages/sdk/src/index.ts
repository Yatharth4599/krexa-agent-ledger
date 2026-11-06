/**
 * `@krexa-ual/sdk`
 *
 * Canonical JSON and hashing, offline chain verification, policy validation, evidence
 * signing, and the ledger client. SPEC.md 8.1.
 *
 * The client's transport is injected (`LedgerCaller`), so this package depends on no NEAR
 * library. Anyone who only wants to recheck a hash chain can install it and do so.
 */

export {
  assertNoFloatOrOversizedNumberSyntax,
  assertPolicyBytesCanonical,
  canonical,
  canonicalHash,
  CanonicalError,
  genesisHash,
  isHex64,
  isPrintableAscii,
  MAX_SAFE_INTEGER,
  parseCanonicalJson,
  sha256Hex,
  type CanonicalErrorCode,
} from "./canonical.js";

export { base58Decode, base58Encode } from "./base58.js";

export {
  receiptHash,
  receiptHashValid,
  verifyChain,
  type ChainResult,
  type Mode,
  type Receipt,
  type ReceiptKind,
  type Verdict,
} from "./receipts.js";

export {
  groupForSource,
  isValidDeskId,
  minKForNonZero,
  precheckPolicyJson,
  serializePolicy,
  sizeMultiplierBps,
  validatePolicy,
  type EvidenceBlock,
  type EvidenceGroup,
  type Policy,
  type PolicyMode,
  type Venue,
  type VenueAccount,
} from "./policy.js";

export {
  buildEvidencePayload,
  bundleHash,
  contentHashOf,
  generateFetcherKey,
  MAX_BUNDLE_ITEMS,
  publicKeyFromSeed,
  signEvidenceItem,
  signingBytes,
  signingString,
  verifyEvidenceItem,
  type Direction,
  type EvidenceBundle,
  type EvidenceItemKind,
  type EvidencePayload,
  type FetcherKeyPair,
  type SignedEvidenceItem,
  type Stance,
} from "./evidence.js";

export {
  canonicalOf,
  DEFAULT_GAS,
  UalClient,
  type CallOptions,
  type FillKind,
  type FillRef,
  type Intent,
  type LedgerCaller,
  type PrecheckFinding,
  type Side,
} from "./client.js";

/** 64 zeros: the honest declaration that a fetcher is not running in an attested enclave. */
export const UNATTESTED = "0".repeat(64);
