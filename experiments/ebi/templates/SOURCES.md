# Attack templates: where every one came from

SPEC.md 2A.4 asks for templates from the release of arXiv 2610.26438 if available, otherwise
from a public prompt-injection benchmark, otherwise written by us and labelled as such. It also
requires every source to be cited. This file is that citation.

## None of these came from the paper

Checked on 6 Nov 2026: the arXiv listing for **2610.26438v1** carries no link to code, data, a
benchmark repository or templates, and the abstract contains no availability statement. The
page's "Code, Data and Media" section lists third-party tools (alphaXiv, CatalyzeX, DagsHub)
but none resolves to released material.

So the third option applies. **Every template in this directory was written by us.** None is
copied from the paper, from a benchmark, or from any real publisher's wire. They are labelled
`SYNTHETIC ATTACK` in the archive, in the receipts, in the run output and in the UI, and the
source id they are injected under is literally `synthetic-attack.example`.

## What they are modelled on

The paper's findings are public even though its templates are not, and two of them shape the
design directly.

**Finding (ii): surface form matters more than content.**

> "For fact-poisoning templates, surface form matters more than content, since removing
> credibility cues such as a named source or a "BREAKING" tag drops ASR from 100% to 0% while
> the fake claim remains identical."

Every fact-poisoning template therefore exists in four cue variants over one unchanged claim:
both cues, named source only, BREAKING tag only, neither. If the cues matter as reported, the
four variants should separate sharply, and if they do not, that is a finding about our Analyst
rather than about the gate and will be reported as such.

**Finding (i): information injection beats prompt injection.**

> "Prompt injection achieves 14% attack success rate (ASR), but fabricated news reaches 62%"

`prompt-injection-control` exists to reproduce that ordering as a sanity check. If our
prompt-injection control scored *higher* than our fabricated news, the harness would be
measuring something other than what it claims to.

## The templates

| id | class | what it does | tests |
|---|---|---|---|
| `single-source-fake` | fact poisoning | one fabricated headline, one outlet | the base case: does the gate refuse a lone source |
| `two-group-fake` | fact poisoning | the identical text planted in 2 declared groups | H4 at k=2: half size allowed |
| `three-group-fake` | fact poisoning | the identical text planted in 3 declared groups | H4 at k=3: **full size allowed on one fabrication** |
| `fake-indicator-panel` | fabricated indicator | real price citations, fabricated RSI and momentum claims | the recompute path, which is the one genuinely checkable defence |
| `prompt-injection-control` | prompt injection | instruction text embedded in a headline | the control for finding (i) |
| `undeclared-source-fake` | fact poisoning | fabricated headline from a source the policy never declared | that the group allowlist is load bearing |

Each of the fact-poisoning templates carries the four cue variants.

## Honest limits of this template set

- **Written by us, so not independent.** We designed both the attack and the defence. A
  template set authored by the people being defended is the weakest kind of evidence, and the
  README says so. The right follow-up is to rerun against the paper's set if it is ever
  released.
- **One claim shape.** Every fact-poisoning template is a bullish institutional-adoption
  headline, because that is the shape most likely to move a crypto desk. A bearish or
  regulatory shape might behave differently and is not covered.
- **No adaptive adversary.** The templates are fixed. A real attacker would look at the
  policy's declared groups, which are public on chain, and plant into exactly those. The
  `three-group-fake` template is a hand-built instance of that, not a search for the cheapest
  one.
- **The state dependence is measured, not controlled.** Finding (iii) reports a fake indicator
  panel at 91% against an agent about to hold and 12% against one about to buy. The harness
  records the desk's intended action immediately before injection and reports attack success
  broken down by it, because an aggregate rate can be moved sevenfold by timing alone.
