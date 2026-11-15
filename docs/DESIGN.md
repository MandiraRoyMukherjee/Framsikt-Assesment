# Snack Counter Automation – Design Document

## 0. What "automate" means here (and why)

The real failure is **diffusion of responsibility**: everyone sees the empty box, nobody owns it.
Automation therefore means **one explicit owner per refill, with a clock on it**, plus **fair rotation** and **money tracking**:

1. Anyone reports "box empty" in chat → the system opens **exactly one** refill for that office.
2. The system **asks one specific volunteer** (not a broadcast), chosen by fairness + presence.
3. If they don't answer / don't deliver in time, it **moves on automatically**, then escalates to a human.
4. After purchase the system **creates the HR claim itself**, tracks it to reimbursement and nags HR if it is slow.
5. Every purchase is recorded with line items, so spend and "what gets eaten" are known, and a **monthly report** is generated.

Deliberately **not** automated: buying the snacks (a human must), approving claims (HR's job), detecting an empty box (no sensor – a human reports it).

### Questions I would have asked, and the assumption I made instead

| # | Question | Assumption used |
|---|----------|-----------------|
| 1 | Does HR push approvals (webhook) or must we poll? | Poll by claim id (a webhook only replaces the poll). |
| 2 | Does HR de-duplicate claims? | No. We send an idempotency key (= refill id) and keep our own `hrClaimId`, so a retry never creates a second claim. |
| 3 | Which currency / FX rate for the management report? | Report in **NOK**, rate per month from config (stored with the report). Native-currency totals are always shown too. |
| 4 | Who is the escalation contact? | One office manager per office. |
| 5 | Is there presence data (office / home / holiday)? | Yes – company calendar/directory, queried per day. |
| 6 | Can a visiting employee volunteer? | Yes. Eligibility is **physical presence**, not home office. |
| 7 | Who may pay? | Anyone who is a registered volunteer. Purchase is in the **office's** currency; HR converts to the employee's payroll currency. |

## 1. Lifecycle: "empty" → "reimbursed"

```
 OPEN ──offer──▶ OFFERED ──accept──▶ COMMITTED ──receipt──▶ PURCHASED ──HR claim──▶ CLAIM_SUBMITTED ──▶ REIMBURSED
   ▲               │ decline/timeout     │ release/deadline missed                         └──▶ CLAIM_REJECTED
   └───────────────┴─────────────────────┘ (next candidate)             any open state ──▶ CANCELLED
```

* **OPEN** – needs an owner. Budget is checked first; if exhausted the refill waits and the manager is told.
* **OFFERED** – one volunteer has 2 h to answer. Decline/timeout → next candidate.
* **COMMITTED** – volunteer owns it for 24 h; a budget amount is **reserved**. Reminder at 50 %; at 100 % it is handed over (counts as a missed commitment).
* **PURCHASED** – receipt + amount + items recorded; spend booked against the monthly budget.
* **CLAIM_SUBMITTED** – claim created in HR (amount, currency, description, receipt, employee id). Polled until approved (1–10 days). Pending > 10 days → manager is alerted.
* **REIMBURSED / CLAIM_REJECTED** – terminal; rejection alerts the manager and volunteer.

## 2. Main parts and the data each keeps

| Part | Responsibility | Data it owns |
|------|----------------|--------------|
| **Refill Service** | State machine, the only writer of refill state | `Refill` (status, version, assignee, deadlines, attempts, purchase, claim) |
| **Volunteer Selector** | Pure ranking function, no I/O | none (reads stats) |
| **Budget Service** | Spent / reserved / available per office per month | derived from refills + `Office` config (budget, typical range, timezone) |
| **Scheduler (`tick`)** | Timeouts, reminders, retries, HR polling, escalation | none (idempotent sweep over refills) |
| **Report Service** | Monthly management report | derived (never stored → cannot drift) |
| **Chat port** | DMs/channel posts, receives accept/decline/report | stand-in: message log |
| **HR port** | `createClaim`, `getClaim` | stand-in: in-memory claims |
| **Directory port** | volunteers, home office, payroll currency, daily presence | stand-in: fixed data |
| **FX port** | monthly rate to the reporting currency | stand-in: fixed rates |

## 3. How each problem is prevented

| Problem | Mechanism |
|---------|-----------|
| Box empty for days, "someone else will do it" | A named owner is **assigned** and timed (offer 2 h, commit 24 h). Timeouts hand over automatically; after 3 failed attempts or 48 h a human (manager) is paged. |
| Two people buy the same day | (a) **At most one active refill per office** (unique rule in the repository = partial unique index in SQL). Duplicate "empty" reports return the existing refill. (b) A commit is a **compare-and-set on `version`**: of two simultaneous accepts exactly one wins. (c) A reminder at 50 % of the window asks "still on it?" before a hand-over, reducing late double-buying. |
| A few people do all the work and wait weeks for money | Selection ranks by **outstanding unreimbursed claims** (hard cap of 2, relaxed only if everyone is capped), then **refills in last 30 days**, then **missed commitments**, then **longest since last refill**. Slow HR claims are chased automatically. |
| Nobody knows monthly spend / what is eaten | Spend is booked per purchase with **line items**; the monthly report shows per-office totals, combined total in NOK, budget use, top items, load per volunteer, reimbursement latency. |
| Budget overrun | Before offering and again at commit: `available = budget − spent − reserved`. Below the office's minimum typical purchase → no new offer, manager notified. A reservation (≤ typical max) is held while committed. At purchase time the amount must fit what is left (`available + own reservation`): a bigger bill is **rejected** (nothing recorded, no claim) and the volunteer is told to ask the manager. Only an explicit **manager override** lets it through, and it is then flagged `OVER_BUDGET`. Because reservations shrink to what is left, two refills can never jointly overspend. A receipt image can back only **one** refill, so a duplicate submission never creates a second HR claim. |
| Hybrid / holiday / visitors | Only volunteers **in the office today or tomorrow** (per calendar, in the office's timezone) are candidates; a visiting Oslo volunteer in Bengaluru qualifies for Bengaluru. |
| Two currencies | Money = integer minor units + currency; mixing currencies throws. Budgets are checked in native currency; only the report converts, once per office total (no rounding drift). |

## 4. Trade-offs and what I deliberately did not build

* **Sequential offers instead of broadcast "first to click"**: slower in the best case, but fair, no bystander effect, no race. A broadcast **self-take** is still allowed when nobody is auto-selectable.
* **Presence before fairness** (after the claim cap): a box that is empty today beats perfect rotation. Cost: regular office-goers do slightly more.
* **Polling HR** instead of webhooks; **in-memory repository** with optimistic locking – the SQL schema (`docs/schema.sql`) shows the production equivalent, but persistence is not needed to prove the rules.
* **Wall-clock timeouts**, not business hours (no quiet hours/weekends logic). A late buyer after a hand-over is rejected and the manager must resolve it.
* Rejected claims are **excluded from booked spend**.
* **Not built**: receipt OCR / amount verification, stock sensors, purchase price benchmarking, multi-box offices, FX rate feed, auth (company SSO is assumed in front of the chat bot), UI beyond a demo.
