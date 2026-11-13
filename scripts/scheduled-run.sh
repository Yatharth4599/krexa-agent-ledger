#!/usr/bin/env bash
# The scheduled EBI run. YK approved two: 11 Nov and 13 Nov 2026.
#
# What it does, in order:
#   1. builds the contract
#   2. runs the harness over the whole archive at a realistic attack rate
#   3. regenerates docs/RESULTS.md from the receipts
#   4. commits the run and the results, and pushes
#
# ## It produces a usable result with or without an API key
#
# If NEARAI_API_KEY (or OPENAI_API_KEY) and UAL_MODELS are set, the run uses LLM Analysts and
# the budget meter stops it at LLM_DAILY_BUDGET_USD. If they are not, it runs with the scripted
# Analysts, costs nothing, and labels itself accordingly.
#
# That fallback is the point of scheduling it at all. A scripted run over several hundred points
# still produces the clean-run block rate, which is on SPEC.md 18's never-cut list and which the
# pilot could not measure because every pilot point was attacked. Skipping the run for want of a
# key would lose that for nothing.
#
# The run is labelled in run.json and in docs/RESULTS.md either way, so no scripted result is
# ever mistaken for a model result.
set -euo pipefail

cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

LABEL="${1:-manual}"
LOG="experiments/ebi/scheduled-${LABEL}.log"
mkdir -p experiments/ebi

exec > >(tee -a "$LOG") 2>&1
echo ""
echo "=================================================================="
echo "scheduled EBI run: ${LABEL}"
echo "started $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "=================================================================="

# --- .env, if present ---
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# --- how many points do we actually have ---
POINTS=$(python3 - <<'PY'
import json, os
p = "data/archive/index.jsonl"
print(len({json.loads(l)["ts"] for l in open(p) if l.strip()}) if os.path.exists(p) else 0)
PY
)
echo "archive holds ${POINTS} decision points"
if [ "$POINTS" -lt 2 ]; then
  echo "refusing to run: fewer than 2 decision points. Is the recorder running?"
  echo "  ./scripts/archive-start.sh"
  exit 1
fi

# --- is this a model run or a scripted one ---
MODE="scripted"
if [ -n "${UAL_MODELS:-}" ] && { [ -n "${NEARAI_API_KEY:-}" ] || [ -n "${OPENAI_API_KEY:-}" ]; }; then
  if [ -z "${LLM_DAILY_BUDGET_USD:-}" ]; then
    echo "UAL_MODELS and a key are set but LLM_DAILY_BUDGET_USD is not."
    echo "Refusing to make a model call without a cap. See experiments/ebi/BUDGET.md."
    exit 1
  fi
  MODE="llm"
  echo "mode: LLM Analysts, models=${UAL_MODELS}, cap=\$${LLM_DAILY_BUDGET_USD}"
else
  echo "mode: scripted Analysts (no UAL_MODELS and/or no API key present)"
  echo "      This still measures the clean-run block rate, which the pilot could not."
  echo "      Set UAL_MODELS and NEARAI_API_KEY in .env for a model run."
fi

# --- archive integrity before using it ---
echo ""
echo "--- verifying the archive ---"
pnpm archive:verify

# --- build ---
echo ""
echo "--- building the contract ---"
pnpm run build:contract

# --- run ---
# 10% attack rate, so most points are clean and the block rate is measurable. The pilot used
# 100% and therefore had no clean runs at all.
echo ""
echo "--- harness over ${POINTS} points, attack rate 0.1 ---"
UAL_RUN_MODE="$MODE" bash scripts/with-sandbox.sh pnpm -F @krexa-ual/runtime sim --attack-rate 0.1

# --- results ---
echo ""
echo "--- regenerating docs/RESULTS.md ---"
pnpm ebi:report

# --- commit ---
echo ""
echo "--- committing ---"
# Only what a run writes. `git add -A` would also publish any stray key or local file.
git add -- data/archive docs/RESULTS.md experiments/ebi/results
if git diff --cached --quiet; then
  echo "nothing changed, not committing"
else
  git commit -q -F - <<EOF
Scheduled EBI run (${LABEL}): ${POINTS} points, ${MODE} Analysts

Produced by scripts/scheduled-run.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ).
docs/RESULTS.md regenerated from the receipts in experiments/ebi/results.

Mode: ${MODE}. Attack rate 0.1, so most points are clean and the clean-run
block rate is measurable, which the 100% attack rate pilot could not do.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
  git push || echo "push failed; the commit is local and can be pushed by hand"
  echo "committed and pushed"
fi

echo ""
echo "finished $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "results: docs/RESULTS.md"
