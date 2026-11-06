/**
 * `@krexa-ual/sdk`
 *
 * M1 surface: canonical JSON, hashing and offline chain verification. The on-chain calls
 * (`createDesk`, `commitPolicy`, `submitEvidence`, `submitIntent`, `recordFill`,
 * `recordMark`, `killSwitch`, `getRecord`) land in M2, per SPEC.md 8.1.
 */

export {
  canonical,
  canonicalHash,
  parseCanonicalJson,
  assertNoFloatOrOversizedNumberSyntax,
  assertPolicyBytesCanonical,
  sha256Hex,
  genesisHash,
  isHex64,
  isPrintableAscii,
  CanonicalError,
  MAX_SAFE_INTEGER,
  type CanonicalErrorCode,
} from "./canonical.js";

export {
  receiptHash,
  receiptHashValid,
  verifyChain,
  type ChainResult,
  type Receipt,
  type ReceiptKind,
  type Mode,
  type Verdict,
} from "./receipts.js";
