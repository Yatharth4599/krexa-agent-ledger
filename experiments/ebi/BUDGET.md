# LLM budget for the full runs

> **Correction, 13 Nov 2026.** The point counts below are a plan from 7 Nov and the archive
> never reached them. The recorder lost about two thirds of its snapshots to machine sleep, so
> **670 was never reachable** and the run that actually happened used **293 points**. The cost
> model per point still holds; only the multiplier was wrong. Measurement and cause are in
> [docs/SCHEDULED_RUNS.md](../../docs/SCHEDULED_RUNS.md), and the run's own count is in
> `run.json` and `docs/RESULTS.md`, which are the numbers to trust over anything in this file.
>
> Also note `.env` currently sets `LLM_DAILY_BUDGET_USD=5`, not the approved 60. A model run
> would stop at $5, part-way, and label itself accordingly. YK raises it or does not; an agent
> does not raise a spend cap on its own.

## Approved

YK approved on 7 Nov 2026:

- **Cap: $60.**
- **670 real decision points**, not reused points.
- **`debate` dropped, `hier` kept** (cut-line change from SPEC.md 18; the reasoning is in
  docs/PRIOR_WORK.md and the pilot confirmed `debate` merely tracks `plain`).

Dropping `debate` removes 3.3 of the 8.8 Analyst calls per decision point, which is where most
of the cost was. **Nothing has been spent yet.** No LLM call has been made anywhere in this repo
to date, and two things still block the run: see "What is still blocking" at the end.

### Revised cost with `debate` dropped

LLM desks are now `plain` (1.1 calls per point), `ebi` (1.1) and `hier` (3.3, since it runs
three specialists): **5.5 Analyst calls per decision point**, down from 8.8.

| points | cheap tier | mid tier | frontier tier |
|---|---|---|---|
| 480, 1 model | $0.55 | $3.17 | $12.67 |
| 480, 2 models | $1.11 | **$6.34** | $25.34 |
| 670, 1 model | $0.77 | $4.42 | $17.69 |
| 670, 2 models | $1.55 | **$8.84** | $35.38 |

So the approved $60 covers the target run roughly seven times over at the mid tier, or twice
at frontier rates. The headroom is now large enough that the run can be done more than once,
which matters for the schedule problem below.

The estimate below is kept as written, so the arithmetic that produced it can be checked.

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

## What is still blocking, after the approval

### 1. The archive does not hold 670 points yet, and the date it will is the freeze date

Measured on 7 Nov 2026: **10 decision points exist.** Recording began 6 Nov at 15:45 UTC on a
15 minute grid, so 670 points arrives on **13 Nov at about 15:45 UTC**, which is SPEC.md 18's
freeze day. The paid run, the scoring, `docs/RESULTS.md` and the README would all have to
happen after that, on the day reserved for bug fixes only, with submission the next day.

That is too tight to be the plan. Because the revised cost is under $10 per full run, the
budget now allows the obvious fix:

**Recommended: run twice.**

- **Run A, 11 Nov**, on whatever has accumulated (about 480 points). Roughly $6 at the mid
  tier. This produces a complete `docs/RESULTS.md`, proves the whole pipeline end to end, and
  means a shippable result exists two days before freeze.
- **Run B, 13 Nov**, on the full archive (about 670 points), only if Run A was clean. Roughly
  $9. Replaces Run A's numbers if it completes; if anything goes wrong, Run A still ships.

Total about $15 against the $60 cap. The alternative, a single run on 13 Nov, spends the same
money with no fallback on the day everything else is also due.

Either way the actual point count is printed in the results and in the README. No run is
reported as "about 2,000 decisions" when it was 480.

### 2. No model and no key

Still outstanding, and the run cannot start without them:

- [ ] **Confirm the models.** SPEC.md 7 prefers NEAR AI Cloud so `aiSigHash` can be real. Worth
      knowing: this build does not verify those signatures, so `aiSig.verified` stays `false`
      either way and the model id remains self-reported. Two models from the same provider is
      enough for SPEC.md 2A.4; two providers would be better evidence and costs the same.
- [ ] **Provide `NEARAI_API_KEY`** in `.env` (gitignored), or a key for whichever provider.

## Meanwhile

`apps/runtime` has a provider-shaped Analyst interface and a budget-capped runner, both tested
against a mock provider so they work without a key. `pnpm runtime:sim` keeps using the scripted
Analysts, which cost nothing, need no key, and are what a judge runs. The scorecard and
`docs/RESULTS.md` generator run on the pilot receipts today, so when the key arrives the only
new thing is the model calls.

The runner reads `LLM_DAILY_BUDGET_USD` from `.env`, refuses to start without it, counts tokens
as it goes, and **stops** at the cap rather than overshooting. A run that stops early is
reported as partial with the decision count reached, as SPEC.md M5 requires.
