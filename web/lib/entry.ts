import { screenRules, section } from "./defaults";
import { profitTarget, protectiveStop, stopCeiling } from "./levels";
import { isNum, pctChange, r2, sum } from "./num";
import { heldPairs } from "./portfolio";
import type { Report, ScreenResult } from "./types";

// Entry planner: at which price to add to a holding, in how many steps, with what stop and targets.
// Mirror image of exit.ts. Pure and deterministic (no network, no fs) so it runs in the browser and
// on the server. Thresholds come from the "entry_plan" block (and the screen's "entry" block) in
// screen-rules.json; these defaults apply only when a key is missing.
const DEFAULT_ENTRY_PLAN = {
  min_pullback_pct: 2, // a support level must sit at least this far below price to be a pullback anchor
  max_pullback_pct: 10, // ...and no further than this, or it is too far away to wait for
  tranche_pcts: [40, 35, 25] as number[], // % of the intended position bought at zone top, anchor, zone bottom
  stop_buffer_pct: 1, // stop sits this far under the chosen support
  min_stop_distance_pct: 3,
  max_stop_distance_pct: 12,
  profit_target_pcts: [10, 20] as number[], // targets above the average entry
  min_reward_risk: 1.5, // warn when first target / stop gives less than this
  avoid_downtrend: true,
};
type EntryPlanRules = typeof DEFAULT_ENTRY_PLAN;
type EntryCfg = { plan: EntryPlanRules; screen: ReturnType<typeof screenRules>["entry"] };

export type EntryStatus = "Enter now" | "Wait for pullback" | "Avoid for now" | "No data";
export type Tranche = { price: number; pct: number; why: string };
export type EntryPlan = {
  id: string;
  status: EntryStatus;
  signal: string;
  price: number;
  zone: { low: number; high: number; anchor: number; basis: string } | null;
  away_pct: number; // how far price is above the top of the zone (0 when already inside)
  tranches: Tranche[];
  avg_entry: number | null;
  stop: { price: number; distance_pct: number; basis: string } | null;
  targets: { price: number; gain_pct: number; why: string }[];
  reward_risk: number | null;
  reasons: string[]; // why this status
  warnings: string[];
};

function planEntry(r: ScreenResult, marketCaution: boolean, c: EntryCfg): EntryPlan {
  const cfg = c.plan, se = c.screen, t = r.technicals;
  const price = t?.price ?? r.ltp;
  const reasons: string[] = [], warnings: string[] = [];
  const base: EntryPlan = { id: r.id, status: "No data", signal: r.signal, price, zone: null, away_pct: 0, tranches: [], avg_entry: null, stop: null, targets: [], reward_risk: null, reasons, warnings };
  if (!t) { warnings.push("No candles: trend, zone and stop cannot be computed."); return base; }

  // 1. Blockers: things that make buying now unattractive by your own rules.
  const blockers: string[] = [];
  const downtrend = t.trend === "Downtrend";
  if (downtrend && cfg.avoid_downtrend) blockers.push(`Downtrend: price ${price} is below SMA50 ${t.sma50} and SMA200 ${t.sma200}.`);
  else if (!se.allowed_trends.includes(t.trend)) blockers.push(`Trend is ${t.trend}; your rules allow ${se.allowed_trends.join(" or ")}.`);
  if (isNum(se.rsi_max) && t.rsi14 > se.rsi_max) blockers.push(`RSI ${t.rsi14} is above ${se.rsi_max}; momentum is stretched.`);
  if (isNum(se.rsi_min) && t.rsi14 < se.rsi_min) warnings.push(`RSI ${t.rsi14} is below ${se.rsi_min}; momentum is weak.`);
  if (isNum(se.max_pct_above_sma50) && t.pct_vs_sma50 > se.max_pct_above_sma50) blockers.push(`Price is ${t.pct_vs_sma50}% above SMA50 (limit ${se.max_pct_above_sma50}%); extended.`);
  if (marketCaution) warnings.push("NIFTY caution is on: buy only the lower tranches.");
  if (r.signal === "FAILS RULES" || r.signal === "TECHNICAL ONLY") warnings.push("Fundamentals do not meet your valuation, quality or growth rules.");
  if (r.signal === "NO FUNDAMENTALS") warnings.push("No fundamentals recorded for this stock.");

  // 2. Pullback anchor: nearest support below price, between min and max pullback distance.
  const lo = price * (1 - cfg.max_pullback_pct / 100), hi = price * (1 - cfg.min_pullback_pct / 100);
  const supports = [{ v: t.sma20, b: "SMA20" }, { v: t.sma50, b: "SMA50" }, { v: t.sma200, b: "SMA200" }]
    .filter((x) => isNum(x.v) && x.v <= hi && x.v >= lo).sort((a, b) => b.v - a.v);
  const fallbackPct = Math.max(cfg.min_pullback_pct, se.pullback_band_pct);
  const anchor = supports[0] ?? { v: price * (1 - fallbackPct / 100), b: `${fallbackPct}% pullback (no support nearby)` };
  const band = se.pullback_band_pct / 100;
  const zoneHigh = Math.min(price, anchor.v * (1 + band)), zoneLow = anchor.v * (1 - band);

  // 3. Status. "Enter now" only when the screen's own entry checks pass and nothing blocks it.
  const entryPass = r.checks?.entry?.verdict === "pass" && !blockers.length;
  const status: EntryStatus = downtrend && cfg.avoid_downtrend ? "Avoid for now" : entryPass && !marketCaution ? "Enter now" : "Wait for pullback";
  if (status === "Enter now") reasons.push(`Entry checks pass: ${t.trend}, RSI ${t.rsi14}, ${t.pct_vs_sma50}% above SMA50.`);
  reasons.push(...blockers);
  if (status === "Wait for pullback" && !blockers.length) reasons.push(marketCaution ? "NIFTY caution is on; wait for the lower zone." : "Entry checks are not all passing yet.");
  const away = status === "Enter now" ? 0 : Math.max(0, ((price - zoneHigh) / price) * 100);

  // 4. Tranches: spread the buy across the zone. When entering now the first slice is at today's price.
  const pcts = cfg.tranche_pcts;
  const levels = [
    { price: status === "Enter now" ? price : zoneHigh, why: status === "Enter now" ? "At today's price" : "Top of the zone" },
    { price: anchor.v, why: `At ${anchor.b}` },
    { price: zoneLow, why: "Bottom of the zone" },
  ];
  const tranches: Tranche[] = levels.slice(0, pcts.length).map((l, i) => ({ price: r2(l.price), pct: pcts[i], why: l.why }));
  const avg = sum(tranches, (x) => x.price * x.pct) / (sum(tranches, (x) => x.pct) || 1);

  // 5. Stop: nearest support below the bottom of the zone, kept between min and max distance from the average entry.
  const stop = protectiveStop(t, avg, Math.min(zoneLow, stopCeiling(avg, cfg)), cfg, "entry");

  // 6. Targets above the average entry.
  const targets = cfg.profit_target_pcts.map((p, i) => {
    const tp = profitTarget(avg, p, i, t, "entry");
    return { price: r2(tp.price), gain_pct: r2(pctChange(tp.price, avg)), why: tp.why };
  });
  const rr = targets[0] ? r2((targets[0].price - avg) / (avg - stop.v)) : null;
  if (isNum(rr) && rr < cfg.min_reward_risk) warnings.push(`Reward/risk ${rr} is below your ${cfg.min_reward_risk} minimum.`);

  return {
    ...base, status,
    zone: { low: r2(zoneLow), high: r2(zoneHigh), anchor: r2(anchor.v), basis: anchor.b },
    away_pct: r2(away), tranches, avg_entry: r2(avg),
    stop: { price: r2(stop.v), distance_pct: r2(((avg - stop.v) / avg) * 100), basis: stop.basis },
    targets, reward_risk: rr,
  };
}

export type HoldingBuy = EntryPlan & { qty: number; avg_cost: number; pnl_pct: number };

/** Re-price a screen result at a live last price so zones and checks use today's price. Averages and RSI stay as scanned. */
function atLivePrice(r: ScreenResult, ltp: number): ScreenResult {
  const t = r.technicals;
  if (!t || !isNum(ltp) || ltp <= 0) return r;
  const vs = (ma: number) => (isNum(ma) && ma > 0 ? Math.round((ltp / ma - 1) * 1000) / 10 : 0);
  return { ...r, ltp, technicals: { ...t, price: ltp, pct_vs_sma50: vs(t.sma50), pct_vs_sma200: vs(t.sma200) } };
}

/** Buy triggers for stocks you already hold (add-on or average-down levels). Nothing is hard-coded per stock. */
export function planHoldingBuys(report: Report, marketCaution: boolean, rules: Record<string, unknown>): HoldingBuy[] {
  const c: EntryCfg = { plan: section(rules, "entry_plan", DEFAULT_ENTRY_PLAN), screen: screenRules(rules).entry };
  const rank = (p: EntryPlan) => (p.status === "Enter now" ? 0 : p.status === "Wait for pullback" ? 1 : 2);
  return heldPairs(report)
    .map(({ r, h }) => ({ ...planEntry(atLivePrice(r, h.ltp), marketCaution, c), qty: h.qty, avg_cost: h.avg, pnl_pct: r2(pctChange(h.value, h.cost)) }))
    .sort((a, b) => rank(a) - rank(b) || a.away_pct - b.away_pct);
}
