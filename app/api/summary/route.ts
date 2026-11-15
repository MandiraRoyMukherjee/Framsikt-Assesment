import { NextResponse } from "next/server";
import { llmConfigFromEnv, OpenAiReportSummarizer } from "../../../src/adapters/openai";
import { runScenario } from "../../../src/demo/scenario";
import { summarizeReport } from "../../../src/services/reportSummary";

// Dynamic on purpose: the LLM (if configured) is called per request, never at build time.
export const dynamic = "force-dynamic";

export async function GET() {
  const { report } = await runScenario();
  const cfg = llmConfigFromEnv();
  const summary = await summarizeReport(report, cfg ? new OpenAiReportSummarizer(cfg) : undefined);
  return NextResponse.json({ summary, llmConfigured: !!cfg });
}
