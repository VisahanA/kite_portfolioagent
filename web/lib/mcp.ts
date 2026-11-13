import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

// Shared plumbing for the remote MCP servers this app talks to (Kite, Gmail).

export type Tool = { name: string; inputSchema?: { properties?: Record<string, unknown> } };
export type Raw = Record<string, unknown>;
type ToolCall = Parameters<Client["callTool"]>[0];

/** Concatenated text blocks of a tool result. */
export function toolText(res: unknown): string {
  const c = (res as { content?: { type: string; text?: string }[] }).content ?? [];
  return c.map((b) => (b.type === "text" ? b.text ?? "" : "")).join("");
}

/** Call a tool and return its text; throws with the server's message when the tool reports an error. */
export async function callText(client: Client, call: ToolCall, errorLabel: string): Promise<string> {
  const res = await client.callTool(call);
  const text = toolText(res);
  if ((res as { isError?: boolean }).isError) throw new Error(text.slice(0, 300) || errorLabel);
  return text;
}

/** Call a tool and parse its text as JSON; null when the reply is not JSON. */
export async function callJson(client: Client, call: ToolCall): Promise<unknown> {
  try { return JSON.parse(toolText(await client.callTool(call))); } catch { return null; }
}

/** A list reply is either the array itself or `{ data: [...] }`. */
export function dataArray(j: unknown): Raw[] | null {
  const arr = Array.isArray(j) ? j : (j as { data?: unknown } | null)?.data;
  return Array.isArray(arr) ? (arr as Raw[]) : null;
}

/** First argument name in a tool's input schema matching `re`. */
export const argName = (tool: Tool, re: RegExp) => Object.keys(tool.inputSchema?.properties ?? {}).find((p) => re.test(p));

// ---------- OAuth: one provider class, state kept wherever the caller stores it ----------
export type OAuthStore = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string };

export class StoredOAuthProvider implements OAuthClientProvider {
  authUrl: URL | null = null;
  constructor(
    private redirect: string,
    private clientName: string,
    private load: () => OAuthStore,
    private save: (s: OAuthStore) => void,
  ) {}
  private patch(p: Partial<OAuthStore>) { this.save({ ...this.load(), ...p }); }
  get redirectUrl() { return this.redirect; }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: this.clientName, redirect_uris: [this.redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  clientInformation() {
    const c = this.load().client as { redirect_uris?: string[] } | undefined;
    return c?.redirect_uris?.includes(this.redirect) ? (c as OAuthClientInformationMixed) : undefined; // re-register if the redirect changed
  }
  saveClientInformation(client: OAuthClientInformationMixed) { this.patch({ client }); }
  tokens() { return this.load().tokens; }
  saveTokens(tokens: OAuthTokens) { this.patch({ tokens }); }
  saveCodeVerifier(verifier: string) { this.patch({ verifier }); }
  codeVerifier() { return this.load().verifier ?? ""; }
  redirectToAuthorization(u: URL) { this.authUrl = u; }
}

export type Connected = { client: Client } | { authUrl: string; transport: StreamableHTTPClientTransport };

/** Connect to an MCP server; when it needs a login, returns the login URL and the transport that will finish it. */
export async function connectMcp(url: string, provider: StoredOAuthProvider, version: string): Promise<Connected> {
  const transport = new StreamableHTTPClientTransport(new URL(url), { authProvider: provider });
  const client = new Client({ name: "portfolio-agent", version });
  try {
    await client.connect(transport);
  } catch (e) {
    if (e instanceof UnauthorizedError && provider.authUrl) return { authUrl: provider.authUrl.toString(), transport };
    throw e;
  }
  return { client };
}
