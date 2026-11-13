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
| Tracks | `swarms` primary, `defi` secondary | yes (SPEC.md 20) |
| Testnet contract | `ual.krexa-ual.testnet` | yes |

Team size is `2 - 4` rather than `1` because [@codingstark-dev](https://github.com/codingstark-dev)
contributed the fixes in PR #2, including the raw-body hash check that closed a real forgery path.
See the Contributors section of the README.

## Drafts awaiting YK's yes

Written so there is something to react to rather than a blank field at 20:00 on the last day.
Neither has been sent anywhere. Both still count as "needed from YK" below until he approves or
rewrites them.

### Idea text, draft (1,180 characters, limit 2,000)

> An LLM trading swarm will act on whatever text reaches it. Published work shows a single
> fabricated headline moving a whole swarm of trading agents at once, and peer debate between
> agents does not catch it.
>
> Evidence-Bound Intents makes a trading agent cite its sources. Every Analyst signal has to
> reference evidence that was fetched, hashed and signed before the decision. A deterministic
> verifier recomputes the indicators from the raw attested bodies and counts how many
> independent source groups actually corroborate the claim, and that count sets the size: one
> source buys nothing and is refused as R_UNCORROBORATED, two gets half size, three or more gets
> full size. Every decision becomes a hash-chained receipt on NEAR, rejections included, so an
> allocator can audit what an agent was refused as well as what it did.
>
> NEAR does three specific things here. Function-call access keys let each agent write to the
> ledger while being unable to transfer funds or call any other contract, which the integration
> tests prove by trying. The contract enforces the policy the owner committed in advance, so the
> operator's own server is not the judge of its own track record. One sub-account per agent makes
> each actor traceable.
>
> Results are paper and the honest finding is mixed: the gate fails exactly where we predicted
> before building it, against a fake planted across several declared sources. docs/RESULTS.md
> reports that alongside what worked.

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
> write its own record but cannot move funds, and the contract — not my server — enforces the
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
beats 7 and 8 — the whole point is that the two desks saw the same input.

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
- [ ] Whether to add `security` and `open` to the track list, which SPEC.md 20 raises as an option
- [ ] Demo video (under 2 minutes)
- [ ] Hosted demo URL, if there is one. Optional; a local-only demo is eligible (Q-012).

## Also blocked on YK, not submission fields

- `NEARAI_API_KEY` and `UAL_MODELS` in `.env`, without which the model runs cannot happen. The
  budget cap is already set.
- The news-feed terms decision.
- The 13 Nov pre-public review.

## Process, so it is not improvised later

1. A `requestId` UUID is generated **once**.
2. The full payload is printed for YK to read.
3. It is sent only after YK types yes.
4. One submission only. Corrections go through https://nearhackathon.com/request-changes.
5. Repo public before 2026-11-14T23:59Z, with `gitleaks detect` clean.
