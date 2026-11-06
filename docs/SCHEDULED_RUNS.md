# The two scheduled EBI runs

YK approved two runs on 7 Nov 2026: **11 Nov** and **13 Nov**. Both are scheduled and will
fire without anyone being at the keyboard.

## What is scheduled

Two one-shot `launchd` agents, loaded under the operator's own account:

| label | fires | log |
|---|---|---|
| `xyz.krexa.ual.ebirun-nov11` | 11 Nov, 18:00 local | `experiments/ebi/launchd-nov11.log` |
| `xyz.krexa.ual.ebirun-nov13` | 13 Nov, 18:00 local | `experiments/ebi/launchd-nov13.log` |

Both run `scripts/scheduled-run.sh`, which builds the contract, verifies the archive, runs the
harness over every archived decision point at a 10% attack rate, regenerates `docs/RESULTS.md`
from the receipts, then commits and pushes.

Check or change them:

```bash
launchctl list | grep krexa                  # are they loaded
launchctl unload ~/Library/LaunchAgents/xyz.krexa.ual.ebirun-nov11.plist   # cancel one
./scripts/scheduled-run.sh manual            # run right now instead
```

## Why 11 Nov and not just 13 Nov

670 decision points arrives on 13 Nov at about 15:45 UTC, which is SPEC.md 18's freeze day.
A single run on that date would put the run, the scoring, `docs/RESULTS.md` and the README all
on the day reserved for bug fixes, with submission the next day and no fallback if anything
broke.

Since a full run costs under $10 against the approved $60 cap, running twice is close to free
insurance:

- **11 Nov**, about 480 points. Produces a complete `docs/RESULTS.md` two days before freeze,
  so a shippable result exists regardless of what happens afterwards.
- **13 Nov**, about 670 points. Replaces the 11 Nov numbers if it completes cleanly. If it does
  not, the 11 Nov result still ships.

The actual point count is printed in `run.json`, in `docs/RESULTS.md` and in the README. No run
is ever described as "about 2,000 decisions" when it was 480.

## It produces a usable result with or without an API key

The run checks for `UAL_MODELS` plus a key (`NEARAI_API_KEY` or `OPENAI_API_KEY`) in `.env`:

- **Both present**: LLM Analysts, with the budget meter stopping the run at
  `LLM_DAILY_BUDGET_USD`. Refuses to start if a key is present and the cap is not.
- **Either missing**: scripted Analysts. Costs nothing, needs no key, and the run labels itself
  `scripted` in `run.json` and in the limits section of `docs/RESULTS.md`.

The fallback is deliberate rather than a consolation. A scripted run over several hundred
points still measures the **clean-run block rate**, which is on SPEC.md 18's never-cut list and
which the pilot could not measure at all because every pilot point was attacked. Skipping the
run for want of a key would lose that for nothing.

No scripted result is ever presented as a model result. The mode appears in the limits
paragraph at the top of `docs/RESULTS.md`, above the table.

## What is still needed for the runs to be model runs

Add to `.env` (gitignored):

```
UAL_MODELS=provider/model-a,provider/model-b
NEARAI_API_KEY=...
LLM_DAILY_BUDGET_USD=60
```

Worth knowing before choosing: this build does not verify NEAR AI Cloud response signatures, so
`aiSig.verified` stays `false` and the model id stays self-reported either way. Two models from
two different providers would be stronger evidence than two from one, at the same cost.

## What the 11 Nov run will and will not be able to report

Based on the dry run against the archive as it stood on 7 Nov:

- **Attack success per desk and per template**: yes, with Wilson intervals.
- **Attack success by prior state**: yes. arXiv 2610.26438 finding (iii) makes this necessary
  rather than optional, since an aggregate can be moved sevenfold by when the attack lands.
- **Clean-run block rate**: only if the window contains enough price movement for the Analyst's
  24 hour momentum signal to vary. On the 2.5 hour pilot window every clean point was a HOLD, so
  the block rate was undefined rather than zero, and `docs/RESULTS.md` says so in those words.
  A five-day window should fix this; a news feed would fix it properly, and that is held up on
  terms rather than on code.
- **False-block rate**: no. It needs to know whether each blocked signal would have been
  profitable at its stated `horizonMin`, which needs a price path extending past each signal.
  Reachable on the 13 Nov run for signals early in the window.
- **Skill verdict**: `CANT_TELL_YET` for every desk, as predicted before anything was built.
