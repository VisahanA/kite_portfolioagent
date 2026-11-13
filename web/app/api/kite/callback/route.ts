import { oauthCallback } from "../../../../lib/api";
import { finishAuth } from "../../../../lib/kite";
import { getSid } from "../../../../lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const sid = await getSid();
  return oauthCallback(req, "kite", (code) => finishAuth(sid, code), process.env.APP_URL);
}
