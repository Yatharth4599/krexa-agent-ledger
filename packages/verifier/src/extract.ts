/**
 * Turning an archived response body into a normalised price point.
 *
 * One extractor per source, written against the real payloads in `data/archive/raw/` rather
 than against documentation, because the two disagree often enough to matter.
 *
 * Everything here is pure and total: an extractor returns `undefined` rather than throwing or
 * guessing when a payload does not carry what was asked for. A verifier that guessed would
 * hand the gate a number no one can reproduce, which is the opposite of the point.
 *
 * Prices are kept as strings until the last moment and compared in integer micro-units, so no
 * float rounding reaches a verdict.
 */

export type Venue = "hyperliquid" | "binance-public" | "coinbase-public" | "kraken-public";

export interface PricePoint {
  venue: Venue;
  asset: string;
  /** Mid or last price, as the venue reported it. Decimal string, unrounded. */
  price: string;
  /** Previous-day reference price where the venue publishes one. */
  prevDayPrice?: string;
  /** Funding rate as a decimal string, perp venues only. */
  funding?: string;
  /** 24h volume in base units, where published. */
  volume?: string;
}

/** Asset symbols as each venue spells them. */
const SYMBOLS: Record<Venue, Record<string, string>> = {
  hyperliquid: { BTC: "BTC", ETH: "ETH" },
  "binance-public": { BTC: "BTCUSDT", ETH: "ETHUSDT" },
  "coinbase-public": { BTC: "BTC-USD", ETH: "ETH-USD" },
  // Kraken uses its own legacy codes: XBT for bitcoin, and X/Z prefixes on the pair names.
  "kraken-public": { BTC: "XXBTZUSD", ETH: "XETHZUSD" },
};

function num(v: unknown): string | undefined {
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

type Json = Record<string, unknown> | unknown[];

function parse(raw: string): Json | undefined {
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === "object" && v !== null ? (v as Json) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Hyperliquid `metaAndAssetCtxs`: a two element array of [meta, contexts], where
 * `meta.universe[i]` names the asset and `contexts[i]` carries its state. The pairing is
 * positional, which means a universe reordering would silently shift every price. So the
 * index is resolved by name and the result is discarded if the arrays disagree in length.
 */
function extractHyperliquid(raw: string, asset: string): PricePoint | undefined {
  const root = parse(raw);
  if (!Array.isArray(root) || root.length < 2) return undefined;
  const meta = root[0] as { universe?: { name?: string; isDelisted?: boolean }[] };
  const ctxs = root[1] as Record<string, unknown>[];
  if (!Array.isArray(meta?.universe) || !Array.isArray(ctxs)) return undefined;
  if (meta.universe.length !== ctxs.length) return undefined;

  const symbol = SYMBOLS.hyperliquid[asset];
  if (!symbol) return undefined;
  const i = meta.universe.findIndex((u) => u?.name === symbol && u?.isDelisted !== true);
  if (i < 0) return undefined;
  const ctx = ctxs[i];
  if (!ctx) return undefined;

  const price = num(ctx.midPx) ?? num(ctx.markPx) ?? num(ctx.oraclePx);
  if (!price) return undefined;
  return {
    venue: "hyperliquid",
    asset,
    price,
    prevDayPrice: num(ctx.prevDayPx),
    funding: num(ctx.funding),
    volume: num(ctx.dayBaseVlm),
  };
}

/** Binance `/ticker/24hr` with a `symbols` filter: an array of per-symbol objects. */
function extractBinance(raw: string, asset: string): PricePoint | undefined {
  const root = parse(raw);
  const symbol = SYMBOLS["binance-public"][asset];
  if (!symbol) return undefined;
  const rows = Array.isArray(root) ? root : [root];
  const row = (rows as Record<string, unknown>[]).find((r) => r?.symbol === symbol);
  if (!row) return undefined;
  const price = num(row.lastPrice);
  if (!price) return undefined;
  return {
    venue: "binance-public",
    asset,
    price,
    prevDayPrice: num(row.openPrice),
    volume: num(row.volume),
  };
}

/**
 * Coinbase `/products/<id>/ticker`: a single object with no symbol field, so the asset cannot
 * be checked against the payload. The archive records which URL produced it, and the URL
 * names the product, so the caller passes the asset and we trust the pairing. Noted because
 * it is a weaker guarantee than the other three.
 */
function extractCoinbase(raw: string, asset: string): PricePoint | undefined {
  const root = parse(raw);
  if (!root || Array.isArray(root)) return undefined;
  const row = root as Record<string, unknown>;
  if (!SYMBOLS["coinbase-public"][asset]) return undefined;
  const price = num(row.price) ?? num(row.bid);
  if (!price) return undefined;
  return {
    venue: "coinbase-public",
    asset,
    price,
    volume: num(row.volume),
  };
}

/**
 * Kraken `/0/public/Ticker`: `{error: [], result: {PAIR: {...}}}`.
 * `c` is [last trade price, lot volume]; `o` is today's opening price.
 * A non-empty `error` array means the payload is an error report, not data.
 */
function extractKraken(raw: string, asset: string): PricePoint | undefined {
  const root = parse(raw);
  if (!root || Array.isArray(root)) return undefined;
  const obj = root as { error?: unknown[]; result?: Record<string, unknown> };
  if (Array.isArray(obj.error) && obj.error.length > 0) return undefined;
  const pair = SYMBOLS["kraken-public"][asset];
  if (!pair || !obj.result) return undefined;
  const row = obj.result[pair] as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const last = Array.isArray(row.c) ? num((row.c as unknown[])[0]) : undefined;
  if (!last) return undefined;
  const vol = Array.isArray(row.v) ? num((row.v as unknown[])[1]) : undefined;
  return {
    venue: "kraken-public",
    asset,
    price: last,
    prevDayPrice: num(row.o),
    volume: vol,
  };
}

const EXTRACTORS: Record<Venue, (raw: string, asset: string) => PricePoint | undefined> = {
  hyperliquid: extractHyperliquid,
  "binance-public": extractBinance,
  "coinbase-public": extractCoinbase,
  "kraken-public": extractKraken,
};

export function isKnownVenue(source: string): source is Venue {
  return Object.hasOwn(EXTRACTORS, source);
}

/** Extract a price point, or undefined if this body does not carry one for this asset. */
export function extractPrice(
  source: string,
  raw: string,
  asset: string,
): PricePoint | undefined {
  if (!isKnownVenue(source)) return undefined;
  return EXTRACTORS[source](raw, asset);
}

/** Assets this verifier knows how to read across every venue. */
export function supportedAssets(): string[] {
  return Object.keys(SYMBOLS.hyperliquid);
}
