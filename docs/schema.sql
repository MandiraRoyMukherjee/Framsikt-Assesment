-- Production (Neon / PostgreSQL) equivalent of the in-memory repository used by the core logic.
-- Money is always integer minor units (øre / paise) + an explicit currency.

CREATE TABLE offices (
  id                 TEXT PRIMARY KEY,                 -- 'OSL' | 'BLR'
  name               TEXT NOT NULL,
  currency           CHAR(3) NOT NULL,                 -- 'NOK' | 'INR'
  monthly_budget_minor BIGINT NOT NULL CHECK (monthly_budget_minor > 0),
  typical_min_minor  BIGINT NOT NULL,
  typical_max_minor  BIGINT NOT NULL,
  timezone           TEXT NOT NULL,                    -- 'Europe/Oslo' | 'Asia/Kolkata'
  manager_id         TEXT NOT NULL
);

CREATE TABLE employees (
  id               TEXT PRIMARY KEY,                   -- company login / HR employee id
  name             TEXT NOT NULL,
  home_office_id   TEXT NOT NULL REFERENCES offices(id),
  payroll_currency CHAR(3) NOT NULL
);

CREATE TABLE volunteers (
  employee_id TEXT PRIMARY KEY REFERENCES employees(id),
  active      BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE refills (
  id                TEXT PRIMARY KEY,
  office_id         TEXT NOT NULL REFERENCES offices(id),
  status            TEXT NOT NULL CHECK (status IN
                     ('OPEN','OFFERED','COMMITTED','PURCHASED','CLAIM_SUBMITTED',
                      'REIMBURSED','CLAIM_REJECTED','CANCELLED')),
  version           INT  NOT NULL DEFAULT 1,           -- optimistic lock: UPDATE ... WHERE version = $expected
  reported_by       TEXT NOT NULL REFERENCES employees(id),
  assignee_id       TEXT REFERENCES employees(id),
  created_at        TIMESTAMPTZ NOT NULL,
  offer_expires_at  TIMESTAMPTZ,
  committed_at      TIMESTAMPTZ,
  commit_deadline   TIMESTAMPTZ,
  reminder_sent_at  TIMESTAMPTZ,
  escalated_at      TIMESTAMPTZ,
  reservation_minor BIGINT,
  flags             TEXT[] NOT NULL DEFAULT '{}'
);

-- The key rule that stops two people buying on the same day:
-- at most ONE active refill per office, enforced by the database itself.
CREATE UNIQUE INDEX one_active_refill_per_office
  ON refills (office_id) WHERE status IN ('OPEN','OFFERED','COMMITTED');

CREATE TABLE refill_attempts (
  id           BIGSERIAL PRIMARY KEY,
  refill_id    TEXT NOT NULL REFERENCES refills(id),
  volunteer_id TEXT NOT NULL REFERENCES employees(id),
  outcome      TEXT NOT NULL CHECK (outcome IN ('declined','timeout','missed_deadline','released')),
  at           TIMESTAMPTZ NOT NULL
);

CREATE TABLE purchases (
  refill_id    TEXT PRIMARY KEY REFERENCES refills(id),
  buyer_id     TEXT NOT NULL REFERENCES employees(id),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency     CHAR(3) NOT NULL,
  receipt_ref  TEXT NOT NULL,
  purchased_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE purchase_items (
  id        BIGSERIAL PRIMARY KEY,
  refill_id TEXT NOT NULL REFERENCES purchases(refill_id),
  name      TEXT NOT NULL,
  quantity  INT  NOT NULL CHECK (quantity > 0)
);

CREATE TABLE hr_claims (
  refill_id      TEXT PRIMARY KEY REFERENCES refills(id),
  hr_claim_id    TEXT NOT NULL UNIQUE,                 -- id returned by the external HR system
  status         TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  submitted_at   TIMESTAMPTZ NOT NULL,
  decided_at     TIMESTAMPTZ,
  last_chased_at TIMESTAMPTZ
);

CREATE TABLE fx_rates (
  month         CHAR(7) NOT NULL,                      -- 'YYYY-MM'
  from_currency CHAR(3) NOT NULL,
  to_currency   CHAR(3) NOT NULL,
  rate          NUMERIC(12,6) NOT NULL,
  PRIMARY KEY (month, from_currency, to_currency)
);
