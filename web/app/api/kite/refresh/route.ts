import { NextResponse } from "next/server";
import { errorJson, fxOf } from "../../../../lib/api";
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
    return NextResponse.json({ ...out, report: loadMergedReport(sid, fxOf(req)) ?? out.report });
  } catch (e) {
    return errorJson(e, "Kite refresh failed", 502);
  }
}
