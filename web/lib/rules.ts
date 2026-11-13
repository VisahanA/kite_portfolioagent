import fs from "node:fs";
import path from "node:path";
import { riskOf, scoringOf, type Risk, type Scoring } from "./defaults";
import { dataDir, readJson } from "./store";

// screen-rules.json I/O. Defaults for missing keys live in defaults.ts.
const rulesPath = () => path.join(dataDir(), "screen-rules.json");

export const loadRules = (): Record<string, unknown> => readJson<Record<string, unknown>>(rulesPath()) ?? {};
export const loadScoring = (): Scoring => scoringOf(loadRules());
export const loadRisk = (): Risk => riskOf(loadRules());

/** Validate and write screen-rules.json. Throws on invalid JSON or a non-object. */
export function saveRules(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Rules must be a JSON object.");
  fs.writeFileSync(rulesPath(), JSON.stringify(parsed, null, 2) + "\n", "utf8");
  return parsed;
}
