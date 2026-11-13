// Small numeric helpers shared by the server and the browser (no Node imports).

export const r1 = (n: number) => Math.round(n * 10) / 10;
export const r2 = (n: number) => Math.round(n * 100) / 100;
export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
/** A finite number (not null, undefined, NaN or ±Infinity). */
export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export const sum = <T>(xs: readonly T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
/** Percent change from `base` to `now`; 0 when there is no positive base (e.g. bonus shares at zero cost). */
export const pctChange = (now: number, base: number) => (base > 0 ? ((now - base) / base) * 100 : 0);
/** Whole days elapsed since an ISO date. */
export const daysSince = (iso: string) => (Date.now() - new Date(iso).getTime()) / 864e5;
