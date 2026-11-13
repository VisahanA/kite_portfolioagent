import { NextResponse } from "next/server";
import { DEFAULT_FX } from "./portfolio";

// Helpers shared by the route handlers in app/api.

/** USD -> INR rate from the `fx` query parameter. */
export const fxOf = (req: Request) => Number(new URL(req.url).searchParams.get("fx")) || DEFAULT_FX;

export const errorJson = (e: unknown, fallback: string, status: number) =>
  NextResponse.json({ error: (e as Error)?.message || fallback }, { status });

/** OAuth redirect target: finish the login, then send the browser home with `?<param>=connected|denied|error`. */
export async function oauthCallback(req: Request, param: string, finish: (code: string) => Promise<void>, base?: string) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const home = new URL("/", base || url.origin);
  if (!code) home.searchParams.set(param, "denied");
  else {
    try {
      await finish(code);
      home.searchParams.set(param, "connected");
    } catch (e) {
      home.searchParams.set(param, "error");
      home.searchParams.set("msg", (e as Error).message);
    }
  }
  return NextResponse.redirect(home);
}
