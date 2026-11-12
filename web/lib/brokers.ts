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
