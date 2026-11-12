import Dashboard from "./Dashboard";
import Landing from "./Landing";
import { loadRules } from "../lib/data";
import { loadExternal } from "../lib/external";
import { hasClaude } from "../lib/llm";
import { ensureAliases, loadMergedReport } from "../lib/screen";
import { peekSid } from "../lib/session";

export const dynamic = "force-dynamic";

export default async function Page() {
  const sid = await peekSid();
  await ensureAliases(sid);
  const report = loadMergedReport(sid);
  if (!report) return <Landing />;
  const holdings = report.results.filter((r) => r.sources.includes("holding"));
  const candidates = report.results.filter((r) => !r.sources.includes("holding"));
  return <Dashboard report={{ ...report, results: holdings }} candidates={candidates} file={report.generated_at.slice(0, 10)} rules={loadRules()} claude={hasClaude()} external={loadExternal(sid)} />;
}
