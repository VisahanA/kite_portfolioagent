// Client-safe: no Node imports, shared by the Imports tab and the server parser.
export const BROKERS = {
  axis: { label: "Axis Direct", currency: "INR", assetClass: "Indian equity" },
  icici: { label: "ICICI Direct", currency: "INR", assetClass: "Indian equity" },
  paytm: { label: "Paytm Money", currency: "INR", assetClass: "Indian equity" },
  vested: { label: "Vested", currency: "USD", assetClass: "US stock" },
  coindcx: { label: "CoinDCX", currency: "INR", assetClass: "Crypto" },
} as const;
export type Broker = keyof typeof BROKERS;
export const isBroker = (b: unknown): b is Broker => typeof b === "string" && b in BROKERS;

export type ExtHolding = {
  broker: Broker; symbol: string; name: string; qty: number;
  avg: number | null;   // average buy price per unit, in the holding's currency
  price: number | null; // last price per unit, if the statement shows it
  value: number | null; // current value, if the statement shows it
  currency: "INR" | "USD"; assetClass: string;
};

const optNum = (v: unknown) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Clean untrusted rows (a model reply or a browser PUT) into holdings for `broker`. Rows without a symbol or a
 * positive quantity are dropped; a missing currency or asset class falls back to the broker's own.
 */
export function toHoldings(rows: Partial<Record<keyof ExtHolding, unknown>>[], broker: Broker): ExtHolding[] {
  const meta = BROKERS[broker];
  return rows.filter((x) => x.symbol && Number(x.qty) > 0).map((x) => ({
    broker, symbol: String(x.symbol).toUpperCase().slice(0, 40), name: String(x.name ?? x.symbol).slice(0, 120), qty: Number(x.qty),
    avg: optNum(x.avg), price: optNum(x.price), value: optNum(x.value),
    currency: x.currency === "USD" || x.currency === "INR" ? x.currency : meta.currency,
    assetClass: String(x.assetClass || meta.assetClass).slice(0, 40),
  }));
}
