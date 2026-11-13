import { NextResponse } from "next/server";
import { errorJson } from "../../../lib/api";
import { loadRules, saveRules } from "../../../lib/rules";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(loadRules());
}

export async function PUT(req: Request) {
  try {
    const { text } = (await req.json()) as { text?: string };
    if (typeof text !== "string") throw new Error("Missing rules text.");
    return NextResponse.json({ rules: saveRules(text) });
  } catch (e) {
    return errorJson(e, "Invalid rules", 400);
  }
}
