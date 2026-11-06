# Archive sources

What the recorder fetches, why archiving each one is permitted, and which independence group
it belongs to. SPEC.md 2A.4 requires this file to exist before the archive is used, so that no
source ends up in the study without its terms having been looked at.

Recorded on a 15 minute grid aligned to the clock, so decision points land on :00, :15, :30
and :45 regardless of when the recorder was started. Every attempt appends one line to
`index.jsonl`, including attempts that failed. Raw bodies live content-addressed under
`raw/<sha256>.json` and are gitignored for size; `index.jsonl` is committed and is what makes
a replay reproducible.

Verify at any time with `pnpm archive:verify`, which rehashes every stored body and reports
anything missing or modified.

## Active sources

| Source id | Group | Kind | Endpoint | Terms |
|---|---|---|---|---|
| `hyperliquid` | `exchange-hl` | PRICE | `POST api.hyperliquid.xyz/info` `{"type":"metaAndAssetCtxs"}` | Public unauthenticated info endpoint, documented for programmatic read access. No key, no account, no rate-limit agreement accepted. Read-only. |
| `binance-public` | `exchange-binance` | PRICE | `GET api.binance.com/api/v3/ticker/24hr` | Public market data endpoint. Binance's API terms permit retrieval and display of public market data. Unauthenticated, read-only. |
| `coinbase-public` | `exchange-coinbase` | PRICE | `GET api.exchange.coinbase.com/products/BTC-USD/ticker` | Public Exchange market data endpoint, unauthenticated and read-only. |
| `kraken-public` | `exchange-kraken` | PRICE | `GET api.kraken.com/0/public/Ticker` | Public market data endpoint, unauthenticated and read-only. |

All four are read-only market data. No order is ever placed, no key is ever sent, and no
authenticated endpoint is touched.

### Why four exchanges rather than one exchange plus a prediction market

The evidence gate counts agreeing **independence groups**, so the groups have to be
independent in fact and not just in name. Four separate companies, each with its own order
book and its own price discovery, is a defensible set. Two endpoints of one operator would not
be, and putting them in separate groups would manufacture corroboration out of nothing.

This also makes the verifier's indicator recompute meaningful: a claimed momentum or funding
figure can be checked against raw prices from a venue that did not supply the claim.

## Unavailable sources, recorded rather than removed

| Source id | Group | Status |
|---|---|---|
| `polymarket-gamma` | `onchain-polymarket` | **Not reachable from the operator's network.** |

`gamma-api.polymarket.com` and `clob.polymarket.com` both resolve to `49.44.79.236`, an Indian
ISP address rather than Polymarket's infrastructure, and every request times out after 45
seconds. For comparison, `api.hyperliquid.xyz` resolves to `108.158.245.104` (CloudFront) and
responds in well under a second from the same machine at the same moment.

That pattern is DNS-level blocking by the ISP, not an outage and not a rate limit. Polymarket
is not accessible from India without a proxy, and routing around a national block is out of
scope for this build.

The source is deliberately **left in the source list** rather than deleted. Every snapshot
round appends a line for it with `ok: false` and the reason, so the record shows a source that
was part of the design and could not be collected. Deleting it would quietly rewrite the plan
to match what happened to work.

SPEC.md names Polymarket in several places. Nothing on the never-cut list depends on it: the
`plain` versus `ebi` comparison, the attack success rate, the false-block rate and the clean
Sharpe cost are all computed from price data and injected synthetic attacks. The study
therefore proceeds without it, and `docs/DATA_SOURCES.md` records the consequence.

## News sources: not yet enabled

No news source is being archived yet, and this is a deliberate hold rather than an oversight.

The attack study injects **synthetic** fake headlines (SPEC.md 2A.4), so the attack
measurement itself does not need a real news feed. What a real feed would add is realism for
the clean-run baseline, and a second kind of independence group alongside the exchanges.

The blocker is terms, not technology. A feed whose terms forbid storing responses cannot be
archived into a public repository, and "everyone does it" is not a licence. Candidates under
consideration, pending a decision:

- **GDELT DOC 2.0 API**: explicitly published for research use, returns article metadata
  rather than article text, which sidesteps the republication question.
- Publisher RSS feeds that state archiving is permitted, each as its own group.

Until one is chosen, every headline in this repo is synthetic and labelled
`SYNTHETIC ATTACK`. No real news content is stored anywhere in the archive.

## Gaps are part of the record

A line in `index.jsonl` with `ok: false` means the recorder tried and could not. This matters
more than it looks: without an explicit gap, a hole in the data is indistinguishable from a
period where nothing changed, and a replay harness could use a stale snapshot as though it
were fresh. `pnpm archive:stats` prints per-source coverage including the gap count.
