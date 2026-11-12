# Data sources: what changed from SPEC.md, and why

SPEC.md 2A.4 specifies the evaluation data as "public Hyperliquid prices (and funding) and
Polymarket markets". One of those is not reachable from the machine this build runs on, which
changes the source list and therefore the independence groups. The change is recorded here
rather than absorbed quietly, because the independence groups are the heart of the gate and a
reader has to know what they actually were.

## Polymarket is blocked on the operator's network

Measured on 6 Nov 2026:

| Host | Resolves to | Result |
|---|---|---|
| `gamma-api.polymarket.com` | `49.44.79.236` | times out after 45s |
| `clob.polymarket.com` | `49.44.79.236` | times out |
| `api.hyperliquid.xyz` | `108.158.245.104` (CloudFront) | HTTP 200, sub-second |
| `api.binance.com` | `13.225.101.176` | HTTP 200 |
| `api.exchange.coinbase.com` | `104.18.35.15` | HTTP 200 |
| `api.kraken.com` | `104.16.14.28` | HTTP 200 |

Both Polymarket hosts resolve to the same address in an Indian ISP range, which is not
Polymarket's infrastructure. Every other venue resolves to its real CDN and answers in under a
second from the same machine at the same moment.

### A single probe was not enough

The table above is one measurement at one instant, and it reads as though the four non-Polymarket
venues are simply fine. Over four days of recording they were not equally fine:

| source | ok | failed | failure rate |
|---|---|---|---|
| `hyperliquid` | 139 | 1 | under 1% |
| `coinbase-public` | 139 | 1 | under 1% |
| `kraken-public` | 106 | 34 | 24% |
| `binance-public` | 81 | 59 | **42%** |
| `polymarket-gamma` | 0 | 140 | 100%, blocked as above |

All the failures are `TypeError: fetch failed` rather than an HTTP status, so they are connection
level rather than rejections the venue chose to send. Measured to 10 Nov 2026, 139 rounds.

The consequence for the gate is the part worth stating: only **46% of rounds had all four
reachable price groups**, and 16 rounds had just two. Since the policy's size table is
`[0, 0, 5000, 10000]`, a point with two groups cannot reach the k that unlocks full size no
matter what the evidence says. So a refusal can be caused by the operator's network rather than
by the evidence, and the two must not be counted as the same thing.

`run.json` and the decision log now carry `groupsAvailable` plus per-source failure counts, and
`docs/RESULTS.md` reports them in their own section ahead of the clean-run cost. The lesson
generalises past this repo: a one-off reachability probe tells you a host answered once, not
that you can build a measurement on it.

That pattern is DNS-level blocking by the ISP, not an outage, not a rate limit, and not
something a retry will fix. Polymarket is not accessible from India without a proxy, and
routing around a national block is out of scope for a hackathon build.

### What was done about it

The source stays in the list in `apps/archive/src/sources.ts`, marked `unavailable` with the
reason. Every snapshot round appends a line for it to `data/archive/index.jsonl` with
`ok: false`, so the archive shows a source that was part of the design and could not be
collected.

Deleting it would have been tidier and worse: it would rewrite the plan to match whatever
happened to work, and a reader comparing this repo to SPEC.md would find Polymarket missing
with no explanation.

## The replacement independence groups

| Group | Source | Kind |
|---|---|---|
| `exchange-hl` | `hyperliquid` | PRICE |
| `exchange-binance` | `binance-public` | PRICE |
| `exchange-coinbase` | `coinbase-public` | PRICE |
| `exchange-kraken` | `kraken-public` | PRICE |

Four separate companies, each with its own order book and its own price discovery. Terms for
each are in `data/archive/SOURCES.md`; all four are public, unauthenticated, read-only market
data endpoints.

### This is arguably better for the study than the original pair

Not a consolation. Two concrete reasons:

1. **Independence is defensible.** The gate counts agreeing groups, so the groups have to be
   independent in fact. Four exchanges are. One exchange plus one prediction market is two
   groups, which is the bare minimum for the k=2 row of the size table and leaves no room to
   test the k>=3 row with real data.
2. **The indicator recompute becomes meaningful.** SPEC.md 2A.2 item 3 has the verifier
   recompute any claimed indicator from cited raw PRICE evidence. With four price sources, a
   claimed momentum or funding figure can be checked against a venue that did not supply the
   claim. With a single price source, the recompute only ever checks a source against itself.

### What is lost

- The `onchain-polymarket` group and any MARKET-kind evidence. The evidence `kind` enum still
  carries `MARKET` and `ONCHAIN`; nothing in this build populates them.
- The Polygon transaction verification path for `POLYMARKET_TX` fills (SPEC.md 3.4). That fill
  kind remains defined and rejected in paper mode, and is simply never produced.
- Any claim about prediction-market signals. None is made anywhere.

Nothing on the never-cut list in SPEC.md 18 depends on Polymarket: `plain` versus `ebi`,
buy-and-hold, attack success rate, PnL lost under attack, clean Sharpe cost and false-block
rate are all computed from price data plus injected synthetic attacks.

## News sources are on hold, not forgotten

No news feed is archived yet. The attack study injects **synthetic** headlines (SPEC.md 2A.4),
so the attack measurement does not depend on a real feed; what a feed adds is realism for the
clean-run baseline and a second kind of independence group.

The blocker is terms. A feed whose terms forbid storing responses cannot be archived into a
public repository. Candidates, pending a decision:

- **GDELT DOC 2.0 API**, published for research use and returning article metadata rather than
  article text, which avoids the republication question entirely.
- Publisher RSS feeds whose terms permit archiving, each its own group.

Until one is chosen, every headline anywhere in this repo is synthetic and labelled
`SYNTHETIC ATTACK`. No real news content is stored.

## Effect on the archive window

The recorder started on 6 Nov 2026 at 15:45 UTC on a 15 minute grid, which is one day later
than SPEC.md 18's D1 start. The replay window is therefore about 7 days rather than 8. That
shortens the clean-run series and makes no difference at all to the skill verdict, which was
already going to read `CANT_TELL_YET` for every desk: SPEC.md 12 works through the arithmetic
showing an implausible Sharpe would be needed for significance over 17 days, let alone 7.
