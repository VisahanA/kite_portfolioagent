import { NextResponse } from "next/server";
import { logout } from "../../../../lib/kite";
import { getSid } from "../../../../lib/session";

export const dynamic = "force-dynamic";

/** Forget this browser's Kite login and saved report, so the next connect signs in again (use to switch accounts). */
export async function POST() {
  logout(await getSid());
  return NextResponse.json({ status: "logged_out" });
}
