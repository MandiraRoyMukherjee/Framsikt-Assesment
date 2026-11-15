import { SEED_EMPLOYEES, SEED_PRESENCE } from "../demo/seedData";
import type { Queryable } from "../adapters/postgres";

/** Idempotent: safe to run many times (upserts), so `npm run db:seed` never duplicates data. */
export async function seed(db: Queryable): Promise<{ employees: number; presence: number }> {
  for (const e of SEED_EMPLOYEES) {
    await db.query(
      `INSERT INTO employees (id, name, home_office_id, payroll_currency, is_volunteer)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, home_office_id = EXCLUDED.home_office_id,
         payroll_currency = EXCLUDED.payroll_currency, is_volunteer = EXCLUDED.is_volunteer`,
      [e.id, e.name, e.homeOfficeId, e.payrollCurrency, e.isVolunteer],
    );
  }
  for (const p of SEED_PRESENCE) {
    await db.query(
      `INSERT INTO presence (employee_id, day, office_id) VALUES ($1,$2,$3)
       ON CONFLICT (employee_id, day) DO UPDATE SET office_id = EXCLUDED.office_id`,
      [p.employeeId, p.day, p.officeId],
    );
  }
  return { employees: SEED_EMPLOYEES.length, presence: SEED_PRESENCE.length };
}
