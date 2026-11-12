import { NextResponse } from "next/server";
import { isBroker, loadExternal, replaceBroker, type ExtHolding } from "../../../lib/external";
import { getSid } from "../../../lib/session";
import { loadMergedReport, screenExternal } from "../../../lib/screen";

export const maxDuration = 120;
const fxOf = (req: Request) => Number(new URL(req.url).searchParams.get("fx")) || 88;

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const sid = await getSid();
  return NextResponse.json({ holdings: loadExternal(sid), report: loadMergedReport(sid, fxOf(req)) });
}

/** Save the confirmed rows for one broker, replacing that broker's earlier import. */
export async function PUT(req: Request) {
  const { broker, holdings } = (await req.json()) as { broker: unknown; holdings: ExtHolding[] };
  if (!isBroker(broker) || !Array.isArray(holdings)) return NextResponse.json({ error: "Bad request." }, { status: 400 });
  const clean = holdings.filter((h) => h.symbol && Number(h.qty) > 0).map((h) => ({
    broker, symbol: String(h.symbol).slice(0, 40), name: String(h.name ?? h.symbol).slice(0, 120), qty: Number(h.qty),
    avg: h.avg != null ? Number(h.avg) : null, price: h.price != null ? Number(h.price) : null, value: h.value != null ? Number(h.value) : null,
    currency: h.currency === "USD" ? "USD" as const : "INR" as const, assetClass: String(h.assetClass ?? "").slice(0, 40),
  }));
  const sid = await getSid();
  const next = replaceBroker(sid, broker, clean);
  await screenExternal(sid).catch(() => {}); // trend + fundamentals for the new rows; never blocks the save
  return NextResponse.json({ holdings: next, report: loadMergedReport(sid, fxOf(req)) });
}

export async function DELETE(req: Request) {
  const broker = new URL(req.url).searchParams.get("broker");
  if (!isBroker(broker)) return NextResponse.json({ error: "Bad request." }, { status: 400 });
  const sid = await getSid();
  const next = replaceBroker(sid, broker, []);
  await screenExternal(sid).catch(() => {});
  return NextResponse.json({ holdings: next, report: loadMergedReport(sid, fxOf(req)) });
}
