/** Simulated stand-ins for the outside world: clock, chat tool, HR system, directory, FX. */
import type { Currency } from "../domain/money";
import type { Employee, EmployeeId, HrClaimStatus, OfficeId } from "../domain/types";
import type {
  ChatMessage,
  ChatPort,
  Clock,
  DirectoryPort,
  FxPort,
  HrClaimRequest,
  HrPort,
} from "../ports";

export class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  set(date: Date): void {
    this.current = new Date(date);
  }
}

export class FakeChat implements ChatPort {
  readonly messages: ChatMessage[] = [];
  async send(message: ChatMessage): Promise<void> {
    this.messages.push(message);
  }
  toUser(userId: EmployeeId, kind?: ChatMessage["kind"]): ChatMessage[] {
    return this.messages.filter(
      (m) => "userId" in m.to && m.to.userId === userId && (!kind || m.kind === kind),
    );
  }
  ofKind(kind: ChatMessage["kind"]): ChatMessage[] {
    return this.messages.filter((m) => m.kind === kind);
  }
}

export interface StoredHrClaim extends HrClaimRequest {
  hrClaimId: string;
  status: HrClaimStatus;
}

/**
 * Fake HR system. Like the real one it is slow to approve (tests/demo flip the status
 * manually) and can be down (failNext) - the core must survive both.
 */
export class FakeHr implements HrPort {
  readonly claims = new Map<string, StoredHrClaim>();
  /** Number of upcoming createClaim calls that will throw (simulated outage). */
  failNext = 0;
  /** Counts every create attempt - used to prove idempotent retries create one claim. */
  createCalls = 0;
  private seq = 0;

  async createClaim(req: HrClaimRequest): Promise<{ hrClaimId: string }> {
    this.createCalls++;
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("HR system unavailable");
    }
    // This fake de-duplicates by key; the real one may not, which is why the core also
    // stores hrClaimId and never calls createClaim again once it has one.
    for (const c of this.claims.values()) {
      if (c.idempotencyKey === req.idempotencyKey) return { hrClaimId: c.hrClaimId };
    }
    const hrClaimId = `HR-${++this.seq}`;
    this.claims.set(hrClaimId, { ...req, hrClaimId, status: "PENDING" });
    return { hrClaimId };
  }

  async getClaim(hrClaimId: string): Promise<{ status: HrClaimStatus }> {
    const c = this.claims.get(hrClaimId);
    if (!c) throw new Error(`Unknown HR claim ${hrClaimId}`);
    return { status: c.status };
  }

  decide(hrClaimId: string, status: Exclude<HrClaimStatus, "PENDING">): void {
    const c = this.claims.get(hrClaimId);
    if (!c) throw new Error(`Unknown HR claim ${hrClaimId}`);
    c.status = status;
  }
}

/**
 * Fake company directory + calendar. Default rule: everybody is at their home office
 * on weekdays; tests override with setPresence (home, holiday, visiting another office).
 */
export class FakeDirectory implements DirectoryPort {
  private readonly employees = new Map<EmployeeId, Employee>();
  private readonly presence = new Map<string, OfficeId | null>();

  add(employee: Employee): this {
    this.employees.set(employee.id, employee);
    return this;
  }

  setPresence(employeeId: EmployeeId, localDay: string, office: OfficeId | null): this {
    this.presence.set(`${employeeId}|${localDay}`, office);
    return this;
  }

  async getEmployee(id: EmployeeId): Promise<Employee | undefined> {
    return this.employees.get(id);
  }

  async listVolunteers(): Promise<Employee[]> {
    return [...this.employees.values()].filter((e) => e.isVolunteer);
  }

  async officeOn(employeeId: EmployeeId, localDay: string): Promise<OfficeId | null> {
    const key = `${employeeId}|${localDay}`;
    if (this.presence.has(key)) return this.presence.get(key) ?? null;
    const emp = this.employees.get(employeeId);
    return emp ? emp.homeOfficeId : null;
  }
}

export class FakeFx implements FxPort {
  /** key "FROM>TO" -> rate in millionths. Default: 1 INR = 0.125 NOK. */
  constructor(private readonly rates: Record<string, number> = { "INR>NOK": 125_000, "NOK>INR": 8_000_000 }) {}
  rateMicro(from: Currency, to: Currency, _month: string): number {
    if (from === to) return 1_000_000;
    const rate = this.rates[`${from}>${to}`];
    if (rate === undefined) throw new Error(`No FX rate ${from}>${to}`);
    return rate;
  }
}
