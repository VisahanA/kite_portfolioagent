import { hasClaude, llmJson } from "./llm";
import { dataFile, readJson, writeJson } from "./store";

// Maps any spelling a broker uses ("BHARTI AIRTEL LTD", "BHARTIARTL-EQ", "Bharti Artl") to ONE official NSE trading symbol.
// Public market knowledge, so the alias table is shared by all users: data/symbol-aliases.json
const file = () => dataFile("symbol-aliases.json");
type Aliases = Record<string, string>;

const readAll = () => readJson<Aliases>(file()) ?? {};
const save = (a: Aliases) => writeJson(file(), a, { pretty: true, optional: true }); // read-only deploy: optional

/** Drop the exchange prefix/suffix (NSE:, .NS, .BO) and the series suffix (-EQ, -BE, -BZ, -T...). */
const stripListing = (s: string) =>
  s.toUpperCase().trim().replace(/^(NSE|BSE)[:\s]+/, "").replace(/\.(NS|NSE|BO|BSE)$/, "").replace(/-(EQ|BE|BZ|BL|SM|ST|T|N\d)$/, "");

/** Trading-symbol form of a broker's symbol, hyphens kept: "NSE:BAJAJ-AUTO-EQ" -> "BAJAJ-AUTO". */
export const tickerOf = (s: string) => stripListing(s).replace(/[^A-Z0-9&-]/g, "");

/** Matching key that also drops company words and punctuation: "NSE:Reliance Industries Ltd-EQ" -> "RELIANCEINDUSTRIES". */
export const key = (s: string) =>
  stripListing(s).replace(/\b(LIMITED|LTD|CORPORATION|CORP|INDIA|CO|THE)\b\.?/g, " ").replace(/[^A-Z0-9&]/g, "");

const lev = (a: string, b: string) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};

/** Deterministic fallback: closest known symbol if it is a near-miss (BHARTIARTL vs BHARTIAIRTEL). */
function fuzzy(k: string, known: string[]): string | null {
  let best: string | null = null, bd = 99;
  for (const s of known) { const d = lev(k, s); if (d < bd) { bd = d; best = s; } }
  return best && bd <= Math.max(1, Math.floor(Math.min(k.length, best.length) / 5)) ? best : null;
}

/** Resolve a raw symbol/name using only the cache (sync, safe to call while rendering). */
export function canonical(raw: string): string {
  const k = key(raw);
  return readAll()[k] ?? k;
}

/**
 * Make sure every raw name has an alias entry. `known` = symbols already trusted (Kite holdings, earlier aliases values).
 * Unknown names go to Claude in ONE batched call; a fuzzy match is used if Claude is unavailable.
 */
export async function resolveAliases(raws: { symbol: string; name?: string }[], known: string[]): Promise<void> {
  const aliases = readAll();
  const trusted = new Set([...known.map(key), ...Object.values(aliases)]);
  const todo = new Map<string, string>(); // key -> display text
  for (const r of raws) {
    const k = key(r.symbol);
    if (!k || aliases[k] || trusted.has(k)) continue;
    todo.set(k, [r.symbol, r.name].filter(Boolean).join(" | "));
  }
  if (!todo.size) return;

  let changed = false;
  if (hasClaude()) {
    try {
      const j = await llmJson<Record<string, string | null>>(
        "You normalise Indian stock names to the official NSE trading symbol (as in NSE's equity list, e.g. BHARTIARTL, HDFCBANK, M&M, BAJAJ-AUTO). Several spellings, typos or company names can map to one symbol. Reply with JSON only.",
        `Already-known symbols (prefer these if the input is the same company): ${[...new Set(known)].join(", ") || "none"}\n\nInputs (key => text):\n${[...todo].map(([k, t]) => `${k} => ${t}`).join("\n")}\n\nReturn {"<key>": "<NSE SYMBOL or null if unsure / not an NSE stock>"} for every key.`,
        1500,
      );
      for (const [k] of todo) {
        const v = j[k];
        if (typeof v === "string" && /^[A-Z0-9&-]{1,20}$/.test(v.toUpperCase())) { aliases[k] = v.toUpperCase(); changed = true; }
      }
    } catch { /* fall through to fuzzy */ }
  }
  const pool = [...new Set([...known.map(key), ...Object.values(aliases)])];
  for (const [k] of todo) if (!aliases[k]) { const f = fuzzy(k, pool); if (f) { aliases[k] = f; changed = true; } }
  if (changed) save(aliases);
}
