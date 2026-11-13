// Display formatting shared by the dashboard components.

/** ₹1,23,456 (rounded to the rupee). */
export const inr = (n: number) => (n < 0 ? "-" : "") + "₹" + Math.abs(Math.round(n)).toLocaleString("en-IN");
/** Compact rupees: ₹1.23L or ₹45.6k. */
export const inrk = (n: number) => { const a = Math.abs(n), s = n < 0 ? "-" : ""; return a >= 1e5 ? `${s}₹${(a / 1e5).toFixed(2)}L` : `${s}₹${(a / 1e3).toFixed(1)}k`; };
/** Signed percent with one decimal: +4.2%. */
export const pct = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
/** Indian digit grouping: 1,23,456.78. */
export const num = (n: number, maxDigits?: number) => n.toLocaleString("en-IN", maxDigits == null ? undefined : { maximumFractionDigits: maxDigits });
