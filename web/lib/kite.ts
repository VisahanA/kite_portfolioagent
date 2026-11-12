import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { dataDir } from "./data";
import type { Report } from "./types";

const MCP_URL = process.env.KITE_MCP_URL || "https://mcp.kite.trade/mcp";
const REDIRECT = process.env.KITE_OAUTH_REDIRECT || "http://localhost:3000/api/kite/callback";
const STORE = path.resolve(process.cwd(), ".kite-oauth.json"); // holds OAuth tokens: gitignored

type Store = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string };
const read = (): Store => { try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return {}; } };
const write = (s: Store) => fs.writeFileSync(STORE, JSON.stringify(s, null, 2));

class Provider implements OAuthClientProvider {
  authUrl: URL | null = null;
  get redirectUrl() { return REDIRECT; }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "Portfolio Agent (local)", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  clientInformation() { return read().client; }
  saveClientInformation(c: OAuthClientInformationMixed) { write({ ...read(), client: c }); }
  tokens() { return read().tokens; }
  saveTokens(t: OAuthTokens) { write({ ...read(), tokens: t }); }
  saveCodeVerifier(v: string) { write({ ...read(), verifier: v }); }
  codeVerifier() { return read().verifier ?? ""; }
  redirectToAuthorization(u: URL) { this.authUrl = u; }
}

// Survive Next dev hot reloads: keep the live client/transport on globalThis.
const g = globalThis as unknown as { __kite?: { client: Client; provider: Provider } | null; __kitePending?: { transport: StreamableHTTPClientTransport; provider: Provider } | null };

export type Connect = { client: Client } | { authUrl: string };

async function connect(): Promise<Connect> {
  if (g.__kite) return { client: g.__kite.client };
  const provider = new Provider();
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider });
  const client = new Client({ name: "portfolio-agent", version: "0.1.0" });
  try {
    await client.connect(transport);
  } catch (e) {
    if (e instanceof UnauthorizedError && provider.authUrl) {
      g.__kitePending = { transport, provider };
      return { authUrl: provider.authUrl.toString() };
    }
    throw e;
  }
  g.__kite = { client, provider };
  return { client };
}

/** Called by the OAuth redirect: exchange the code, then the next connect() succeeds. */
export async function finishAuth(code: string) {
  const p = g.__kitePending;
  if (!p) throw new Error("No pending Kite login. Click Run agents again.");
  await p.transport.finishAuth(code);
  g.__kitePending = null;
}

export function disconnect() {
  g.__kite?.client.close().catch(() => {});
  g.__kite = null;
}

type Raw = Record<string, unknown>;
function textOf(res: unknown): string {
  const c = (res as { content?: { type: string; text?: string }[] }).content ?? [];
  return c.map((b) => (b.type === "text" ? b.text ?? "" : "")).join("");
}

async function callHoldings(client: Client): Promise<Raw[]> {
  const tools = (await client.listTools()).tools;
  const direct = tools.find((t) => /^(get_)?holdings$/.test(t.name));
  const consolidated = tools.find((t) => t.name === "portfolio");
  if (!direct && !consolidated) throw new Error(`No holdings tool found. Server offers: ${tools.map((t) => t.name).join(", ")}`);
  const all: Raw[] = [];
  for (let from = 0, guard = 0; guard < 20; guard++) {
    const res = await client.callTool(direct ? { name: direct.name, arguments: {} } : { name: "portfolio", arguments: { mode: "holdings", from } });
    const text = textOf(res);
    if ((res as { isError?: boolean }).isError) throw new Error(text || "Kite returned an error");
    let json: unknown;
    try { json = JSON.parse(text); } catch { throw new Error(text.slice(0, 300) || "Kite returned non-JSON"); }
    const data = Array.isArray(json) ? json : (json as { data?: Raw[] }).data;
    if (!Array.isArray(data)) throw new Error("Unexpected holdings response shape");
    all.push(...data);
    const pg = (json as { pagination?: { has_more?: boolean; returned?: number } }).pagination;
    if (!pg?.has_more) break;
    from += pg.returned ?? data.length;
  }
  return all;
}

export type Refresh =
  | { status: "auth"; authUrl: string }
  | { status: "ok"; file: string; report: Report; missing: string[]; fetchedAt: string };

/** Fetch live holdings from the Kite MCP server and write them into today's screen report. */
export async function refreshHoldings(latest: { report: Report; file: string }): Promise<Refresh> {
  const c = await connect();
  if ("authUrl" in c) return { status: "auth", authUrl: c.authUrl };
  let raw: Raw[];
  try { raw = await callHoldings(c.client); } catch (e) { disconnect(); throw e; }

  // Kite can list the same stock on NSE or BSE from one call to the next, so match the exact id first,
  // then fall back to the trading symbol and keep the report's id. Lines that map to the same stock are merged.
  const known = new Set(latest.report.results.map((r) => r.id));
  const bySymbol = new Map<string, string>();
  for (const r of latest.report.results) {
    const s = r.id.split(":").pop()!;
    if (!bySymbol.has(s) || r.sources.includes("holding")) bySymbol.set(s, r.id);
  }
  const missing: string[] = [];
  const merged = new Map<string, { qty: number; cost: number; value: number; ltp: number }>();
  for (const h of raw) {
    const raw_id = `${h.exchange}:${h.tradingsymbol}`;
    const qty = Number(h.quantity) + Number(h.t1_quantity ?? 0);
    if (!qty) continue;
    const id = known.has(raw_id) ? raw_id : bySymbol.get(String(h.tradingsymbol));
    if (!id) { missing.push(raw_id); continue; }
    const avg = Number(h.average_price), ltp = Number(h.last_price) || Number(h.close_price);
    const m = merged.get(id) ?? { qty: 0, cost: 0, value: 0, ltp };
    m.qty += qty; m.cost += qty * avg; m.value += qty * ltp; m.ltp = ltp;
    merged.set(id, m);
  }
  const hs = [...merged].map(([id, m]) => ({
    id, qty: m.qty, avg: Math.round((m.cost / m.qty) * 100) / 100, ltp: m.ltp,
    value: Math.round(m.value * 100) / 100, cost: Math.round(m.cost * 100) / 100,
  })).sort((a, b) => b.value - a.value);
  if (!hs.length) throw new Error("Kite returned no holdings that match the screened stocks.");

  const now = new Date();
  const report: Report = {
    ...latest.report,
    generated_at: now.toISOString(),
    holdings_by_value: hs,
    holdings_total_value: Math.round(hs.reduce((a, b) => a + b.value, 0) * 100) / 100,
    holdings_total_cost: Math.round(hs.reduce((a, b) => a + b.cost, 0) * 100) / 100,
  };
  const day = new Date(now.getTime() - now.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  const file = `screen-${day}.json`;
  fs.writeFileSync(path.join(dataDir(), "reports", file), JSON.stringify(report, null, 2));
  return { status: "ok", file, report, missing, fetchedAt: now.toISOString() };
}
