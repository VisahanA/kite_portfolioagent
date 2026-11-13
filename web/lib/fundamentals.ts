import { httpGet } from "./http";
import { daysSince, r2 } from "./num";
import { dataFile, readJson, writeJson } from "./store";
import type { Fundamentals } from "./types";

// Fundamentals come only from the public screener.in company page (it has no official API). Results are cached
// per trading symbol in data/fundamentals.json; that file is shared by all users because it is public market data.
const file = () => dataFile("fundamentals.json");
const readAll = () => readJson<Record<string, Fundamentals>>(file()) ?? {};
const save = (sym: string, f: Fundamentals) => writeJson(file(), { ...readAll(), [sym]: f }, { pretty: true, optional: true }); // read-only deploy: the cache is optional

const num = (s: string | undefined | null) => { if (!s) return null; const n = parseFloat(s.replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
const strip = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

async function page(url: string): Promise<string | null> {
  const res = await httpGet(url, { redirect: "follow" });
  return res.ok ? await res.text() : null;
}

async function findHtml(symbol: string): Promise<{ html: string; url: string } | null> {
  const s = encodeURIComponent(symbol);
  for (const u of [`https://www.screener.in/company/${s}/consolidated/`, `https://www.screener.in/company/${s}/`]) {
    const html = await page(u).catch(() => null);
    if (html && html.includes('id="top-ratios"')) return { html, url: u };
  }
  // Some listings (e.g. BSE-only) sit under another id: use screener's own search to find the page.
  try {
    const res = await httpGet(`https://www.screener.in/api/company/search/?q=${s}`, { timeoutMs: 10000 });
    const hit = ((await res.json()) as { url?: string }[])?.[0]?.url;
    if (hit) {
      const u = `https://www.screener.in${hit}`;
      const html = await page(u).catch(() => null);
      if (html?.includes('id="top-ratios"')) return { html, url: u };
    }
  } catch { /* fall through */ }
  return null;
}

function parse(html: string, url: string, price: number): Fundamentals {
  const top: Record<string, string> = {};
  const ul = html.match(/id="top-ratios"[\s\S]*?<\/ul>/)?.[0] ?? "";
  for (const li of ul.match(/<li[\s\S]*?<\/li>/g) ?? []) {
    const name = strip(li.match(/class="name"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? "");
    const val = li.match(/class="number"[^>]*>([^<]*)</)?.[1];
    if (name && val != null) top[name] = val;
  }
  const row = (id: string, label: RegExp) => {
    const sec = html.match(new RegExp(`id="${id}"[\\s\\S]*?</section>`))?.[0] ?? "";
    for (const tr of sec.match(/<tr[\s\S]*?<\/tr>/g) ?? []) {
      const cells = (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/g) ?? []).map(strip);
      if (cells[0] && label.test(cells[0])) return num(cells.slice(1).reverse().find((c) => c !== ""));
    }
    return null;
  };
  const growth = (title: string) => {
    const t = html.match(new RegExp(`${title}[\\s\\S]*?</table>`))?.[0] ?? "";
    return num(t.match(/3 Years:<\/td>\s*<td>([^<]*)</)?.[1]?.replace("%", ""));
  };
  const borrow = row("balance-sheet", /^Borrowings/), eq = row("balance-sheet", /^Equity Capital/), res = row("balance-sheet", /^Reserves/);
  const bv = num(top["Book Value"]);
  const sector = strip(html.match(/title="Broad Sector"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? html.match(/title="Sector"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "");
  const industry = strip(html.match(/title="Industry"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "");
  return {
    as_of: new Date().toISOString().slice(0, 10), source: url, sector: industry || sector || "Unclassified",
    is_financial: /bank|financ|insurance|nbfc|capital markets/i.test(`${sector} ${industry}`),
    pe: num(top["Stock P/E"]), pb: bv && price ? r2(price / bv) : null,
    roe: num(top["ROE"]), roce: num(top["ROCE"]),
    debt_to_equity: borrow != null && eq != null && res != null && eq + res > 0 ? r2(borrow / (eq + res)) : null,
    sales_growth_3y: growth("Compounded Sales Growth"), profit_growth_3y: growth("Compounded Profit Growth"),
    dividend_yield: num(top["Dividend Yield"]), market_cap_cr: num(top["Market Cap"]),
    notes: "From the screener.in public company page.",
  };
}

/** Cached fundamentals if fresh enough, otherwise fetched from screener.in. Null when the site has nothing (shows as NO FUNDAMENTALS). */
export async function getFundamentals(symbol: string, price: number, maxAgeDays: number): Promise<Fundamentals | null> {
  const cached = readAll()[symbol];
  if (cached && daysSince(cached.as_of) <= maxAgeDays) return cached;
  try {
    const found = await findHtml(symbol);
    if (!found) return cached ?? null;
    const f = parse(found.html, found.url, price);
    save(symbol, f);
    return f;
  } catch { return cached ?? null; }
}
