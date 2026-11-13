import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { argName, callText, connectMcp, StoredOAuthProvider, type OAuthStore } from "./mcp";
import { readJson, writeJson } from "./store";
import type { Analysis } from "./types";

const MCP_URL = process.env.GMAIL_MCP_URL || "";
const REDIRECT = process.env.GMAIL_OAUTH_REDIRECT || "http://localhost:3000/api/gmail/callback";
const STORE = path.resolve(process.cwd(), ".gmail-oauth.json"); // OAuth tokens: gitignored

const provider = () => new StoredOAuthProvider(REDIRECT, "Portfolio Agent (local, Gmail)", () => readJson<OAuthStore>(STORE) ?? {}, (s) => writeJson(STORE, s, { pretty: true }));

// Gmail is a single local login (not per browser session); survives Next dev hot reloads.
const g = globalThis as unknown as { __gmail?: Client | null; __gmailPending?: StreamableHTTPClientTransport | null };

async function connect(): Promise<{ client: Client } | { authUrl: string }> {
  if (g.__gmail) return { client: g.__gmail };
  const c = await connectMcp(MCP_URL, provider(), "0.1.0");
  if ("authUrl" in c) {
    g.__gmailPending = c.transport;
    return { authUrl: c.authUrl };
  }
  g.__gmail = c.client;
  return c;
}

export async function finishGmailAuth(code: string) {
  const p = g.__gmailPending;
  if (!p) throw new Error("No pending Gmail login. Click Run agents again.");
  await p.finishAuth(code);
  g.__gmailPending = null;
}

function buildReport(analyses: Analysis[], brief: string | null) {
  const day = new Date().toISOString().slice(0, 10);
  const rows = [...analyses].sort((a, b) => b.combined - a.combined);
  const body = [
    `Portfolio agent report, ${day}`,
    "This is a rule-based screen plus news sentiment, not investment advice.",
    "",
    brief ? `Brief\n${brief}\n` : "",
    "Per-holding results",
    ...rows.map((a) => `- ${a.symbol}: ${a.stance} | quant ${a.quantScore}, news ${a.newsScore}, combined ${a.combined}${a.reviewNotes.length ? `\n    Flags: ${a.reviewNotes.join(" ")}` : ""}`),
    "",
    "Conflicts (quant vs news): " + (rows.filter((a) => a.stance === "Conflicting: review").map((a) => a.symbol).join(", ") || "none"),
  ].join("\n");
  return { subject: `Portfolio agent report ${day}`, body };
}

export type DraftResult = { status: "auth"; authUrl: string } | { status: "drafted"; subject: string } | { status: "unconfigured" };

/** Create a Gmail draft (no recipient) through the Gmail MCP server. Never sends. */
export async function createDraft(analyses: Analysis[], brief: string | null): Promise<DraftResult> {
  if (!MCP_URL) return { status: "unconfigured" };
  const c = await connect();
  if ("authUrl" in c) return { status: "auth", authUrl: c.authUrl };
  const { subject, body } = buildReport(analyses, brief);
  try {
    const tools = (await c.client.listTools()).tools;
    const tool = tools.find((t) => /create.*draft|draft.*create/i.test(t.name)) ?? tools.find((t) => /draft/i.test(t.name) && !/(delete|get|list|update|send)/i.test(t.name));
    if (!tool) throw new Error(`No draft tool found. Server offers: ${tools.map((t) => t.name).join(", ")}`);
    const args = { [argName(tool, /^subject$/i) ?? "subject"]: subject, [argName(tool, /^(body|content|text|message)$/i) ?? "body"]: body };
    await callText(c.client, { name: tool.name, arguments: args }, "Gmail returned an error");
    return { status: "drafted", subject };
  } catch (e) {
    g.__gmail?.close().catch(() => {});
    g.__gmail = null;
    throw e;
  }
}
