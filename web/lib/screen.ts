import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ExtHolding } from "./brokers";
import { canonical, resolveAliases, tickerOf } from "./canon";
import { screenRules } from "./defaults";
import { loadExternal } from "./external";
import { getFundamentals } from "./fundamentals";
import { callHoldings, connect, disconnect, liveClient } from "./kite";
import { fetchCandles, technicals, type Candle } from "./market";
import { callJson, dataArray, type Raw, type Tool } from "./mcp";
import { isNum, r2, sum } from "./num";
import { DEFAULT_FX, symbolOf, type HoldingLine } from "./portfolio";
import { loadRules } from "./rules";
import { sessionFile } from "./session";
import { readJson, writeJson } from "./store";
import { fetchUsCandles, resolveUsTicker, usFundamentals } from "./us";
import type { Check, Fundamentals, Report, ScreenResult, Technicals, Verdict } from "./types";

type Rules = Record<string, unknown>;
const NIFTY = { exchange: "NSE", symbol: "NIFTY 50", token: 256265 }; // NSE index token, same for every account
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- rule checks ----------
function verdict(checks: Check[]): Verdict {
  if (!checks.length) return { verdict: "n/a", checks };
  const p = checks.filter((c) => c.pass).length;
  return { verdict: p === checks.length ? "pass" : p === 0 ? "fail" : "mixed", checks };
}
const chk = (label: string, value: unknown, op: ">=" | "<=" | "in", limit: unknown, pass: boolean): Check => ({ label, value, op, limit, pass });

/** Measure one held stock against the user's rules. A null limit in the rules switches that check off. */
export function screenStock(id: string, ltp: number, t: Technicals | null, f: Fundamentals | null, rules: Rules): ScreenResult {
  const { entry: e, valuation: v, quality: q, growth: g } = screenRules(rules);
  const na: Verdict = { verdict: "n/a", checks: [] };
  const checks = { entry: na, valuation: na, quality: na, growth: na };
  if (t) {
    const cs: Check[] = [];
    cs.push(chk(`Trend (${t.trend})`, t.trend, "in", e.allowed_trends.join("/"), e.allowed_trends.includes(t.trend)));
    if (e.rsi_min != null) cs.push(chk("RSI(14) floor", t.rsi14, ">=", e.rsi_min, t.rsi14 >= e.rsi_min));
    if (e.rsi_max != null) cs.push(chk("RSI(14) ceiling", t.rsi14, "<=", e.rsi_max, t.rsi14 <= e.rsi_max));
    if (e.max_pct_above_sma50 != null) cs.push(chk("% above SMA50 (not extended)", t.pct_vs_sma50, "<=", e.max_pct_above_sma50, t.pct_vs_sma50 <= e.max_pct_above_sma50));
    if (e.require_above_sma200) cs.push(chk("Above SMA200", t.pct_vs_sma200, ">=", 0, t.pct_vs_sma200 >= 0));
    checks.entry = verdict(cs);
  }
  if (f) {
    const vc: Check[] = [], qc: Check[] = [], gc: Check[] = [];
    if (v.max_pe != null) vc.push(chk("P/E", f.pe, "<=", v.max_pe, isNum(f.pe) && f.pe > 0 && f.pe <= v.max_pe)); // loss-making (no / negative P/E) fails
    if (v.max_peg != null && isNum(f.pe) && isNum(f.profit_growth_3y) && f.profit_growth_3y > 0) { const peg = r2(f.pe / f.profit_growth_3y); vc.push(chk("PEG (P/E / 3y profit growth)", peg, "<=", v.max_peg, peg <= v.max_peg)); }
    if (v.max_pb != null && isNum(f.pb)) vc.push(chk("P/B", f.pb, "<=", v.max_pb, f.pb <= v.max_pb));
    if (q.min_roe != null) qc.push(chk("ROE %", f.roe, ">=", q.min_roe, isNum(f.roe) && f.roe >= q.min_roe));
    if (!f.is_financial) { // ROCE and D/E do not apply to banks, NBFCs and insurers
      if (q.min_roce != null) qc.push(chk("ROCE %", f.roce, ">=", q.min_roce, isNum(f.roce) && f.roce >= q.min_roce));
      if (q.max_debt_to_equity != null && isNum(f.debt_to_equity)) qc.push(chk("Debt / equity", f.debt_to_equity, "<=", q.max_debt_to_equity, f.debt_to_equity <= q.max_debt_to_equity));
    }
    if (g.min_sales_growth_3y != null) gc.push(chk("Sales growth 3y %", f.sales_growth_3y, ">=", g.min_sales_growth_3y, isNum(f.sales_growth_3y) && f.sales_growth_3y >= g.min_sales_growth_3y));
    if (g.min_profit_growth_3y != null) gc.push(chk("Profit growth 3y %", f.profit_growth_3y, ">=", g.min_profit_growth_3y, isNum(f.profit_growth_3y) && f.profit_growth_3y >= g.min_profit_growth_3y));
    Object.assign(checks, { valuation: verdict(vc), quality: verdict(qc), growth: verdict(gc) });
  }
  let signal: string;
  if (!t) signal = "INSUFFICIENT DATA";
  else if (!f) signal = "NO FUNDAMENTALS";
  else {
    const fundOk = (["valuation", "quality", "growth"] as const).filter((k) => checks[k].verdict === "pass").length >= 2;
    const entryOk = checks.entry.verdict === "pass";
    signal = fundOk ? (entryOk ? "ENTRY ZONE" : "WAIT FOR ENTRY") : entryOk ? "TECHNICAL ONLY" : "FAILS RULES";
  }
  return { id, sources: ["holding"], signal, ltp, checks, technicals: t ?? undefined, fundamentals: f ?? undefined };
}

// ---------- Kite holdings ----------
export type Refresh =
  | { status: "auth"; authUrl: string }
  | { status: "ok"; report: Report; gaps: string[]; fetchedAt: string };

type KiteLine = HoldingLine & { exchange: string; symbol: string; token: number };

/** One line per exchange:symbol (T+1 quantity included), largest value first. */
function mergeKiteLines(raw: Raw[]): KiteLine[] {
  const merged = new Map<string, KiteLine>();
  for (const h of raw) {
    const qty = Number(h.quantity) + Number(h.t1_quantity ?? 0);
    if (!qty) continue;
    const id = `${h.exchange}:${h.tradingsymbol}`;
    const avg = Number(h.average_price), ltp = Number(h.last_price) || Number(h.close_price);
    const m = merged.get(id) ?? { id, exchange: String(h.exchange), symbol: String(h.tradingsymbol), token: Number(h.instrument_token), qty: 0, avg: 0, cost: 0, value: 0, ltp };
    m.qty += qty; m.cost += qty * avg; m.value += qty * ltp; m.ltp = ltp;
    merged.set(id, m);
  }
  return [...merged.values()].map((m) => ({ ...m, avg: r2(m.cost / m.qty), value: r2(m.value), cost: r2(m.cost) })).sort((a, b) => b.value - a.value);
}

/** Pull this user's live holdings from Kite, then compute indicators and fundamentals for whatever they hold. Nothing is account-specific. */
export async function refreshHoldings(sid: string, origin: string): Promise<Refresh> {
  const c = await connect(sid, origin);
  if ("authUrl" in c) return { status: "auth", authUrl: c.authUrl };
  const { client } = c;
  let raw: Raw[], tools: Tool[];
  try {
    tools = (await client.listTools()).tools as Tool[];
    raw = await callHoldings(client, tools);
  } catch (e) { disconnect(sid); throw e; }

  const hs = mergeKiteLines(raw);
  if (!hs.length) throw new Error("Kite returned no holdings for this account.");
  const rules = loadRules();
  const cfg = screenRules(rules);
  const gaps: string[] = [];

  // Market regime first (NIFTY 50), then each holding. Kite rate-limits historical data, so go one at a time, one retry each.
  const candlesOf = async (x: { token: number; exchange: string; symbol: string }): Promise<Candle[]> => {
    for (let attempt = 0; ; attempt++) {
      try { return await fetchCandles(client, tools, x.token, x.exchange, x.symbol); } catch (e) {
        if (attempt) { gaps.push(`${x.symbol}: candles unavailable (${(e as Error).message.slice(0, 80)})`); return []; }
        await sleep(700);
      }
    }
  };
  const nt = technicals(await candlesOf(NIFTY));
  if (!nt) gaps.push("NIFTY 50: not enough candles, market caution unavailable");
  const caution = !!nt && (cfg.market.caution_when_nifty_downtrend ?? true) === true && nt.trend === "Downtrend";

  const results: ScreenResult[] = [];
  for (const x of hs) {
    const t = technicals(await candlesOf(x), x.ltp);
    await sleep(350);
    const f = await getFundamentals(x.symbol, x.ltp, cfg.fundamentals_max_age_days);
    if (!f) gaps.push(`${x.symbol}: no fundamentals on screener.in`);
    results.push(screenStock(x.id, x.ltp, t, f, rules));
  }

  const now = new Date().toISOString();
  const report: Report = {
    generated_at: now,
    market: { id: `${NIFTY.exchange}:${NIFTY.symbol}`, technicals: nt ?? ({} as Technicals), caution },
    holdings_by_value: hs.map(({ id, qty, avg, ltp, value, cost }) => ({ id, qty, avg, ltp, value, cost })),
    holdings_total_value: r2(sum(hs, (h) => h.value)),
    holdings_total_cost: r2(sum(hs, (h) => h.cost)),
    results,
  };
  writeJson(sessionFile(sid, "report"), report);
  return { status: "ok", report, gaps, fetchedAt: now };
}

const loadSessionReport = (sid: string | null): Report | null => (sid ? readJson<Report>(sessionFile(sid, "report")) : null);
const kiteSymbols = (sid: string) => (loadSessionReport(sid)?.holdings_by_value ?? []).map((h) => symbolOf(h.id));

// ---------- imported holdings (other brokers) merged into the same report ----------
type ExtEntry = { t: Technicals | null; f: Fundamentals | null; ltp?: number; sym?: string; at: string };
type ExtScreen = Record<string, ExtEntry>;
const loadExtScreen = (sid: string) => readJson<ExtScreen>(sessionFile(sid, "extscreen")) ?? {};
const saveExtScreen = (sid: string, s: ExtScreen) => writeJson(sessionFile(sid, "extscreen"), s);

const isIndian = (h: ExtHolding) => h.currency === "INR" && /indian/i.test(h.assetClass);
const isUS = (h: ExtHolding) => h.currency === "USD" && /us stock|equity/i.test(h.assetClass);
const extId = (h: ExtHolding) => (isIndian(h) ? `NSE:${canonical(h.symbol)}` : `${h.broker.toUpperCase()}:${tickerOf(h.symbol) || h.symbol}`);

/** The first object of a reply that is an object, an array, or `{ data: object | array }`. */
const firstObj = (j: unknown): Raw | null => {
  const d = Array.isArray(j) ? j : (j as { data?: unknown } | null)?.data;
  const o = Array.isArray(d) ? d[0] : d;
  return o && typeof o === "object" ? (o as Raw) : null;
};

/** Find the NSE token and live price for an imported stock via the Kite instrument search. */
async function lookup(client: Client, id: string, name: string): Promise<{ token: number; ltp?: number; sym?: string } | null> {
  const market = (args: Raw) => callJson(client, { name: "market", arguments: args }).catch(() => null);
  const pick = (o: Raw | null) => (o && Number(o.instrument_token) ? { token: Number(o.instrument_token), ltp: Number(o.last_price) || undefined, sym: o.tradingsymbol ? tickerOf(String(o.tradingsymbol)) : undefined } : null);
  const byId = pick(firstObj(await market({ mode: "search", search_mode: "get_by_id", id, include_live_quote: true })));
  if (byId) return byId;
  const arr = dataArray(await market({ mode: "search", query: name, exchange: "NSE", limit: 5, include_live_quote: true })) ?? [];
  return pick(arr.find((x) => String(x.exchange ?? "NSE") === "NSE" && /^EQ$|equity/i.test(String(x.segment ?? x.instrument_type ?? "EQ"))) ?? arr[0] ?? null);
}

/** Indian stock: trend from Kite candles (needs a live client), fundamentals from screener.in. Keeps earlier results on failure. */
async function screenIndian(h: ExtHolding, id: string, prev: ExtEntry | undefined, client: Client | null, toolsOf: () => Promise<Tool[]>, maxAge: number): Promise<ExtEntry> {
  let t = prev?.t ?? null, ltp = prev?.ltp, sym = prev?.sym;
  if (client) {
    try {
      const hit = await lookup(client, id, h.name || h.symbol);
      if (hit) {
        ltp = hit.ltp ?? ltp; sym = hit.sym ?? sym; // resolved official ticker, e.g. "RELIANCE INDUSTRIES" -> RELIANCE
        t = technicals(await fetchCandles(client, await toolsOf(), hit.token, "NSE", sym ?? canonical(h.symbol)), ltp);
        await sleep(350);
      }
    } catch { /* keep any earlier result */ }
  }
  const f = await getFundamentals(sym ?? symbolOf(id), ltp ?? h.price ?? h.avg ?? 0, maxAge).catch(() => null);
  return { t, f, ltp, sym, at: new Date().toISOString() };
}

/** US stock (e.g. Vested): same technicals + fundamentals pipeline, fed from Yahoo Finance instead of Kite/screener.in. */
async function screenUs(h: ExtHolding, prev: ExtEntry | undefined, maxAge: number): Promise<ExtEntry> {
  let t = prev?.t ?? null, f = prev?.f ?? null, ltp = prev?.ltp, sym = prev?.sym;
  try {
    sym ??= (await resolveUsTicker(tickerOf(h.symbol), h.name)) ?? undefined;
    if (sym) {
      const c = await fetchUsCandles(sym);
      ltp = c.ltp ?? ltp;
      t = technicals(c.candles, ltp) ?? t;
      f = await usFundamentals(sym, ltp ?? h.price ?? h.avg ?? 0, f, maxAge);
    }
  } catch { /* keep any earlier result */ }
  return { t, f, ltp, sym, at: new Date().toISOString() };
}

/** Compute (or refresh) trend + fundamentals for imported stocks. Without a live Kite client, Indian stocks get fundamentals only. */
export async function screenExternal(sid: string, client: Client | null = liveClient(sid)): Promise<void> {
  const all = loadExternal(sid);
  await ensureAliases(sid); // every spelling -> one NSE symbol before ids are built
  const cache = loadExtScreen(sid);
  const maxAge = screenRules(loadRules()).fundamentals_max_age_days;
  let tools: Tool[] | null = null;
  const toolsOf = async () => (tools ??= (await client!.listTools()).tools as Tool[]);
  const next: ExtScreen = {}; // rebuilt from scratch, so removed holdings drop out of the cache
  for (const h of all) {
    const id = extId(h);
    if (isUS(h)) { next[id] = await screenUs(h, cache[id], maxAge); await sleep(300); }
    else if (isIndian(h)) next[id] = await screenIndian(h, id, cache[id], client, toolsOf, maxAge);
  }
  saveExtScreen(sid, next);
}

/** Resolve spelling variants of every imported stock to one NSE symbol, trusting Kite's own symbols (cached, so only the first call is slow). */
export async function ensureAliases(sid: string | null): Promise<void> {
  if (!sid) return;
  const ext = loadExternal(sid).filter(isIndian);
  if (ext.length) await resolveAliases(ext, kiteSymbols(sid)).catch(() => {});
}

/** Fold another position in the same stock into `line`. */
function addTo(line: HoldingLine, qty: number, cost: number, value: number) {
  line.qty += qty; line.cost += cost; line.value += value;
  if (line.qty) line.avg = line.cost / line.qty;
}

const NO_FUNDAMENTALS = { as_of: "", source: "", pe: null, pb: null, roe: null, roce: null, debt_to_equity: null, sales_growth_3y: null, profit_growth_3y: null, dividend_yield: null, notes: "Imported holding" };

/** The saved Kite report plus the user's imported holdings (USD converted at `fx`). Null until Kite has been connected once. */
export function loadMergedReport(sid: string | null, fx = DEFAULT_FX): Report | null {
  const base = loadSessionReport(sid);
  if (!base || !sid) return base;
  const ext = loadExternal(sid);
  if (!ext.length) return base;
  const cache = loadExtScreen(sid);
  const rules = loadRules();
  const lines = new Map(base.holdings_by_value.map((h) => [h.id, { ...h }]));
  const results = new Map(base.results.map((r) => [r.id, r]));
  const extLines: NonNullable<Report["ext_lines"]> = [];
  for (const h of ext) {
    const raw = extId(h), c = cache[raw];
    const id = isIndian(h) && c?.sym ? `NSE:${c.sym}` : raw; // alias -> canonical id so it merges with the Kite line
    const k = h.currency === "USD" ? fx : 1;
    const px = (c?.ltp ?? h.price ?? h.avg ?? 0) * k;
    const value = h.value != null && !c?.ltp ? h.value * k : h.qty * px;
    const cost = h.avg != null ? h.qty * h.avg * k : value;
    extLines.push({ broker: h.broker, symbol: h.symbol, value, cost, live: !!c?.ltp });
    const cur = lines.get(id);
    if (cur) addTo(cur, h.qty, cost, value); // same stock also held on Kite
    else lines.set(id, { id, qty: h.qty, avg: cost / h.qty, ltp: px || cost / h.qty, value, cost, imported: true });
    if (!results.has(id)) {
      const r = screenStock(id, px, c?.t ?? null, c?.f ?? null, rules);
      if (!c?.f && !isIndian(h) && !isUS(h)) r.fundamentals = { ...NO_FUNDAMENTALS, sector: h.assetClass }; // e.g. crypto: shows the asset class as sector
      results.set(id, r);
    }
  }
  // Final safety net: collapse any remaining lines that are the same Indian stock (NSE/BSE listings, spelling variants).
  const seen = new Map<string, string>();
  for (const [id, l] of [...lines]) {
    const m = /^(NSE|BSE):(.+)$/.exec(id);
    if (!m) continue;
    const ck = canonical(m[2]), first = seen.get(ck);
    if (!first) { seen.set(ck, id); continue; }
    const t = lines.get(first)!;
    addTo(t, l.qty, l.cost, l.value);
    t.imported = t.imported && l.imported;
    lines.delete(id); results.delete(id);
  }
  const hv = [...lines.values()].sort((a, b) => b.value - a.value);
  return {
    ...base, holdings_by_value: hv, holdings_total_value: sum(hv, (h) => h.value), holdings_total_cost: sum(hv, (h) => h.cost), results: [...results.values()],
    ext_lines: extLines, kite_total_value: sum(base.holdings_by_value, (h) => h.value), kite_total_cost: sum(base.holdings_by_value, (h) => h.cost),
  };
}
