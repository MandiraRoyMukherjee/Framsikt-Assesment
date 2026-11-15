/**
 * Monthly report narrative: "LLM narrates, code computes".
 *
 *  1. Facts (numbers) come ONLY from MonthlyReport - computed by tested code.
 *  2. The LLM gets those facts and is told to use no other numbers.
 *  3. We VERIFY its answer: every number in the text must appear in the facts. If not (hallucination),
 *     or if the LLM is down / not configured, we return a deterministic template instead.
 * So the worst case is a plain, correct sentence - never a wrong figure in front of management.
 */
import { format } from "../domain/money";
import type { ReportSummarizer } from "../ports/llm";
import type { MonthlyReport } from "./report";

export function reportFacts(report: MonthlyReport): string[] {
  const lines = [`Month: ${report.month}`, `Total spend, both offices: ${format(report.total)}`];
  for (const o of report.offices) {
    lines.push(
      `${o.officeName}: spent ${format(o.spent)} of ${format(o.budget)} (${(o.budgetUsedBps / 100).toFixed(1)}% used), ` +
        `${o.purchaseCount} purchases, ${o.outstandingClaims} claims still waiting for HR, ${o.flaggedRefills} flagged`,
    );
    if (o.topItems.length) lines.push(`${o.officeName} top items: ${o.topItems.slice(0, 3).map((i) => `${i.name} x${i.quantity}`).join(", ")}`);
    if (o.refillsByVolunteer.length) {
      lines.push(`${o.officeName} refills by person: ${o.refillsByVolunteer.map((v) => `${v.volunteerId} ${v.count}`).join(", ")}`);
    }
  }
  return lines;
}

export function buildSummaryPrompt(report: MonthlyReport): { system: string; user: string } {
  return {
    system:
      "You write a 3-5 sentence monthly snack-spending summary for management. " +
      "Use ONLY the facts provided. Never calculate, estimate or invent numbers. Copy figures exactly as given.",
    user: reportFacts(report).join("\n"),
  };
}

export function templateSummary(report: MonthlyReport): string {
  const parts = report.offices.map(
    (o) => `${o.officeName} spent ${format(o.spent)} (${(o.budgetUsedBps / 100).toFixed(1)}% of budget) on ${o.purchaseCount} purchases`,
  );
  return `${report.month}: total snack spend ${format(report.total)}. ${parts.join("; ")}.`;
}

const numbersIn = (text: string): string[] => (text.replace(/(\d)[\s\u00a0,](?=\d{3}\b)/g, "$1").match(/\d+(?:\.\d+)?/g) ?? []);

/** True if every number in `text` also occurs in the facts (after removing thousands separators). */
export function usesOnlyKnownNumbers(text: string, report: MonthlyReport): boolean {
  const known = new Set(numbersIn(reportFacts(report).join("\n")));
  // Allow small ordinals/percent rounding the model may write, e.g. "3" in "3 purchases" is already known;
  // anything else must be copied from the facts.
  return numbersIn(text).every((n) => known.has(n));
}

export interface SummaryResult {
  text: string;
  source: "llm" | "template";
  reason?: "no-llm" | "llm-error" | "unknown-numbers";
}

export async function summarizeReport(report: MonthlyReport, summarizer?: ReportSummarizer): Promise<SummaryResult> {
  if (!summarizer) return { text: templateSummary(report), source: "template", reason: "no-llm" };
  try {
    const text = (await summarizer.summarize(report)).trim();
    if (!text) throw new Error("empty");
    if (!usesOnlyKnownNumbers(text, report)) {
      return { text: templateSummary(report), source: "template", reason: "unknown-numbers" };
    }
    return { text, source: "llm" };
  } catch {
    return { text: templateSummary(report), source: "template", reason: "llm-error" };
  }
}
