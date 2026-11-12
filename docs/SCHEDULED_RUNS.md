# The two scheduled EBI runs

YK approved two runs on 7 Nov 2026: **11 Nov** and **13 Nov**.

**The 11 Nov run never happened, and nothing noticed for two days.** The section below records
what failed, because a scheduled job that reports success by committing its own results has no
way to report that it never started.

## What was scheduled, and why it did not run

Two one-shot `launchd` agents, loaded under the operator's own account:

| label | fired | result |
|---|---|---|
| `xyz.krexa.ual.ebirun-nov11` | 11 Nov, 18:00 local | **exit 126**, nothing ran |
| `xyz.krexa.ual.ebirun-nov13` | would have been 13 Nov, 18:00 | unloaded before it could repeat it |

The whole of `experiments/ebi/launchd-nov11.log`, 58 bytes:

```
bash: ./scripts/scheduled-run.sh: Operation not permitted
```

Not a bug in the script, and not a missing `chmod`: the script is `-rwxr-xr-x` and runs fine from
a terminal. macOS TCC does not let a `launchd` agent touch anything under `~/Desktop`,
`~/Documents` or `~/Downloads` without Full Disk Access, and this repo lives on the Desktop. The
job was spawned by `launchd`, which has no such grant, so `exec` was refused before a single line
of the script ran. `launchctl list` had been showing the failure the whole time, in the one place
nobody looks:

```
-	126	xyz.krexa.ual.ebirun-nov11
```

**Why it was silent.** `scheduled-run.sh` reports by committing and pushing its results. A run
that dies at `exec` writes no commit, and an absent commit looks exactly like a quiet day. The
monitoring was the work product, so the absence of the work product was the only alarm, and it
was an alarm nobody was listening for. The archive recorder was healthy the entire time, which
made it look more alive than it was.

## What replaced it

`launchd` was abandoned rather than fixed. The alternatives were to grant Full Disk Access to
`launchd` (a system-wide permission change, on freeze day, to work around a path) or to move the
repo off the Desktop (changing every recorded absolute path two days before submission). Both
are larger than the problem.

Instead the timer runs as a detached child of an already-permitted terminal, which inherits the
grant the terminal has:

```bash
nohup bash -c 'until [ "$(date +%H%M)" -ge 1800 ]; do sleep 60; done;
  cd /Users/yatharthkher/Desktop/krexa-agent-ledger && ./scripts/scheduled-run.sh nov13' \
  >> experiments/ebi/timer-nov13.log 2>&1 &
```

It watches the clock instead of sleeping for a fixed span, so a machine that sleeps and wakes
fires late by at most a minute rather than by however long it was asleep.

Check it, or just do the run by hand:

```bash
pgrep -fl "ge 1800"                          # is the timer alive
./scripts/scheduled-run.sh manual            # run right now instead
launchctl list | grep krexa                  # should be empty; the plists are unloaded
```

The plist files are left in `~/Library/LaunchAgents/` unloaded rather than deleted, so the
failure can be reproduced by anyone who wants to check this write-up.

## Why 11 Nov and not just 13 Nov

13 Nov is SPEC.md 18's freeze day. A single run on that date would put the run, the scoring,
`docs/RESULTS.md` and the README all on the day reserved for bug fixes, with submission the next
day and no fallback if anything broke.

Since a full run costs under $10 against the approved $60 cap, running twice is close to free
insurance:

- **11 Nov** produces a complete `docs/RESULTS.md` two days before freeze, so a shippable
  result exists regardless of what happens afterwards.
- **13 Nov** replaces the 11 Nov numbers if it completes cleanly. If it does not, the 11 Nov
  result still ships.

The actual point count is printed in `run.json`, in `docs/RESULTS.md` and in the README. No run
is ever described as "about 2,000 decisions" when it was 480.

### The point counts this file used to promise were wrong

It said about 480 points on 11 Nov and about 670 on 13 Nov. Both assumed the recorder held its
15 minute grid. Measured on 10 Nov, it had not:

| | |
|---|---|
| rounds recorded | 140 in 97.5 hours |
| expected at a 15 minute grid | 390 |
| observed rate | 1.44 per hour against a design 4.0 |
| stalls over 30 minutes | 36, the longest 5.9 hours |

The median interval was exactly 900 seconds, so the schedule was right and the machine was
asleep. `pmset -g log` confirms it: idle sleep after 15 minutes, with only brief dark wakes for
maintenance, which pauses the recorder's loop.

`caffeinate -s -i` now runs detached to hold the machine awake, which only works on AC power.
Revised projections, with the assumption stated rather than buried:

| run | fires | if the grid now holds | if sleep continues |
|---|---|---|---|
| 11 Nov | 12:30 UTC | about 215 points | about 170 |
| 13 Nov | 12:30 UTC | about 410 points | about 240 |

**670 is not reachable.** It needed roughly seven days of clean recording and three remain. The
honest number is whatever `run.json` reports, and the runs print it rather than this table.

Stop holding the machine awake with:

```bash
pkill -f "caffeinate -s -i"
```

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
