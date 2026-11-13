import { riskOf, scoringOf, type Risk, type Scoring } from "./defaults";
import { hasClaude, llm } from "./llm";
import { fetchNews } from "./news";
import { daysSince, pctChange } from "./num";
import { symbolOf } from "./portfolio";
import { quantScore } from "./quant";
import { loadRules } from "./rules";
import { scoreSentiment } from "./sentiment";
import type { Analysis, AgentStep, Report, ScreenResult, Sentiment, Stance } from "./types";

/** Weighted quant/news blend; quant alone when there is no news. Both inputs on the same scale. */
const blend = (quant: number, news: number, newsWeight: number) => (1 - newsWeight) * quant + newsWeight * news;

function stanceOf(quant: number, news: number, newsWeight: number, s: Scoring): Stance {
  const q = quant / 100;
  if (newsWeight && Math.abs(q) >= s.conflict_threshold && Math.abs(news) >= s.conflict_threshold && Math.sign(q) !== Math.sign(news)) return "Conflicting: review";
  const c = blend(q, news, newsWeight);
  return c >= s.stance_threshold ? "Aligned positive" : c <= -s.stance_threshold ? "Aligned cautious" : "Neutral / mixed";
}

/** Portfolio-aware flags: weight, drawdown vs cost, trend, stretched RSI, stale data. A null threshold switches a flag off. */
function riskNotes(r: ScreenResult, report: Report, risk: Risk): string[] {
  const notes: string[] = [];
  const t = r.technicals;
  const h = report.holdings_by_value.find((x) => x.id === r.id);
  if (h && report.holdings_total_value) {
    const w = (h.value / report.holdings_total_value) * 100;
    if (risk.large_position_pct != null && w >= risk.large_position_pct) notes.push(`Large position: ${w.toFixed(1)}% of holdings value.`);
    const pnl = pctChange(h.ltp, h.avg);
    if (risk.loss_vs_cost_pct != null && h.avg > 0 && pnl <= risk.loss_vs_cost_pct) notes.push(`Trading ${pnl.toFixed(1)}% below your average cost.`);
  }
  if (t) {
    if (t.trend === "Downtrend") notes.push(`Downtrend. Reference levels: SMA50 ${t.sma50}, SMA200 ${t.sma200}, 3M swing low ${t.swing_low_3m}.`);
    if (risk.rsi_stretched != null && t.rsi14 > risk.rsi_stretched) notes.push(`RSI ${t.rsi14} is stretched.`);
  }
  const age = r.fundamentals ? Math.round(daysSince(r.fundamentals.as_of)) : null;
  if (age == null) notes.push("No fundamentals recorded.");
  else if (risk.stale_fundamentals_days != null && age > risk.stale_fundamentals_days) notes.push(`Fundamentals are ${age} days old.`);
  return notes;
}

async function newsSentiment(symbol: string, sector: string): Promise<Sentiment> {
  try {
    return await scoreSentiment(symbol, sector, await fetchNews(symbol));
  } catch (e) {
    const s = await scoreSentiment(symbol, "", []);
    s.rationale = `News fetch failed: ${(e as Error).message}`;
    return s;
  }
}

export async function analyzeStock(r: ScreenResult, report: Report): Promise<Analysis> {
  const rules = loadRules();
  const scoring = scoringOf(rules);
  const symbol = symbolOf(r.id);
  const steps: AgentStep[] = [];

  // 1. Quant agent: trend, momentum and rule-based fundamentals from the screen
  const q = quantScore(r, scoring);
  steps.push({ agent: "Quant agent", score: q.score, summary: `Quant score ${q.score}/100 (screen signal: ${r.signal}).`, detail: q.parts.map((p) => `${p.pts >= 0 ? "+" : ""}${p.pts}  ${p.label}`) });

  // 2. News agent: fetch headlines, score sentiment
  const sentiment = await newsSentiment(symbol, r.fundamentals?.sector ?? "");
  const newsScore = Math.round(sentiment.score * 100);
  steps.push({
    agent: "News sentiment agent", score: newsScore, detail: sentiment.themes,
    summary: `${sentiment.label} (${sentiment.score.toFixed(2)}, confidence ${sentiment.confidence.toFixed(2)}, ${sentiment.method}). ${sentiment.rationale}`,
  });

  // 3. Risk agent: thresholds come from the "risk" block in screen-rules.json
  const notes = riskNotes(r, report, riskOf(rules));
  steps.push({ agent: "Risk agent", summary: notes.length ? `${notes.length} flag(s).` : "No flags.", detail: notes });

  // 4. Synthesis agent: combine quant + news. Describes alignment with the user's rules, never buy/sell.
  const newsWeight = sentiment.method !== "none" ? scoring.news_weight : 0;
  const stance = stanceOf(q.score, sentiment.score, newsWeight, scoring);
  let synthesis: Analysis["synthesis"] = "rules";
  let text = `Quant ${q.score} and news ${newsScore} give "${stance}".`;
  if (hasClaude() && newsWeight) {
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

  return {
    id: r.id, symbol, quantScore: q.score, newsScore, combined: Math.round(blend(q.score, sentiment.score * 100, newsWeight)), newsWeight, stance,
    steps, sentiment, reviewNotes: notes, ranAt: new Date().toISOString(), synthesis,
  };
}
