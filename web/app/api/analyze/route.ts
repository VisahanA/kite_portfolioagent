import { NextResponse } from "next/server";
import { analyzeStock } from "../../../lib/agents";
import { loadMergedReport } from "../../../lib/screen";
import { getSid } from "../../../lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const id = q.get("id");
  const report = loadMergedReport(await getSid(), Number(q.get("fx")) || 88);
  if (!report) return NextResponse.json({ error: "Not connected. Connect your Kite account first." }, { status: 404 });
  const r = report.results.find((x) => x.id === id);
  if (!r) return NextResponse.json({ error: "Unknown stock" }, { status: 404 });
  try {
    return NextResponse.json(await analyzeStock(r, report));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message ?? "Analysis failed" }, { status: 500 });
  }
}
