// Browser-side calls to this app's API routes.

/** Fetch a JSON API route; throws the route's `error` message (or the HTTP status) on failure. */
export async function apiJson<T = Record<string, unknown>>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, json === undefined ? rest : { ...rest, headers: { "content-type": "application/json", ...rest.headers }, body: JSON.stringify(json) });
  const text = await res.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error(`Server returned non-JSON (HTTP ${res.status}). Check the dev server console.`); }
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
  return data as T;
}
