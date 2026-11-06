# The TEE fetch path: what we checked, and what we shipped

SPEC.md 2A.2 item 2 wants the evidence fetcher running inside an attested enclave, so that
each item is signed by a key generated in the enclave and the owner can verify an attestation
before registering that key. The plan allowed half a day for this and named a fallback.

**Outcome: shipped the signed local fetcher, labelled `attested: false`.** This is SPEC.md
cut-line 7, taken deliberately rather than by running out of time.

## What was checked, on 6 Nov 2026

### NEAR AI Cloud: not applicable

`docs.near.ai/cloud/verification` and `docs.near.ai/llms.txt` describe TEE attestation for
**model inference served by the gateway**: gateway attestation, per-model attestation, TLS
termination inside the enclave, and per-response signatures. The specialized endpoints page
lists what runs inside the TEE as "embeddings, reranking, image generation, audio
transcription, and PII detection".

Nothing in the documentation offers arbitrary code execution, a container runtime, a sandbox,
or outbound HTTP requests from inside the enclave. The product is scoped to inference on
models NEAR AI hosts.

So NEAR AI Cloud can attest **that a given model produced a given output**, which is useful
for the `aiSigHash` field on a DecisionRecord (SPEC.md 3.6) and is a separate matter. It
cannot attest that a fetch happened. The feasibility note in SPEC.md 2A.2 asked for this to
be checked on D2; it has been, and the answer is no.

### OutLayer: plausible, not adopted in this build

`app.outlayer.ai/docs/getting-started` documents TEE execution of arbitrary WebAssembly with
an attestation over three things: a SHA-256 of the exact WASM binary, a SHA-256 of the input,
and the output produced by that code on that input, plus worker identity from TEE
measurements. A NEAR testnet example (`outlayer.testnet`) appears in the docs.

That is the right shape for this problem. Two things stopped it being adopted now:

1. **Outbound HTTP from inside the enclave is implied, not documented.** The overview lists
   "HTTP requests" among the things the platform is for, but the getting-started material does
   not state that a WASM job may open a connection from inside the TEE, nor what the
   attestation says about the remote peer. That is the exact property the evidence fetcher
   needs, so assuming it would have been guessing.
2. **Onboarding cost is unknown.** The docs do not state whether there is a free tier, whether
   an API key or deposit or allowlist is needed, or how long a first job takes. With the
   schedule already a day behind, spending the remaining half-day budget on an unknown
   onboarding path risked the never-cut list in SPEC.md 18.

Recorded as the recommended path for after the hackathon. It is not claimed as integrated,
per SPEC.md 16: this build does not call OutLayer at all.

## What shipped instead

`apps/fetcher` with a local ed25519 key:

- `pnpm fetcher:keygen` generates a 32 byte seed. It goes in `.env`, which is gitignored.
- The owner registers the public half with `register_fetcher(desk, pubkey, attestation_hash, label)`
  passing an `attestation_hash` of **64 zeros**.
- The contract treats 64 zeros as the declaration that this fetcher is not attested, and every
  EVIDENCE receipt downstream of it carries `attested: false`.
- `pnpm fetcher:once` fetches live and signs; `pnpm fetcher:from-archive` signs the archived
  snapshot with the archive's own timestamp, which is how the replay harness reconstructs
  evidence for a past decision point without look-ahead.

The 64 zeros are not a placeholder to be quietly swapped. They are load bearing: a reader of
any receipt can tell whether the evidence behind it came from an attested fetcher, and in this
build the honest answer is no.

## What a working TEE fetch would and would not prove

Worth being precise, because this is the part most easily oversold.

**Would prove:** that a specific, hash-identified piece of code ran, that it was given a
specific URL, and that it returned specific bytes, with a key that never left the enclave. If
TLS is terminated inside the enclave, it would also bind those bytes to the domain that served
them. That is a real and useful property: it closes the gap where an operator fabricates a
headline and signs it as though it had been fetched.

**Would not prove:** that the content is true. A TEE attests transport and execution, not
accuracy. If a publisher prints something false, an attested fetch records a false thing
faithfully.

This is why the gate does not rest on attestation alone. Corroboration across independent
groups is the part that addresses content, and SPEC.md 2A.6 H4 states the limit of that too:
an attacker who plants the same fake across several declared groups raises k legitimately and
the gate lets the trade through. Both limits are measured in M4 rather than argued away.

## Consequence for the results

Every receipt this build produces will read `attested: false`. The README and
`docs/RESULTS.md` must say so next to any number derived from them, and no claim of attested
provenance may appear anywhere. The threat-model row in SPEC.md 15 for "fetcher key stolen or
fetcher not really in a TEE" applies in full: the residual risk is real and undiminished,
because in this build there is no attestation to diminish it.
