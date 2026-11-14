# Submission fields

SPEC.md section 20 says every form field is decided by YK and never invented by an agent. This
file is where the decided ones are recorded, so the payload is assembled from a written decision
rather than from memory on the last day.

**Nothing is sent from here.** The payload gets printed in full for YK and goes only after an
explicit yes, once, per SPEC.md section 20 and the safety rules.

## Decided

| Field | Value | Decided |
|---|---|---|
| Public repo URL | `https://github.com/Yatharth4599/krexa-agent-ledger` | yes |
| Team size | `2 - 4` | yes, 7 Nov 2026, after codingstark-dev's code review was merged |
| Tracks | `swarms` primary, then `defi` and `security` | yes, 14 Nov 2026 |
| Testnet contract | `ual.krexa-ual.testnet` | yes |

Team size is `2 - 4` rather than `1` because [@codingstark-dev](https://github.com/codingstark-dev)
contributed the fixes in PR #2, including the raw-body hash check that closed a real forgery path.
See the Contributors section of the README.

`security` was added to the tracks on 14 Nov, after the second review. SPEC.md 20 left it open.
What earns it: the function-call-key denials proven against a real node rather than asserted
(`tests/integration/tests/fc_keys.rs`, plus 12 attempts in `pnpm attack-demo`, 8 refused by the
protocol before contract code runs), two adversarial reviews merged with each finding reproduced
against the pre-merge code, and a threat model that names the rows with **no mitigation** instead
of omitting them. `open` was considered and dropped: it would add a submission without adding a
claim.

## Drafts awaiting YK's yes

Written so there is something to react to rather than a blank field at 20:00 on the last day.
Neither has been sent anywhere. Both still count as "needed from YK" below until he approves or
rewrites them.

### Idea text, draft (1,966 characters, limit 2,000)

> An LLM trading swarm acts on whatever text reaches it. Published work shows one fabricated
> headline moving a whole swarm at once, and peer debate between agents does not catch it.
>
> Evidence-Bound Intents makes a trading agent cite its sources. Every signal must reference
> evidence fetched, hashed and signed before the decision. A deterministic verifier recomputes
> the indicators from the raw bodies and counts how many independent source groups corroborate
> the claim, and that count sets the size: one source trades nothing and is refused as
> R_UNCORROBORATED, two gets half size, three or more gets full. Every decision becomes a
> hash-chained receipt on NEAR, rejections included, so an allocator can audit what an agent was
> refused as well as what it did.
>
> NEAR does three things here. Function-call access keys let each agent write to the ledger while
> being unable to transfer funds or call another contract, which the integration tests prove by
> trying. The contract enforces the policy the owner committed in advance, so the operator's
> server is not the judge of its own record. One sub-account per agent keeps each actor traceable.
>
> The result is paper, scripted rather than model-driven, and mixed. Over 337 archived decision
> points the fabrication moved both the plain and the gated desk into the same 25 long positions.
> The gate refused 20 and 5 got through, at a cost of 19.8% of clean-run intents. Four of the
> five were planted across several declared sources, the limit we wrote down before building
> anything. The fifth was not: one fake reached full size because three exchanges happened to be
> drifting the right way and the verifier counts price agreement as corroboration, so timing
> substitutes for planting. docs/THREAT_MODEL.md carries that as a limit with no mitigation here.
> A hierarchical baseline took none of the 34 attacks, but it went long once in 300 clean
> decisions, so its zero is not a defence. docs/RESULTS.md has all of it, limits first.

### X post, draft

Cannot be posted until the video exists. Needs YK's account.

> A fake headline can make a whole swarm of LLM trading agents buy at once.
>
> So we made them cite their sources. Each signal references hashed, signed evidence; a verifier
> on NEAR recomputes the indicators and counts how many independent sources actually agree. One
> source trades nothing. Two gets half size. Every refusal is a receipt on chain, not a missing
> row.
>
> In the clip: the same fake headline. The ungated desk opens a long. The gated desk's intent is
> REJECTED as R_UNCORROBORATED, and you can walk the hash chain to it.
>
> NEAR's part is the part I'd have had to invent otherwise: function-call keys mean the agent can
> write its own record but cannot move funds, and the contract, not my server, enforces the
> policy I committed before trading.
>
> It also blocks some real early signals. That cost is in docs/RESULTS.md, measured, next to the
> wins.
>
> Built at the NEAR Hackathon. Repo: github.com/Yatharth4599/krexa-agent-ledger
>
> Honest question for anyone who has run agents against live markets: how many independent
> sources would *you* require before letting an agent size up?
>
> @NEARProtocol #NEARHackathon

### Video shot list, draft

Under 2 minutes is about 300 spoken words, which is five beats and not eleven. SPEC.md 19 lists
eleven. These five are chosen because `pnpm demo` already prints each one, so nothing has to be
staged or re-enacted: the beat numbers below are the demo's own, and the full nineteen scroll
past anyway.

| # | Shot | Command / source | Say |
|---|---|---|---|
| 1 | The fake headline arriving, marked `SYNTHETIC ATTACK` | demo beat 6 | "A fake headline can make a whole swarm of LLM traders buy at once." |
| 2 | Ungated desk opens a long; gated desk's intent **REJECTED `R_UNCORROBORATED`** | demo beats 7 and 8 | "Same headline, two desks, identical limits. One trades it. The other is refused, and the refusal is a receipt on chain." |
| 3 | Second source confirms: k=2, allowed at half size. Then the fabricated indicator panel caught by recompute | demo beats 9 and 12 | "Two independent sources gets half size. And a faked indicator panel dies because the verifier recomputes RSI from the attested raw prices." |
| 4 | Prompt-injected trader: withdraw blocked by the protocol, oversize order `R_MAX_POSITION` | `pnpm attack-demo` (or demo beats 15 and 16) | "Its function-call key cannot move money. That is NEAR refusing before any of my code runs." |
| 5 | `docs/RESULTS.md`, then the explorer: walk the chain, tamper a byte, "broken at seq n" | `pnpm web` | "It also blocks real early signals, and that cost is measured here next to the wins. The verdict on skill is can't-tell-yet, on purpose." |

Record `pnpm demo` in one unbroken take at a readable terminal size. It asserts every beat and
exits non-zero on failure, so a take that completes is itself the evidence. Do not cut between
beats 7 and 8. The whole point is that the two desks saw the same input.

Leave in the beat titled **"What this demo does not show"**. A judge who sees the limits on
screen reads the rest more generously, and HACKATHON.md's screening rewards exactly this.

## Still needed from YK

None of these can be guessed, and a wrong value here is worse than a late one.

- [ ] Project name (2 to 80 characters)
- [ ] Lead name
- [ ] Contact email
- [ ] **Mainnet NEAR account for payout.** YK creates this. Never generated by an agent.
- [ ] Public X post URL, which does not exist until the post goes up
- [ ] Idea text (20 to 2000 characters), or approval of a draft
- [ ] Consent to: "I agree that the organizers may use these details to review our submission and
      contact us about this hackathon."
- [ ] Demo video (under 2 minutes)
- [ ] Hosted demo URL, if there is one. Optional; a local-only demo is eligible (Q-012).

## Also blocked on YK, not submission fields

- `NEARAI_API_KEY` and `UAL_MODELS` in `.env`, without which the model runs cannot happen. The
  budget cap is already set, at `LLM_DAILY_BUDGET_USD=5` rather than the approved 60, and an
  agent does not raise a spend cap on its own.
- The news-feed terms decision.
- The 13 Nov pre-public review.

## State at freeze, 13 Nov 2026

Checked rather than assumed, so the last day is about the values above and not about the code.

| | |
|---|---|
| Repo | public at `https://github.com/Yatharth4599/krexa-agent-ledger` |
| `gitleaks detect` over the whole history | clean |
| Private Krexa code in the repo | none. `reused/` holds only `.gitkeep`, and the README says so |
| Testnet | `ual.krexa-ual.testnet` answering, desk `ebi` head at seq 32, policy `59f5db11...` |
| Fresh clone, no `.env`, no keys | `setup.sh`, `pnpm test` (77 Rust, 15 sandbox, 335 TypeScript), `pnpm demo`, `pnpm web` all pass |
| `docs/RESULTS.md` | generated from `sim-2026-11-06154524-323p`, the 13 Nov run, 323 points |
| Evidence clock | shifted per decision point. The earlier 293 point run measured the archive's age instead and says so in its own file |

## How the payload gets sent

`pnpm submit` assembles and checks it. The values live in `submission.local.json`, which is
gitignored because it carries YK's email and payout account:

```bash
cp submission.example.json submission.local.json
$EDITOR submission.local.json      # the seven values from the checklist above
pnpm submit                        # validates, prints the exact payload, sends nothing
pnpm submit --send                 # the same, then asks for a typed yes and POSTs once
```

It reports every constraint failure at once rather than one per run: the length limits, the
`size` enum where the spaces around the dash are part of the value, the 13 track ids, duplicate
tracks, NEAR account rules, both URLs, and `consent` exactly true. It refuses a `nearAddress`
ending in `.testnet`, because the prize is paid on mainnet and that is the one value here that
cannot be fixed afterwards.

## Process, so it is not improvised later

1. A `requestId` UUID is generated **once**, by `pnpm submit`, and written back so a retry after
   a timeout stays one application rather than becoming two.
2. The full payload is printed for YK to read.
3. It is sent only after YK types yes.
4. One submission only. Corrections go through https://nearhackathon.com/request-changes.
5. Repo public before 2026-11-14T23:59Z, with `gitleaks detect` clean.
