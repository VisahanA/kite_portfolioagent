import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { readJson, sessionFile } from "./session";

const MCP_URL = process.env.KITE_MCP_URL || "https://mcp.kite.trade/mcp";
// Deployed: set APP_URL (e.g. https://portfolio.example.com). Locally the redirect is derived from the request origin.
export const redirectFor = (origin: string) => process.env.KITE_OAUTH_REDIRECT || `${process.env.APP_URL || origin}/api/kite/callback`;

type Store = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string };
const read = (sid: string): Store => readJson<Store>(sessionFile(sid, "oauth")) ?? {};
const write = (sid: string, s: Store) => fs.writeFileSync(sessionFile(sid, "oauth"), JSON.stringify(s, null, 2));

class Provider implements OAuthClientProvider {
  authUrl: URL | null = null;
  constructor(private sid: string, private redirect: string) {}
  get redirectUrl() { return this.redirect; }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "Portfolio Agent", redirect_uris: [this.redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  clientInformation() {
    const c = read(this.sid).client as { redirect_uris?: string[] } | undefined;
    return c && c.redirect_uris?.includes(this.redirect) ? (c as OAuthClientInformationMixed) : undefined; // re-register if the app URL changed
  }
  saveClientInformation(c: OAuthClientInformationMixed) { write(this.sid, { ...read(this.sid), client: c }); }
  tokens() { return read(this.sid).tokens; }
  saveTokens(t: OAuthTokens) { write(this.sid, { ...read(this.sid), tokens: t }); }
  saveCodeVerifier(v: string) { write(this.sid, { ...read(this.sid), verifier: v }); }
  codeVerifier() { return read(this.sid).verifier ?? ""; }
  redirectToAuthorization(u: URL) { this.authUrl = u; }
}

// One live MCP client per browser session; survives Next dev hot reloads.
type Live = { client: Client };
type Pending = { transport: StreamableHTTPClientTransport };
const g = globalThis as unknown as { __kiteLive?: Map<string, Live>; __kitePend?: Map<string, Pending> };
// New global names + instanceof guard: an older build kept a single object under the previous names across hot reloads.
const live = () => (g.__kiteLive instanceof Map ? g.__kiteLive : (g.__kiteLive = new Map()));
const pending = () => (g.__kitePend instanceof Map ? g.__kitePend : (g.__kitePend = new Map()));

export type Connect = { client: Client } | { authUrl: string };

export async function connect(sid: string, origin: string): Promise<Connect> {
  const hit = live().get(sid);
  if (hit) return { client: hit.client };
  const provider = new Provider(sid, redirectFor(origin));
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider });
  const client = new Client({ name: "portfolio-agent", version: "0.2.0" });
  try {
    await client.connect(transport);
  } catch (e) {
    if (e instanceof UnauthorizedError && provider.authUrl) {
      pending().set(sid, { transport });
      return { authUrl: provider.authUrl.toString() };
    }
    throw e;
  }
  live().set(sid, { client });
  return { client };
}

/** Called by the OAuth redirect: exchange the code, then the next connect() succeeds. */
export async function finishAuth(sid: string, code: string) {
  const p = pending().get(sid);
  if (!p) throw new Error("No pending Kite login for this browser. Click Connect Kite again.");
  await p.transport.finishAuth(code);
  pending().delete(sid);
}

/** The already-connected Kite client for this browser, or null. Never starts a login. */
export const liveClient = (sid: string): Client | null => live().get(sid)?.client ?? null;

export function disconnect(sid: string) {
  live().get(sid)?.client.close().catch(() => {});
  live().delete(sid);
}

/** Switch account: drop the live client, saved tokens and saved report for this browser. */
export function logout(sid: string) {
  disconnect(sid);
  pending().delete(sid);
  for (const k of ["oauth", "report", "extscreen"] as const) try { fs.rmSync(sessionFile(sid, k), { force: true }); } catch {}
}

export type Raw = Record<string, unknown>;
function textOf(res: unknown): string {
  const c = (res as { content?: { type: string; text?: string }[] }).content ?? [];
  return c.map((b) => (b.type === "text" ? b.text ?? "" : "")).join("");
}

export async function callHoldings(client: Client): Promise<Raw[]> {
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

