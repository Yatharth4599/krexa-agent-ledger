# Threat model

SPEC.md 15, with what the build actually does and what it actually does not. The residual-risk
column is the honest part: several rows have no mitigation at all, and saying so is more useful
than a table where everything is handled.

Three things are true of the whole system before any row below:

- **Unaudited.** Testnet only. Nobody has reviewed this contract for security.
- **Every receipt says `attested: false`.** There is no TEE in this build
  ([docs/TEE.md](TEE.md)), so no claim about attested provenance holds anywhere.
- **The owner is the trust root.** A compromised owner key can commit a new policy with any
  limits it likes. Nothing in the design constrains the owner, and nothing could: the owner is
  who the policy belongs to.

## What is actually enforced, and by whom

The distinction matters more than the list. Two different things are doing the work:

| Enforced by | What that means | What it covers |
|---|---|---|
| **The NEAR protocol** | Rejected before any contract code runs. A bug in our contract would not help an attacker. | the agent's function-call key: one contract, four methods, no transfer, no key management |
| **The contract** | Refused by the committed policy, and **recorded as a receipt** | position caps, daily loss, allowlists, the evidence gate, the kill switch, paper and live labels |
| **Nothing** | Stated below as residual risk | the rows marked "no mitigation" |

`docs/attack-demo.log` is a run of a fully compromised Trader against a real node: 9 protocol
refusals, 3 policy refusals recorded as receipts, and a closing section on what it does not
prove. `tests/integration/tests/fc_keys.rs` has the same denials as 12 tests.

## The table

| Threat | Mitigation in this build | Residual risk |
|---|---|---|
| Prompt-injected or buggy agent tries an oversized or disallowed trade | Contract policy check; REJECTED receipt with reasons; the SDK pre-check reports the same verdict before a transaction is spent | None for the ledger. In live mode the venue must also obey, and venue keys must be trade-only |
| Agent tries to withdraw, transfer, or call an owner method | No withdraw method exists anywhere in the contract. The agent's key is a function-call key scoped to one contract and four methods, so the protocol refuses before any code runs | The key's gas allowance is finite. Exhausting it locks the agent out until the owner issues a new key, which is a denial of service with no automatic recovery |
| Agent tries to grant itself a better key | AddKey is not a function call, so the function-call permission does not cover it | None, assuming the account holds no full-access key. If one is left on the account, every other row in this section is void |
| Agent reaches a different contract | The key's `receiver_id` is pinned, so even the same code redeployed elsewhere is out of reach | None |
| Monitor is prompt-injected into not firing | The Monitor contains no LLM call. It is a rule, so there is no text for an injection to live in | A rule can only fire on what it was written to watch. An attack shaped to avoid all five triggers is not caught |
| Monitor is subverted into releasing the brake | `release_kill_switch` is owner-only in the contract and absent from the Monitor's key | None |
| Operator fakes paper fills or equity | Paper is labelled on chain by the contract, not by the caller, and shown separately. Fills carry an evidence hash | **Paper equity is operator-reported. It is not proof of anything except the operator's commitment over time.** No mitigation, by construction |
| Operator fakes live fills | Live fills must reference settlement (1Click status, Hyperliquid fill, Polygon tx) from a `venueAccounts` address hashed into the policy | Off-chain fills with no venue signature cannot be proven. Shown as UNVERIFIED rather than assumed good. Not exercised: this build never runs live |
| Operator trades from an undeclared wallet and ledgers only winners | `venueAccounts` is hashed into the policy, so a reconciliation against public venue data is possible | A fully separate unledgered strategy is invisible. **No mitigation.** SPEC.md 1.1 says so too: UAL makes ledgered records more credible, not unledgered ones less so |
| Cherry-picking by spinning up many desks | `get_desks_by_owner` lists them all, retired ones included, and K in the multiple-testing threshold counts the owner's other desks | An owner can use a different NEAR account. **No mitigation** |
| Chain rewrite or deletion | Append-only. No delete method. Head check on every write. Anyone can recompute the hashes, including in the browser | The contract account's full-access key can redeploy new code. Not upgradable via any method, but a redeploy is still possible. Disclosed, not solved: lock the key after the hackathon |
| Fake headline or indicator panel injected into agent context | Citations required; indicators recomputed from cited raw prices and dropped if they do not match; size by independent-group count | **The gate does not detect fake news.** It demands that independent groups agree. One fake planted across three declared groups earns full size, measured in experiments/ebi/FINDINGS.md. The declared groups are public on chain, so an attacker knows exactly which sources to reach |
| Stance on a news item is mislabelled | For PRICE items the stance is recomputed from the bytes. For NEWS it cannot be: a deterministic function cannot read a headline | The verifier records NEWS stance as `declared` rather than `recomputed`, so a reader can see it was not checked. A dishonest operator can mislabel stance on their own desk. **No mitigation**, and none is possible without putting an LLM in the verifier, which is the thing an injection would attack |
| Fetcher key stolen | Keys are revocable, and revocation is a CONTROL receipt | A stolen key has perfectly good provenance. The gate checks who signed, not whether they should have. **No mitigation** until revocation |
| Fetcher not really in a TEE | The attestation hash is recorded, and 64 zeros is the explicit declaration of "not attested" | **There is no TEE in this build.** Every receipt says `attested: false`. The row is listed so it is not forgotten, not because it is handled |
| Reasoning faked after the fact | `decisionHash` is committed before the fill; `decisionsRoot` covers holds, so an agent cannot later claim whichever hold flattered it | Hashes prove commitment, not correctness. **Not zkML.** The model id is self-reported: this build does not verify NEAR AI Cloud signatures, so `aiSig.verified` is always false |
| Strategy leakage, since intents are public | Paper by default | Live intents would be public on chain. No mitigation in this build, and the stretch in SPEC.md 12A that would address it was cut |
| Look-ahead bias in evaluation | Decision points are built only from snapshots dated at or before the point, with an assertion that fails the run otherwise | 7 days of data cannot show skill whatever the methodology |
| Contract bugs | 67 unit tests, 15 sandbox integration tests, differential tests against the TypeScript pre-check, and cross-language test vectors | **Unaudited.** Testnet only |
| The SDK pre-check disagrees with the contract | The same reject cases run against both, from the same vectors. The float-syntax asymmetry between Rust and JavaScript was found this way and is handled in `parseCanonicalJson` | A pre-check that disagreed would send transactions doomed to fail, or refuse policies the chain would accept. Covered by tests, not by proof |
| The browser verifier disagrees with the contract | The page bundles the SDK rather than reimplementing. One SHA-256 implementation, pinned by Rust-generated vectors | A drifting verifier would call a valid chain broken or the reverse, which is worse than no verifier |

## The five Monitor triggers, and what each misses

| Trigger | Fires on | Misses |
|---|---|---|
| `DAILY_LOSS` | UTC-day loss reaching the committed limit | a slow bleed across days |
| `STALE_EVIDENCE` | an open position with no fresh evidence | a flat desk, deliberately: a desk not trading needs no brake |
| `VERIFIER_FAILURE_SPIKE` | more than half of citations failing over 8 decisions | a steady low rate of failures |
| `ATTACK_SUSPECT` | 3 or more desks citing one single-group item in a window | a fake planted widely enough to look corroborated, which is the H4 case |
| `CHAIN_MISMATCH` | the local head disagreeing with the chain | nothing, but it is a symptom rather than an attack |

## What would change the picture

Honestly, in rough order of how much:

1. **A working TEE fetch.** It would close the gap where an operator fabricates evidence and
   signs it as fetched. It would still prove nothing about truth.
2. **Source independence that is checked rather than declared.** Right now independence is the
   owner's judgement, published on chain for an attacker to read. Deriving it from ownership
   data would make the H4 attack materially harder.
3. **Verified model signatures.** Would turn the self-reported model id into a checked one.
4. **An audit.** Everything above assumes the contract does what its tests say.
