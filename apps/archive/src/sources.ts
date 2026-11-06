/**
 * The fixed source list the archive records and the evidence fetcher signs from.
 *
 * Two rules govern what belongs here:
 *
 * 1. **Terms must permit archiving.** Every entry carries its own `terms` note, which is
 *    reproduced in `data/archive/SOURCES.md`. A source whose terms forbid storing responses
 *    does not go in, however convenient it would be.
 * 2. **Groups must be genuinely independent.** The whole gate counts agreeing *groups*, so
 *    putting two endpoints of one operator in different groups would manufacture
 *    corroboration out of nothing. Each exchange here is a separate company with its own
 *    order book and its own price discovery.
 *
 * SPEC.md 2A.2 item 4 and 2A.4.
 */

export type SourceKind = "PRICE" | "NEWS" | "MARKET" | "ONCHAIN";

export interface Source {
  /** Stable id. Also the `source` field of every evidence item, and the policy's group key. */
  id: string;
  /** Independence group declared in the policy. Two sources may not share one. */
  group: string;
  kind: SourceKind;
  url: string;
  method: "GET" | "POST";
  body?: unknown;
  /** Why archiving this is permitted. Copied into SOURCES.md. */
  terms: string;
  /** Set when a source is known not to work, with the reason. Recorded, not deleted. */
  unavailable?: string;
}

export const SOURCES: Source[] = [
  {
    id: "hyperliquid",
    group: "exchange-hl",
    kind: "PRICE",
    url: "https://api.hyperliquid.xyz/info",
    method: "POST",
    // metaAndAssetCtxs carries mids, funding, open interest and mark prices in one response,
    // which is what the verifier needs to recompute a claimed funding or momentum figure.
    body: { type: "metaAndAssetCtxs" },
    terms:
      "Public unauthenticated info endpoint, documented for programmatic read access. " +
      "No key, no account, no rate-limit agreement accepted. Read-only.",
  },
  {
    id: "binance-public",
    group: "exchange-binance",
    kind: "PRICE",
    url: "https://api.binance.com/api/v3/ticker/24hr?symbols=%5B%22BTCUSDT%22%2C%22ETHUSDT%22%5D",
    method: "GET",
    terms:
      "Public market data endpoint. Binance's API terms permit retrieval and display of " +
      "public market data; this is read-only and unauthenticated.",
  },
  {
    id: "coinbase-public",
    group: "exchange-coinbase",
    kind: "PRICE",
    url: "https://api.exchange.coinbase.com/products/BTC-USD/ticker",
    method: "GET",
    terms:
      "Public Exchange market data endpoint, unauthenticated and read-only.",
  },
  {
    id: "kraken-public",
    group: "exchange-kraken",
    kind: "PRICE",
    url: "https://api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD",
    method: "GET",
    terms: "Public market data endpoint, unauthenticated and read-only.",
  },
  {
    id: "polymarket-gamma",
    group: "onchain-polymarket",
    kind: "MARKET",
    url: "https://gamma-api.polymarket.com/markets?closed=false&limit=20",
    method: "GET",
    terms: "Public markets API, read-only.",
    // Measured, not assumed: gamma-api.polymarket.com resolves to 49.44.79.236, an Indian
    // ISP address rather than Polymarket's infrastructure, and every request times out.
    // That is DNS-level blocking on the operator's network, not an outage. The source stays
    // in this list so the archive records an explicit gap for it rather than pretending the
    // source was never part of the design. docs/DATA_SOURCES.md has the detail.
    unavailable:
      "DNS sinkholed on the operator's network (resolves to an ISP address, requests time out). " +
      "Polymarket is not reachable from India without a proxy, which is out of scope.",
  },
];

/** The sources an archive run will actually attempt. */
export function activeSources(): Source[] {
  return SOURCES.filter((s) => !s.unavailable);
}

/** Independence groups, in the shape a policy's `evidence.groups` wants. */
export function policyGroups(): { group: string; sources: string[] }[] {
  const byGroup = new Map<string, string[]>();
  for (const s of activeSources()) {
    const list = byGroup.get(s.group) ?? [];
    list.push(s.id);
    byGroup.set(s.group, list);
  }
  return [...byGroup.entries()]
    .map(([group, sources]) => ({ group, sources: sources.sort() }))
    .sort((a, b) => (a.group < b.group ? -1 : 1));
}
