# Prior work: the quotes, checked

SPEC.md 2A.1 relays two numeric claims and marks them "claims as relayed by YK, not verified
by us", with an instruction to read both papers and quote them exactly or drop the numbers.
Both have now been checked against the arXiv abstracts, on 6 Nov 2026. Both hold, and one of
them has a consequence for our own hypotheses that is worth stating plainly.

Both papers are by the same two authors, **Mengxiao Wang and Nitesh Saxena**. That is worth
knowing when citing them as two independent confirmations of anything: they are not
independent.

## arXiv 2610.26438

**"Fake News, Real Crashes: Information Injection Attacks on LLM Financial Trading Agents"**,
Mengxiao Wang and Nitesh Saxena, submitted 19 October 2026.

The numbers SPEC.md 2A.1 relays are correct. Quoted from the abstract, finding (i):

> "Prompt injection achieves 14% attack success rate (ASR), but fabricated news reaches 62%
> and two 30-word templates reach 100% on all 15 stocks, inverting the usual LLM-security
> intuition."

So "about 62% versus about 14%" is accurate and may be used, with the citation. Three further
findings from the same abstract matter for our design:

> "(ii) For fact-poisoning templates, surface form matters more than content, since removing
> credibility cues such as a named source or a "BREAKING" tag drops ASR from 100% to 0% while
> the fake claim remains identical."

> "(iii) Success depends on the agent's state, with a fake indicator panel scoring 91% against
> an agent about to hold but 12% against one about to buy."

> "(v) Most attacks evade standard defenses, since model scaling stops shallow vectors but not
> fact poisoning, peer debate fails, and only hierarchical aggregation reduces ASR."

### Consequence 1: our H2 is partly contradicted by the work we cite

SPEC.md 2A.6 states:

> "H2: `debate` and `hier` do not reliably reduce ASR, because all Analysts read the same
> poisoned context."

Finding (v) agrees about debate and disagrees about hierarchical aggregation: "peer debate
fails, and **only hierarchical aggregation reduces ASR**". Publishing H2 as written would mean
predicting the opposite of the paper we are citing as motivation, without saying so.

H2 is therefore restated for this build:

- **H2a**: `debate` does not reliably reduce ASR. This agrees with prior work and we expect to
  reproduce it.
- **H2b**: `hier` **does** reduce ASR relative to `plain`, per finding (v). The open question
  is not whether it helps but whether the evidence gate helps more, and whether the two
  compose.

This makes the study more demanding rather than less. The interesting comparison is no longer
`ebi` against `plain`, which prior work already suggests is easy. It is `ebi` against `hier`,
the one defence the literature reports as working.

### Consequence 2: `hier` should move down the cut-line list

SPEC.md 18 cut-line 5 drops the `hier` desk, keeping `plain`, `debate`, `ebi` and `bh`. Given
finding (v), `hier` is the strongest published baseline, and dropping it would leave the
results comparing the gate only against defences the literature already reports as failing.
That is the comparison most likely to flatter us.

Recommendation, for YK: move `hier` above `debate` in priority. If something has to go, drop
`debate`, whose negative result is already published, and keep `hier`, whose result we would
otherwise be taking on trust.

### Consequence 3: the attack injector must record agent state

Finding (iii) reports a fake indicator panel at 91% against an agent about to hold and 12%
against one about to buy, a seven-fold difference from the agent's state alone. An ASR number
reported without the state distribution is close to meaningless, because it can be moved that
far by when the attack lands.

So `experiments/ebi` records the desk's intended action immediately before injection, and the
scorecard reports ASR broken down by prior state as well as in aggregate.

### Consequence 4: different asset class

The benchmark covers "~10,000 decisions on 15 U.S. stocks". This build trades crypto perps on
Hyperliquid. News flow, halt rules and the absence of a closing auction all differ, so their
ASR figures are context for the problem and not a baseline our numbers can be compared
against. The README must not place our ASR next to theirs as if they measured the same thing.

### Attack templates are not available

SPEC.md 2A.4 prefers "the templates released with arXiv 2610.26438 if available". Checked on
6 Nov 2026: the arXiv listing for 2610.26438v1 has no link to code, data, a benchmark
repository or templates, and the abstract contains no availability statement.

So the fallback applies: templates are written by us and labelled as such, with the two
structural cues finding (ii) identifies (a named source and a "BREAKING" tag) varied
deliberately, since the paper reports those cues alone move ASR from 100% to 0%.
`experiments/ebi/templates/SOURCES.md` will state the provenance of every template and that
none came from the paper.

## arXiv 2609.19705

**"Trading Agents or Market Crashers? Dissecting Robustness and Security Failures in Academic
Financial LLM Trading Schemes"**, Mengxiao Wang and Nitesh Saxena, submitted 17 September 2026.

SPEC.md 2A.1 relays this as "none of the 15 published trading-agent schemes it reviewed
combines source provenance with cross-source corroboration". The abstract says:

> "Across 15 academic schemes, no paper describes a halt that skips LLM inference or combines
> source provenance with cross-source corroboration, and the 7 code releases enforce no
> stop-loss or position limit outside the LLM."

The relayed version is accurate on corroboration but drops half the sentence. The full claim
is a disjunction covering two gaps: no scheme has a halt that skips LLM inference, **and** no
scheme combines provenance with corroboration. Quote the whole sentence, not the fragment.

### This paper's recommendations are what UAL built

The closing sentence of the abstract:

> "We derive 14 open problems and urge deployers to corroborate sources, keep interrupts that
> bypass the model, and enforce loss limits outside it."

All three map onto components of this build:

| FARSIGHT recommendation | Where it is in this repo |
|---|---|
| "corroborate sources" | the evidence gate: independence groups, net k, size table |
| "keep interrupts that bypass the model" | the Monitor, which is rule-based and contains no LLM call, holding a key scoped to `engage_kill_switch` and unable to release it |
| "enforce loss limits outside it" | policy limits enforced in the contract, not in the agent: `maxPositionUsd`, `dailyLossLimitUsd`, `maxOpenPositions` |

This is the honest framing of the contribution, and it is a smaller claim than novelty: the
gaps were named by someone else and this build closes them in one concrete, auditable way on a
public chain. Nothing here is a first, and the README says so.

## What may now be written

Permitted, with citation:

- "arXiv 2610.26438 reports prompt injection at 14% ASR and fabricated news at 62%, with two
  30-word templates reaching 100% on all 15 stocks."
- "arXiv 2609.19705 reports that across 15 academic schemes, no paper describes a halt that
  skips LLM inference or combines source provenance with cross-source corroboration."

Not permitted:

- Citing the two as independent corroboration of each other. Same two authors.
- Comparing our ASR to their 62% as though both measured the same thing. Different asset
  class, different decision cadence, different agents.
- Any claim that this build is the first to combine provenance with corroboration. The cited
  survey says no *academic scheme* did; it says nothing about products, and SPEC.md 13 lists
  several adjacent ones.
