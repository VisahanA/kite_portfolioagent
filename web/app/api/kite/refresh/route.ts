import { NextResponse } from "next/server";
import { loadMergedReport, refreshHoldings, screenExternal } from "../../../../lib/screen";
import { getSid } from "../../../../lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // screening fetches candles + fundamentals per holding

export async function POST(req: Request) {
  const sid = await getSid();
  try {
    const out = await refreshHoldings(sid, new URL(req.url).origin);
    if (out.status !== "ok") return NextResponse.json(out);
    await screenExternal(sid).catch(() => {}); // refresh imported holdings' trend with the live Kite session
    const fx = Number(new URL(req.url).searchParams.get("fx")) || 88;
    return NextResponse.json({ ...out, report: loadMergedReport(sid, fx) ?? out.report });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message ?? "Kite refresh failed" }, { status: 502 });
  }
}
