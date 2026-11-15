/**
 * LLM ports. The core never imports an LLM SDK: it only knows these two interfaces.
 *
 * Design rule (important for the interview): an LLM may ASSIST, it may never DECIDE money.
 *  - ReceiptReader   -> can only add a flag for a human to look at; never blocks a purchase or a claim.
 *  - ReportSummarizer-> only narrates numbers computed by code; output with unknown numbers is rejected.
 */
import type { Currency } from "../domain/money";
import type { MonthlyReport } from "../services/report";

export interface ReceiptReading {
  /** Total on the receipt in minor units (øre / paise), or null if it could not be read. */
  totalMinor: number | null;
  currency: Currency | null;
  /** 0..1 - the reader's own confidence. Low confidence never creates a flag. */
  confidence: number;
}

export interface ReceiptReader {
  read(receiptImageRef: string): Promise<ReceiptReading>;
}

export interface ReportSummarizer {
  summarize(report: MonthlyReport): Promise<string>;
}
