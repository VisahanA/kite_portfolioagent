// Stop and target levels shared by the exit and entry planners. Pure: runs in the browser and on the server.
import { isNum } from "./num";
import type { Technicals } from "./types";

export type StopRules = { stop_buffer_pct: number | null; min_stop_distance_pct: number | null; max_stop_distance_pct: number | null };

/**
 * Protective stop: the highest support (3-month swing low, SMA200, SMA50), less the buffer, that sits at or below
 * `ceiling`; never further than max_stop_distance_pct below `ref`. `refLabel` names `ref` in the basis text.
 */
export function protectiveStop(t: Technicals, ref: number, ceiling: number, cfg: StopRules, refLabel: string): { v: number; basis: string } {
  const buf = 1 - (cfg.stop_buffer_pct ?? 0) / 100;
  const floor = ref * (1 - (cfg.max_stop_distance_pct ?? 100) / 100);
  const best = [{ v: t.swing_low_3m, b: "3-month swing low" }, { v: t.sma200, b: "SMA200" }, { v: t.sma50, b: "SMA50" }]
    .filter((x) => isNum(x.v) && x.v * buf <= ceiling)
    .sort((a, b) => b.v - a.v)[0];
  const stop = best ? { v: best.v * buf, basis: `${best.b} (-${cfg.stop_buffer_pct}%)` } : null;
  return !stop || stop.v < floor ? { v: floor, basis: `max-loss cap (${cfg.max_stop_distance_pct}% below ${refLabel})` } : stop;
}

/** Highest price a stop may sit at: min_stop_distance_pct below `ref`. */
export const stopCeiling = (ref: number, cfg: StopRules) => ref * (1 - (cfg.min_stop_distance_pct ?? 0) / 100);

/** Profit target `pct` above `base`; for the first target the 52-week high replaces it when nearer (resistance). */
export function profitTarget(base: number, pct: number, index: number, t: Technicals | undefined, baseLabel: string): { price: number; why: string } {
  const tp = base * (1 + pct / 100);
  if (index === 0 && t && t.high_52w > base * 1.02 && t.high_52w < tp) return { price: t.high_52w, why: "52-week high (resistance)" };
  return { price: tp, why: `+${pct}% from ${baseLabel}` };
}
