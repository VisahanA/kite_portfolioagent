import fs from "node:fs";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { callText, connectMcp, dataArray, StoredOAuthProvider, type OAuthStore, type Raw, type Tool } from "./mcp";
import { sessionFile } from "./session";
import { readJson, writeJson } from "./store";

const MCP_URL = process.env.KITE_MCP_URL || "https://mcp.kite.trade/mcp";
// Deployed: set APP_URL (e.g. https://portfolio.example.com). Locally the redirect is derived from the request origin.
const redirectFor = (origin: string) => process.env.KITE_OAUTH_REDIRECT || `${process.env.APP_URL || origin}/api/kite/callback`;

const providerFor = (sid: string, origin: string) => {
  const file = sessionFile(sid, "oauth");
  return new StoredOAuthProvider(redirectFor(origin), "Portfolio Agent", () => readJson<OAuthStore>(file) ?? {}, (s) => writeJson(file, s, { pretty: true }));
};

// One live MCP client per browser session; survives Next dev hot reloads.
const g = globalThis as unknown as { __kiteLive?: Map<string, Client>; __kitePend?: Map<string, StreamableHTTPClientTransport> };
// instanceof guard: an older build kept a different object under these names across hot reloads.
const live = () => (g.__kiteLive instanceof Map ? g.__kiteLive : (g.__kiteLive = new Map()));
const pending = () => (g.__kitePend instanceof Map ? g.__kitePend : (g.__kitePend = new Map()));

export async function connect(sid: string, origin: string): Promise<{ client: Client } | { authUrl: string }> {
  const hit = live().get(sid);
  if (hit) return { client: hit };
  const c = await connectMcp(MCP_URL, providerFor(sid, origin), "0.2.0");
  if ("authUrl" in c) {
    pending().set(sid, c.transport);
    return { authUrl: c.authUrl };
  }
  live().set(sid, c.client);
  return c;
}

/** Called by the OAuth redirect: exchange the code, then the next connect() succeeds. */
export async function finishAuth(sid: string, code: string) {
  const p = pending().get(sid);
  if (!p) throw new Error("No pending Kite login for this browser. Click Connect Kite again.");
  await p.finishAuth(code);
  pending().delete(sid);
}

/** The already-connected Kite client for this browser, or null. Never starts a login. */
export const liveClient = (sid: string): Client | null => live().get(sid) ?? null;

export function disconnect(sid: string) {
  live().get(sid)?.close().catch(() => {});
  live().delete(sid);
}

/** Switch account: drop the live client, saved tokens and saved report for this browser. */
export function logout(sid: string) {
  disconnect(sid);
  pending().delete(sid);
  for (const k of ["oauth", "report", "extscreen"] as const) try { fs.rmSync(sessionFile(sid, k), { force: true }); } catch { /* best effort */ }
}

export async function callHoldings(client: Client, tools: Tool[]): Promise<Raw[]> {
  const direct = tools.find((t) => /^(get_)?holdings$/.test(t.name));
  if (!direct && !tools.some((t) => t.name === "portfolio")) throw new Error(`No holdings tool found. Server offers: ${tools.map((t) => t.name).join(", ")}`);
  const all: Raw[] = [];
  for (let from = 0, guard = 0; guard < 20; guard++) {
    const text = await callText(client, direct ? { name: direct.name, arguments: {} } : { name: "portfolio", arguments: { mode: "holdings", from } }, "Kite returned an error");
    let json: unknown;
    try { json = JSON.parse(text); } catch { throw new Error(text.slice(0, 300) || "Kite returned non-JSON"); }
    const data = dataArray(json);
    if (!data) throw new Error("Unexpected holdings response shape");
    all.push(...data);
    const pg = (json as { pagination?: { has_more?: boolean; returned?: number } }).pagination;
    if (!pg?.has_more) break;
    from += pg.returned ?? data.length;
  }
  return all;
}
