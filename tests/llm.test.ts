import { describe, expect, it } from "vitest";
import { major } from "../src/domain/money";
import { OFFICES } from "../src/domain/config";
import { FakeChat, FakeClock, FakeDirectory, FakeHr } from "../src/adapters/fakes";
import { InMemoryRefillRepository } from "../src/adapters/inMemoryRepository";
import { llmConfigFromEnv, OpenAiReceiptReader, OpenAiReportSummarizer, parseReceiptJson } from "../src/adapters/openai";
import type { ReceiptReader, ReceiptReading, ReportSummarizer } from "../src/ports/llm";
import { RefillService } from "../src/services/refillService";
import { buildMonthlyReport } from "../src/services/report";
import { reportFacts, summarizeReport, templateSummary, usesOnlyKnownNumbers } from "../src/services/reportSummary";
import { FakeFx } from "../src/adapters/fakes";
import { emp, START } from "./helpers/setup";
import type { Refill } from "../src/domain/types";

// ------------------------------------------------------------------ receipt check

class FakeReceiptReader implements ReceiptReader {
  calls = 0;
  constructor(private readonly result: ReceiptReading | Error) {}
  async read(): Promise<ReceiptReading> {
    this.calls++;
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

async function purchaseWith(reader: ReceiptReader | undefined, entered = 800) {
  const directory = new FakeDirectory().add(emp("anna", "OSL"));
  const hr = new FakeHr();
  const service = new RefillService({
    repo: new InMemoryRefillRepository(),
    chat: new FakeChat(),
    hr,
    directory,
    clock: new FakeClock(START),
    offices: OFFICES,
    receiptReader: reader,
    idGenerator: () => "r1",
  });
  const { refill } = await service.reportEmpty("OSL", "anna");
  await service.accept(refill.id, "anna");
  const done = await service.recordPurchase(refill.id, "anna", {
    amount: major(entered, "NOK"),
    receiptImageRef: "https://example.test/receipt.jpg",
    items: [{ name: "Chips", quantity: 5 }],
  });
  return { done, hr };
}

const reading = (totalMajor: number | null, over: Partial<ReceiptReading> = {}): ReceiptReading => ({
  totalMinor: totalMajor === null ? null : Math.round(totalMajor * 100),
  currency: "NOK",
  confidence: 0.95,
  ...over,
});

describe("LLM receipt check: assists, never decides", () => {
  it("no reader configured -> behaves exactly as before", async () => {
    const { done } = await purchaseWith(undefined);
    expect(done.flags).not.toContain("RECEIPT_MISMATCH");
    expect(done.status).toBe("CLAIM_SUBMITTED");
  });

  it("matching total -> no flag", async () => {
    const { done } = await purchaseWith(new FakeReceiptReader(reading(800)));
    expect(done.flags).not.toContain("RECEIPT_MISMATCH");
  });

  it("a confident mismatch adds a flag but the claim is STILL filed (never blocks)", async () => {
    const { done, hr } = await purchaseWith(new FakeReceiptReader(reading(500)), 800);
    expect(done.flags).toContain("RECEIPT_MISMATCH");
    expect(done.status).toBe("CLAIM_SUBMITTED");
    expect(hr.claims.size).toBe(1);
  });

  it("tolerates a <=1% difference (rounding)", async () => {
    const { done } = await purchaseWith(new FakeReceiptReader(reading(795)), 800); // 0.6%
    expect(done.flags).not.toContain("RECEIPT_MISMATCH");
  });

  it.each([
    ["unreadable receipt", reading(null)],
    ["low confidence", reading(100, { confidence: 0.3 })],
    ["different currency", reading(100, { currency: "INR" })],
  ])("%s -> no opinion, no flag", async (_name, r) => {
    const { done } = await purchaseWith(new FakeReceiptReader(r));
    expect(done.flags).not.toContain("RECEIPT_MISMATCH");
  });

  it("LLM outage never breaks the purchase", async () => {
    const reader = new FakeReceiptReader(new Error("LLM down"));
    const { done } = await purchaseWith(reader);
    expect(reader.calls).toBe(1);
    expect(done.status).toBe("CLAIM_SUBMITTED");
    expect(done.flags).not.toContain("RECEIPT_MISMATCH");
  });
});

describe("parseReceiptJson: LLM output is untrusted input", () => {
  it("parses a valid answer into minor units", () => {
    expect(parseReceiptJson('{"total": 840.5, "currency": "NOK", "confidence": 0.9}')).toEqual({
      totalMinor: 84050,
      currency: "NOK",
      confidence: 0.9,
    });
  });
  it.each(["not json", "{}", '{"total": -5}', '{"total": "840"}', '{"total": null}'])("rejects %s", (bad) => {
    expect(parseReceiptJson(bad).totalMinor).toBeNull();
  });
  it("clamps confidence and drops unknown currencies", () => {
    expect(parseReceiptJson('{"total": 10, "currency": "USD", "confidence": 7}')).toEqual({ totalMinor: 1000, currency: null, confidence: 1 });
  });
});

// ------------------------------------------------------------------ report summary

const bought = (office: "OSL" | "BLR", amount: number, at: string): Refill => ({
  id: `r-${office}-${at}`,
  officeId: office,
  status: "REIMBURSED",
  version: 1,
  reportedBy: "x",
  createdAt: new Date(at),
  selfTakeOpen: false,
  attempts: [],
  flags: [],
  purchase: {
    buyerId: "anna",
    amount: major(amount, office === "OSL" ? "NOK" : "INR"),
    receipt: { imageRef: "i" },
    items: [{ name: "Chips", quantity: 4 }],
    purchasedAt: new Date(at),
  },
});

const report = buildMonthlyReport(
  "2026-03",
  OFFICES,
  [bought("OSL", 1000, "2026-03-03T10:00:00Z"), bought("BLR", 2500, "2026-03-04T10:00:00Z")],
  new FakeFx(),
);

const stub = (text: string | Error): ReportSummarizer => ({
  async summarize() {
    if (text instanceof Error) throw text;
    return text;
  },
});

describe("monthly summary: LLM narrates, code computes", () => {
  it("facts contain the exact computed numbers", () => {
    const facts = reportFacts(report).join("\n");
    expect(facts).toContain("1 000.00 NOK");
    expect(facts).toContain("2 500.00 INR");
    expect(facts).toContain("1 312.50 NOK"); // 1 000 + 2 500 * 0.125
  });

  it("no LLM configured -> deterministic template", async () => {
    const r = await summarizeReport(report);
    expect(r).toEqual({ text: templateSummary(report), source: "template", reason: "no-llm" });
    expect(r.text).toContain("1 312.50 NOK");
  });

  it("accepts an LLM answer that only uses numbers from the facts", async () => {
    const text = "In 2026-03 the two offices spent 1 312.50 NOK; Oslo used 16.7% of its budget over 1 purchases.";
    const r = await summarizeReport(report, stub(text));
    expect(r.source).toBe("llm");
    expect(r.text).toBe(text);
  });

  it("REJECTS an answer with a made-up number and falls back to the template", async () => {
    const r = await summarizeReport(report, stub("Spend was 9 999.00 NOK this month."));
    expect(r.source).toBe("template");
    expect(r.reason).toBe("unknown-numbers");
    expect(r.text).not.toContain("9 999");
  });

  it("LLM error or empty answer -> template, never throws", async () => {
    expect((await summarizeReport(report, stub(new Error("503")))).reason).toBe("llm-error");
    expect((await summarizeReport(report, stub("   "))).reason).toBe("llm-error");
  });

  it("number check ignores thousands separators", () => {
    expect(usesOnlyKnownNumbers("Total 1312.50 NOK", report)).toBe(true);
    expect(usesOnlyKnownNumbers("Total 1 312.50 NOK", report)).toBe(true);
    expect(usesOnlyKnownNumbers("Total 1 313.50 NOK", report)).toBe(false);
  });
});

// ------------------------------------------------------------------ OpenAI-compatible adapter

const okFetch = (content: string, seen: { url?: string; body?: any; auth?: string } = {}): typeof fetch =>
  (async (url: any, init: any) => {
    seen.url = String(url);
    seen.body = JSON.parse(init.body);
    seen.auth = init.headers.authorization;
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }) as typeof fetch;

describe("OpenAI-compatible adapter (fetch stubbed, no network)", () => {
  it("is disabled without LLM_API_KEY and configured from env otherwise", () => {
    expect(llmConfigFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(llmConfigFromEnv({ LLM_API_KEY: "k" } as unknown as NodeJS.ProcessEnv)).toMatchObject({
      apiKey: "k",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    });
  });

  it("receipt reader sends the image, temperature 0, JSON mode and the bearer key", async () => {
    const seen: any = {};
    const reader = new OpenAiReceiptReader({
      apiKey: "secret",
      baseUrl: "http://llm.local/v1/",
      model: "m",
      fetchImpl: okFetch('{"total": 840, "currency": "NOK", "confidence": 0.9}', seen),
    });
    const r = await reader.read("https://example.test/r.jpg");
    expect(r.totalMinor).toBe(84000);
    expect(seen.url).toBe("http://llm.local/v1/chat/completions");
    expect(seen.auth).toBe("Bearer secret");
    expect(seen.body.temperature).toBe(0);
    expect(seen.body.response_format).toEqual({ type: "json_object" });
    expect(JSON.stringify(seen.body.messages)).toContain("https://example.test/r.jpg");
  });

  it("summarizer sends the facts and returns the text; HTTP errors surface as exceptions", async () => {
    const seen: any = {};
    const ok = new OpenAiReportSummarizer({ apiKey: "k", baseUrl: "http://x", model: "m", fetchImpl: okFetch("Fine.", seen) });
    expect(await ok.summarize(report)).toBe("Fine.");
    expect(seen.body.messages[1].content).toContain("1 312.50 NOK");

    const failing = new OpenAiReportSummarizer({
      apiKey: "k",
      baseUrl: "http://x",
      model: "m",
      fetchImpl: (async () => new Response("no", { status: 500 })) as typeof fetch,
    });
    await expect(failing.summarize(report)).rejects.toThrow("500");
    // ...and the orchestrator turns that into the template fallback
    expect((await summarizeReport(report, failing)).source).toBe("template");
  });
});
