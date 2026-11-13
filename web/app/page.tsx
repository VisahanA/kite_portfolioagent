import Dashboard from "./Dashboard";
import Landing from "./Landing";
import { loadExternal } from "../lib/external";
import { hasClaude } from "../lib/llm";
import { onlyHoldings } from "../lib/portfolio";
import { loadRules } from "../lib/rules";
import { ensureAliases, loadMergedReport } from "../lib/screen";
import { peekSid } from "../lib/session";

export const dynamic = "force-dynamic";

export default async function Page() {
  const sid = await peekSid();
  await ensureAliases(sid);
  const report = loadMergedReport(sid);
  if (!report) return <Landing />;
  return <Dashboard report={onlyHoldings(report)} rules={loadRules()} claude={hasClaude()} external={loadExternal(sid)} />;
}
