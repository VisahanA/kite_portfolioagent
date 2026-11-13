import fs from "node:fs";
import path from "node:path";

/** Repo root holding screen-rules.json and data/. */
export const dataDir = () => process.env.KITE_DATA_DIR || path.resolve(process.cwd(), "..");
/** A file under data/ (shared, public market data such as fundamentals and symbol aliases). */
export const dataFile = (name: string) => path.join(dataDir(), "data", name);

/** Parsed JSON, or null if the file is missing or invalid. */
export function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return null; }
}

/**
 * Write JSON, creating the folder. With `optional`, failures are ignored: used for shared caches,
 * which may sit on a read-only deploy.
 */
export function writeJson(file: string, data: unknown, { pretty = false, optional = false } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, pretty ? 2 : undefined));
  } catch (e) {
    if (!optional) throw e;
  }
}
