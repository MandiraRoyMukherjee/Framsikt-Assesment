# Snack Counter Automation

Automation for the Oslo and Bengaluru office snack counters: **every empty box gets exactly one owner with a deadline**, ownership rotates fairly, the HR reimbursement claim is filed automatically, and spend is tracked in a monthly report across NOK and INR.

Built for the Framsikt assessment (see [`requirments.txt`](requirments.txt)).

| Document | What is in it |
|---|---|
| [`docs/DESIGN.md`](docs/DESIGN.md) | The 1–2 page **design document** the assessment asks for (lifecycle, components + data, how each problem is prevented, trade-offs, assumptions) |
| [`architecture.md`](architecture.md) | **HLD, LLD, ER + class diagrams**, algorithms, tech-stack reasoning, interview Q&A |
| [`docs/schema.sql`](docs/schema.sql) | Production PostgreSQL (Neon) schema for the same model |

---

## 1. Why this solution (the short version)

The real failure is not "we lack a reminder", it is **nobody owns the refill**. So "automate" here means:

1. **One refill per office at a time.** Duplicate "empty" reports return the existing refill → no double buying.
2. **One named owner with a clock.** A single volunteer is asked (2 h to answer), then has 24 h to buy. No answer → automatically handed to the next person; after 3 failures or 48 h the manager is paged.
3. **Fair rotation.** Ranking prefers people who are in the office, are not already waiting for money (≥ 2 unreimbursed claims), and have done the fewest refills recently.
4. **Automatic HR claim** with amount, currency, description, receipt and the buyer's employee id – retried if HR is down, never duplicated, chased if slow.
5. **Budget control and reporting.** Monthly budget per office in its own currency; one combined monthly report for management.

Deliberately **not** automated: buying (a human must), approving claims (HR's job), detecting an empty box (no sensor).

---

## 2. Tech stack

| Layer | Choice | Why (details in [`architecture.md`](architecture.md#4-tech-stack--and-why)) |
|---|---|---|
| Language | TypeScript (strict) | Closed unions for states, strict null checks, one language for core + tests + web demo |
| Tests | Vitest | Fast, zero-config TS/ESM |
| Architecture | Ports & adapters | Chat and HR are simulated per the brief; real ones are drop-in |
| Time | Injected `Clock` | "Nobody completes it → hand over" is tested with a fake clock in microseconds |
| Money | Integer minor units + currency | No float drift; mixing NOK and INR throws |
| Concurrency | Optimistic locking (`version`) + one-active-refill rule | Low contention, serverless-friendly |
| Demo | Next.js 14 (App Router) on Vercel | Zero-config deploy; deterministic scenario prerendered statically |
| Data | **Mock data (in-memory)** now; **Neon Postgres** is the production path ([`docs/schema.sql`](docs/schema.sql)) | The assessment grades the logic; the repository port makes the swap a single adapter |

---

## 3. How to run

Prerequisite: **Node.js 20+**.

```bash
git clone git@github.com:MandiraRoyMukherjee/Framsikt-Assesment.git
cd Framsikt-Assesment
npm install

npm test            # 83 automated tests (the proof of the rules)
npm run typecheck   # strict TypeScript
npm run dev         # demo at http://localhost:3000   (JSON: /api/scenario)
npm run build       # production build (what Vercel runs)
```

The demo page replays one deterministic scenario through the **real** core logic with simulated chat, HR, directory and clock: a first volunteer ignores the offer and the scheduler hands it over, HR is down when the receipt arrives and the claim is retried automatically, an Oslo employee visiting Bengaluru is picked for a Bengaluru refill, and finally the monthly report totals both currencies.

### Deploy to Vercel

1. Import the GitHub repository in Vercel (framework is auto-detected as Next.js).
2. No environment variables are needed for the mock-data demo.
3. Deploy.

### Is Postgres required? No – mock data is the default

| Mode | Needs a database? | Used by |
|---|---|---|
| **Mock / in-memory** (default) | No | `npm run dev`, `npm run build`, the demo page, Vercel deploy, most tests |
| **Neon Postgres** (optional) | Yes (`DATABASE_URL`) | `PostgresRefillRepository` + `PostgresDirectory` in [`src/adapters/postgres.ts`](src/adapters/postgres.ts) |

Both implement the same ports, so `RefillService` behaves identically. [`tests/postgres.test.ts`](tests/postgres.test.ts) runs the same lifecycle and race tests against Postgres using `pg-mem` (an in-process Postgres emulator), so no real database is needed to run the test suite.

### Using Neon Postgres (optional)

1. Create a Neon project, then copy **Connection Details → pooled connection string**.
2. `cp .env.example .env` and paste it as `DATABASE_URL` (`.env` is git-ignored; [`.env.example`](.env.example) is the committed template).
3. Create tables and load seed data (15 Oslo + 20 Bengaluru volunteers, plus holiday / home / visiting examples):

   ```bash
   npm run db:setup      # = db:migrate (docs/schema.sql) + db:seed (src/demo/seedData.ts)
   ```

   Both commands are idempotent (`IF NOT EXISTS`, upserts), so re-running is safe.
4. On Vercel add the same `DATABASE_URL` under *Project → Settings → Environment Variables*.
5. Still to be written for a real rollout: `ChatPort`, `HrPort` and the calendar-based `DirectoryPort` for the real chat tool / HR API, and a scheduler (Vercel Cron) calling `RefillService.tick()` every ~5 minutes.

The two concurrency rules live **in the database**: a partial unique index (`one_active_refill_per_office`) and `UPDATE … WHERE id=$1 AND version=$2` (zero rows → `ConflictError`).

---

## 4. Project layout

```
src/domain      money, types, errors, config (offices, budgets, timers), time helpers
src/ports       interfaces to chat / HR / directory / FX / repo / clock
src/adapters    simulated stand-ins, in-memory repository, Postgres (Neon) repository + directory
src/db          migrate, seed, connection pool
scripts/        db.ts CLI (npm run db:migrate | db:seed | db:setup)
src/services    refillService (lifecycle), volunteerSelector, budget, report
src/demo        deterministic end-to-end scenario
app/            Next.js demo page + /api/scenario
tests/          Vitest suites
docs/           DESIGN.md, schema.sql
```

---

## 5. What the tests prove

The three examples from the brief, plus the realities around them (83 tests, all passing):

| Rule | Where |
|---|---|
| Two people cannot both commit to the same refill (concurrent accepts, duplicate reports, stale writer) | `tests/refillService.test.ts` |
| A refill nobody completes is handed to someone else (offer timeout, decline, missed 24 h deadline, release, escalation, idempotent scheduler) | `tests/refillService.test.ts` |
| Budgets and totals are correct across both currencies (per-office budgets, reservations, timezone month boundary, one conversion per office total) | `tests/budget.test.ts`, `tests/report.test.ts`, `tests/money.test.ts` |
| Fair choice of who buys; hybrid, holiday and visiting employees | `tests/volunteerSelector.test.ts`, `tests/refillService.test.ts` |
| HR outage, idempotent claim, slow and rejected claims | `tests/hrIntegration.test.ts` |
| End-to-end demo scenario | `tests/scenario.test.ts` |

Sanity check performed: disabling the optimistic-lock check makes the race tests fail, so they genuinely test the rule.

---

## 6. Key trade-offs (details in [`docs/DESIGN.md`](docs/DESIGN.md))

- Sequential targeted offers instead of broadcast "first to click" → fair and race-free, slightly slower.
- Presence is ranked before perfect fairness → an empty box today wins over rotation purity.
- Wall-clock timers, no business-hours logic; polling HR instead of webhooks.
- Budget is derived from history, not stored → cannot drift.
- Not built: receipt OCR, stock sensors, price benchmarking, multi-box offices, FX feed, real auth, full UI.

---

## 7. Assessment workflow (how this was built)

1. Read the brief, list the assumptions/questions ([`docs/DESIGN.md` §0](docs/DESIGN.md)).
2. Write the design first, then implement it feature by feature with tests alongside.
3. One commit per feature: scaffold → design → domain/money → ports + fakes → selection → budget → lifecycle → HR integration → report → demo scenario → web demo → docs.
