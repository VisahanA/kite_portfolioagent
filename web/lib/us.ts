import type { Candle } from "./market";
import type { Fundamentals } from "./types";

// US stocks: daily candles and fundamentals from Yahoo Finance's public endpoints (no key). Output has the same
// shape as the Indian path (Candle[] -> technicals(), Fundamentals), so the same rules and quant score apply.
const UA = { "user-agent": "Mozilla/5.0 (portfolio-screen)", accept: "application/json" };
const num = (v: unknown): number | null => { const n = typeof v === "object" && v && "raw" in v ? (v as { raw: unknown }).raw : v; return typeof n === "number" && Number.isFinite(n) ? n : null; };
const r2 = (n: number) => Math.round(n * 100) / 100;

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Yahoo ${res.status}`);
  return res.json();
}

/** Turn a statement symbol or company name into a Yahoo ticker. */
export async function resolveUsTicker(symbol: string, name: string): Promise<string | null> {
  const s = symbol.trim().toUpperCase().replace(/\s+/g, "");
  if (/^[A-Z]{1,5}([.-][A-Z])?$/.test(s)) {
    try { const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=5d&interval=1d`); if (j?.chart?.result?.[0]) return s; } catch { /* try search */ }
  }
  try {
    const j = await getJson(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(name || symbol)}&quotesCount=6&newsCount=0`);
    const q = (j?.quotes ?? []).find((x: { quoteType?: string; symbol?: string }) => x.quoteType === "EQUITY" && x.symbol && !/\.[A-Z]{1,2}$/.test(x.symbol.replace(/\.[A-Z]$/, "")));
    return q?.symbol ?? null;
  } catch { return null; }
}

export async function fetchUsCandles(ticker: string): Promise<{ candles: Candle[]; ltp?: number }> {
  const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=2y&interval=1d`);
  const r = j?.chart?.result?.[0];
  if (!r?.timestamp) throw new Error(j?.chart?.error?.description ?? "No Yahoo candles");
  const q = r.indicators?.quote?.[0] ?? {};
  const candles: Candle[] = [];
  (r.timestamp as number[]).forEach((ts, i) => {
    const c = q.close?.[i];
    if (c == null || !Number.isFinite(c)) return;
    candles.push({ t: new Date(ts * 1000).toISOString(), o: +q.open[i] || c, h: +q.high[i] || c, l: +q.low[i] || c, c, v: +(q.volume?.[i] ?? 0) });
  });
  return { candles, ltp: num(r.meta?.regularMarketPrice) ?? undefined };
}

// Yahoo's quoteSummary needs a cookie + crumb pair; cache it for the process.
let auth: { cookie: string; crumb: string; at: number } | null = null;
async function getAuth() {
  if (auth && Date.now() - auth.at < 30 * 60e3) return auth;
  const r = await fetch("https://fc.yahoo.com", { headers: UA, redirect: "manual", signal: AbortSignal.timeout(10000) });
  const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const crumb = await (await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", { headers: { ...UA, cookie }, signal: AbortSignal.timeout(10000) })).text();
  if (!crumb || /<|Too Many/.test(crumb)) throw new Error("Yahoo crumb unavailable");
  return (auth = { cookie, crumb, at: Date.now() });
}

/** Annual series (oldest -> newest) from Yahoo's fundamentals-timeseries endpoint. */
async function series(ticker: string, types: string[]): Promise<Record<string, number[]>> {
  const now = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(ticker)}?type=${types.map((t) => (t.startsWith("trailing") ? t : "annual" + t)).join(",")}&period1=${now - 6 * 365 * 86400}&period2=${now}`;
  const out: Record<string, number[]> = {};
  try {
    const j = await getJson(url);
    for (const x of j?.timeseries?.result ?? []) {
      const key = String(x?.meta?.type?.[0] ?? "").replace(/^annual/, "");
      const rows = (x?.[x?.meta?.type?.[0]] ?? []) as { reportedValue?: { raw?: number } }[];
      out[key] = rows.map((v) => v?.reportedValue?.raw).filter((n): n is number => typeof n === "number");
    }
  } catch { /* growth/ROCE stay null */ }
  return out;
}
const cagr3 = (a?: number[]) => (a && a.length >= 4 && a.at(-4)! > 0 && a.at(-1)! > 0 ? r2((Math.pow(a.at(-1)! / a.at(-4)!, 1 / 3) - 1) * 100) : null);

export async function fetchUsFundamentals(ticker: string, price: number): Promise<Fundamentals | null> {
  let sum: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    const a = await getAuth();
    const j = await getJson(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=defaultKeyStatistics,financialData,summaryProfile,summaryDetail,price&crumb=${encodeURIComponent(a.crumb)}`, { cookie: a.cookie });
    sum = j?.quoteSummary?.result?.[0] ?? {};
  } catch { auth = null; }
  const ts = await series(ticker, ["TotalRevenue", "NetIncome", "EBIT", "TotalAssets", "CurrentLiabilities", "StockholdersEquity", "TotalDebt", "trailingPeRatio", "trailingPbRatio"]);
  const fd = sum.financialData ?? {}, ks = sum.defaultKeyStatistics ?? {}, sd = sum.summaryDetail ?? {}, sp = sum.summaryProfile ?? {};
  if (!Object.keys(sum).length && !Object.keys(ts).length) return null;

  const pe = num(sd.trailingPE) ?? num(ks.trailingPE) ?? ts.trailingPeRatio?.at(-1) ?? null;
  const bvps = num(ks.bookValue);
  const pb = num(ks.priceToBook) ?? ts.trailingPbRatio?.at(-1) ?? (bvps && price ? r2(price / bvps) : null);
  const eq = ts.StockholdersEquity?.at(-1), ni = ts.NetIncome?.at(-1), debt = ts.TotalDebt?.at(-1);
  const roe = num(fd.returnOnEquity) ?? (ni != null && eq != null && eq > 0 ? ni / eq : null);
  const de = num(fd.debtToEquity) ?? (debt != null && eq != null && eq > 0 ? (debt / eq) * 100 : null); // Yahoo reports this in percent
  const ebit = ts.EBIT?.at(-1), ta = ts.TotalAssets?.at(-1), cl = ts.CurrentLiabilities?.at(-1);
  const roce = ebit != null && ta != null && cl != null && ta - cl > 0 ? r2((ebit / (ta - cl)) * 100) : null;
  const sector = `${sp.industry ?? ""} ${sp.sector ?? ""}`;
  const dy = num(sd.dividendYield);
  return {
    as_of: new Date().toISOString().slice(0, 10), source: `https://finance.yahoo.com/quote/${ticker}`,
    sector: sp.industry || sp.sector || "Unclassified",
    is_financial: /bank|financ|insurance|capital markets|credit/i.test(sector),
    pe: pe != null && pe > 0 ? r2(pe) : null, pb: pb != null ? r2(pb) : null,
    roe: roe != null ? r2(roe * 100) : null, roce,
    debt_to_equity: de != null ? r2(de / 100) : null,
    sales_growth_3y: cagr3(ts.TotalRevenue), profit_growth_3y: cagr3(ts.NetIncome),
    dividend_yield: dy != null ? r2(dy * 100) : null,
    notes: "US stock: Yahoo Finance public data (3y growth = CAGR of annual revenue / net income).",
  };
}
