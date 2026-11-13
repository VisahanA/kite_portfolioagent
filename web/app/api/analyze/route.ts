import { NextResponse } from "next/server";
import { analyzeStock } from "../../../lib/agents";
import { errorJson, fxOf } from "../../../lib/api";
import { loadMergedReport } from "../../../lib/screen";
import { getSid } from "../../../lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  const report = loadMergedReport(await getSid(), fxOf(req));
  if (!report) return NextResponse.json({ error: "Not connected. Connect your Kite account first." }, { status: 404 });
  const r = report.results.find((x) => x.id === id);
  if (!r) return NextResponse.json({ error: "Unknown stock" }, { status: 404 });
  try {
    return NextResponse.json(await analyzeStock(r, report));
  } catch (e) {
    return errorJson(e, "Analysis failed", 500);
  }
}
