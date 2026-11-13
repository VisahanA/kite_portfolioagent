import { NextResponse } from "next/server";
import { fxOf } from "../../../lib/api";
import { isBroker, toHoldings, type Broker, type ExtHolding } from "../../../lib/brokers";
import { loadExternal, replaceBroker } from "../../../lib/external";
import { loadMergedReport, screenExternal } from "../../../lib/screen";
import { getSid } from "../../../lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const badRequest = () => NextResponse.json({ error: "Bad request." }, { status: 400 });

/** Replace one broker's imported rows, re-screen imports, and return the holdings plus the merged report. */
async function replace(req: Request, broker: Broker, rows: ExtHolding[]) {
  const sid = await getSid();
  const holdings = replaceBroker(sid, broker, rows);
  await screenExternal(sid).catch(() => {}); // trend + fundamentals for the new rows; never blocks the save
  return NextResponse.json({ holdings, report: loadMergedReport(sid, fxOf(req)) });
}

export async function GET(req: Request) {
  const sid = await getSid();
  return NextResponse.json({ holdings: loadExternal(sid), report: loadMergedReport(sid, fxOf(req)) });
}

/** Save the confirmed rows for one broker, replacing that broker's earlier import. */
export async function PUT(req: Request) {
  const { broker, holdings } = (await req.json()) as { broker: unknown; holdings: unknown };
  if (!isBroker(broker) || !Array.isArray(holdings)) return badRequest();
  return replace(req, broker, toHoldings(holdings, broker));
}

export async function DELETE(req: Request) {
  const broker = new URL(req.url).searchParams.get("broker");
  if (!isBroker(broker)) return badRequest();
  return replace(req, broker, []);
}
