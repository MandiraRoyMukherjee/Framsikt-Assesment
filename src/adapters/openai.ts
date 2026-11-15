/**
 * Minimal OpenAI-compatible chat client (no SDK, just fetch), so ONE adapter works with OpenAI,
 * Azure OpenAI, Ollama, vLLM, or any gateway that speaks /chat/completions.
 * Configured through LLM_API_KEY / LLM_BASE_URL / LLM_MODEL (see .env.example).
 */
import type { Currency } from "../domain/money";
import { buildSummaryPrompt } from "../services/reportSummary";
import type { ReceiptReader, ReceiptReading, ReportSummarizer } from "../ports/llm";
import type { MonthlyReport } from "../services/report";

export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
}

export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig | undefined {
  if (!env.LLM_API_KEY) return undefined; // no key -> features degrade gracefully
  return {
    apiKey: env.LLM_API_KEY,
    baseUrl: env.LLM_BASE_URL || "https://api.openai.com/v1",
    model: env.LLM_MODEL || "gpt-4o-mini",
  };
}

type Content = string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;

async function chat(cfg: LlmConfig, messages: { role: "system" | "user"; content: Content }[], json = false): Promise<string> {
  const res = await (cfg.fetchImpl ?? fetch)(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0, // reproducible, no creative numbers
      messages,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`LLM request failed: ${res.status}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = body.choices?.[0]?.message?.content;
  if (!text) throw new Error("LLM returned no content");
  return text;
}

export class OpenAiReceiptReader implements ReceiptReader {
  constructor(private readonly cfg: LlmConfig) {}

  async read(receiptImageRef: string): Promise<ReceiptReading> {
    const text = await chat(
      this.cfg,
      [
        {
          role: "system",
          content:
            'You read shop receipts. Reply ONLY with JSON: {"total": <number or null>, "currency": "NOK"|"INR"|null, "confidence": <0..1>}. ' +
            "total is the final amount paid in major units (e.g. 840.50). If unreadable, use null.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Read the total of this receipt." },
            { type: "image_url", image_url: { url: receiptImageRef } },
          ],
        },
      ],
      true,
    );
    return parseReceiptJson(text);
  }
}

/** Defensive parsing: LLM output is untrusted input. */
export function parseReceiptJson(text: string): ReceiptReading {
  const none: ReceiptReading = { totalMinor: null, currency: null, confidence: 0 };
  let o: any;
  try {
    o = JSON.parse(text);
  } catch {
    return none;
  }
  const total = typeof o?.total === "number" && Number.isFinite(o.total) && o.total > 0 ? Math.round(o.total * 100) : null;
  const currency: Currency | null = o?.currency === "NOK" || o?.currency === "INR" ? o.currency : null;
  const confidence = typeof o?.confidence === "number" ? Math.min(1, Math.max(0, o.confidence)) : 0;
  return total === null ? none : { totalMinor: total, currency, confidence };
}

export class OpenAiReportSummarizer implements ReportSummarizer {
  constructor(private readonly cfg: LlmConfig) {}

  async summarize(report: MonthlyReport): Promise<string> {
    const { system, user } = buildSummaryPrompt(report);
    return chat(this.cfg, [
      { role: "system", content: system },
      { role: "user", content: user },
    ]);
  }
}
