export type Check = { label: string; value: unknown; op: string; limit: unknown; pass: boolean };
export type Verdict = { verdict: "pass" | "fail" | "mixed" | "n/a" | string; checks: Check[] };
export type Technicals = {
  price: number; sma20: number; sma50: number; sma200: number; pct_vs_sma50: number; pct_vs_sma200: number;
  rsi14: number; trend: string; cross: string | null; return_1m: number | null; return_3m: number | null;
  return_6m: number | null; high_52w: number; low_52w: number; pct_from_52w_high: number; swing_low_3m: number;
  last_candle: string;
};
export type Fundamentals = {
  as_of: string; source: string; sector: string; pe: number | null; pb: number | null; roe: number | null;
  roce: number | null; debt_to_equity: number | null; sales_growth_3y: number | null;
  profit_growth_3y: number | null; dividend_yield: number | null; notes: string;
  market_cap_cr?: number | null; is_financial?: boolean;
};
export type ScreenResult = {
  id: string; sources: string[]; signal: string; score: number; ltp: number;
  checks: Record<"entry" | "valuation" | "quality" | "growth", Verdict>;
  holding?: { quantity: number; average_price: number; pnl: number; pnl_pct: number };
  technicals?: Technicals; fundamentals?: Fundamentals;
};
export type Report = {
  generated_at: string;
  market: { id: string; technicals: Technicals; caution: boolean };
  holdings_by_value: { id: string; qty: number; avg: number; ltp: number; value: number; cost: number; imported?: boolean }[];
  holdings_total_value: number; holdings_total_cost: number; results: ScreenResult[];
  /** Zerodha-only totals (before imports are merged in). Present on merged reports. */
  kite_total_value?: number; kite_total_cost?: number;
  /** Each imported holding valued the same way as the merged totals (live Kite price where known), in INR. */
  ext_lines?: { broker: string; symbol: string; value: number; cost: number; live: boolean }[];
};

export type Headline = { title: string; source: string; link: string; published: string };
export type Sentiment = {
  score: number; // -1..1
  confidence: number; // 0..1
  label: "Positive" | "Neutral" | "Negative" | "No news";
  themes: string[]; rationale: string; method: "claude" | "lexicon" | "none";
  headlines: (Headline & { score: number })[];
};
export type AgentStep = { agent: string; summary: string; score?: number; detail?: string[] };
export type Stance = "Aligned positive" | "Aligned cautious" | "Conflicting: review" | "Neutral / mixed";
export type Analysis = {
  id: string; symbol: string; quantScore: number; newsScore: number; combined: number; stance: Stance;
  steps: AgentStep[]; sentiment: Sentiment; reviewNotes: string[]; ranAt: string; synthesis: "claude" | "rules";
};
