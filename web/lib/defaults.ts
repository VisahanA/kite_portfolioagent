// Every default for screen-rules.json lives here, used whenever the file omits a key.
// The user edits screen-rules.json, not this file. Client-safe (no Node imports): the
// exit/entry planners and the dashboard run in the browser. A key set to null in the
// rules file stays null, which switches that check off.

type Rules = Record<string, unknown>;

export const DEFAULT_SCREEN = {
  fundamentals_max_age_days: 30,
  entry: {
    allowed_trends: ["Uptrend", "Recovering"] as string[],
    pullback_band_pct: 3,
    rsi_min: 35 as number | null,
    rsi_max: 60 as number | null,
    max_pct_above_sma50: 5 as number | null,
    require_above_sma200: false,
  },
  valuation: { max_pe: 40 as number | null, max_pb: 8 as number | null, max_peg: 1.5 as number | null },
  quality: { min_roe: 15 as number | null, min_roce: 15 as number | null, max_debt_to_equity: 1 as number | null },
  growth: { min_sales_growth_3y: 8 as number | null, min_profit_growth_3y: 10 as number | null },
  market: { caution_when_nifty_downtrend: true },
};

export const DEFAULT_SCORING = {
  trend_points: { Uptrend: 30, Recovering: 10, Weakening: -15, Downtrend: -30 } as Record<string, number>,
  above_sma200_points: 10,
  below_sma200_points: -10,
  rsi_overbought: 75,
  rsi_overbought_points: -10,
  rsi_oversold: 35,
  rsi_oversold_points: -5,
  rsi_normal_points: 5,
  return_3m_divisor: 2,
  return_3m_cap: 15,
  verdict_points: { pass: 10, mixed: 0, fail: -10 } as Record<string, number>,
  news_weight: 0.4,
  stance_threshold: 0.25,
  conflict_threshold: 0.2,
};

export const DEFAULT_RISK = {
  large_position_pct: 10 as number | null,
  loss_vs_cost_pct: -20 as number | null,
  rsi_stretched: 75 as number | null,
  stale_fundamentals_days: 30 as number | null,
};

export type ScreenRules = {
  fundamentals_max_age_days: number;
  entry: typeof DEFAULT_SCREEN.entry;
  valuation: typeof DEFAULT_SCREEN.valuation;
  quality: typeof DEFAULT_SCREEN.quality;
  growth: typeof DEFAULT_SCREEN.growth;
  market: typeof DEFAULT_SCREEN.market;
};
export type Scoring = typeof DEFAULT_SCORING;
export type Risk = typeof DEFAULT_RISK;

/** `defaults` overlaid with the rules block `rules[key]` (a missing or null block keeps every default). */
export function section<T extends object>(rules: Rules, key: string, defaults: T): T {
  const block = rules[key];
  return { ...defaults, ...(block && typeof block === "object" ? (block as Partial<T>) : {}) };
}

export function screenRules(rules: Rules): ScreenRules {
  const entry = section(rules, "entry", DEFAULT_SCREEN.entry);
  return {
    fundamentals_max_age_days: Number(rules.fundamentals_max_age_days ?? DEFAULT_SCREEN.fundamentals_max_age_days),
    entry: { ...entry, allowed_trends: entry.allowed_trends ?? DEFAULT_SCREEN.entry.allowed_trends },
    valuation: section(rules, "valuation", DEFAULT_SCREEN.valuation),
    quality: section(rules, "quality", DEFAULT_SCREEN.quality),
    growth: section(rules, "growth", DEFAULT_SCREEN.growth),
    market: section(rules, "market", DEFAULT_SCREEN.market),
  };
}

export function scoringOf(rules: Rules): Scoring {
  const s = section(rules, "scoring", DEFAULT_SCORING);
  const raw = (rules.scoring ?? {}) as Partial<Scoring>;
  return {
    ...s,
    trend_points: { ...DEFAULT_SCORING.trend_points, ...raw.trend_points },
    verdict_points: { ...DEFAULT_SCORING.verdict_points, ...raw.verdict_points },
  };
}

export const riskOf = (rules: Rules): Risk => section(rules, "risk", DEFAULT_RISK);
