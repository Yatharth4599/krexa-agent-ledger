# LLM budget for the full runs

SPEC.md 2A.4 and the M4 acceptance both require this estimate before the M5 runs start, and
require YK to approve it. **Nothing in this file has been spent. No LLM call has been made
anywhere in this repo to date.**

Everything measured so far ran with scripted Analysts, which cost nothing, so the numbers below
are an estimate built from measured token counts rather than from a guess about prompt sizes.

## What is actually being bought

The scripted Analysts already produce the full pipeline: decisions, receipts, the gate, the
attack accounting. Paying for LLM calls buys one thing, and it is worth being precise about it:
**evidence that the result holds for a model that reads language, rather than for a rule that
keys on two regex cues.**

That is a real gap. The scripted Analyst is a model of the vulnerability (see the header of
`apps/runtime/src/analyst.ts`), and a sceptical reader is right to say that attacking a regex
proves little about attacking GPT-class models. The LLM runs close that gap and nothing else.

## Measured token counts

From the prompts the harness already builds, counted with a 4-characters-per-token
approximation on real archived snapshots:

| Item | Characters | Tokens (approx) |
|---|---|---|
| `plain` / `ebi` prompt, 4 price sources, no news | 1,850 | 460 |
| `plain` / `ebi` prompt, with one injected headline | 1,940 | 485 |
| `debate` prompt (3 panel prompts concatenated) | 5,700 | 1,425 |
| `hier` prompt (3 specialist prompts concatenated) | 5,500 | 1,375 |
| Expected completion (thesis, order, citations as JSON) | 600 | 150 |

A real prompt would add a system message and a response schema, so round the single-Analyst
input to **600 tokens** and the completion to **200**.

## Decisions per full run

SPEC.md 2A.4 asks for about 2,000 to 5,000 paper decisions across 2 models.

Per decision point, per desk, the harness makes **two** Analyst calls at attacked points: one
on clean evidence and one on attacked, because finding (iii) makes the prior state necessary
rather than optional. At clean points it makes one.

With an attack rate of 10%:

- LLM desks: `plain`, `debate`, `hier`, `ebi` (4 desks; `bh` makes no calls)
- Analyst calls per desk per point: 1.1 average
- `debate` and `hier` each make 3 internal Analyst calls per decision

Weighted calls per decision point, per model:

| Desk | Analyst calls per point | Tokens in | Tokens out |
|---|---|---|---|
| `plain` | 1.1 | 660 | 220 |
| `ebi` | 1.1 | 660 | 220 |
| `debate` | 3.3 | 1,980 | 660 |
| `hier` | 3.3 | 1,980 | 660 |
| **total per point** | **8.8** | **5,280** | **1,760** |

## Cost

At 2,000 decision points per model (the low end of SPEC.md's range):

| | per model | 2 models |
|---|---|---|
| Analyst calls | 17,600 | 35,200 |
| Input tokens | 10.6M | 21.1M |
| Output tokens | 3.5M | 7.0M |

Priced against mid-tier hosted model rates, which is the right band for the NEAR AI Cloud
models SPEC.md 7 prefers:

| Rate assumption | 2 models, 2,000 points | 2 models, 5,000 points |
|---|---|---|
| $0.15 / $0.60 per 1M (cheap tier) | **$7.40** | **$18.50** |
| $1.00 / $3.00 per 1M (mid tier) | **$42.10** | **$105.30** |
| $3.00 / $15.00 per 1M (frontier) | **$168.30** | **$420.80** |

## Recommended plan, and the hard cap

**Recommendation: approve $60, run 2 models over 2,000 points on a mid-tier model.**

That lands around $42 at the mid-tier rate with roughly 40% headroom for retries, a longer
prompt than estimated, and the system message. It satisfies the low end of SPEC.md 2A.4's
range, which is the honest target given the archive window (see below).

The runner will take `LLM_DAILY_BUDGET_USD` from `.env`, refuse to start without it, count
tokens as it goes, and **stop** at the cap rather than overshooting. If it stops early the
results are reported as partial, with the decision count reached, as SPEC.md M5 requires.

## Two things that constrain this regardless of budget

1. **The archive window is shorter than planned.** Recording started 6 Nov, not 5 Nov, so the
   replay window is about 7 days. At 15 minute points that is roughly 670 points of real
   market data. Running 2,000 *distinct* points is therefore not possible from this archive:
   the options are 670 points per model (about $14 at mid tier), or reusing points with
   different attack cases, which is not 2,000 independent observations and must not be
   reported as though it were.

   **This changes what SPEC.md 2A.4 can deliver, and it is YK's call.** My recommendation is to
   report roughly 670 points per model honestly, with the decision count stated, rather than
   inflating the denominator by replaying the same point under different templates and
   counting each as an observation.

2. **Nothing here buys statistical significance on returns.** The skill verdict was always
   going to read `CANT_TELL_YET`; SPEC.md 12 works through the arithmetic. The LLM budget buys
   external validity for the *attack* result, which is measured per decision and does not need
   a long return series.

## What I need from YK

- [ ] Approve a cap (recommended: **$60**), or set a different one.
- [ ] Decide the point count: about 670 real points per model, or reuse with a stated caveat.
- [ ] Confirm the models. SPEC.md 7 prefers NEAR AI Cloud so `aiSigHash` can be real; note that
      this build does not verify those signatures, so `aiSig.verified` stays false either way.
- [ ] Provide `NEARAI_API_KEY` in `.env` if NEAR AI Cloud is the choice.

Until all four are settled, the runner stays unbuilt and `pnpm runtime:sim` keeps using
scripted Analysts, which cost nothing and are what a judge runs.
