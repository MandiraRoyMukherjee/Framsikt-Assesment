-- Neon / PostgreSQL schema. Applied by `npm run db:migrate` (scripts/db.ts -> src/db/migrate.ts).
-- Money inside the JSON document is always { minor: <integer>, currency: 'NOK'|'INR' }.

CREATE TABLE IF NOT EXISTS employees (
  id               TEXT PRIMARY KEY,                   -- company login / HR employee id
  name             TEXT NOT NULL,
  home_office_id   TEXT NOT NULL,                      -- 'OSL' | 'BLR'
  payroll_currency TEXT NOT NULL,                      -- HR reimburses in this currency
  is_volunteer     BOOLEAN NOT NULL DEFAULT FALSE
);

-- Where someone is physically on a given office-local day. No row = at home office (default).
-- office_id NULL = working from home / holiday.
CREATE TABLE IF NOT EXISTS presence (
  employee_id TEXT NOT NULL REFERENCES employees(id),
  day         TEXT NOT NULL,                           -- 'YYYY-MM-DD'
  office_id   TEXT,
  PRIMARY KEY (employee_id, day)
);

-- One row per refill. Hot columns are real columns (indexable, constraint-able);
-- the rest of the aggregate (attempts, purchase, claim, flags...) lives in `data`.
CREATE TABLE IF NOT EXISTS refills (
  id         TEXT PRIMARY KEY,
  office_id  TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN
               ('OPEN','OFFERED','COMMITTED','PURCHASED','CLAIM_SUBMITTED',
                'REIMBURSED','CLAIM_REJECTED','CANCELLED')),
  version    INT  NOT NULL,                            -- optimistic lock: UPDATE ... WHERE version = $expected
  created_at TIMESTAMPTZ NOT NULL,
  data       JSONB NOT NULL
);

-- The rule that stops two people buying on the same day, enforced by the database itself:
-- at most ONE active refill per office.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_refill_per_office
  ON refills (office_id) WHERE status IN ('OPEN','OFFERED','COMMITTED');

CREATE INDEX IF NOT EXISTS refills_office_status ON refills (office_id, status);
