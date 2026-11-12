"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/** First screen for a visitor with no saved report: connect their own Kite account, then screen whatever they hold. */
export default function Landing() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const auto = useRef(false);

  async function connect() {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/kite/refresh", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      if (data.status === "auth") { setAuthUrl(data.authUrl); window.location.href = data.authUrl; return; }
      router.refresh();
    } catch (e) { setMsg((e as Error).message); setBusy(false); }
  }

  // Back from the Kite login: fetch and screen the holdings straight away.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("kite") === "connected" && !auto.current) { auto.current = true; window.history.replaceState({}, "", "/"); connect(); }
    else if (q.get("kite") === "error" || q.get("kite") === "denied") setMsg(q.get("msg") ?? "Kite login was cancelled.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="main">
      <h1>Portfolio Agent</h1>
      <p className="muted">Connect your Zerodha Kite account to screen your own holdings: trend, valuation, quality, growth, news sentiment, exit and entry levels. Read-only; no orders are ever placed.</p>
      <button className="btn primary" disabled={busy} onClick={connect}>{busy ? "Connecting and screening… this can take a minute" : "Connect Kite"}</button>
      {authUrl && <div className="muted sm">Not redirected? <a href={authUrl}>Open the Kite login</a>.</div>}
      {msg && <div className="card sm neg" style={{ marginTop: 16 }}>{msg}</div>}
    </main>
  );
}
