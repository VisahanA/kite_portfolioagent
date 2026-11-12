"use client";

import { useEffect, useMemo, useState } from "react";
import type { Analysis, Report, ScreenResult } from "../lib/types";
import { planAll, type ExitPlan } from "../lib/exit";
import { planHoldingBuys, type EntryPlan } from "../lib/entry";
import { CAT, Donut, HBars, RangeBar, Scatter, Stacked, type Slice } from "./charts";
import Imports from "./Imports";
import { BROKERS, type ExtHolding } from "../lib/brokers";

const inr = (n: number) => (n < 0 ? "-" : "") + "₹" + Math.abs(Math.round(n)).toLocaleString("en-IN");
const inrk = (n: number) => { const a = Math.abs(n), s = n < 0 ? "-" : ""; return a >= 1e5 ? `${s}₹${(a / 1e5).toFixed(2)}L` : `${s}₹${(a / 1e3).toFixed(1)}k`; };
const pct = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
const stripCands = (r: Report): Report => ({ ...r, results: r.results.filter((x) => x.sources.includes("holding")) });
const sym = (id: string) => id.split(":").pop()!;
const stanceClass = (s: string) => (s === "Aligned positive" ? "good" : s === "Aligned cautious" ? "bad" : s.startsWith("Conflicting") ? "warn" : "");
const sigClass = (s: string) => (s === "ENTRY ZONE" ? "good" : s === "FAILS RULES" ? "bad" : s === "WAIT FOR ENTRY" || s === "TECHNICAL ONLY" ? "warn" : "");
const stanceColor = (s: string) => (s === "Aligned positive" ? "var(--pos)" : s === "Aligned cautious" ? "var(--neg)" : s.startsWith("Conflicting") ? "var(--warn)" : "var(--cx)");
const trendColor: Record<string, string> = { Uptrend: "var(--pos)", Recovering: "var(--c1)", Weakening: "var(--warn)", Downtrend: "var(--neg)" };

type Row = { r: ScreenResult; id: string; s: string; qty: number; ltp: number; value: number; cost: number; w: number; pnlAbs: number; pnlPct: number; sector: string; color: string };
type View = "overview" | "holdings" | "exit" | "entry" | "analytics" | "imports";
type SortKey = "value" | "pnlPct" | "rsi" | "quant" | "news";

export default function Dashboard({ report: initial, candidates, file: initialFile, rules, claude, external }: { report: Report; candidates: ScreenResult[]; file: string; rules: Record<string, unknown>; claude: boolean; external: ExtHolding[] }) {
  const [report, setReport] = useState<Report>(initial);
  const [file, setFile] = useState(initialFile);
  const [kite, setKite] = useState<{ authUrl?: string; note?: string } | null>(null);
  const [view, setView] = useState<View>("overview");
  const [analyses, setAnalyses] = useState<Record<string, Analysis>>({});
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
  const [brief, setBrief] = useState<string | null>(null);
  const [mail, setMail] = useState<{ authUrl?: string; note?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({ k: "value", dir: -1 });
  const [filter, setFilter] = useState("All");
  const [dark, setDark] = useState<boolean | null>(null);
  const [rulesText, setRulesText] = useState(() => JSON.stringify(rules, null, 2));
  const [rulesObj, setRulesObj] = useState(rules);
  const [rulesMsg, setRulesMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [ext, setExt] = useState<ExtHolding[]>(external);
  const [fx, setFx] = useState(88);
  useEffect(() => { try { const n = Number(localStorage.getItem("pa_usdinr")); if (n) setFx(n); } catch { /* optional */ } }, []);
  const setFxSaved = (n: number) => { setFx(n); try { localStorage.setItem("pa_usdinr", String(n)); } catch { /* optional */ } };

  // The report already includes imported holdings (merged server-side); quant/news only appear after Run agents.
  const rows: Row[] = useMemo(() => {
    const val = new Map(report.holdings_by_value.map((h) => [h.id, h]));
    return report.results
      .filter((r) => val.has(r.id))
      .map((r) => {
        const h = val.get(r.id)!;
        return { r, id: r.id, s: sym(r.id), qty: h.qty, ltp: h.ltp, value: h.value, cost: h.cost, w: (h.value / report.holdings_total_value) * 100, pnlAbs: h.value - h.cost, pnlPct: h.cost > 0 ? ((h.value - h.cost) / h.cost) * 100 : 0, sector: r.fundamentals?.sector ?? "Unclassified", color: "" };
      })
      .sort((a, b) => b.value - a.value)
      .map((x, i) => ({ ...x, color: CAT[i % 8] }));
  }, [report]);
  const kiteRows = rows;

  // Re-price imported USD holdings when the rate changes
  useEffect(() => {
    if (fx === 88 && ext.every((h) => h.currency !== "USD")) return;
    fetch(`/api/external?fx=${fx}`).then((r) => r.json()).then((d) => { if (d.report) setReport(stripCands(d.report)); }).catch(() => {});
  }, [fx]); // eslint-disable-line react-hooks/exhaustive-deps

  const plans = useMemo(() => planAll(report, rulesObj), [report, rulesObj]);
  const holdBuys = useMemo(() => planHoldingBuys(report, report.market.caution, rulesObj), [report, rulesObj]);
  const planOf = (id: string): ExitPlan | undefined => plans.find((p) => p.id === id);
  // Zerodha-only totals come from the server (imports merged into a Kite line must not count as Kite money).
  const kiteTotal = report.kite_total_value ?? report.holdings_total_value;
  const kiteCost = report.kite_total_cost ?? report.holdings_total_cost;
  const total = report.holdings_total_value;
  const totalCost = report.holdings_total_cost;
  const pnl = total - totalCost;
  const pnlPct = totalCost > 0 ? (pnl / totalCost) * 100 : 0;
  const m = report.market.technicals;
  const ran = Object.keys(analyses).length > 0;
  const byPnl = [...rows].sort((a, b) => b.pnlPct - a.pnlPct);
  const conflicts = Object.values(analyses).filter((a) => a.stance.startsWith("Conflicting"));
  const maxPe = Number((rules as { valuation?: { max_pe?: number } }).valuation?.max_pe ?? 40);
  const minRoe = Number((rules as { quality?: { min_roe?: number } }).quality?.min_roe ?? 15);

  async function saveRulesText() {
    try {
      const res = await fetch("/api/rules", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: rulesText }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setRulesText(JSON.stringify(data.rules, null, 2));
      setRulesObj(data.rules);
      setRulesMsg({ ok: true, text: "Saved." });
    } catch (e) { setRulesMsg({ ok: false, text: `Not saved: ${(e as Error).message}` }); }
  }

  async function run() {
    setRunning(true); setDone(0); setErr(null); setBrief(null); setKite(null);
    // 1. Pull live holdings from the Kite MCP server
    let runRows = kiteRows;
    try {
      const res = await fetch(`/api/kite/refresh?fx=${fx}`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      if (data.status === "auth") {
        setKite({ authUrl: data.authUrl });
        window.open(data.authUrl, "_blank");
        setRunning(false);
        return;
      }
      const fresh: Report = { ...data.report, results: data.report.results.filter((r: ScreenResult) => r.sources.includes("holding")) };
      setReport(fresh); setFile(fresh.generated_at.slice(0, 10));
      const val = new Map(fresh.holdings_by_value.map((h) => [h.id, h]));
      runRows = fresh.results.filter((r) => val.has(r.id)).map((r) => ({ id: r.id, s: sym(r.id) } as Row));
      setKite({ note: `Live holdings from Kite at ${new Date(data.fetchedAt).toLocaleTimeString()}${data.gaps.length ? ` · gaps: ${data.gaps.join("; ")}` : ""}` });
    } catch (e) {
      setKite({ note: `Kite refresh failed, showing last saved screen: ${(e as Error).message}` });
    }
    const out: Record<string, Analysis> = {};
    for (const row of runRows) {
      try {
        const res = await fetch(`/api/analyze?id=${encodeURIComponent(row.id)}&fx=${fx}`);
        const text = await res.text();
        let data: unknown;
        try { data = JSON.parse(text); } catch { throw new Error(`Server returned non-JSON (HTTP ${res.status}). Check the dev server console.`); }
        if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
        out[row.id] = data as Analysis;
        setAnalyses({ ...out });
      } catch (e) { setErr(`${row.s}: ${(e as Error).message}`); }
      setDone((d) => d + 1);
    }
    let briefText: string | null = null;
    if (claude && Object.keys(out).length) {
      try {
        const res = await fetch("/api/brief", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ analyses: Object.values(out) }) });
        if (res.ok) { briefText = (await res.json()).brief; setBrief(briefText); }
      } catch { /* optional */ }
    }
    if (Object.keys(out).length) {
      try {
        const res = await fetch("/api/gmail/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ analyses: Object.values(out), brief: briefText }) });
        const d = await res.json();
        if (!res.ok) setMail({ note: `Gmail draft failed: ${d.error}` });
        else if (d.status === "auth") setMail({ authUrl: d.authUrl });
        else if (d.status === "drafted") setMail({ note: `Report saved as Gmail draft: ${d.subject}` });
        else setMail(null);
      } catch (e) { setMail({ note: `Gmail draft failed: ${(e as Error).message}` }); }
    }
    setRunning(false);
  }

  function toggleTheme() {
    const next = !(dark ?? window.matchMedia("(prefers-color-scheme: dark)").matches);
    setDark(next);
    document.documentElement.setAttribute("data-theme", next ? "dark" : "light");
  }

  const signals = ["All", ...Array.from(new Set(rows.map((x) => x.r.signal)))];
  const tableRows = useMemo(() => {
    const val = (x: Row) => sort.k === "value" ? x.value : sort.k === "pnlPct" ? x.pnlPct : sort.k === "rsi" ? x.r.technicals?.rsi14 ?? -1 : sort.k === "quant" ? analyses[x.id]?.quantScore ?? -999 : analyses[x.id]?.newsScore ?? -999;
    return rows.filter((x) => filter === "All" || x.r.signal === filter).sort((a, b) => (val(a) - val(b)) * sort.dir);
  }, [rows, sort, filter, analyses]);
  const th = (k: SortKey, label: string, n = true) => (
    <th className={n ? "n" : ""} onClick={() => setSort((s) => ({ k, dir: s.k === k ? (-s.dir as 1 | -1) : -1 }))}>{label}{sort.k === k ? (sort.dir === -1 ? " ↓" : " ↑") : ""}</th>
  );

  // chart data
  const top = rows.slice(0, 7);
  const rest = rows.slice(7);
  const donut: Slice[] = [...top.map((x) => ({ label: x.s, value: x.value, color: x.color })), ...(rest.length ? [{ label: `Other (${rest.length})`, value: rest.reduce((a, b) => a + b.value, 0), color: "var(--cx)" }] : [])];
  const sectors = Object.entries(kiteRows.reduce<Record<string, number>>((a, x) => ((a[x.sector] = (a[x.sector] ?? 0) + x.w), a), {})).sort((a, b) => b[1] - a[1]);
  const trendCounts = ["Uptrend", "Recovering", "Weakening", "Downtrend"].map((t) => ({ label: t, value: kiteRows.filter((x) => x.r.technicals?.trend === t).length, color: trendColor[t] }))
    .concat([{ label: "No data", value: kiteRows.filter((x) => !x.r.technicals).length, color: "var(--cx)" }]);
  const sigs = Array.from(new Set(kiteRows.map((x) => x.r.signal)));
  const sigCounts = sigs.map((s) => ({ label: s, value: kiteRows.filter((x) => x.r.signal === s).length, color: s === "ENTRY ZONE" ? "var(--pos)" : s === "FAILS RULES" ? "var(--neg)" : s === "WAIT FOR ENTRY" ? "var(--c4)" : s === "TECHNICAL ONLY" ? "var(--c1)" : "var(--cx)" }));
  const attention = kiteRows.filter((x) => x.r.technicals?.trend === "Downtrend" || x.r.signal === "FAILS RULES").sort((a, b) => b.value - a.value).slice(0, 5);
  const sel_ = sel ? rows.find((x) => x.id === sel) : null;
  const selA = sel ? analyses[sel] : null;

  const NavBtn = ({ v, icon, label }: { v: View; icon: string; label: string }) => (
    <button className={"nav" + (view === v ? " on" : "")} onClick={() => setView(v)}><span>{icon}</span>{label}</button>
  );

  return (
    <div className="app">
      <aside className="side">
        <div className="brand"><span className="logo">◆</span>Portfolio Agent</div>
        <NavBtn v="overview" icon="▦" label="Overview" />
        <NavBtn v="holdings" icon="☰" label="Holdings" />
        <NavBtn v="exit" icon="↗" label="Exit plan" />
        <NavBtn v="entry" icon="↘" label="Entry plan" />
        <NavBtn v="analytics" icon="◔" label="Analytics" />
        <NavBtn v="imports" icon="⇪" label="Imports" />
        <div className="grow" />
        <button className="nav" onClick={toggleTheme}><span>◐</span>Toggle theme</button>
        <div className="sidefoot">Screen {file.replace("screen-", "").replace(".json", "")}<br />Candles to {m.last_candle ?? "n/a"}<br />{claude ? "Claude sentiment on" : "Lexicon sentiment"}</div>
      </aside>

      <main className="main">
        <div className="head">
          <div>
            <h1>{view === "overview" ? "Overview" : view === "holdings" ? "Holdings" : view === "exit" ? "Exit plan" : view === "entry" ? "Entry plan" : view === "imports" ? "Imports" : "Analytics"}</h1>
            <div className="muted sm">{rows.length} holdings · quant signals + news sentiment · read-only</div>
          </div>
          <div className="actions">
            <div>
              <button className="btn primary" disabled={running} onClick={run}>{running ? `Running agents ${done}/${kiteRows.length}…` : ran ? "↻ Re-run agents" : "▶ Run agents"}</button>
              {running && <div className="bar"><i style={{ width: `${(done / Math.max(1, kiteRows.length)) * 100}%` }} /></div>}
              {kite?.authUrl && <div className="muted sm">Kite login needed: <a href={kite.authUrl} target="_blank" rel="noreferrer">authorize here</a>, then click Run agents again.</div>}
              {kite?.note && <div className="muted sm">{kite.note}</div>}
              <div className="muted sm"><a href="#" onClick={async (e) => { e.preventDefault(); await fetch("/api/kite/logout", { method: "POST" }); window.location.href = "/"; }}>Switch Kite account</a></div>
              {mail?.authUrl && <div className="muted sm">Gmail login needed: <a href={mail.authUrl} target="_blank" rel="noreferrer">authorize here</a>, then click Run agents again.</div>}
              {mail?.note && <div className="muted sm">{mail.note}</div>}
            </div>
          </div>
        </div>

        {err && <div className="card sm neg" style={{ marginBottom: 16 }}>{err}</div>}

        {view === "overview" && (<>
          <div className="grid g4">
            <div className="card hero">
              <div className="lbl">Portfolio value</div>
              <div className="big num">{inr(total)}</div>
              <span className="pill">{pnl >= 0 ? "▲" : "▼"} {inr(pnl)} · {pct(pnlPct)} vs cost</span>
            </div>
            <div className="card kpi"><div className="lbl">Invested</div><div className="v num">{inr(totalCost)}</div><div className="d">{rows.length} positions</div></div>
            <div className="card kpi"><div className="lbl">Best / worst</div><div className="v"><span className="pos">{byPnl[0].s}</span> <span className="muted">/</span> <span className="neg">{byPnl.at(-1)!.s}</span></div><div className="d">{pct(byPnl[0].pnlPct)} / {pct(byPnl.at(-1)!.pnlPct)}</div></div>
            <div className="card kpi"><div className="lbl">Quant vs news conflicts</div><div className="v">{ran ? conflicts.length : "–"}</div><div className="d">{ran ? conflicts.map((c) => c.symbol).join(", ") || "none" : "run agents to check"}</div></div>
          </div>

          <div className="grid g32">
            <div className="card">
              <h2>Allocation</h2><div className="sub">By current value</div>
              <div className="alloc">
                <Donut data={donut} total={total} center={<><b>{rows.length}</b><span>holdings</span></>} />
                <div className="alist">
                  {donut.map((d) => (<div className="arow" key={d.label}><i style={{ background: d.color }} /><span>{d.label}</span><span className="muted num">{inrk(d.value)}</span><b className="num">{((d.value / total) * 100).toFixed(1)}%</b></div>))}
                </div>
              </div>
            </div>
            <div className="card">
              <h2>NIFTY 50 regime</h2><div className="sub">Caution flag {report.market.caution ? "on" : "off"}</div>
              <div className="kpi"><div className="v">{m.trend} <span className="pill">RSI {m.rsi14}</span></div></div>
              <div style={{ margin: "14px 0" }}><RangeBar lo={m.low_52w} hi={m.high_52w} price={m.price} marks={[{ v: m.sma50, label: "SMA50" }, { v: m.sma200, label: "SMA200" }]} /></div>
              <div className="sm muted">52w {m.low_52w.toLocaleString("en-IN")} – {m.high_52w.toLocaleString("en-IN")} · ticks: SMA50, SMA200</div>
              <div className="mini"><div><span className="muted sm">Close</span><b className="num">{m.price.toLocaleString("en-IN")}</b></div><div><span className="muted sm">vs SMA50</span><b className={m.pct_vs_sma50 >= 0 ? "pos" : "neg"}>{pct(m.pct_vs_sma50)}</b></div><div><span className="muted sm">vs SMA200</span><b className={m.pct_vs_sma200 >= 0 ? "pos" : "neg"}>{pct(m.pct_vs_sma200)}</b></div></div>
            </div>
          </div>

          <div className="grid g2">
            <div className="card"><h2>Return on cost</h2><div className="sub">Unrealised, per holding</div><HBars diverging data={byPnl.map((x) => ({ label: x.s, value: x.pnlPct, sub: inr(x.pnlAbs) }))} fmt={pct} /></div>
            <div className="card">
              <h2>Needs a look</h2><div className="sub">Largest holdings in a downtrend or failing your rules</div>
              {attention.map((x) => (
                <div key={x.id} className="arow" style={{ gridTemplateColumns: "1fr auto auto", padding: "8px 0", borderBottom: "1px solid var(--line)", cursor: "pointer" }} onClick={() => setSel(x.id)}>
                  <span><b>{x.s}</b> <span className="muted sm">{x.r.technicals?.trend ?? "No candles"} · {x.w.toFixed(1)}%</span></span>
                  <span className={x.pnlPct >= 0 ? "pos num" : "neg num"}>{pct(x.pnlPct)}</span>
                  <span className={"pill " + sigClass(x.r.signal)}>{x.r.signal}</span>
                </div>
              ))}
              {brief && (<><h2 style={{ marginTop: 18 }}>Agent brief</h2><pre className="brief">{brief}</pre></>)}
              {!ran && <div className="empty" style={{ marginTop: 16 }}>Run the agents to add news sentiment and a quant-vs-news check.</div>}
            </div>
          </div>
        </>)}

        {view === "holdings" && (
          <div className="card">
            <div className="filters">{signals.map((s) => (<button key={s} className={"chip" + (filter === s ? " on" : "")} onClick={() => setFilter(s)}>{s}</button>))}</div>
            <div className="tablewrap">
              <table>
                <thead><tr><th>Holding</th>{th("value", "Value")}{th("pnlPct", "Return")}<th>52w range</th>{th("rsi", "RSI")}<th>Screen</th>{th("quant", "Quant")}{th("news", "News")}<th>Stance</th></tr></thead>
                <tbody>
                  {tableRows.map((x) => {
                    const a = analyses[x.id], t = x.r.technicals;
                    return (
                      <tr key={x.id} className={sel === x.id ? "sel" : ""} onClick={() => setSel(x.id)}>
                        <td><div className="sym"><span className="av" style={{ background: x.color }}>{x.s.slice(0, 2)}</span><div><b>{x.s}</b><div className="sm muted">{x.sector}</div></div></div></td>
                        <td className="n num">{inr(x.value)}<span className="wbar"><i style={{ width: `${Math.min(100, x.w * 4)}%` }} /></span><div className="sm muted">{x.w.toFixed(1)}%</div></td>
                        <td className={"n num " + (x.pnlPct >= 0 ? "pos" : "neg")}>{pct(x.pnlPct)}<div className="sm muted">{inr(x.pnlAbs)}</div></td>
                        <td>{t ? <RangeBar lo={t.low_52w} hi={t.high_52w} price={t.price} marks={[{ v: t.sma200, label: "SMA200" }]} /> : <span className="muted">–</span>}<div className="sm muted">{t?.trend ?? "No candles"}</div></td>
                        <td className="n num">{t ? t.rsi14 : "–"}</td>
                        <td><span className={"pill " + sigClass(x.r.signal)}>{x.r.signal}</span></td>
                        <td className="n">{a ? <span className="score">{a.quantScore}</span> : <span className="muted">–</span>}</td>
                        <td className="n">{a ? <span className="score">{a.sentiment.method === "none" ? "n/a" : a.newsScore}</span> : <span className="muted">–</span>}</td>
                        <td>{a ? <span className={"pill " + stanceClass(a.stance)}>{a.stance}</span> : <span className="muted">–</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {view === "exit" && (() => {
          const trims = plans.filter((p) => p.now.pct > 0);
          const proceeds = trims.reduce((a, p) => a + p.now.proceeds, 0);
          const realised = trims.reduce((a, p) => a + p.now.realised_pnl, 0);
          const downside = plans.reduce((a, p) => a + (p.stop?.downside ?? 0), 0);
          const ladder = plans.reduce((a, p) => a + p.targets.reduce((x, t) => x + t.proceeds, 0), 0);
          const nameOf = (id: string) => rows.find((x) => x.id === id);
          return (<>
            <div className="grid g4">
              <div className="card kpi"><div className="lbl">Sell / trim now</div><div className="v">{trims.length}</div><div className="d">{trims.filter((p) => p.action === "Exit").length} full exits · {inrk(proceeds)} proceeds</div></div>
              <div className="card kpi"><div className="lbl">Realised P&amp;L if done</div><div className={"v num " + (realised >= 0 ? "pos" : "neg")}>{inr(realised)}</div><div className="d">vs your average cost, before tax</div></div>
              <div className="card kpi"><div className="lbl">Worst case at stops</div><div className="v num neg">{inr(-downside)}</div><div className="d">{pct((-downside / kiteTotal) * 100)} of portfolio, on shares kept</div></div>
              <div className="card kpi"><div className="lbl">Profit ladder</div><div className="v num">{inrk(ladder)}</div><div className="d">if every target fills</div></div>
            </div>
            <div className="card">
              <h2>When and how much</h2>
              <div className="sub">Triggers use daily closes, so check once after the market closes, not intraday. "Now" is what your rules say to sell at today's price; targets and stops are standing levels for the shares you keep. Edit the exit block in your rules to change any number.</div>
              <div className="tablewrap">
                <table>
                  <thead><tr><th>Holding</th><th>Action</th><th className="n">Sell now</th><th className="n">Stop</th><th>Profit targets</th><th>Why</th></tr></thead>
                  <tbody>
                    {plans.map((p) => { const x = nameOf(p.id)!; return (
                      <tr key={p.id} onClick={() => setSel(p.id)}>
                        <td><div className="sym"><span className="av" style={{ background: x.color }}>{x.s.slice(0, 2)}</span><div><b>{x.s}</b><div className="sm muted">{p.weight_pct.toFixed(1)}% · {pct(x.pnlPct)} vs cost</div></div></div></td>
                        <td><span className={"pill " + (p.action === "Exit" ? "bad" : p.action === "Trim" ? "warn" : "good")}>{p.action}</span></td>
                        <td className="n num">{p.now.shares ? <>{p.now.shares} of {x.qty}<div className="sm muted">{p.now.pct}% · {inrk(p.now.proceeds)}</div></> : <span className="muted">–</span>}</td>
                        <td className="n num">{p.stop ? <>{p.stop.price.toLocaleString("en-IN")}<div className="sm muted">-{p.stop.distance_pct}% · risk {inrk(p.stop.downside)}</div></> : <span className="muted">–</span>}</td>
                        <td className="num">{p.targets.length ? p.targets.map((t) => <div key={t.price} className="sm">{t.price.toLocaleString("en-IN")} <span className="muted">+{t.gain_pct}% · sell {t.shares}</span></div>) : <span className="muted">–</span>}</td>
                        <td className="sm">{p.now.reasons.length ? p.now.reasons.map((r, i) => <div key={i}>{r.text}</div>) : <span className="muted">No sell trigger. Keep the stop.</span>}</td>
                      </tr>); })}
                  </tbody>
                </table>
              </div>
            </div>
          </>);
        })()}

        {view === "entry" && (() => {
          const all = holdBuys;
          const now = all.filter((p) => p.status === "Enter now").length;
          const wait = all.filter((p) => p.status === "Wait for pullback").length;
          const stat = (p: EntryPlan) => (p.status === "Enter now" ? "good" : p.status === "Wait for pullback" ? "warn" : "bad");
          return (<>
            <div className="grid g4">
              <div className="card kpi"><div className="lbl">Holdings tracked</div><div className="v">{all.length}</div><div className="d">add-on triggers below</div></div>
              <div className="card kpi"><div className="lbl">In the entry zone now</div><div className="v">{now}</div><div className="d">of your {all.length} holdings</div></div>
              <div className="card kpi"><div className="lbl">Waiting for a pullback</div><div className="v">{wait}</div><div className="d">limit levels below</div></div>
              <div className="card kpi"><div className="lbl">Market</div><div className="v">{report.market.caution ? "Caution" : "Clear"}</div><div className="d">NIFTY {report.market.technicals.trend}, RSI {report.market.technicals.rsi14}</div></div>
            </div>
            <div className="card">
              <h2>Your holdings: buy triggers</h2>
              <div className="sub">Add-on levels for stocks you already own, from the same entry rules, priced at your live holdings price. Place limit or GTT buys at these levels; stocks in a downtrend get no trigger. "vs your avg" compares each level with your average cost.</div>
              <div className="tablewrap">
                <table>
                  <thead><tr><th>Holding</th><th>Status</th><th className="n">Entry zone</th><th>Buy in steps</th><th className="n">Stop</th><th>Targets</th><th>Why</th></tr></thead>
                  <tbody>
                    {holdBuys.map((p) => { const none = p.status === "Avoid for now"; return (
                      <tr key={p.id} onClick={() => setSel(p.id)}>
                        <td><div><b>{sym(p.id)}</b><div className="sm muted">{p.qty} sh · avg {p.avg_cost.toLocaleString("en-IN", { maximumFractionDigits: 2 })} · {pct(p.pnl_pct)}</div><div className="sm muted">LTP {p.price.toLocaleString("en-IN")}</div></div></td>
                        <td><span className={"pill " + stat(p)}>{p.status}</span><div className="sm muted">{p.signal}</div></td>
                        <td className="n num">{p.zone && !none ? <>{p.zone.low.toLocaleString("en-IN")} – {p.zone.high.toLocaleString("en-IN")}<div className="sm muted">{p.status === "Enter now" ? "price is in range" : `${p.away_pct}% below price`} · {p.zone.basis}</div></> : <span className="muted">–</span>}</td>
                        <td className="num">{!none && p.tranches.length ? p.tranches.map((x, i) => <div key={i} className="sm">{x.pct}% at {x.price.toLocaleString("en-IN")} <span className="muted">{pct((x.price / p.avg_cost - 1) * 100)} vs your avg</span></div>) : <span className="muted">No buy trigger</span>}</td>
                        <td className="n num">{p.stop && !none ? <>{p.stop.price.toLocaleString("en-IN")}<div className="sm muted">-{p.stop.distance_pct}% · {p.stop.basis}</div></> : <span className="muted">–</span>}</td>
                        <td className="num">{!none && p.targets.length ? <>{p.targets.map((x) => <div key={x.price} className="sm">{x.price.toLocaleString("en-IN")} <span className="muted">+{x.gain_pct}%</span></div>)}{p.reward_risk != null && <div className="sm muted">reward/risk {p.reward_risk}</div>}</> : <span className="muted">–</span>}</td>
                        <td className="sm">{p.reasons.map((x, i) => <div key={i}>{x}</div>)}{p.warnings.map((x, i) => <div key={"w" + i} className="muted">{x}</div>)}</td>
                      </tr>); })}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card"><div className="sub">How to read this: the entry zone is the nearest support below price (SMA20, SMA50 or SMA200) plus or minus your pullback band. "Buy in steps" splits the intended position across the zone so one price is never the whole bet. The stop and targets are measured from the average entry. Triggers use daily closes, so check after the close. Tune every number in the entry_plan and entry blocks of your rules.</div></div>
          </>);
        })()}

        {view === "imports" && <Imports held={ext} onChange={(h, rep) => { setExt(h); if (rep) setReport(stripCands(rep)); }} fx={fx} setFx={setFxSaved} kiteValue={kiteTotal} kiteCost={kiteCost} totalValue={total} totalCost={totalCost} ext_lines={report.ext_lines} />}

        {view === "analytics" && (<>
          <div className="grid g2">
            <div className="card">
              <h2>Quant vs news</h2><div className="sub">Agreement between trend/fundamental score and headline sentiment</div>
              {ran ? (
                <Scatter xDom={[-100, 100]} yDom={[-100, 100]} xMid={0} yMid={0} xLabel="Quant score" yLabel="News sentiment" quad={["Both positive", "News up, quant down", "Both cautious", "Quant up, news down"]}
                  pts={kiteRows.filter((x) => analyses[x.id]?.sentiment.method !== "none" && analyses[x.id]).map((x) => { const a = analyses[x.id]; return { label: x.s, x: a.quantScore, y: a.newsScore, r: 5 + x.w * 0.6, color: stanceColor(a.stance), tip: <><b>{x.s}</b><div>Quant {a.quantScore} · News {a.newsScore}</div><div>{a.stance}</div></> }; })} />
              ) : <div className="empty">Run the agents to plot quant against news.</div>}
              {ran && <div className="legend"><span><i style={{ background: "var(--pos)" }} />Aligned positive</span><span><i style={{ background: "var(--neg)" }} />Aligned cautious</span><span><i style={{ background: "var(--warn)" }} />Conflicting</span><span><i style={{ background: "var(--cx)" }} />Neutral</span></div>}
            </div>
            <div className="card">
              <h2>Quality vs valuation</h2><div className="sub">P/E against ROE; bubble size is portfolio weight. Dashed lines are your limits.</div>
              <Scatter xDom={[0, 80]} yDom={[0, 60]} xMid={maxPe} yMid={minRoe} xLabel="P/E (capped at 80)" yLabel="ROE %" quad={["Pricey, high quality", "Cheap, high quality", "Cheap, low quality", "Pricey, low quality"]}
                pts={kiteRows.filter((x) => x.r.fundamentals?.pe != null && x.r.fundamentals?.roe != null).map((x) => ({ label: x.s, x: Math.min(80, Math.max(0, x.r.fundamentals!.pe!)), y: Math.min(60, Math.max(0, x.r.fundamentals!.roe!)), r: 5 + x.w * 0.8, color: x.color, tip: <><b>{x.s}</b><div>P/E {x.r.fundamentals!.pe} · ROE {x.r.fundamentals!.roe}%</div><div>{x.w.toFixed(1)}% of portfolio</div></> }))} />
            </div>
          </div>

          <div className="grid g2">
            <div className="card"><h2>Sector exposure</h2><div className="sub">Share of portfolio value</div><HBars data={sectors.slice(0, 8).map(([k, v]) => ({ label: k, value: v }))} fmt={(n) => n.toFixed(1) + "%"} /></div>
            <div className="card"><h2>Momentum (RSI-14)</h2><div className="sub">Overbought above 70, oversold below 30</div>
              <HBars data={kiteRows.filter((x) => x.r.technicals).sort((a, b) => b.r.technicals!.rsi14 - a.r.technicals!.rsi14).map((x) => ({ label: x.s, value: x.r.technicals!.rsi14, color: x.r.technicals!.rsi14 > 70 ? "var(--warn)" : x.r.technicals!.rsi14 < 30 ? "var(--c1)" : "var(--accent)" }))} fmt={(n) => n.toFixed(0)} />
            </div>
          </div>

          <div className="grid g2">
            <div className="card"><h2>Trend mix</h2><div className="sub">Holdings by trend label</div><Stacked data={trendCounts} /></div>
            <div className="card"><h2>Screen signals</h2><div className="sub">Against your screen-rules.json</div><Stacked data={sigCounts} /></div>
          </div>
          <details className="card"><summary>Your screen rules (editable)</summary>
            <div className="sub">Saved to screen-rules.json. Scoring and risk changes apply on the next analysis run; screen signals (valuation, quality, growth, entry) update when the kite-fundamental-analysis skill re-scores.</div>
            <textarea className="rules-edit" spellCheck={false} value={rulesText} onChange={(e) => { setRulesText(e.target.value); setRulesMsg(null); }} />
            <div className="rules-actions">
              <button className="nav on" onClick={saveRulesText}>Save rules</button>
              <button className="nav" onClick={() => { setRulesText(JSON.stringify(rules, null, 2)); setRulesMsg(null); }}>Revert</button>
              {rulesMsg && <span className={rulesMsg.ok ? "good" : "bad"}>{rulesMsg.text}</span>}
            </div>
          </details>
        </>)}

        <p className="disc">A rule-based screen of your own holdings, not investment advice. Stances describe whether quant signals and news agree. The exit and entry plans apply your own thresholds in screen-rules.json mechanically; it does not know your tax position, holding period or goals. Read-only: no orders, GTTs or alerts are placed. Only company names go to the news feed and only scores go to the model API.</p>
      </main>

      {sel_ && (<>
        <div className="scrim" onClick={() => setSel(null)} />
        <aside className="drawer">
          <div className="dhead">
            <div className="sym"><span className="av" style={{ background: sel_.color }}>{sel_.s.slice(0, 2)}</span><div><h2 style={{ fontSize: 18 }}>{sel_.s}</h2><div className="sm muted">{sel_.sector}</div></div></div>
            <button className="x" onClick={() => setSel(null)} aria-label="Close">✕</button>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <span className={"pill " + sigClass(sel_.r.signal)}>{sel_.r.signal}</span>
            {selA && <span className={"pill " + stanceClass(selA.stance)}>{selA.stance}</span>}
          </div>
          <div className="mini">
            <div><span className="muted sm">Value</span><b className="num">{inrk(sel_.value)}</b></div>
            <div><span className="muted sm">Return</span><b className={sel_.pnlPct >= 0 ? "pos" : "neg"}>{pct(sel_.pnlPct)}</b></div>
            <div><span className="muted sm">Weight</span><b>{sel_.w.toFixed(1)}%</b></div>
            {sel_.r.technicals && <><div><span className="muted sm">RSI</span><b>{sel_.r.technicals.rsi14}</b></div><div><span className="muted sm">vs SMA50</span><b className={sel_.r.technicals.pct_vs_sma50 >= 0 ? "pos" : "neg"}>{pct(sel_.r.technicals.pct_vs_sma50)}</b></div><div><span className="muted sm">vs SMA200</span><b className={sel_.r.technicals.pct_vs_sma200 >= 0 ? "pos" : "neg"}>{pct(sel_.r.technicals.pct_vs_sma200)}</b></div></>}
          </div>
          {(() => { const p = planOf(sel_.id); return p ? (
            <div className="step"><b>Exit plan</b>
              <div>{p.action}{p.now.shares ? `: sell ${p.now.shares} of ${sel_.qty} shares (${p.now.pct}%) ≈ ${inr(p.now.proceeds)}, realising ${inr(p.now.realised_pnl)} vs cost.` : ". No sell trigger today."}</div>
              <ul>
                {p.now.reasons.map((r, i) => <li key={"r" + i}>{r.text}</li>)}
                {p.stop && <li>Stop {p.stop.price} ({p.stop.basis}): {p.stop.distance_pct}% below price. If hit, the {p.remaining_after_now} shares kept lose about {inr(p.stop.downside)}; the stop is {p.stop.vs_cost_pct >= 0 ? `${p.stop.vs_cost_pct}% above` : `${Math.abs(p.stop.vs_cost_pct)}% below`} your cost.</li>}
                {p.targets.map((t) => <li key={t.price}>At {t.price} ({t.why}): sell {t.shares} shares ({t.sell_pct}% of the rest) ≈ {inr(t.proceeds)}.</li>)}
                {p.notes.map((n, i) => <li key={"n" + i}>{n}</li>)}
              </ul>
            </div>) : null; })()}
          {!selA ? <div className="empty">Run the agents to see the quant, news and risk reasoning for {sel_.s}.</div> : (<>
            <div className="sm muted">Combined {selA.combined} = 60% quant ({selA.quantScore}) + 40% news ({selA.newsScore}) · synthesis: {selA.synthesis}</div>
            {selA.steps.map((s) => (<div className="step" key={s.agent}><b>{s.agent}</b><div>{s.summary}</div>{!!s.detail?.length && <ul>{s.detail.map((d, i) => <li key={i}>{d}</li>)}</ul>}</div>))}
            <h2 style={{ margin: "16px 0 6px" }}>Headlines</h2>
            <ul className="news">
              {selA.sentiment.headlines.map((h, i) => (<li key={i}><a href={h.link} target="_blank" rel="noreferrer">{h.title}<div className="sm muted">{h.source} · {h.published.slice(0, 10)}</div></a><span className={"num " + (h.score > 0.15 ? "pos" : h.score < -0.15 ? "neg" : "muted")}>{h.score.toFixed(1)}</span></li>))}
              {!selA.sentiment.headlines.length && <li className="muted">No recent headlines.</li>}
            </ul>
          </>)}
        </aside>
      </>)}
    </div>
  );
}
