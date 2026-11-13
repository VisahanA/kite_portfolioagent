// Report helpers shared by the server and the browser (no Node imports).
import type { Report, ScreenResult } from "./types";

export type HoldingLine = Report["holdings_by_value"][number];

/** USD -> INR rate used until the user sets their own. */
export const DEFAULT_FX = 88;

/** "NSE:RELIANCE" -> "RELIANCE". */
export const symbolOf = (id: string) => id.split(":").pop() ?? id;

export const isHolding = (r: ScreenResult) => r.sources.includes("holding");

/** The report with only held stocks in `results`. */
export const onlyHoldings = (r: Report): Report => ({ ...r, results: r.results.filter(isHolding) });

/** Each screened result paired with its holding line (results without a line are skipped). */
export function heldPairs(report: Report): { r: ScreenResult; h: HoldingLine }[] {
  const lines = new Map(report.holdings_by_value.map((h) => [h.id, h]));
  return report.results.flatMap((r) => {
    const h = lines.get(r.id);
    return h ? [{ r, h }] : [];
  });
}
