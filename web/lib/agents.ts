import { hasClaude, llm } from "./llm";
import { fetchNews } from "./news";
import { quantScore } from "./quant";
import { scoreSentiment } from "./sentiment";
import type { Analysis, AgentStep, Report, ScreenResult, Sentiment, Stance } from "./types";
import { symbolOf } from "./data";
import { loadRisk, loadScoring } from "./rules";

function stanceOf(quant: number, news: number, hasNews: boolean): Stance {
  const s = loadScoring();
  const q = quant / 100;
  if (hasNews && Math.abs(q) >= s.conflict_threshold && Math.abs(news) >= s.conflict_threshold && Math.sign(q) !== Math.sign(news)) return "Conflicting: review";
  const c = hasNews ? (1 - s.news_weight) * q + s.news_weight * news : q;
  return c >= s.stance_threshold ? "Aligned positive" : c <= -s.stance_threshold ? "Aligned cautious" : "Neutral / mixed";
}

export async function analyzeStock(r: ScreenResult, report: Report): Promise<Analysis> {
  const symbol = symbolOf(r.id);
  const steps: AgentStep[] = [];

  // 1. Quant agent: trend, momentum and rule-based fundamentals from the screen
  const q = quantScore(r);
  steps.push({
    agent: "Quant agent",
    score: q.score,
    summary: `Quant score ${q.score}/100 (screen signal: ${r.signal}).`,
    detail: q.parts.map((p) => `${p.pts >= 0 ? "+" : ""}${p.pts}  ${p.label}`),
  });

  // 2. News agent: fetch headlines, score sentiment
  let sentiment: Sentiment;
  try {
    const items = await fetchNews(symbol);
    sentiment = await scoreSentiment(symbol, r.fundamentals?.sector ?? "", items);
  } catch (e) {
    sentiment = await scoreSentiment(symbol, "", []);
    sentiment.rationale = `News fetch failed: ${(e as Error).message}`;
  }
  steps.push({
    agent: "News sentiment agent",
    score: Math.round(sentiment.score * 100),
    summary: `${sentiment.label} (${sentiment.score.toFixed(2)}, confidence ${sentiment.confidence.toFixed(2)}, ${sentiment.method}). ${sentiment.rationale}`,
    detail: sentiment.themes,
  });

  // 3. Risk agent: portfolio-aware flags (weight, drawdown vs cost, stale data, levels)
  const risk = loadRisk(); // thresholds come from the "risk" block in screen-rules.json; null switches a flag off
  const notes: string[] = [];
  const t = r.technicals;
  const h = report.holdings_by_value.find((x) => x.id === r.id);
  if (h && report.holdings_total_value) {
    const w = (h.value / report.holdings_total_value) * 100;
    if (risk.large_position_pct != null && w >= risk.large_position_pct) notes.push(`Large position: ${w.toFixed(1)}% of holdings value.`);
    const pnl = ((h.ltp - h.avg) / h.avg) * 100;
    if (risk.loss_vs_cost_pct != null && pnl <= risk.loss_vs_cost_pct) notes.push(`Trading ${pnl.toFixed(1)}% below your average cost.`);
  }
  if (t) {
    if (t.trend === "Downtrend") notes.push(`Downtrend. Reference levels: SMA50 ${t.sma50}, SMA200 ${t.sma200}, 3M swing low ${t.swing_low_3m}.`);
    if (risk.rsi_stretched != null && t.rsi14 > risk.rsi_stretched) notes.push(`RSI ${t.rsi14} is stretched.`);
  }
  const age = r.fundamentals ? Math.round((Date.now() - new Date(r.fundamentals.as_of).getTime()) / 864e5) : null;
  if (age == null) notes.push("No fundamentals recorded.");
  else if (risk.stale_fundamentals_days != null && age > risk.stale_fundamentals_days) notes.push(`Fundamentals are ${age} days old.`);
  steps.push({ agent: "Risk agent", summary: notes.length ? `${notes.length} flag(s).` : "No flags.", detail: notes });

  // 4. Synthesis agent: combine quant + news. Describes alignment with the user's rules, never buy/sell.
  const hasNews = sentiment.method !== "none";
  const stance = stanceOf(q.score, sentiment.score, hasNews);
  let synthesis: Analysis["synthesis"] = "rules";
  let text = `Quant ${q.score} and news ${Math.round(sentiment.score * 100)} give "${stance}".`;
  if (hasClaude() && hasNews) {
    try {
      text = await llm(
        "You summarise how a stock measures against a rule-based screen and recent news. You never say buy, sell or hold and never suggest position sizes. Two sentences max, plain text.",
        `${symbol}: screen signal ${r.signal}; quant score ${q.score}; news ${sentiment.label} (${sentiment.score.toFixed(2)}); news themes ${sentiment.themes.join(", ") || "none"}; flags: ${notes.join(" ") || "none"}; rule-based stance: ${stance}. Explain where quant and news agree or conflict and what to check.`,
        400,
      );
      synthesis = "claude";
    } catch (e) {
      console.error("synthesis failed:", e);
    }
  }
  steps.push({ agent: "Synthesis agent", summary: text });

  const nw = loadScoring().news_weight;
  const combined = Math.round(hasNews ? (1 - nw) * q.score + nw * sentiment.score * 100 : q.score);
  return {
    id: r.id, symbol, quantScore: q.score, newsScore: Math.round(sentiment.score * 100), combined, stance,
    steps, sentiment, reviewNotes: notes, ranAt: new Date().toISOString(), synthesis,
  };
}
