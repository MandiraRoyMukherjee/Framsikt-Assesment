/**
 * Deterministic end-to-end scenario used by the web demo (and tested).
 * It drives the REAL RefillService with the simulated chat / HR / directory / clock, so what the
 * demo shows is exactly what the core logic does - nothing is faked in the UI layer.
 */
import { FakeChat, FakeClock, FakeDirectory, FakeFx, FakeHr } from "../adapters/fakes";
import { InMemoryRefillRepository } from "../adapters/inMemoryRepository";
import { DEFAULT_CONFIG, OFFICES } from "../domain/config";
import { major } from "../domain/money";
import type { Employee } from "../domain/types";
import { buildMonthlyReport, type MonthlyReport } from "../services/report";
import { RefillService } from "../services/refillService";

const HOUR = 3_600_000;

export interface TimelineEntry {
  at: string; // ISO
  kind: "ACTION" | "SYSTEM" | "CHAT" | "HR";
  text: string;
}

export interface ScenarioResult {
  timeline: TimelineEntry[];
  report: MonthlyReport;
}

const e = (id: string, home: "OSL" | "BLR"): Employee => ({
  id,
  name: id,
  homeOfficeId: home,
  payrollCurrency: home === "OSL" ? "NOK" : "INR",
  isVolunteer: true,
});

export async function runScenario(): Promise<ScenarioResult> {
  const clock = new FakeClock(new Date("2026-03-10T09:00:00Z"));
  const chat = new FakeChat();
  const hr = new FakeHr();
  const directory = new FakeDirectory();
  [e("anna", "OSL"), e("bjorn", "OSL"), e("chloe", "OSL"), e("ravi", "BLR"), e("sita", "BLR"), e("tara", "BLR")].forEach((x) =>
    directory.add(x),
  );
  // Anna is on holiday all week; Oslo's Bjorn is visiting Bengaluru; Tara works from home.
  for (const d of ["2026-03-10", "2026-03-11"]) {
    directory.setPresence("anna", d, null).setPresence("tara", d, null);
  }
  directory.setPresence("bjorn", "2026-03-12", "BLR").setPresence("bjorn", "2026-03-13", "BLR");

  const service = new RefillService({
    repo: new InMemoryRefillRepository(),
    chat,
    hr,
    directory,
    clock,
    offices: OFFICES,
    config: DEFAULT_CONFIG,
    idGenerator: (() => {
      let n = 0;
      return () => `refill-${++n}`;
    })(),
  });

  const timeline: TimelineEntry[] = [];
  let seen = 0;
  const log = (kind: TimelineEntry["kind"], text: string) => timeline.push({ at: clock.now().toISOString(), kind, text });
  const flush = () => {
    for (const m of chat.messages.slice(seen)) {
      const to = "userId" in m.to ? `@${m.to.userId}` : `#${m.to.channelOfOffice}-snacks`;
      log("CHAT", `[${m.kind}] -> ${to}: ${m.text}`);
    }
    seen = chat.messages.length;
  };
  const step = async (kind: TimelineEntry["kind"], text: string, fn: () => Promise<unknown>) => {
    log(kind, text);
    await fn();
    flush();
  };

  // --- Oslo: first refill, first volunteer ignores the offer (hand-over by timeout)
  let oslo = (await service.reportEmpty("OSL", "chloe")).refill;
  log("ACTION", "Chloe reports the Oslo box empty");
  flush();
  await step("ACTION", "Chloe is not asked to buy - a second 'empty' report from Bjorn is ignored (one refill per office)", () =>
    service.reportEmpty("OSL", "bjorn"),
  );
  const first = oslo.assigneeId!;
  clock.advance(2 * HOUR + 1);
  await step("SYSTEM", `${first} did not answer within 2h -> scheduler hands the refill to the next volunteer`, () => service.tick());
  oslo = await service.getRefill(oslo.id);
  const second = oslo.assigneeId!;
  clock.advance(HOUR);
  await step("ACTION", `${second} accepts`, () => service.accept(oslo.id, second));
  clock.advance(5 * HOUR);
  hr.failNext = 1;
  await step("ACTION", `${second} uploads receipt: 840.00 NOK (HR system is down at this moment)`, () =>
    service.recordPurchase(oslo.id, second, {
      amount: major(840, "NOK"),
      receiptImageRef: "receipts/osl-001.jpg",
      items: [{ name: "Chips", quantity: 8 }, { name: "Fruit", quantity: 12 }, { name: "Nuts", quantity: 3 }],
    }),
  );
  clock.advance(HOUR);
  await step("SYSTEM", "Scheduler retries the HR claim automatically", () => service.tick());

  // --- Bengaluru: declined, then accepted
  clock.set(new Date("2026-03-11T04:30:00Z"));
  let blr = (await service.reportEmpty("BLR", "ravi")).refill;
  log("ACTION", "Ravi reports the Bengaluru box empty");
  flush();
  await step("ACTION", `${blr.assigneeId} declines`, () => service.decline(blr.id, blr.assigneeId!));
  blr = await service.getRefill(blr.id);
  const blrBuyer = blr.assigneeId!;
  await step("ACTION", `${blrBuyer} accepts`, () => service.accept(blr.id, blrBuyer));
  clock.advance(3 * HOUR);
  await step("ACTION", `${blrBuyer} uploads receipt: 2 450.00 INR`, () =>
    service.recordPurchase(blr.id, blrBuyer, {
      amount: major(2450, "INR"),
      receiptImageRef: "receipts/blr-001.jpg",
      items: [{ name: "Biscuits", quantity: 15 }, { name: "Chikki", quantity: 10 }, { name: "Fruit", quantity: 20 }],
    }),
  );

  // --- Visitor: Bjorn (Oslo) is in Bengaluru and is picked for the next Bengaluru refill
  clock.set(new Date("2026-03-12T05:00:00Z"));
  const blr2 = (await service.reportEmpty("BLR", "sita")).refill;
  log("ACTION", "Sita reports the Bengaluru box empty again");
  flush();
  await step("ACTION", `${blr2.assigneeId} (a visitor from Oslo, physically in Bengaluru) accepts`, () =>
    service.accept(blr2.id, blr2.assigneeId!),
  );
  clock.advance(2 * HOUR);
  await step("ACTION", `${blr2.assigneeId} uploads receipt: 1 900.00 INR (HR reimburses him in NOK, his payroll currency)`, () =>
    service.recordPurchase(blr2.id, blr2.assigneeId!, {
      amount: major(1900, "INR"),
      receiptImageRef: "receipts/blr-002.jpg",
      items: [{ name: "Biscuits", quantity: 10 }, { name: "Fruit", quantity: 15 }],
    }),
  );

  // --- HR approves after a few days
  clock.advance(4 * 24 * HOUR);
  for (const c of hr.claims.values()) hr.decide(c.hrClaimId, "APPROVED");
  await step("HR", "HR approves all pending claims (took 4-5 days)", () => service.tick());

  const report = buildMonthlyReport("2026-03", OFFICES, await service.listRefills(), new FakeFx());
  return { timeline, report };
}
