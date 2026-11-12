import fs from "node:fs";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callHoldings, connect, disconnect, liveClient, type Raw } from "./kite";
import { loadExternal } from "./external";
import { canonical, resolveAliases } from "./canon";
import { fetchCandles, technicals, type Tool } from "./market";
import { getFundamentals } from "./fundamentals";
import { fetchUsCandles, fetchUsFundamentals, resolveUsTicker } from "./us";
import type { ExtHolding } from "./brokers";
import { loadRules, symbolOf } from "./data";
import { quantScore } from "./quant";
import { readJson, sessionFile } from "./session";
import type { Check, Fundamentals, Report, ScreenResult, Technicals, Verdict } from "./types";

const NIFTY = { exchange: "NSE", symbol: "NIFTY 50", token: 256265 }; // NSE index token, same for every account
type Rules = Record<string, Record<string, unknown> | number | undefined>;
const sect = (r: Rules, k: string) => (r[k] ?? {}) as Record<string, number | boolean | string[] | null | undefined>;
const lim = (v: unknown, d: number | null) => (v === undefined ? d : (v as number | null)); // null switches a check off

function verdict(checks: Check[]): Verdict {
  if (!checks.length) return { verdict: "n/a", checks };
  const p = checks.filter((c) => c.pass).length;
  return { verdict: p === checks.length ? "pass" : p === 0 ? "fail" : "mixed", checks };
}
const chk = (label: string, value: unknown, op: ">=" | "<=" | "in", limit: unknown, pass: boolean): Check => ({ label, value, op, limit, pass });
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function score(id: string, ltp: number, t: Technicals | null, f: Fundamentals | null, rules: Rules): Omit<ScreenResult, "sources" | "holding" | "score"> {
  const na: Verdict = { verdict: "n/a", checks: [] };
  const checks = { entry: na, valuation: na, quality: na, growth: na };
  if (t) {
    const e = sect(rules, "entry"), cs: Check[] = [];
    const allowed = (e.allowed_trends as string[] | undefined) ?? ["Uptrend", "Recovering"];
    cs.push(chk(`Trend (${t.trend})`, t.trend, "in", allowed.join("/"), allowed.includes(t.trend)));
    const rmin = lim(e.rsi_min, 35), rmax = lim(e.rsi_max, 60), ext = lim(e.max_pct_above_sma50, 5);
    if (rmin != null) cs.push(chk("RSI(14) floor", t.rsi14, ">=", rmin, t.rsi14 >= rmin));
    if (rmax != null) cs.push(chk("RSI(14) ceiling", t.rsi14, "<=", rmax, t.rsi14 <= rmax));
    if (ext != null) cs.push(chk("% above SMA50 (not extended)", t.pct_vs_sma50, "<=", ext, t.pct_vs_sma50 <= ext));
    if (e.require_above_sma200) cs.push(chk("Above SMA200", t.pct_vs_sma200, ">=", 0, t.pct_vs_sma200 >= 0));
    checks.entry = verdict(cs);
  }
  if (f) {
    const v = sect(rules, "valuation"), q = sect(rules, "quality"), g = sect(rules, "growth");
    const vc: Check[] = [], qc: Check[] = [], gc: Check[] = [];
    const mpe = lim(v.max_pe, 40), mpb = lim(v.max_pb, 8), mpeg = lim(v.max_peg, 1.5);
    if (mpe != null) vc.push(chk("P/E", f.pe, "<=", mpe, num(f.pe) && f.pe > 0 && f.pe <= mpe)); // loss-making (no / negative P/E) fails
    if (mpeg != null && num(f.pe) && num(f.profit_growth_3y) && f.profit_growth_3y > 0) { const peg = Math.round((f.pe / f.profit_growth_3y) * 100) / 100; vc.push(chk("PEG (P/E / 3y profit growth)", peg, "<=", mpeg, peg <= mpeg)); }
    if (mpb != null && num(f.pb)) vc.push(chk("P/B", f.pb, "<=", mpb, f.pb <= mpb));
    const roe = lim(q.min_roe, 15), roce = lim(q.min_roce, 15), de = lim(q.max_debt_to_equity, 1);
    if (roe != null) qc.push(chk("ROE %", f.roe, ">=", roe, num(f.roe) && f.roe >= roe));
    if (!f.is_financial) { // ROCE and D/E do not apply to banks, NBFCs and insurers
      if (roce != null) qc.push(chk("ROCE %", f.roce, ">=", roce, num(f.roce) && f.roce >= roce));
      if (de != null && num(f.debt_to_equity)) qc.push(chk("Debt / equity", f.debt_to_equity, "<=", de, f.debt_to_equity <= de));
    }
    const sg = lim(g.min_sales_growth_3y, 8), pg = lim(g.min_profit_growth_3y, 10);
    if (sg != null) gc.push(chk("Sales growth 3y %", f.sales_growth_3y, ">=", sg, num(f.sales_growth_3y) && f.sales_growth_3y >= sg));
    if (pg != null) gc.push(chk("Profit growth 3y %", f.profit_growth_3y, ">=", pg, num(f.profit_growth_3y) && f.profit_growth_3y >= pg));
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
  return { id, signal, ltp, checks, technicals: t ?? undefined, fundamentals: f ?? undefined };
}

export type Refresh =
  | { status: "auth"; authUrl: string }
  | { status: "ok"; report: Report; gaps: string[]; fetchedAt: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pull this user's live holdings from Kite, then compute indicators and fundamentals for whatever they hold. Nothing is account-specific. */
export async function refreshHoldings(sid: string, origin: string): Promise<Refresh> {
  const c = await connect(sid, origin);
  if ("authUrl" in c) return { status: "auth", authUrl: c.authUrl };
  const { client } = c;
  let raw: Raw[], tools: Tool[];
  try { raw = await callHoldings(client); tools = (await client.listTools()).tools as Tool[]; } catch (e) { disconnect(sid); throw e; }

  // Merge lines that map to the same stock (same exchange:symbol, plus T+1 quantity).
  const merged = new Map<string, { exchange: string; symbol: string; token: number; qty: number; cost: number; value: number; ltp: number }>();
  for (const h of raw) {
    const qty = Number(h.quantity) + Number(h.t1_quantity ?? 0);
    if (!qty) continue;
    const id = `${h.exchange}:${h.tradingsymbol}`;
    const avg = Number(h.average_price), ltp = Number(h.last_price) || Number(h.close_price);
    const m = merged.get(id) ?? { exchange: String(h.exchange), symbol: String(h.tradingsymbol), token: Number(h.instrument_token), qty: 0, cost: 0, value: 0, ltp };
    m.qty += qty; m.cost += qty * avg; m.value += qty * ltp; m.ltp = ltp;
    merged.set(id, m);
  }
  const hs = [...merged].map(([id, m]) => ({ id, ...m, avg: Math.round((m.cost / m.qty) * 100) / 100, value: Math.round(m.value * 100) / 100, cost: Math.round(m.cost * 100) / 100 })).sort((a, b) => b.value - a.value);
  if (!hs.length) throw new Error("Kite returned no holdings for this account.");

  const rules = loadRules() as Rules;
  const maxAge = Number(rules.fundamentals_max_age_days ?? 30);
  const gaps: string[] = [];

  // Market regime first (NIFTY 50), then each holding. Kite rate-limits historical data, so go one at a time.
  const candlesOf = async (x: { token: number; exchange: string; symbol: string }) => {
    try { return await fetchCandles(client, tools, x.token, x.exchange, x.symbol); }
    catch (e) { await sleep(700); try { return await fetchCandles(client, tools, x.token, x.exchange, x.symbol); } catch (e2) { gaps.push(`${x.symbol}: candles unavailable (${(e2 as Error).message.slice(0, 80)})`); void e; return []; } }
  };
  const nt = technicals(await candlesOf(NIFTY));
  if (!nt) gaps.push("NIFTY 50: not enough candles, market caution unavailable");
  const mrules = sect(rules, "market");
  const caution = !!nt && (mrules.caution_when_nifty_downtrend ?? true) === true && nt.trend === "Downtrend";

  const results: ScreenResult[] = [];
  for (const x of hs) {
    const t = technicals(await candlesOf(x), x.ltp);
    await sleep(350);
    const f = await getFundamentals(x.symbol, x.ltp, maxAge);
    if (!f) gaps.push(`${x.symbol}: no fundamentals on screener.in`);
    const base = score(x.id, x.ltp, t, f, rules);
    const r: ScreenResult = { ...base, sources: ["holding"], score: 0, holding: { quantity: x.qty, average_price: x.avg, pnl: x.value - x.cost, pnl_pct: ((x.value - x.cost) / x.cost) * 100 } };
    r.score = quantScore(r).score;
    results.push(r);
  }

  const now = new Date();
  const report: Report = {
    generated_at: now.toISOString(),
    market: { id: `${NIFTY.exchange}:${NIFTY.symbol}`, technicals: nt ?? ({} as Technicals), caution },
    holdings_by_value: hs.map((x) => ({ id: x.id, qty: x.qty, avg: x.avg, ltp: x.ltp, value: x.value, cost: x.cost })),
    holdings_total_value: Math.round(hs.reduce((a, b) => a + b.value, 0) * 100) / 100,
    holdings_total_cost: Math.round(hs.reduce((a, b) => a + b.cost, 0) * 100) / 100,
    results,
  };
  fs.writeFileSync(sessionFile(sid, "report"), JSON.stringify(report));
  return { status: "ok", report, gaps, fetchedAt: now.toISOString() };
}

export const loadSessionReport = (sid: string | null): Report | null => (sid ? readJson<Report>(sessionFile(sid, "report")) : null);


// ---------- imported holdings (other brokers) merged into the same report ----------
type ExtScreen = Record<string, { t: Technicals | null; f: Fundamentals | null; ltp?: number; sym?: string; at: string }>;
const isIndian = (h: { assetClass: string; currency: string }) => h.currency === "INR" && /indian/i.test(h.assetClass);
const isUS = (h: { assetClass: string; currency: string }) => h.currency === "USD" && /us stock|equity/i.test(h.assetClass);
// Canonical NSE symbol: drop exchange prefix/suffix (NSE:, .NS, .BO), series suffix (-EQ, -BE, -BZ, -T...) and punctuation.
const cleanSym = (s: string) => s.toUpperCase().trim().replace(/^(NSE|BSE)[:\s]+/, "").replace(/\.(NS|NSE|BO|BSE)$/, "").replace(/-(EQ|BE|BZ|BL|SM|ST|T|N\d)$/, "").replace(/[^A-Z0-9&-]/g, "");
const extId = (h: { broker: string; symbol: string; assetClass: string; currency: string }) => (isIndian(h) ? `NSE:${canonical(h.symbol)}` : `${h.broker.toUpperCase()}:${cleanSym(h.symbol) || h.symbol}`);

async function marketJson(client: Client, args: Record<string, unknown>): Promise<unknown> {
  const res = await client.callTool({ name: "market", arguments: args });
  const text = ((res as { content?: { type: string; text?: string }[] }).content ?? []).map((b) => b.text ?? "").join("");
  try { return JSON.parse(text); } catch { return null; }
}
const findObj = (j: unknown): Record<string, unknown> | null => {
  const arr = Array.isArray(j) ? j : ((j as { data?: unknown })?.data as unknown[] | undefined);
  const o = Array.isArray(arr) ? arr[0] : arr;
  return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
};

/** Find the NSE token and live price for an imported stock via the Kite instrument search. */
async function lookup(client: Client, id: string, name: string): Promise<{ token: number; ltp?: number; sym?: string } | null> {
  const pick = (o: Record<string, unknown> | null) => (o && Number(o.instrument_token) ? { token: Number(o.instrument_token), ltp: Number(o.last_price) || undefined, sym: o.tradingsymbol ? cleanSym(String(o.tradingsymbol)) : undefined } : null);
  const a = pick(findObj(await marketJson(client, { mode: "search", search_mode: "get_by_id", id, include_live_quote: true }).catch(() => null)));
  if (a) return a;
  const j = await marketJson(client, { mode: "search", query: name, exchange: "NSE", limit: 5, include_live_quote: true }).catch(() => null);
  const arr = ((Array.isArray(j) ? j : (j as { data?: unknown[] })?.data) ?? []) as Record<string, unknown>[];
  return pick(arr.find((x) => String(x.exchange ?? "NSE") === "NSE" && /^EQ$|equity/i.test(String(x.segment ?? x.instrument_type ?? "EQ"))) ?? arr[0] ?? null);
}

/** Compute (or refresh) trend + fundamentals for imported Indian stocks. Without a live Kite client only fundamentals are fetched. */
export async function screenExternal(sid: string, client: Client | null = liveClient(sid)): Promise<void> {
  const all = loadExternal(sid);
  const ext = all.filter(isIndian);
  await screenUs(sid, all.filter(isUS));
  // Singularise: map every spelling (names, typos, series suffixes) to one NSE symbol, using Kite's own symbols as the trusted set.
  const kiteSyms = (loadSessionReport(sid)?.holdings_by_value ?? []).map((h) => symbolOf(h.id));
  await resolveAliases(ext, kiteSyms).catch(() => {});
  const cache = readJson<ExtScreen>(sessionFile(sid, "extscreen")) ?? {};
  const maxAge = Number(((loadRules() as Rules).fundamentals_max_age_days as number) ?? 30);
  let tools: Tool[] | null = null;
  const next: ExtScreen = {};
  for (const h of ext) {
    const id = extId(h), prev = cache[id];
    let t: Technicals | null = prev?.t ?? null, ltp = prev?.ltp, sym = prev?.sym;
    if (client) {
      try {
        const hit = await lookup(client, id, h.name || h.symbol);
        if (hit) {
          ltp = hit.ltp ?? ltp; sym = hit.sym ?? sym; // resolved official ticker, e.g. "RELIANCE INDUSTRIES" -> RELIANCE
          tools ??= (await client.listTools()).tools as Tool[];
          t = technicals(await fetchCandles(client, tools, hit.token, "NSE", sym ?? canonical(h.symbol)), ltp);
          await sleep(350);
        }
      } catch { /* keep any earlier result */ }
    }
    const f = await getFundamentals(sym ?? id.split(":")[1], ltp ?? h.price ?? h.avg ?? 0, maxAge).catch(() => null);
    next[id] = { t, f, ltp, sym, at: new Date().toISOString() };
  }
  const prevAll = readJson<ExtScreen>(sessionFile(sid, "extscreen")) ?? {};
  for (const [k, v] of Object.entries(prevAll)) if (k.includes(":") && !k.startsWith("NSE:") && !(k in next)) next[k] = v; // keep US entries written by screenUs
  fs.writeFileSync(sessionFile(sid, "extscreen"), JSON.stringify(next));
}

/** US stocks (e.g. Vested): same technicals + fundamentals pipeline as Indian stocks, fed from Yahoo Finance instead of Kite/screener.in. */
async function screenUs(sid: string, us: ExtHolding[]): Promise<void> {
  const cache = readJson<ExtScreen>(sessionFile(sid, "extscreen")) ?? {};
  const maxAge = Number(((loadRules() as Rules).fundamentals_max_age_days as number) ?? 30);
  for (const h of us) {
    const id = extId(h), prev = cache[id];
    let { t, f, ltp, sym } = { t: prev?.t ?? null, f: prev?.f ?? null, ltp: prev?.ltp, sym: prev?.sym };
    try {
      sym ??= (await resolveUsTicker(cleanSym(h.symbol), h.name)) ?? undefined;
      if (sym) {
        const c = await fetchUsCandles(sym);
        ltp = c.ltp ?? ltp;
        t = technicals(c.candles, ltp) ?? t;
        const stale = !f || (Date.now() - new Date(f.as_of).getTime()) / 864e5 > maxAge;
        if (stale) f = (await fetchUsFundamentals(sym, ltp ?? h.price ?? h.avg ?? 0).catch(() => null)) ?? f;
      }
    } catch { /* keep any earlier result */ }
    cache[id] = { t, f, ltp, sym, at: new Date().toISOString() };
    await sleep(300);
  }
  fs.writeFileSync(sessionFile(sid, "extscreen"), JSON.stringify(cache));
}

/** The saved Kite report plus the user's imported holdings (USD converted at `fx`). Null until Kite has been connected once. */
export function loadMergedReport(sid: string | null, fx = 88): Report | null {
  const base = loadSessionReport(sid);
  if (!base || !sid) return base;
  const ext = loadExternal(sid);
  if (!ext.length) return base;
  const cache = readJson<ExtScreen>(sessionFile(sid, "extscreen")) ?? {};
  const rules = loadRules() as Rules;
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
    if (cur) { cur.qty += h.qty; cur.cost += cost; cur.value += value; cur.avg = cur.cost / cur.qty; } // same stock also held on Kite
    else lines.set(id, { id, qty: h.qty, avg: cost / h.qty, ltp: px || cost / h.qty, value, cost, imported: true });
    if (!results.has(id)) {
      const sc = score(id, px, c?.t ?? null, c?.f ?? null, rules);
      const line = lines.get(id)!;
      const r: ScreenResult = { ...sc, sources: ["holding"], score: 0, holding: { quantity: line.qty, average_price: line.avg, pnl: line.value - line.cost, pnl_pct: line.cost > 0 ? ((line.value - line.cost) / line.cost) * 100 : 0 } };
      if (!c?.f && !isIndian(h) && !isUS(h)) r.fundamentals = { as_of: "", source: "", sector: h.assetClass, pe: null, pb: null, roe: null, roce: null, debt_to_equity: null, sales_growth_3y: null, profit_growth_3y: null, dividend_yield: null, notes: "Imported holding" };
      r.score = quantScore(r).score;
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
    t.qty += l.qty; t.cost += l.cost; t.value += l.value; t.avg = t.qty ? t.cost / t.qty : t.avg; t.imported = t.imported && l.imported;
    lines.delete(id); results.delete(id);
    const r = results.get(first);
    if (r?.holding) r.holding = { quantity: t.qty, average_price: t.avg, pnl: t.value - t.cost, pnl_pct: t.cost > 0 ? ((t.value - t.cost) / t.cost) * 100 : 0 };
  }
  const hv = [...lines.values()].sort((a, b) => b.value - a.value);
  return {
    ...base, holdings_by_value: hv, holdings_total_value: hv.reduce((a, b) => a + b.value, 0), holdings_total_cost: hv.reduce((a, b) => a + b.cost, 0), results: [...results.values()],
    ext_lines: extLines, kite_total_value: base.holdings_by_value.reduce((a, b) => a + b.value, 0), kite_total_cost: base.holdings_by_value.reduce((a, b) => a + b.cost, 0),
  };
}

/** Resolve spelling variants of every imported stock to one NSE symbol before rendering (cached, so only the first call is slow). */
export async function ensureAliases(sid: string | null): Promise<void> {
  if (!sid) return;
  const ext = loadExternal(sid).filter(isIndian);
  if (!ext.length) return;
  const kite = (loadSessionReport(sid)?.holdings_by_value ?? []).map((h) => symbolOf(h.id));
  await resolveAliases(ext, kite).catch(() => {});
}
