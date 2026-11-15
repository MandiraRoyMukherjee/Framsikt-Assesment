/**
 * Seed data: ~15 Oslo + ~20 Bengaluru volunteers (matching the brief), a few non-volunteers,
 * and presence exceptions (holiday, home office, visiting the other office).
 * Used by `npm run db:seed` and by the Postgres tests, so both see the same world.
 */
import type { Employee, EmployeeId, OfficeId } from "../domain/types";

export interface PresenceRow {
  employeeId: EmployeeId;
  day: string; // YYYY-MM-DD, office-local
  officeId: OfficeId | null; // null = home / holiday
}

const osloNames = [
  "anna", "bjorn", "chloe", "dag", "eirik", "freja", "gunnar", "hanne",
  "ingrid", "jonas", "kari", "lars", "mia", "nils", "olav",
];
const blrNames = [
  "ravi", "sita", "tara", "uma", "vikram", "wasim", "xena", "yash", "zoya", "arjun",
  "bhavna", "chetan", "deepa", "esha", "farhan", "gita", "harish", "isha", "jay", "kavya",
];

const make = (id: string, home: "OSL" | "BLR", isVolunteer: boolean): Employee => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  homeOfficeId: home,
  payrollCurrency: home === "OSL" ? "NOK" : "INR",
  isVolunteer,
});

export const SEED_EMPLOYEES: Employee[] = [
  ...osloNames.map((n) => make(n, "OSL", true)),
  ...blrNames.map((n) => make(n, "BLR", true)),
  make("mgr-osl", "OSL", false),
  make("mgr-blr", "BLR", false),
  make("emma", "OSL", false), // regular employee, not a volunteer
  make("karthik", "BLR", false),
];

/** Week of 2026-03-09: anna on holiday, tara working from home, bjorn visiting Bengaluru. */
export const SEED_PRESENCE: PresenceRow[] = [
  ...["2026-03-10", "2026-03-11"].flatMap((day) => [
    { employeeId: "anna", day, officeId: null },
    { employeeId: "tara", day, officeId: null },
  ]),
  { employeeId: "bjorn", day: "2026-03-12", officeId: "BLR" },
  { employeeId: "bjorn", day: "2026-03-13", officeId: "BLR" },
];
