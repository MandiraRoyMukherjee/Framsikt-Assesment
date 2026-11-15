/**
 * Sandbox = the REAL RefillService + simulated chat / HR / directory / clock, wrapped so a UI can
 * drive it by hand. It is browser-safe (no Node-only imports), so the interactive page runs it
 * client-side: no server, no database, works on Vercel as a static page.
 *
 * Nothing here re-implements a rule. Every button calls RefillService; when a rule says "no"
 * (second accept, late purchase, wrong person...) the typed error is shown in the timeline.
 */
import { FakeChat, FakeClock, FakeFx, FakeHr } from "../adapters/fakes";
import { InMemoryRefillRepository } from "../adapters/inMemoryRepository";
import { DEFAULT_CONFIG, OFFICES } from "../domain/config";
import { DomainError } from "../domain/errors";
import { major, type Money } from "../domain/money";
import { localDay, monthKey } from "../domain/time";
import type { Employee, EmployeeId, Office, OfficeId, Refill } from "../domain/types";
import type { DirectoryPort } from "../ports";
import type { ReceiptReader, ReceiptReading } from "../ports/llm";
import { summarize, type BudgetSummary } from "../services/budget";
import { RefillService } from "../services/refillService";
import { buildMonthlyReport, type MonthlyReport } from "../services/report";
import { templateSummary } from "../services/reportSummary";
import {
  buildCandidates,
  computeStats,
  rankCandidates,
  type Candidate,
  type VolunteerStats,
} from "../services/volunteerSelector";

export type Location = "office" | "remote" | "holiday" | "visiting";

export interface TimelineEntry {
  at: string;
  kind: "ACTION" | "SYSTEM" | "CHAT" | "HR" | "BLOCKED";
  text: string;
}

export interface PersonView {
  id: EmployeeId;
  home: OfficeId;
  isVolunteer: boolean;
  location: Location;
  /** Office the person is physically in right now (null = remote / holiday). */
  physicallyIn: OfficeId | null;
  stats: VolunteerStats;
}

export interface OfficeView {
  office: Office;
  budget: BudgetSummary;
  active?: Refill;
  history: Refill[];
  /** Who the system would ask next (best first) - makes the fairness rules visible. */
  ranking: Candidate[];
}

export interface HrClaimView {
  hrClaimId: string;
  employeeId: string;
  amount: Money;
  status: "PENDING" | "APPROVED" | "REJECTED";
}

export interface SandboxView {
  now: string;
  hrDown: boolean;
  people: PersonView[];
  offices: OfficeView[];
  hrClaims: HrClaimView[];
  report: MonthlyReport;
  summary: string;
  timeline: TimelineEntry[];
}

const PEOPLE: Employee[] = [
  ["anna", "OSL"], ["bjorn", "OSL"], ["chloe", "OSL"], ["dag", "OSL"],
  ["ravi", "BLR"], ["sita", "BLR"], ["tara", "BLR"], ["uma", "BLR"],
].map(([id, home]) => ({
  id: id!,
  name: id!,
  homeOfficeId: home!,
  payrollCurrency: home === "OSL" ? ("NOK" as const) : ("INR" as const),
  isVolunteer: true,
}));

const START = new Date("2026-03-10T09:00:00Z"); // Tuesday

const ITEM_PRESETS = [
  { name: "Chips", quantity: 6 },
  { name: "Fruit", quantity: 10 },
  { name: "Nuts", quantity: 3 },
];

class SandboxDirectory implements DirectoryPort {
  readonly location = new Map<EmployeeId, Location>();
  async getEmployee(id: EmployeeId) {
    return PEOPLE.find((p) => p.id === id);
  }
  async listVolunteers() {
    return PEOPLE.filter((p) => p.isVolunteer);
  }
  async officeOn(id: EmployeeId): Promise<OfficeId | null> {
    return this.physicalOffice(id);
  }
  physicalOffice(id: EmployeeId): OfficeId | null {
    const p = PEOPLE.find((e) => e.id === id);
    if (!p) return null;
    const loc = this.location.get(id) ?? "office";
    if (loc === "office") return p.homeOfficeId;
    if (loc === "visiting") return p.homeOfficeId === "OSL" ? "BLR" : "OSL";
    return null; // remote or holiday
  }
}

/** Stand-in for the LLM receipt reader: reports whatever the "receipt" really says. */
class SandboxReceiptReader implements ReceiptReader {
  truthMinor: number | null = null;
  currency: ReceiptReading["currency"] = null;
  async read(): Promise<ReceiptReading> {
    return { totalMinor: this.truthMinor, currency: this.currency, confidence: 0.95 };
  }
}

export class Sandbox {
  private clock = new FakeClock(START);
  private repo = new InMemoryRefillRepository();
  private chat = new FakeChat();
  private hr = new FakeHr();
  private directory = new SandboxDirectory();
  private reader = new SandboxReceiptReader();
  private service: RefillService;
  private timeline: TimelineEntry[] = [];
  private seen = 0;
  private hrDown = false;
  private seq = 0;

  constructor() {
    this.service = new RefillService({
      repo: this.repo,
      chat: this.chat,
      hr: this.hr,
      directory: this.directory,
      clock: this.clock,
      offices: OFFICES,
      config: DEFAULT_CONFIG,
      receiptReader: this.reader,
      idGenerator: () => `refill-${++this.seq}`,
    });
    this.log("SYSTEM", "Sandbox ready. Oslo and Bengaluru boxes are full. Click \"Box is empty\" on an office to start.");
  }

  // ---------------------------------------------------------------- actions

  reportEmpty(officeId: OfficeId, by: EmployeeId) {
    return this.run(`${by} reports the ${officeId} box empty`, () => this.service.reportEmpty(officeId, by));
  }

  accept(refillId: string, who: EmployeeId) {
    return this.run(`${who} presses Accept`, () => this.service.accept(refillId, who));
  }

  decline(refillId: string, who: EmployeeId) {
    return this.run(`${who} presses Decline`, () => this.service.decline(refillId, who));
  }

  release(refillId: string, who: EmployeeId) {
    return this.run(`${who} gives the job back`, () => this.service.release(refillId, who));
  }

  /** Same person double-taps Accept (two requests at once): exactly one may win. */
  async raceAccept(refillId: string, who: EmployeeId) {
    this.log("ACTION", `${who} double-taps Accept (two simultaneous requests)`);
    const results = await Promise.allSettled([this.service.accept(refillId, who), this.service.accept(refillId, who)]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    this.log(ok === 1 ? "SYSTEM" : "BLOCKED", `Result: ${ok} of 2 succeeded - ${ok === 1 ? "exactly one wins, the loser is rejected" : "UNEXPECTED"}`);
    this.flushChat();
  }

  async purchase(refillId: string, who: EmployeeId, amount: number, receiptActuallyShows?: number) {
    const refill = await this.repo.get(refillId);
    const currency = OFFICES.find((o) => o.id === refill?.officeId)?.currency ?? "NOK";
    this.reader.truthMinor = Math.round((receiptActuallyShows ?? amount) * 100);
    this.reader.currency = currency;
    await this.run(`${who} uploads a receipt for ${amount} ${currency}`, () =>
      this.service.recordPurchase(refillId, who, {
        amount: major(amount, currency),
        receiptImageRef: `receipts/${refillId}.jpg`,
        items: ITEM_PRESETS,
      }),
    );
  }

  hrDecide(hrClaimId: string, status: "APPROVED" | "REJECTED") {
    this.hr.decide(hrClaimId, status);
    return this.run(`HR ${status === "APPROVED" ? "approves" : "rejects"} ${hrClaimId}`, () => this.service.tick(), "HR");
  }

  setHrDown(down: boolean) {
    this.hrDown = down;
    this.hr.failNext = down ? 1_000_000 : 0;
    this.log("HR", down ? "HR system goes DOWN (claims cannot be created)" : "HR system is back UP");
  }

  setLocation(who: EmployeeId, loc: Location) {
    this.directory.location.set(who, loc);
    this.log("ACTION", `${who} is now: ${loc === "office" ? "in their home office" : loc === "visiting" ? "visiting the other office" : loc}`);
  }

  approveOverride(refillId: string, managerId: EmployeeId) {
    return this.run(`${managerId} approves a budget override`, () => this.service.approveBudgetOverride(refillId, managerId));
  }

  /** Move the clock forward, then let the scheduler run (what a cron would do). */
  advance(hours: number) {
    this.clock.advance(hours * 3_600_000);
    return this.run(`${hours >= 24 ? `${hours / 24} day(s)` : `${hours}h`} pass - scheduler runs`, () => this.service.tick(), "SYSTEM");
  }

  tick() {
    return this.run("Scheduler tick", () => this.service.tick(), "SYSTEM");
  }

  /** Fast-forward helper used by "spend most of the budget" so budget rules can be shown quickly. */
  async spendBudget(officeId: OfficeId, amount: number) {
    const office = OFFICES.find((o) => o.id === officeId)!;
    const buyer = PEOPLE.find((p) => p.homeOfficeId === officeId)!.id;
    this.log("SYSTEM", `Shortcut: ${amount} ${office.currency} already spent this month in ${office.name}`);
    const { refill } = await this.service.reportEmpty(officeId, buyer);
    if (refill.status === "OFFERED") await this.service.accept(refill.id, refill.assigneeId!);
    const current = await this.service.getRefill(refill.id);
    if (current.status === "COMMITTED") {
      await this.service.recordPurchase(current.id, current.assigneeId!, {
        amount: major(amount, office.currency),
        receiptImageRef: "receipts/shortcut.jpg",
        items: ITEM_PRESETS,
      });
    }
    this.flushChat();
  }

  // ------------------------------------------------------------------- view

  async view(): Promise<SandboxView> {
    const refills = await this.repo.list();
    const now = this.clock.now();
    const stats = computeStats(refills, now, DEFAULT_CONFIG);

    const people: PersonView[] = PEOPLE.map((p) => ({
      id: p.id,
      home: p.homeOfficeId,
      isVolunteer: p.isVolunteer,
      location: this.directory.location.get(p.id) ?? "office",
      physicallyIn: this.directory.physicalOffice(p.id),
      stats: stats.get(p.id) ?? { outstandingClaims: 0, recentRefills: 0, recentMisses: 0 },
    }));

    const offices: OfficeView[] = [];
    for (const office of OFFICES) {
      const mine = refills.filter((r) => r.officeId === office.id);
      const active = mine.find((r) => ["OPEN", "OFFERED", "COMMITTED"].includes(r.status));
      const tried = new Set(active?.attempts.map((a) => a.volunteerId) ?? []);
      const candidates = await buildCandidates(office, now, this.directory, refills, DEFAULT_CONFIG);
      offices.push({
        office,
        budget: summarize(office, monthKey(now, office.timezone), refills),
        active,
        history: mine.filter((r) => r !== active).reverse(),
        ranking: rankCandidates(candidates, tried, DEFAULT_CONFIG),
      });
    }

    const report = buildMonthlyReport(monthKey(now, "Europe/Oslo"), OFFICES, refills, new FakeFx());
    return {
      now: now.toISOString(),
      hrDown: this.hrDown,
      people,
      offices,
      hrClaims: [...this.hr.claims.values()].map((c) => ({
        hrClaimId: c.hrClaimId,
        employeeId: c.employeeId,
        amount: c.amount,
        status: c.status,
      })),
      report,
      summary: templateSummary(report),
      timeline: [...this.timeline],
    };
  }

  /** Local day label, handy for the UI header. */
  today(officeId: OfficeId): string {
    const o = OFFICES.find((x) => x.id === officeId)!;
    return localDay(this.clock.now(), o.timezone);
  }

  // ---------------------------------------------------------------- helpers

  private async run(label: string, fn: () => Promise<unknown>, kind: TimelineEntry["kind"] = "ACTION") {
    this.log(kind, label);
    try {
      const r = await fn();
      if (r && typeof r === "object" && "created" in r && (r as { created: boolean }).created === false) {
        this.log("SYSTEM", "A refill is already active for this office - the duplicate report was ignored (no second buyer)");
      }
    } catch (e) {
      const name = e instanceof Error ? e.constructor.name : "Error";
      const msg = e instanceof Error ? e.message : String(e);
      this.log("BLOCKED", `Rejected by the rules (${name}): ${msg}`);
      if (!(e instanceof DomainError)) throw e;
    }
    this.flushChat();
  }

  private log(kind: TimelineEntry["kind"], text: string) {
    this.timeline.push({ at: this.clock.now().toISOString(), kind, text });
  }

  private flushChat() {
    for (const m of this.chat.messages.slice(this.seen)) {
      const to = "userId" in m.to ? `@${m.to.userId}` : `#${m.to.channelOfOffice.toLowerCase()}-snacks`;
      this.log("CHAT", `[${m.kind}] to ${to}: ${m.text}`);
    }
    this.seen = this.chat.messages.length;
  }
}
