import { NextResponse } from "next/server";
import { errorJson } from "../../../../lib/api";
import { createDraft } from "../../../../lib/gmail";
import type { Analysis } from "../../../../lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { analyses, brief } = (await req.json()) as { analyses: Analysis[]; brief: string | null };
  try {
    return NextResponse.json(await createDraft(analyses, brief));
  } catch (e) {
    return errorJson(e, "Gmail draft failed", 502);
  }
}
