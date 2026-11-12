import fs from "node:fs";
import { extractText, getDocumentProxy } from "unpdf";
import { hasClaude, llm } from "./llm";
import { readJson, sessionFile } from "./session";

import { BROKERS, isBroker, type Broker, type ExtHolding } from "./brokers";
export { BROKERS, isBroker, type Broker, type ExtHolding };

export const loadExternal = (sid: string | null): ExtHolding[] => (sid ? readJson<ExtHolding[]>(sessionFile(sid, "external")) ?? [] : []);
export const saveExternal = (sid: string, h: ExtHolding[]) => fs.writeFileSync(sessionFile(sid, "external"), JSON.stringify(h));

/** Replace everything previously imported for `broker` with `rows`. */
export function replaceBroker(sid: string, broker: Broker, rows: ExtHolding[]): ExtHolding[] {
  const next = [...loadExternal(sid).filter((h) => h.broker !== broker), ...rows.map((r) => ({ ...r, broker }))];
  saveExternal(sid, next);
  return next;
}

export async function pdfText(buf: Uint8Array, password?: string): Promise<string> {
  const pdf = await getDocumentProxy(buf, password ? { password } : {});
  const { text } = await extractText(pdf, { mergePages: false });
  return (Array.isArray(text) ? text : [text]).join("\n");
}

// ---------- heuristic parser (works on typical "name ... qty avg price value" holding rows) ----------
const SKIP = /\b(total|grand|page|statement|balance|opening|closing|charges|brokerage|gst|stt|date|client|ledger|summary|net\s|pan\b|account|period)\b/i;
const NUM = /(?<![\w.])-?\(?[\d,]*\.?\d+\)?(?![\w])/g;
const toNum = (s: string) => { const n = Number(s.replace(/[(),]/g, "")); return Number.isFinite(n) ? n : NaN; };
const near = (a: number, b: number, tol = 0.02) => Math.abs(a - b) <= Math.max(0.5, Math.abs(b) * tol);

// ---------- header-driven parser: reads the statement's own column titles, then maps every row by position ----------
type Col = "name" | "ticker" | "currency" | "isin" | "qty" | "avg" | "price" | "value" | "invested" | "skip";
const TITLES: [RegExp, Col][] = [
  // "skip" titles first so "Investment Returns (%)" is not read as "returns"/"value"
  [/(?:investment\s+)?returns?\s*\(%\)|daily\s+change\s*\(%\)|day'?s?\s+change\s*\(%\)|(?:p&l|pnl|profit\s*(?:\/|and|&)?\s*loss|unrealised\s+p&l|gain\/loss)\s*\(?%?\)?|(?:investment\s+)?returns?|daily\s+change|day'?s?\s+change|change\s*\(%\)|net\s+change|% ?change|weight|allocation|xirr|cagr|unrealis?zed\s+(?:gain|loss|p&l|profit)(?:\s*\/\s*loss)?|realis?zed\s+(?:gain|p&l)|gain(?:\s*\/\s*loss)?/i, "skip"],
  [/total\s+amount\s+invested|amount\s+invested|invested\s+(?:amount|value)|buy\s+value|cost\s+value|total\s+cost|purchase\s+value|investment\s+value|invested/i, "invested"],
  [/total\s+shares\s+held|shares\s+held|total\s+quantity|total\s+qty|quantity|qty\.?|shares|units|balance\s+qty/i, "qty"],
  [/average\s+(?:buy\s+)?(?:cost|price)|avg\.?\s+(?:buy\s+)?(?:cost|price|rate)|buy\s+avg|purchase\s+price|buy\s+price|cost\s+price/i, "avg"],
  [/current\s+equity\s+value|current\s+(?:value|amount)|market\s+value|present\s+value|current\s+market\s+value|holding\s+value|value/i, "value"],
  [/current\s+price|market\s+price|last\s+(?:traded\s+)?price|closing\s+price|close\s+price|current\s+rate|market\s+rate|ltp|cmp|price/i, "price"],
  [/currency/i, "currency"],
  [/isin/i, "isin"],
  [/ticker|symbol|scrip\s+code|trading\s+symbol|coin\s+symbol/i, "ticker"],
  [/stock\s+name|security\s+name|scrip\s+name|company\s+name|instrument|asset\s+name|coin\s+name|security|scrip|company|coin|asset|name/i, "name"],
];
const TITLE_RE = new RegExp(TITLES.map(([r], i) => `(?<t${i}>${r.source})`).join("|"), "gi");

function headerCols(s: string): Col[] {
  const cols: Col[] = [];
  for (const m of s.matchAll(TITLE_RE)) {
    const i = TITLES.findIndex((_, x) => m.groups?.[`t${x}`] !== undefined);
    if (i >= 0) cols.push(TITLES[i][1]);
  }
  return cols;
}
/** Parse a CSV export (Axis Direct etc.): header cells are mapped with the same titles as the PDF parser. */
export function fromCsv(text: string, broker: Broker): ExtHolding[] {
  const meta = BROKERS[broker];
  const src = text.replace(/^﻿/, "");
  const first = src.split(/\r?\n/, 1)[0] ?? "";
  const delim = [",", ";", "\t", "|"].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let cell = "", row: string[] = [], q = false;
  for (let i = 0; i < src.length; i++) { // RFC-4180 style: quotes, escaped quotes, newlines inside quotes
    const ch = src[i];
    if (q) { if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && src[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some((c) => c.trim())) rows.push(row); row = []; }
    else cell += ch;
  }
  row.push(cell); if (row.some((c) => c.trim())) rows.push(row);

  const hi = rows.findIndex((r) => { const c = r.map((x) => headerCols(x)[0]); return c.includes("qty") && (c.includes("name") || c.includes("ticker")) && c.filter((x) => x && !TEXT_COLS.includes(x) && x !== "qty").length >= 1; });
  if (hi < 0) return [];
  const cols = rows[hi].map((x) => headerCols(x)[0] ?? "skip");
  const out: ExtHolding[] = [];
  for (const r of rows.slice(hi + 1)) {
    const get = (c: Col) => { const i = cols.indexOf(c); return i >= 0 ? (r[i] ?? "").trim() : ""; };
    const num = (c: Col) => { const s = get(c).replace(/^'+/, "").replace(/[₹$,\s]/g, ""); return s && /\d/.test(s) ? tokNum(s) : null; };
    const name = get("name"), ticker = get("ticker"), qty = num("qty") ?? 0;
    if (!(qty > 0) || !(name || ticker) || /^(total|grand)\b/i.test(name || ticker)) continue;
    const price = num("price"), value = num("value"), invested = num("invested");
    const avg = num("avg") ?? (invested != null ? invested / qty : null);
    const cur = get("currency").toUpperCase();
    out.push({
      broker, symbol: (ticker || name).toUpperCase(), name: name || ticker, qty,
      avg: avg && avg > 0 ? Math.round(avg * 1e6) / 1e6 : null,
      price: price ?? (value != null ? value / qty : null), value: value ?? (price != null ? qty * price : null),
      currency: cur === "USD" ? "USD" : cur === "INR" ? "INR" : meta.currency, assetClass: meta.assetClass,
    });
  }
  return out;
}

const TEXT_COLS: Col[] = ["name", "ticker", "currency", "isin"];
const isNumTok = (t: string) => /^[-+(]?[₹$]?[-+]?[\d,]*\.?\d+%?\)?$/.test(t) || /^(-{1,2}|n\/?a|nil)$/i.test(t);
const tokNum = (t: string): number | null => {
  if (/^(-{1,2}|n\/?a|nil)$/i.test(t)) return null;
  const neg = /^\(.*\)$/.test(t) || t.includes("-");
  const n = Number(t.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
};
const ISO = /^(USD|INR|EUR|GBP|AED|SGD)$/;

export function byHeader(text: string, broker: Broker): ExtHolding[] {
  const meta = BROKERS[broker];
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  // 1. find the header: one to three consecutive lines that name a quantity column and at least two other numeric columns
  let cols: Col[] = [], start = -1;
  for (let i = 0; i < lines.length && start < 0; i++) {
    for (let span = 1; span <= 3 && i + span <= lines.length; span++) {
      const c = headerCols(lines.slice(i, i + span).join(" "));
      const num = c.filter((x) => !TEXT_COLS.includes(x));
      if (c.includes("qty") && num.filter((x) => x !== "qty").length >= 2 && (c.includes("name") || c.includes("ticker"))) { cols = c; start = i + span; break; }
    }
  }
  if (start < 0) return [];
  const numCols = cols.filter((c) => !TEXT_COLS.includes(c));
  const textCols = cols.filter((c) => TEXT_COLS.includes(c));
  const tickerFirst = textCols.indexOf("ticker") >= 0 && textCols.indexOf("ticker") < Math.max(0, textCols.indexOf("name"));
  const n = numCols.length;
  // 2. parse each row: the last n tokens are the numeric columns, whatever is in front is name / ticker / currency / isin
  const out: ExtHolding[] = [];
  let carry = ""; // a wrapped name line sitting above its numbers
  for (const line of lines.slice(start)) {
    const toks = line.split(" ");
    let k = toks.length;
    while (k > 0 && toks.length - k < n && isNumTok(toks[k - 1])) k--;
    const tail = toks.slice(k);
    if (tail.length < n) { // not a data row; remember it as a possible wrapped name unless it looks like a footer
      carry = /^(total|grand|net|summary|note|disclaimer|page|statement|as on|as of)\b/i.test(line) || headerCols(line).length >= 3 ? "" : line;
      continue;
    }
    let pre = toks.slice(0, k);
    if (!pre.length && carry) pre = carry.split(" ");
    carry = "";
    if (!pre.length || /^(total|grand)\b/i.test(pre.join(" "))) continue;
    let currency: "INR" | "USD" = meta.currency, ticker = "", isin = "";
    const ci = pre.findIndex((t) => ISO.test(t));
    if (ci >= 0 && cols.includes("currency")) { currency = pre[ci] === "USD" ? "USD" : "INR"; pre = pre.filter((_, x) => x !== ci); }
    const ii = pre.findIndex((t) => /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(t));
    if (ii >= 0) { isin = pre[ii]; pre = pre.filter((_, x) => x !== ii); }
    if (cols.includes("ticker") && pre.length > 1) ticker = tickerFirst ? pre.shift()! : pre.pop()!;
    const name = pre.join(" ").trim();
    const val: Partial<Record<Col, number | null>> = {};
    numCols.forEach((c, x) => { if (c !== "skip" && val[c] === undefined) val[c] = tokNum(tail[x]); });
    const qty = val.qty ?? 0;
    if (!(qty > 0) || !/[A-Za-z]/.test(name + ticker)) continue;
    const symbol = (ticker || (isin && !name ? isin : name)).toUpperCase();
    const avg = val.avg ?? (val.invested != null ? val.invested / qty : null);
    const price = val.price ?? (val.value != null ? val.value / qty : null);
    out.push({ broker, symbol, name: name || symbol, qty, avg: avg && avg > 0 ? Math.round(avg * 1e6) / 1e6 : null, price: price && price > 0 ? price : null, value: val.value ?? (price ? qty * price : null), currency, assetClass: meta.assetClass });
  }
  return out;
}

export function heuristic(text: string, broker: Broker): ExtHolding[] {
  const meta = BROKERS[broker], out: ExtHolding[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[₹$]|INR|USD|Rs\.?/gi, " ").replace(/\s+/g, " ").trim();
    if (line.length < 6 || SKIP.test(line)) continue;
    const first = line.search(/(?<![A-Za-z])-?\d/);
    if (first <= 0) continue;
    const label = line.slice(0, first).replace(/\bINE[0-9A-Z]{9}\b/g, "").trim();
    if (!/[A-Za-z]{3}/.test(label) || /^(USD|INR)$/i.test(label)) continue;
    const nums = (line.slice(first).match(NUM) ?? []).map(toNum).filter((n) => !Number.isNaN(n));
    if (nums.length < 2) continue;
    // find qty * price ~ value among the numbers; the avg price is another number
    let qty = NaN, price: number | null = null, value: number | null = null, avg: number | null = null;
    outer: for (let i = 0; i < nums.length; i++) for (let j = 0; j < nums.length; j++) for (let k = 0; k < nums.length; k++) {
      if (i === j || j === k || i === k || nums[i] <= 0 || nums[j] <= 0 || nums[k] <= 0) continue;
      if (nums[k] > nums[j] && near(nums[i] * nums[j], nums[k], 0.01)) {
        qty = nums[i]; price = nums[j]; value = nums[k];
        const rest = nums.filter((_, x) => x !== i && x !== j && x !== k);
        avg = rest.length ? rest[0] : null;
        break outer;
      }
    }
    if (Number.isNaN(qty)) { qty = nums[0]; avg = nums[1]; } // fall back to "qty avg"
    if (!(qty > 0)) continue;
    const tok = label.split(" ").find((t) => /^[A-Z][A-Z0-9&.-]{0,14}$/.test(t));
    const symbol = (tok ?? label.split(" ")[0]).toUpperCase();
    out.push({ broker, symbol, name: label, qty, avg: avg && avg > 0 ? avg : null, price, value, currency: meta.currency, assetClass: meta.assetClass });
  }
  return out;
}

// ---------- optional model parser (used only when the heuristic finds nothing) ----------
async function viaModel(text: string, broker: Broker): Promise<ExtHolding[]> {
  const meta = BROKERS[broker];
  const reply = await llm(
    "You extract holdings from broker statements. Reply with a JSON array only.",
    `Broker: ${meta.label} (${meta.currency}, ${meta.assetClass}). From this statement text list every current holding as {"symbol":string,"name":string,"qty":number,"avg":number|null (average buy price per unit),"price":number|null (last price per unit),"value":number|null (current value)}. Ignore totals, transactions, charges and cash. Text:\n${text.slice(0, 30000)}`,
    4000,
  );
  const arr = JSON.parse(reply.slice(reply.indexOf("["), reply.lastIndexOf("]") + 1));
  return (arr as Partial<ExtHolding>[]).filter((x) => x.symbol && Number(x.qty) > 0).map((x) => ({
    broker, symbol: String(x.symbol).toUpperCase(), name: String(x.name ?? x.symbol), qty: Number(x.qty),
    avg: x.avg != null ? Number(x.avg) : null, price: x.price != null ? Number(x.price) : null, value: x.value != null ? Number(x.value) : null,
    currency: meta.currency, assetClass: meta.assetClass,
  }));
}

export async function parseStatement(buf: Uint8Array, broker: Broker, password?: string, kind: "pdf" | "csv" = "pdf"): Promise<{ holdings: ExtHolding[]; method: "table" | "claude"; chars: number }> {
  if (kind === "csv") {
    const csv = new TextDecoder("utf-8").decode(buf);
    return { holdings: fromCsv(csv, broker), method: "table", chars: csv.length };
  }
  const text = await pdfText(buf, password);
  let holdings = byHeader(text, broker);
  if (!holdings.length) holdings = heuristic(text, broker); // unknown layout: guess columns from qty x price = value
  if (holdings.length) return { holdings, method: "table", chars: text.length };
  if (hasClaude() && text.trim()) { holdings = await viaModel(text, broker); return { holdings, method: "claude", chars: text.length }; }
  return { holdings: [], method: "table", chars: text.length };
}
