import Anthropic from "@anthropic-ai/sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";

// Auth, in order of preference:
//  1. ANTHROPIC_API_KEY             -> direct Messages API
//  2. CLAUDE_CODE_OAUTH_TOKEN       -> Claude Agent SDK using your subscription (create with `claude setup-token`)
//  3. a local `claude login` session -> Claude Agent SDK (set CLAUDE_CLI=1 to opt in)
const useKey = () => !!process.env.ANTHROPIC_API_KEY;
const useCli = () => !!process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.CLAUDE_CLI === "1";

export const hasClaude = () => useKey() || useCli();
export const hasApiKey = useKey; // direct API only; the Agent SDK is too slow for per-stock calls
export const model = () => process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";

/** One-shot text completion. Throws on failure so callers can fall back. */
export async function llm(system: string, prompt: string, maxTokens = 800): Promise<string> {
  if (useKey()) {
    const msg = await new Anthropic().messages.create({ model: model(), max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }] });
    return msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  }
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // make sure the subscription login is used
  let out = "", err = "";
  for await (const m of query({
    prompt,
    options: { model: model(), systemPrompt: system, maxTurns: 1, allowedTools: [], settingSources: [], env },
  })) {
    if (m.type === "result") {
      if (m.subtype === "success") out = m.result;
      else err = m.subtype;
    }
  }
  if (!out) throw new Error(`claude agent sdk returned no result${err ? ` (${err})` : ""}`);
  return out.trim();
}
