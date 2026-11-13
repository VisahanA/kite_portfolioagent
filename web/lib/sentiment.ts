import { hasApiKey, llmJson } from "./llm";
import { clamp } from "./num";
import type { Headline, Sentiment } from "./types";

const POS = ["surge", "rally", "gain", "beat", "record", "profit", "growth", "upgrade", "win", "order", "expansion", "strong", "rise", "jumps", "soars", "approval", "dividend", "outperform", "bullish"];
const NEG = ["fall", "drop", "plunge", "miss", "loss", "downgrade", "probe", "fraud", "penalty", "fine", "weak", "slump", "cut", "decline", "lawsuit", "resign", "concern", "bearish", "tumbles", "crash", "ban", "default"];

function lexiconScore(t: string) {
  const w = t.toLowerCase();
  let s = 0;
  for (const p of POS) if (w.includes(p)) s++;
  for (const n of NEG) if (w.includes(n)) s--;
  return clamp(s / 2, -1, 1);
}

function label(score: number): Sentiment["label"] {
  return score > 0.15 ? "Positive" : score < -0.15 ? "Negative" : "Neutral";
}

export async function scoreSentiment(symbol: string, sector: string, items: Headline[]): Promise<Sentiment> {
  if (!items.length)
    return { score: 0, confidence: 0, label: "No news", themes: [], rationale: "No recent headlines found.", method: "none", headlines: [] };

  if (hasApiKey()) { // model sentiment only via the fast direct API; otherwise the lexicon below
    try {
      const list = items.map((h, i) => `${i}. ${h.title} (${h.source}, ${h.published.slice(0, 10)})`).join("\n");
      const j = await llmJson<{ scores?: unknown[]; overall?: unknown; confidence?: unknown; themes?: string[]; rationale?: unknown }>(
        "You are a financial news sentiment analyst for Indian equities. Judge only what the headlines say about the company's business prospects and stock. Reply with JSON only.",
        `Company symbol: ${symbol} (${sector}).\nHeadlines:\n${list}\n\nReturn JSON: {"scores":[number -1..1 per headline, in order, 0 if irrelevant to this company],"overall":number -1..1,"confidence":number 0..1 (low if few/irrelevant/old headlines),"themes":[up to 4 short strings],"rationale":"max 2 sentences"}`,
        1200,
      );
      const overall = clamp(Number(j.overall) || 0, -1, 1);
      return {
        score: overall,
        confidence: clamp(Number(j.confidence) || 0.5, 0, 1),
        label: label(overall),
        themes: (j.themes ?? []).slice(0, 4),
        rationale: String(j.rationale ?? ""),
        method: "claude",
        headlines: items.map((h, i) => ({ ...h, score: Number(j.scores?.[i]) || 0 })),
      };
    } catch (e) {
      console.error("claude sentiment failed, using lexicon:", e);
    }
  }
  const scored = items.map((h) => ({ ...h, score: lexiconScore(h.title) }));
  const avg = scored.reduce((a, b) => a + b.score, 0) / scored.length;
  return {
    score: avg,
    confidence: Math.min(0.5, scored.length / 24),
    label: label(avg),
    themes: [],
    rationale: "Keyword lexicon over headlines (set ANTHROPIC_API_KEY for model-based sentiment).",
    method: "lexicon",
    headlines: scored,
  };
}
