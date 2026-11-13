import { section } from "./defaults";
import { profitTarget, protectiveStop, stopCeiling } from "./levels";
import { isNum, pctChange, r2, sum } from "./num";
import { heldPairs, type HoldingLine } from "./portfolio";
import type { Report, ScreenResult } from "./types";

// Exit planner: when to sell, and how much. Pure and deterministic (no network, no fs) so it runs
// in the browser and on the server. Every threshold comes from the "exit" block in screen-rules.json;
// these defaults apply only when a key is missing. Set a number to null to switch that rule off.
const DEFAULT_EXIT = {
  min_profit_pct_for_trim: 5 as number | null, // profit-taking trims only apply when at least this far above cost
  overbought_rsi: 75 as number | null,
  overbought_trim_pct: 25 as number | null,
  extended_pct_above_sma50: 15 as number | null,
  extended_trim_pct: 20 as number | null,
  fundamentals_fail_trim_pct: 25 as number | null, // signal FAILS RULES while in profit
  concentration_cap_pct: 10 as number | null, // trim back down to this portfolio weight
  downtrend_sell_pct: 50 as number | null,
  deep_loss_pct: -20 as number | null, // downtrend AND this far below cost: cut an extra deep_loss_extra_pct
  deep_loss_extra_pct: 25 as number | null,
  market_caution_trim_pct: 10 as number | null, // extra trim for non-uptrend holdings when NIFTY caution is on
  min_stop_distance_pct: 3 as number | null, // stop must sit at least this far below price (avoids whipsaw)
  max_stop_distance_pct: 12 as number | null, // stop is never further than this below price (caps the downside)
  stop_buffer_pct: 1 as number | null, // stop sits this far under the chosen support level
  profit_target_pcts: [10, 20] as number[], // price targets above current price
  ladder_sell_pcts: [25, 25] as number[], // % of the remaining shares sold at each target
};
type ExitRules = typeof DEFAULT_EXIT;

export type Rung = { price: number; gain_pct: number; sell_pct: number; shares: number; proceeds: number; why: string };
export type ExitPlan = {
  id: string;
  action: "Exit" | "Trim" | "Hold with stop" | "No data";
  weight_pct: number;
  now: { pct: number; shares: number; proceeds: number; realised_pnl: number; reasons: { pct: number; text: string }[] };
  stop: { price: number; distance_pct: number; basis: string; downside: number; vs_cost_pct: number } | null;
  targets: Rung[];
  remaining_after_now: number;
  notes: string[];
};

function planExit(r: ScreenResult, h: HoldingLine, total: number, marketCaution: boolean, cfg: ExitRules): ExitPlan {
  const t = r.technicals;
  const price = h.ltp;
  const w = total ? (h.value / total) * 100 : 0;
  const profitPct = pctChange(h.ltp, h.avg);
  const inProfit = isNum(cfg.min_profit_pct_for_trim) ? profitPct >= cfg.min_profit_pct_for_trim : profitPct > 0;
  const reasons: { pct: number; text: string }[] = [];
  const notes: string[] = [];
  const add = (pct: number | null, text: string) => { if (isNum(pct)) reasons.push({ pct, text }); };

  // 1. Sell-now triggers, each adds a % of the position. The total is capped at 100.
  if (t) {
    if (t.trend === "Downtrend" && isNum(cfg.downtrend_sell_pct)) {
      add(cfg.downtrend_sell_pct, `Downtrend: price ${price} below SMA50 ${t.sma50} and SMA200 ${t.sma200}.`);
      if (isNum(cfg.deep_loss_pct) && profitPct <= cfg.deep_loss_pct) add(cfg.deep_loss_extra_pct, `Also ${profitPct.toFixed(1)}% below your cost (limit ${cfg.deep_loss_pct}%).`);
    }
    if (isNum(cfg.overbought_rsi) && t.rsi14 > cfg.overbought_rsi && inProfit)
      add(cfg.overbought_trim_pct, `RSI ${t.rsi14} is above ${cfg.overbought_rsi} with a ${profitPct.toFixed(1)}% gain to protect.`);
    if (isNum(cfg.extended_pct_above_sma50) && t.pct_vs_sma50 > cfg.extended_pct_above_sma50 && inProfit)
      add(cfg.extended_trim_pct, `Price is ${t.pct_vs_sma50}% above SMA50 (limit ${cfg.extended_pct_above_sma50}%); stretched.`);
    if (marketCaution && t.trend !== "Uptrend") add(cfg.market_caution_trim_pct, `NIFTY caution is on and this holding is ${t.trend}.`);
  } else {
    notes.push("No candles: trend, stop and RSI triggers are unavailable.");
  }
  if (r.signal === "FAILS RULES" && inProfit)
    add(cfg.fundamentals_fail_trim_pct, `Fails your valuation, quality or growth rules while ${profitPct.toFixed(1)}% in profit.`);
  // Concentration is measured on the weight left after the trims above, so the same shares are never counted twice.
  const otherPct = Math.min(100, sum(reasons, (x) => x.pct));
  const wAfter = w * (1 - otherPct / 100);
  if (isNum(cfg.concentration_cap_pct) && wAfter > cfg.concentration_cap_pct)
    add(r2(((wAfter - cfg.concentration_cap_pct) / w) * 100), `Weight ${w.toFixed(1)}%${otherPct ? ` (${wAfter.toFixed(1)}% after the trims above)` : ""} exceeds your ${cfg.concentration_cap_pct}% cap; trim back to the cap.`);

  const nowPct = Math.min(100, r2(sum(reasons, (x) => x.pct)));
  const nowShares = nowPct >= 100 ? h.qty : Math.floor((h.qty * nowPct) / 100);
  const remaining = h.qty - nowShares;
  const now = { pct: nowPct, shares: nowShares, proceeds: Math.round(nowShares * price), realised_pnl: Math.round(nowShares * (price - h.avg)), reasons };

  // 2. Protective stop: nearest support below price, kept between min and max distance.
  let stop: ExitPlan["stop"] = null;
  if (t && remaining > 0) {
    const s = protectiveStop(t, price, stopCeiling(price, cfg), cfg, "price");
    stop = {
      price: r2(s.v), distance_pct: r2(((price - s.v) / price) * 100), basis: s.basis,
      downside: Math.round((price - s.v) * remaining), vs_cost_pct: r2(pctChange(s.v, h.avg)),
    };
  }

  // 3. Profit ladder: sell a slice of the remaining shares at each target.
  const targets: Rung[] = [];
  if (remaining > 0) {
    let left = remaining;
    cfg.profit_target_pcts.forEach((p, i) => {
      const tp = profitTarget(price, p, i, t, "here");
      const sellPct = cfg.ladder_sell_pcts[i] ?? 0;
      const shares = Math.min(left, Math.floor((remaining * sellPct) / 100));
      if (!shares) return;
      left -= shares;
      targets.push({ price: r2(tp.price), gain_pct: r2(pctChange(tp.price, price)), sell_pct: sellPct, shares, proceeds: Math.round(shares * tp.price), why: tp.why });
    });
  }

  const action: ExitPlan["action"] = !t && !reasons.length ? "No data" : nowPct >= 100 ? "Exit" : nowPct > 0 ? "Trim" : "Hold with stop";
  if (t && r.signal === "ENTRY ZONE") notes.push("Screen still shows ENTRY ZONE; exit triggers here are risk controls only.");
  return { id: r.id, action, weight_pct: r2(w), now, stop, targets, remaining_after_now: remaining, notes };
}

export function planAll(report: Report, rules: Record<string, unknown>): ExitPlan[] {
  const cfg = section(rules, "exit", DEFAULT_EXIT);
  return heldPairs(report)
    .map(({ r, h }) => planExit(r, h, report.holdings_total_value, report.market.caution, cfg))
    .sort((a, b) => b.now.proceeds - a.now.proceeds || b.weight_pct - a.weight_pct);
}
