// Outbound HTTP for the public data sources (screener.in, Yahoo Finance, Google News).
export const UA = "Mozilla/5.0 (portfolio-screen)";

export function httpGet(url: string, { headers = {}, timeoutMs = 15000, redirect }: { headers?: Record<string, string>; timeoutMs?: number; redirect?: RequestRedirect } = {}) {
  return fetch(url, { headers: { "user-agent": UA, ...headers }, signal: AbortSignal.timeout(timeoutMs), redirect });
}
