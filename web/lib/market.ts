import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { argName, callText, type Tool } from "./mcp";
import { r1, r2 } from "./num";
import type { Technicals } from "./types";

export type Candle = { t: string; o: number; h: number; l: number; c: number; v: number };
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Build historical-candle arguments from whatever the server's tool schema calls its parameters. */
function historicalCall(tools: Tool[], token: number, exchange: string, symbol: string, from: Date, to: Date) {
  const dedicated = tools.find((t) => /historical/i.test(t.name) && t.name !== "market");
  const tool = dedicated ?? tools.find((t) => t.name === "market");
  if (!tool) throw new Error(`No historical-data tool on the Kite server (has: ${tools.map((t) => t.name).join(", ")})`);
  const pick = (re: RegExp) => argName(tool, re);
  const args: Record<string, unknown> = {};
  const mode = pick(/^mode$/);
  if (mode && !dedicated) args[mode] = "historical";
  const tokenKey = pick(/instrument_token|^token$/);
  const instKey = pick(/^instruments?$|^symbols?$/);
  if (tokenKey) args[tokenKey] = token;
  else if (instKey) args[instKey] = `${exchange}:${symbol}`;
  const fromKey = pick(/^from/), toKey = pick(/^to/), intKey = pick(/interval/);
  if (fromKey) args[fromKey] = ymd(from);
  if (toKey) args[toKey] = ymd(to);
  if (intKey) args[intKey] = "day";
  return { name: tool.name, arguments: args };
}

function parseCandles(text: string): Candle[] {
  let j: unknown;
  try { j = JSON.parse(text); } catch { throw new Error(text.slice(0, 200) || "Non-JSON candle response"); }
  let arr: unknown = j;
  for (const k of ["data", "candles"]) if (arr && !Array.isArray(arr) && typeof arr === "object" && k in (arr as object)) arr = (arr as Record<string, unknown>)[k];
  if (arr && !Array.isArray(arr) && typeof arr === "object") { const first = Object.values(arr as object)[0]; if (Array.isArray(first)) arr = first; }
  if (!Array.isArray(arr)) throw new Error("Unexpected candle response shape");
  return arr
    .map((x) => {
      if (Array.isArray(x)) return { t: String(x[0]), o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +(x[5] ?? 0) };
      const o = x as Record<string, unknown>;
      return { t: String(o.date ?? o.timestamp ?? ""), o: +(o.open as number), h: +(o.high as number), l: +(o.low as number), c: +(o.close as number), v: +((o.volume as number) ?? 0) };
    })
    .filter((c) => Number.isFinite(c.c))
    .sort((a, b) => a.t.localeCompare(b.t));
}

export async function fetchCandles(client: Client, tools: Tool[], token: number, exchange: string, symbol: string): Promise<Candle[]> {
  const to = new Date(), from = new Date(to.getTime() - 430 * 864e5); // ~14 months
  return parseCandles(await callText(client, historicalCall(tools, token, exchange, symbol, from, to), "Kite historical error"));
}

const sma = (c: number[], n: number) => (c.length >= n ? c.slice(-n).reduce((a, b) => a + b, 0) / n : NaN);
function rsi(c: number[], n = 14) {
  if (c.length <= n) return NaN;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

/** Daily candles -> indicators. Needs 200 candles for SMA200; otherwise null (INSUFFICIENT DATA). */
export function technicals(candles: Candle[], livePrice?: number): Technicals | null {
  if (candles.length < 200) return null;
  const closes = candles.map((c) => c.c);
  const price = livePrice && livePrice > 0 ? livePrice : closes.at(-1)!;
  const s20 = sma(closes, 20), s50 = sma(closes, 50), s200 = sma(closes, 200);
  const trend = price >= s50 ? (s50 >= s200 ? "Uptrend" : "Recovering") : price >= s200 ? "Weakening" : "Downtrend";
  const ret = (d: number) => (closes.length > d ? r1((price / closes[closes.length - 1 - d] - 1) * 100) : null);
  const year = candles.slice(-250), q = candles.slice(-63);
  const hi = Math.max(...year.map((c) => c.h)), lo = Math.min(...year.map((c) => c.l));
  let cross: string | null = null; // golden / death cross in the last 20 sessions
  for (let i = closes.length - 20; i < closes.length; i++) {
    const a = closes.slice(0, i), b = closes.slice(0, i + 1);
    if (a.length < 200) continue;
    const d0 = sma(a, 50) - sma(a, 200), d1 = sma(b, 50) - sma(b, 200);
    if (d0 <= 0 && d1 > 0) cross = "golden";
    else if (d0 >= 0 && d1 < 0) cross = "death";
  }
  return {
    price: r2(price), sma20: r2(s20), sma50: r2(s50), sma200: r2(s200),
    pct_vs_sma50: r1((price / s50 - 1) * 100), pct_vs_sma200: r1((price / s200 - 1) * 100),
    rsi14: r1(rsi(closes)), trend, cross, return_1m: ret(21), return_3m: ret(63), return_6m: ret(126),
    high_52w: r2(hi), low_52w: r2(lo), pct_from_52w_high: r1((price / hi - 1) * 100), swing_low_3m: r2(Math.min(...q.map((c) => c.l))),
    last_candle: candles.at(-1)!.t.slice(0, 10),
  };
}
