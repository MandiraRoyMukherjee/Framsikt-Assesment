import { ActiveRefillExistsError, ConflictError, NotFoundError } from "../domain/errors";
import { ACTIVE_STATUSES, type OfficeId, type Refill } from "../domain/types";
import type { RefillRepository } from "../ports";

/**
 * In-memory repository that behaves like a database:
 *  - stores/returns COPIES (so a stale in-memory object cannot silently mutate stored state)
 *  - save() is compare-and-set on `version` (== UPDATE ... WHERE version = $expected)
 *  - insert() enforces "one active refill per office" (== partial unique index)
 */
export class InMemoryRefillRepository implements RefillRepository {
  private readonly rows = new Map<string, Refill>();

  async get(id: string): Promise<Refill | undefined> {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : undefined;
  }

  async findActiveByOffice(officeId: OfficeId): Promise<Refill | undefined> {
    for (const r of this.rows.values()) {
      if (r.officeId === officeId && ACTIVE_STATUSES.includes(r.status)) return structuredClone(r);
    }
    return undefined;
  }

  async list(): Promise<Refill[]> {
    return [...this.rows.values()].map((r) => structuredClone(r));
  }

  async insert(refill: Refill): Promise<void> {
    if (this.rows.has(refill.id)) throw new ConflictError(`Refill ${refill.id} already exists`);
    if (ACTIVE_STATUSES.includes(refill.status)) {
      for (const r of this.rows.values()) {
        if (r.officeId === refill.officeId && ACTIVE_STATUSES.includes(r.status)) {
          throw new ActiveRefillExistsError(`Office ${refill.officeId} already has active refill ${r.id}`);
        }
      }
    }
    this.rows.set(refill.id, structuredClone(refill));
  }

  async save(refill: Refill, expectedVersion: number): Promise<void> {
    const current = this.rows.get(refill.id);
    if (!current) throw new NotFoundError(`Refill ${refill.id} not found`);
    if (current.version !== expectedVersion) {
      throw new ConflictError(
        `Refill ${refill.id} changed concurrently (expected v${expectedVersion}, found v${current.version})`,
      );
    }
    refill.version = expectedVersion + 1;
    this.rows.set(refill.id, structuredClone(refill));
  }
}
