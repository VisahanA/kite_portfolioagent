import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { cookies } from "next/headers";

const COOKIE = "pa_sid";
const SID = /^[a-f0-9]{32}$/;
export const sessionDir = () => {
  const d = process.env.SESSION_DIR || path.resolve(process.cwd(), ".sessions"); // holds OAuth tokens + that user's report: gitignored
  fs.mkdirSync(d, { recursive: true });
  return d;
};

/** Read the browser's session id without creating one (safe in server components). */
export async function peekSid(): Promise<string | null> {
  const v = (await cookies()).get(COOKIE)?.value;
  return v && SID.test(v) ? v : null;
}

/** Read or create the session id. Only call from route handlers (they may set cookies). Each browser gets its own Kite login and report. */
export async function getSid(): Promise<string> {
  const jar = await cookies();
  const v = jar.get(COOKIE)?.value;
  if (v && SID.test(v)) return v;
  const sid = crypto.randomBytes(16).toString("hex");
  jar.set(COOKIE, sid, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 30 });
  return sid;
}

export const sessionFile = (sid: string, kind: "oauth" | "report" | "external" | "extscreen") => path.join(sessionDir(), `${sid}.${kind}.json`);

export function readJson<T>(file: string): T | null { try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return null; } }
