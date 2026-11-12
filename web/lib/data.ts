import fs from "node:fs";
import path from "node:path";

export const dataDir = () => process.env.KITE_DATA_DIR || path.resolve(process.cwd(), "..");

export function loadRules(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir(), "screen-rules.json"), "utf8")); } catch { return {}; }
}

export const symbolOf = (id: string) => id.split(":").pop() ?? id;
