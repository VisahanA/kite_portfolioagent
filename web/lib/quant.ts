import type { Scoring } from "./defaults";
import { clamp } from "./num";
import type { ScreenResult } from "./types";

/** Quant score (-100..100) for a screened stock. Every weight and threshold comes from the "scoring" block in screen-rules.json. */
export function quantScore(r: ScreenResult, s: Scoring) {
  const t = r.technicals;
  const parts: { label: string; pts: number }[] = [];
  if (t) {
    parts.push({ label: `Trend: ${t.trend}`, pts: s.trend_points[t.trend] ?? 0 });
    const above = t.pct_vs_sma200 >= 0;
    parts.push({ label: `${above ? "Above" : "Below"} SMA200 (${t.pct_vs_sma200}%)`, pts: above ? s.above_sma200_points : s.below_sma200_points });
    parts.push({ label: `RSI ${t.rsi14}`, pts: t.rsi14 > s.rsi_overbought ? s.rsi_overbought_points : t.rsi14 < s.rsi_oversold ? s.rsi_oversold_points : s.rsi_normal_points });
    if (t.return_3m != null) parts.push({ label: `3M return ${t.return_3m}%`, pts: Math.round(clamp(t.return_3m / s.return_3m_divisor, -s.return_3m_cap, s.return_3m_cap)) });
  }
  for (const k of ["valuation", "quality", "growth"] as const) {
    const v = r.checks?.[k]?.verdict;
    if (v) parts.push({ label: `${k[0].toUpperCase() + k.slice(1)}: ${v}`, pts: s.verdict_points[v] ?? 0 });
  }
  const score = clamp(parts.reduce((a, p) => a + p.pts, 0), -100, 100);
  return { score, parts };
}
