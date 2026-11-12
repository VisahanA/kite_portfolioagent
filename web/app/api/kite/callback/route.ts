import { NextResponse } from "next/server";
import { finishAuth } from "../../../../lib/kite";
import { getSid } from "../../../../lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const home = new URL("/", process.env.APP_URL || url.origin);
  if (!code) { home.searchParams.set("kite", "denied"); return NextResponse.redirect(home); }
  try {
    await finishAuth(await getSid(), code);
    home.searchParams.set("kite", "connected");
  } catch (e) {
    home.searchParams.set("kite", "error");
    home.searchParams.set("msg", (e as Error).message);
  }
  return NextResponse.redirect(home);
}
