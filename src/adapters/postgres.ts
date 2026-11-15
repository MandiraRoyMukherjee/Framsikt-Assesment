/**
 * PostgreSQL (Neon) adapters: RefillRepository + DirectoryPort.
 * They depend only on `Queryable`, so they work with a real `pg` Pool (Neon) and with pg-mem in tests.
 *
 * The two concurrency rules from the design are enforced by the DATABASE:
 *  - insert(): the partial unique index `one_active_refill_per_office` -> ActiveRefillExistsError
 *  - save():   UPDATE ... WHERE id = $1 AND version = $2  -> 0 rows -> ConflictError
 */
import { ActiveRefillExistsError, ConflictError, NotFoundError } from "../domain/errors";
import type { Employee, EmployeeId, OfficeId, Refill } from "../domain/types";
import type { DirectoryPort, RefillRepository } from "../ports";

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

// ------------------------------------------------------------ (de)serialisation

const DATE_FIELDS = [
  "createdAt",
  "offerExpiresAt",
  "committedAt",
  "commitDeadline",
  "reminderSentAt",
  "escalatedAt",
] as const;

/** JSON turns Dates into strings; bring them back so the domain code sees real Dates. */
export function reviveRefill(data: any): Refill {
  const r = { ...data };
  for (const f of DATE_FIELDS) if (r[f]) r[f] = new Date(r[f]);
  r.attempts = (r.attempts ?? []).map((a: any) => ({ ...a, at: new Date(a.at) }));
  if (r.purchase) r.purchase = { ...r.purchase, purchasedAt: new Date(r.purchase.purchasedAt) };
  if (r.claim) {
    r.claim = {
      ...r.claim,
      submittedAt: new Date(r.claim.submittedAt),
      decidedAt: r.claim.decidedAt ? new Date(r.claim.decidedAt) : undefined,
      lastChasedAt: r.claim.lastChasedAt ? new Date(r.claim.lastChasedAt) : undefined,
    };
  }
  return r as Refill;
}

const ACTIVE = "('OPEN','OFFERED','COMMITTED')";

const isUniqueViolation = (e: unknown): boolean =>
  typeof e === "object" && e !== null && ((e as any).code === "23505" || /duplicate key|unique/i.test((e as any).message ?? ""));

// ------------------------------------------------------------------ repository

export class PostgresRefillRepository implements RefillRepository {
  constructor(private readonly db: Queryable) {}

  async get(id: string): Promise<Refill | undefined> {
    const { rows } = await this.db.query("SELECT data, version FROM refills WHERE id = $1", [id]);
    return rows[0] ? this.fromRow(rows[0]) : undefined;
  }

  async findActiveByOffice(officeId: OfficeId): Promise<Refill | undefined> {
    const { rows } = await this.db.query(
      `SELECT data, version FROM refills WHERE office_id = $1 AND status IN ${ACTIVE} LIMIT 1`,
      [officeId],
    );
    return rows[0] ? this.fromRow(rows[0]) : undefined;
  }

  async list(): Promise<Refill[]> {
    const { rows } = await this.db.query("SELECT data, version FROM refills ORDER BY created_at, id");
    return rows.map((r) => this.fromRow(r));
  }

  async insert(refill: Refill): Promise<void> {
    try {
      await this.db.query(
        "INSERT INTO refills (id, office_id, status, version, created_at, data) VALUES ($1,$2,$3,$4,$5,$6)",
        [refill.id, refill.officeId, refill.status, refill.version, refill.createdAt.toISOString(), JSON.stringify(refill)],
      );
    } catch (e) {
      if (isUniqueViolation(e)) {
        // Two unique rules can fire: the primary key (same id) or the one-active-refill index.
        // Don't parse driver-specific messages - just ask which one it was.
        if (await this.get(refill.id)) throw new ConflictError(`Refill ${refill.id} already exists`);
        throw new ActiveRefillExistsError(`Office ${refill.officeId} already has an active refill`);
      }
      throw e;
    }
  }

  async save(refill: Refill, expectedVersion: number): Promise<void> {
    const next = expectedVersion + 1;
    const doc = { ...refill, version: next };
    const res = await this.db.query(
      "UPDATE refills SET status = $1, version = $2, data = $3 WHERE id = $4 AND version = $5",
      [refill.status, next, JSON.stringify(doc), refill.id, expectedVersion],
    );
    if (res.rowCount === 0) {
      const exists = await this.db.query("SELECT version FROM refills WHERE id = $1", [refill.id]);
      if (exists.rows.length === 0) throw new NotFoundError(`Refill ${refill.id} not found`);
      throw new ConflictError(
        `Refill ${refill.id} changed concurrently (expected v${expectedVersion}, found v${exists.rows[0].version})`,
      );
    }
    refill.version = next;
  }

  private fromRow(row: { data: any; version: number }): Refill {
    const data = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
    // The `version` column is the source of truth, not the copy inside the document.
    return reviveRefill({ ...data, version: row.version });
  }
}

// ------------------------------------------------------------------- directory

export class PostgresDirectory implements DirectoryPort {
  constructor(private readonly db: Queryable) {}

  async getEmployee(id: EmployeeId): Promise<Employee | undefined> {
    const { rows } = await this.db.query("SELECT * FROM employees WHERE id = $1", [id]);
    return rows[0] ? toEmployee(rows[0]) : undefined;
  }

  async listVolunteers(): Promise<Employee[]> {
    const { rows } = await this.db.query("SELECT * FROM employees WHERE is_volunteer = TRUE ORDER BY id");
    return rows.map(toEmployee);
  }

  async officeOn(employeeId: EmployeeId, localDay: string): Promise<OfficeId | null> {
    const p = await this.db.query("SELECT office_id FROM presence WHERE employee_id = $1 AND day = $2", [employeeId, localDay]);
    if (p.rows[0]) return p.rows[0].office_id ?? null;
    const e = await this.db.query("SELECT home_office_id FROM employees WHERE id = $1", [employeeId]);
    return e.rows[0]?.home_office_id ?? null;
  }
}

function toEmployee(r: any): Employee {
  return {
    id: r.id,
    name: r.name,
    homeOfficeId: r.home_office_id,
    payrollCurrency: r.payroll_currency,
    isVolunteer: r.is_volunteer,
  };
}
