import { XMLParser } from "fast-xml-parser";
import { httpGet } from "./http";
import type { Headline } from "./types";

// Company names make the news query precise (bare tickers like BSE / ITC are ambiguous).
const NAMES: Record<string, string> = {
  BHARTIARTL: "Bharti Airtel", BSE: "BSE Ltd Bombay Stock Exchange", PIIND: "PI Industries", CDSL: "CDSL Central Depository",
  DIXON: "Dixon Technologies", WAAREEENER: "Waaree Energies", HDFCBANK: "HDFC Bank", ITC: "ITC Ltd", PRICOLLTD: "Pricol",
  NSDL: "NSDL National Securities Depository", SUPREMEIND: "Supreme Industries", ADANIPOWER: "Adani Power", WENDT: "Wendt India",
  TATATECH: "Tata Technologies", RELIANCE: "Reliance Industries",
};

const cache = new Map<string, { at: number; items: Headline[] }>();
const TTL = 30 * 60 * 1000;

export async function fetchNews(symbol: string, limit = 12): Promise<Headline[]> {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < TTL) return hit.items;
  // Only the company name goes out in the query; no quantities or portfolio data.
  const q = `${NAMES[symbol] ?? symbol} share stock when:14d`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-IN&gl=IN&ceid=IN:en`;
  const res = await httpGet(url, { timeoutMs: 12000 });
  if (!res.ok) throw new Error(`news feed ${res.status}`);
  const xml = new XMLParser({ ignoreAttributes: false }).parse(await res.text());
  const raw = xml?.rss?.channel?.item ?? [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const seen = new Set<string>();
  const items: Headline[] = [];
  for (const it of arr) {
    const src = typeof it.source === "object" ? it.source["#text"] : it.source;
    let title = String(it.title ?? "");
    if (src && title.endsWith(` - ${src}`)) title = title.slice(0, -(src.length + 3));
    const key = title.toLowerCase().slice(0, 60);
    if (!title || seen.has(key)) continue;
    seen.add(key);
    items.push({ title, source: src ?? "", link: it.link ?? "", published: it.pubDate ? new Date(it.pubDate).toISOString() : "" });
    if (items.length >= limit) break;
  }
  cache.set(symbol, { at: Date.now(), items });
  return items;
}
