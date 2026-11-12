"use client";

import { useState } from "react";
import { BROKERS, type Broker, type ExtHolding } from "../lib/brokers";
import { Donut, CAT } from "./charts";
import type { Report } from "../lib/types";

const inr = (n: number) => (n < 0 ? "-" : "") + "₹" + Math.abs(Math.round(n)).toLocaleString("en-IN");
const pct = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
const brokerIds = Object.keys(BROKERS) as Broker[];

const valueOf = (h: ExtHolding) => h.value ?? (h.price != null ? h.qty * h.price : h.avg != null ? h.qty * h.avg : 0);
const costOf = (h: ExtHolding) => (h.avg != null ? h.qty * h.avg : null);

export default function Imports({ held, onChange: setHeld, fx, setFx: setFxSaved, kiteValue, totalValue, totalCost, ext_lines }: { held: ExtHolding[]; onChange: (h: ExtHolding[], report?: Report) => void; fx: number; setFx: (n: number) => void; kiteValue: number; kiteCost: number; totalValue: number; totalCost: number; ext_lines?: Report["ext_lines"] }) {
  const [broker, setBroker] = useState<Broker>("axis");
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const pick = (f: File) => {
    if (!/\.(pdf|csv)$/i.test(f.name) && f.type !== "application/pdf" && f.type !== "text/csv") { setMsg({ ok: false, text: "Choose a PDF or CSV file." }); return; }
    setFile(f); setPreview(null); setMsg(null);
  };
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [preview, setPreview] = useState<{ broker: Broker; rows: ExtHolding[]; method: string } | null>(null);
  const rate = (h: ExtHolding) => (h.currency === "USD" ? fx : 1);

  async function parse() {
    if (!file) { setMsg({ ok: false, text: "Choose a PDF first." }); return; }
    setBusy(true); setMsg(null); setPreview(null);
    try {
      const fd = new FormData();
      fd.set("broker", broker); fd.set("file", file); if (password) fd.set("password", password);
      const res = await fetch("/api/external/parse", { method: "POST", body: fd });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? res.statusText);
      setPreview({ broker, rows: d.holdings, method: d.method });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    setBusy(false);
  }

  async function save() {
    if (!preview) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/external?fx=${fx}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ broker: preview.broker, holdings: preview.rows }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? res.statusText);
      setHeld(d.holdings, d.report); setPreview(null); setFile(null); setPassword("");
      setMsg({ ok: true, text: `${BROKERS[preview.broker].label}: ${preview.rows.length} holdings added to your portfolio.` });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    setBusy(false);
  }

  async function remove(b: Broker) {
    const res = await fetch(`/api/external?broker=${b}&fx=${fx}`, { method: "DELETE" });
    if (res.ok) { const d = await res.json(); setHeld(d.holdings, d.report); }
  }

  const patch = (i: number, p: Partial<ExtHolding>) => setPreview((v) => v && { ...v, rows: v.rows.map((r, x) => (x === i ? { ...r, ...p } : r)) });

  // Live valuation per imported line comes from the server (same numbers the Overview totals use).
  const lineOf = (h: ExtHolding) => ext_lines?.find((l) => l.broker === h.broker && l.symbol === h.symbol);
  const liveVal = (h: ExtHolding) => lineOf(h)?.value ?? valueOf(h) * rate(h);
  const liveCost = (h: ExtHolding) => lineOf(h)?.cost ?? (costOf(h) != null ? costOf(h)! * rate(h) : null);
  const by = brokerIds.map((b, i) => {
    const hs = held.filter((h) => h.broker === b);
    return { b, hs, value: hs.reduce((a, h) => a + liveVal(h), 0), stmt: hs.reduce((a, h) => a + valueOf(h) * rate(h), 0), cost: hs.reduce((a, h) => a + (liveCost(h) ?? 0), 0), color: CAT[(i + 1) % 8] };
  });
  // Consolidated = live Kite value + live value of every import. This is the same figure as the Overview's portfolio value.
  const extValue = by.reduce((a, x) => a + x.value, 0);
  const grand = kiteValue + extValue;
  const slices = [{ label: "Zerodha (Kite)", value: kiteValue, color: CAT[0] }, ...by.filter((x) => x.value > 0).map((x) => ({ label: BROKERS[x.b].label, value: x.value, color: x.color }))];
  void totalValue; void totalCost;

  return (<>
    <div className="grid g4">
      <div className="card hero"><div className="lbl">Combined portfolio</div><div className="big num">{inr(grand)}</div><span className="pill">Kite {inr(kiteValue)} · other {inr(extValue)}</span></div>
      {by.map((x) => (
        <div className="card kpi" key={x.b}><div className="lbl">{BROKERS[x.b].label}</div><div className="v num">{x.hs.length ? inr(x.value) : "–"}</div>
          <div className="d">{x.hs.length ? `${x.hs.length} holdings${x.cost ? ` · ${pct(((x.value - x.cost) / x.cost) * 100)} vs cost` : ""}` : "nothing imported"}</div></div>
      ))}
    </div>

    <div className="grid g2">
      <div className="card">
        <h2>Import a statement</h2>
        <div className="sub">Upload a holdings statement PDF from Axis Direct, ICICI Direct, Paytm Money, Vested or CoinDCX. You review the parsed rows before anything is saved. The PDF is read on this server and is not stored; if no rows are recognised and a Claude login or key is configured, the statement text is sent to Claude to extract them.</div>
        <div className="filters">{brokerIds.map((b) => (<button key={b} className={"chip" + (broker === b ? " on" : "")} onClick={() => setBroker(b)}>{BROKERS[b].label}</button>))}</div>
        <div className="imp-steps" style={{ marginTop: 4 }}>
          <label className={"drop" + (over ? " over" : "") + (file ? " has" : "")}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) pick(f); }}>
            <input type="file" accept="application/pdf,.pdf,text/csv,.csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); e.target.value = ""; }} />
            <span className="ico">{file ? "✓" : "⇪"}</span>
            <span>
              <div className="t">{file ? file.name : "Choose a PDF or CSV, or drop it here"}</div>
              <div className="s">{file ? `${(file.size / 1024).toFixed(0)} KB · ${BROKERS[broker].label}` : `${BROKERS[broker].label} holdings statement (PDF or CSV), up to 15 MB`}</div>
            </span>
            {file && <button type="button" className="nav clear" style={{ width: "auto" }} onClick={(e) => { e.preventDefault(); setFile(null); setPreview(null); }}>Remove</button>}
          </label>
          <input className="field" type="password" placeholder="PDF password (only if protected)" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
          <div><button className="btn primary" disabled={busy || !file} onClick={parse}>{busy && !preview ? "Reading…" : "Read statement"}</button></div>
          {msg && <div className={"sm " + (msg.ok ? "good" : "bad")}>{msg.text}</div>}
          <div className="sm muted fx">USD → INR rate (Vested): <input className="field sm num" type="number" step="0.1" value={fx} onChange={(e) => setFxSaved(Number(e.target.value) || 0)} style={{ width: 84 }} /> edit to today's rate</div>
        </div>
      </div>
      <div className="card">
        <h2>Where your money is</h2><div className="sub">Share of combined value, in ₹</div>
        {grand > 0 ? (
          <div className="alloc">
            <Donut data={slices} total={grand} center={<><b>{slices.length}</b><span>accounts</span></>} />
            <div className="alist">{slices.map((d) => (<div className="arow" key={d.label}><i style={{ background: d.color }} /><span>{d.label}</span><b className="num">{((d.value / grand) * 100).toFixed(1)}%</b></div>))}</div>
          </div>
        ) : <div className="empty">Nothing to show yet.</div>}
      </div>
    </div>

    {preview && (
      <div className="card">
        <h2>Review: {BROKERS[preview.broker].label}</h2>
        <div className="sub">{preview.rows.length} rows parsed ({preview.method === "claude" ? "extracted by Claude" : "table parser"}). Fix any wrong number, remove rows that are not holdings, then save. Saving replaces earlier {BROKERS[preview.broker].label} holdings. Prices are in {BROKERS[preview.broker].currency}.</div>
        <div className="tablewrap"><table>
          <thead><tr><th>Symbol</th><th>Name</th><th className="n">Qty</th><th className="n">Avg price</th><th className="n">Last price</th><th className="n">Value</th><th /></tr></thead>
          <tbody>{preview.rows.map((r, i) => (
            <tr key={i} className="imp-row">
              <td><input className="field sm" value={r.symbol} onChange={(e) => patch(i, { symbol: e.target.value.toUpperCase() })} style={{ width: 96 }} /></td>
              <td className="sm">{r.name}</td>
              {(["qty", "avg", "price", "value"] as const).map((k) => (
                <td className="n" key={k}><input className="field sm num" type="number" step="any" value={r[k] ?? ""} onChange={(e) => patch(i, { [k]: e.target.value === "" ? null : Number(e.target.value) })} style={{ width: 110 }} /></td>
              ))}
              <td><button className="x" aria-label="Remove row" onClick={() => setPreview((v) => v && { ...v, rows: v.rows.filter((_, x) => x !== i) })}>✕</button></td>
            </tr>))}</tbody>
        </table></div>
        <div className="rules-actions">
          <button className="nav on" disabled={busy || !preview.rows.length} onClick={save}>Save {preview.rows.length} holdings</button>
          <button className="nav" onClick={() => setPreview(null)}>Discard</button>
        </div>
      </div>
    )}

    {by.filter((x) => x.hs.length).map((x) => (
      <div className="card" key={x.b}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2>{BROKERS[x.b].label}</h2>
          <button className="nav" onClick={() => remove(x.b)}>Remove all</button>
        </div>
        <div className="sub">{x.hs[0].assetClass} · {x.hs[0].currency === "USD" ? `converted at ₹${fx}/USD` : "INR"}</div>
        <div className="tablewrap"><table>
          <thead><tr><th>Holding</th><th className="n">Qty</th><th className="n">Avg</th><th className="n">Value (₹)</th><th className="n">Return</th></tr></thead>
          <tbody>{x.hs.map((h, i) => {
            const v = liveVal(h), c = liveCost(h);
            return (<tr key={i}>
              <td><b>{h.symbol}</b><div className="sm muted">{h.name !== h.symbol ? h.name : ""}</div></td>
              <td className="n num">{h.qty.toLocaleString("en-IN", { maximumFractionDigits: 6 })}</td>
              <td className="n num">{h.avg != null ? `${h.currency === "USD" ? "$" : "₹"}${h.avg.toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : "–"}</td>
              <td className="n num">{inr(v)}<div className="sm muted">{((v / grand) * 100).toFixed(1)}% of all</div></td>
              <td className={"n num " + (c ? (v >= c ? "pos" : "neg") : "muted")}>{c ? pct(((v - c) / c) * 100) : "–"}</td>
            </tr>);
          })}</tbody>
        </table></div>
      </div>
    ))}
  </>);
}
