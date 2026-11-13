import { NextResponse } from "next/server";
import { hasClaude, llm } from "../../../lib/llm";
import type { Analysis } from "../../../lib/types";

export async function POST(req: Request) {
  if (!hasClaude()) return NextResponse.json({ brief: null, method: "none" });
  const { analyses } = (await req.json()) as { analyses: Analysis[] };
  // Only scores and flags are sent; no quantities, prices or cost basis.
  const lines = analyses.map((a) => `${a.symbol}: stance ${a.stance}, quant ${a.quantScore}, news ${a.newsScore}, flags: ${a.reviewNotes.join(" ") || "none"}`);
  try {
    const brief = await llm(
      "You write a short portfolio review brief from rule-based screen results and news sentiment. Never say buy, sell or hold; no position sizing; this is a screen, not advice. Max 120 words, bullet points.",
      `Per-holding results:\n${lines.join("\n")}\n\nHighlight conflicts between quant and news, and the holdings worth reviewing first.`,
      700,
    );
    return NextResponse.json({ brief, method: "claude" });
  } catch (e) {
    console.error("brief failed:", e);
    return NextResponse.json({ brief: null, method: "none" }); // the brief is optional
  }
}
