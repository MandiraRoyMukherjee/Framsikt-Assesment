"use client";

import { useEffect, useRef, useState } from "react";
import { Sandbox, type Location, type OfficeView, type SandboxView } from "../src/demo/sandbox";
import { format } from "../src/domain/money";
import type { Refill } from "../src/domain/types";

const STEPS = ["OPEN", "OFFERED", "COMMITTED", "PURCHASED", "CLAIM_SUBMITTED", "REIMBURSED"] as const;
const KIND_COLOR: Record<string, string> = {
  ACTION: "#3b82d4", SYSTEM: "#7c5cd8", CHAT: "#57606a", HR: "#1a7f37", BLOCKED: "#cf222e",
};
const STATUS_HELP: Record<string, string> = {
  OPEN: "Needs an owner. The system is looking for the best volunteer who is physically in the office.",
  OFFERED: "One volunteer was asked and has 2 hours to answer. Nobody else can take it.",
  COMMITTED: "Volunteer owns it for 24 hours. Budget is reserved for them.",
  PURCHASED: "Receipt recorded. The HR claim is being filed (retried automatically if HR is down).",
  CLAIM_SUBMITTED: "HR claim is pending (1-10 days). The system polls HR and chases if it is slow.",
  REIMBURSED: "HR approved. Done.",
  CLAIM_REJECTED: "HR rejected the claim. Manager and buyer are alerted.",
};

const box = { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: 14 } as const;
const btn = (kind: "primary" | "plain" | "danger" = "plain") =>
  ({
    padding: "5px 10px", fontSize: 13, borderRadius: 6, cursor: "pointer", marginRight: 6, marginTop: 6,
    border: `1px solid ${kind === "danger" ? "#cf222e" : kind === "primary" ? "#3b82d4" : "#d0d7de"}`,
    background: kind === "primary" ? "#3b82d4" : "#fff",
    color: kind === "primary" ? "#fff" : kind === "danger" ? "#cf222e" : "#1f2328",
  }) as const;

export default function Simulator() {
  const sb = useRef<Sandbox>(null as unknown as Sandbox);
  if (!sb.current) sb.current = new Sandbox();
  const [view, setView] = useState<SandboxView | null>(null);
  const [amount, setAmount] = useState<Record<string, string>>({ OSL: "800", BLR: "2000" });

  const act = async (fn: (s: Sandbox) => unknown) => {
    try {
      await fn(sb.current);
    } finally {
      setView(await sb.current.view());
    }
  };
  useEffect(() => {
    void sb.current.view().then(setView);
  }, []);
  if (!view) return <p>Loading simulator...</p>;

  const reset = () => {
    sb.current = new Sandbox();
    void sb.current.view().then(setView);
  };

  return (
    <div>
      {/* ---------------------------------------------------------- clock + HR */}
      <section style={{ ...box, marginBottom: 14 }}>
        <b>Simulated time:</b> {view.now.slice(0, 16).replace("T", " ")} UTC &nbsp;
        <span style={{ color: "#57606a", fontSize: 13 }}>(the scheduler runs after every jump, like a cron job)</span>
        <div>
          {[[1, "+1 h"], [3, "+3 h (offer expires)"], [12, "+12 h (reminder)"], [25, "+25 h (deadline missed)"], [72, "+3 days"], [240, "+10 days"]].map(([h, label]) => (
            <button key={h} style={btn()} onClick={() => act((s) => s.advance(h as number))}>{label}</button>
          ))}
          <button style={btn(view.hrDown ? "danger" : "plain")} onClick={() => act((s) => s.setHrDown(!view.hrDown))}>
            HR system: {view.hrDown ? "DOWN (click to restore)" : "up (click to break it)"}
          </button>
          <button style={btn()} onClick={reset}>Reset</button>
        </div>
      </section>

      {/* ---------------------------------------------------------- offices */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 14 }}>
        {view.offices.map((o) => (
          <OfficeCard key={o.office.id} o={o} view={view} act={act} amount={amount[o.office.id] ?? ""}
            setAmount={(v) => setAmount((a) => ({ ...a, [o.office.id]: v }))} />
        ))}
      </div>

      {/* ---------------------------------------------------------- people + HR */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 14, marginTop: 14 }}>
        <section style={box}>
          <h3 style={{ marginTop: 0 }}>People (hybrid work)</h3>
          <p style={{ fontSize: 13, color: "#57606a", marginTop: 0 }}>
            Change where someone is. Only people <b>physically in the office</b> can be asked. Stats drive fairness.
          </p>
          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
            <thead><tr style={{ textAlign: "left" }}><th>Person</th><th>Where</th><th title="refills in last 30 days">Refills</th><th title="unreimbursed claims">Waiting for HR</th><th>Misses</th></tr></thead>
            <tbody>
              {view.people.map((p) => (
                <tr key={p.id} style={{ borderTop: "1px solid #f0f1f3" }}>
                  <td>{p.id} <span style={{ color: "#57606a" }}>({p.home})</span></td>
                  <td>
                    <select value={p.location} onChange={(e) => act((s) => s.setLocation(p.id, e.target.value as Location))}>
                      <option value="office">in home office</option>
                      <option value="remote">working from home</option>
                      <option value="holiday">on holiday</option>
                      <option value="visiting">visiting other office</option>
                    </select>
                  </td>
                  <td>{p.stats.recentRefills}</td><td>{p.stats.outstandingClaims}</td><td>{p.stats.recentMisses}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section style={box}>
          <h3 style={{ marginTop: 0 }}>HR system (other company, simulated)</h3>
          {view.hrClaims.length === 0 && <p style={{ color: "#57606a", fontSize: 13 }}>No claims yet. Upload a receipt to create one.</p>}
          {view.hrClaims.map((c) => (
            <div key={c.hrClaimId} style={{ borderTop: "1px solid #f0f1f3", padding: "6px 0", fontSize: 13 }}>
              <b>{c.hrClaimId}</b> · {c.employeeId} · {format(c.amount)} · <b>{c.status}</b>
              {c.status === "PENDING" && (
                <div>
                  <button style={btn("primary")} onClick={() => act((s) => s.hrDecide(c.hrClaimId, "APPROVED"))}>HR approves</button>
                  <button style={btn("danger")} onClick={() => act((s) => s.hrDecide(c.hrClaimId, "REJECTED"))}>HR rejects</button>
                </div>
              )}
            </div>
          ))}
          <h3>Monthly report ({view.report.month})</h3>
          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
            <tbody>
              {view.report.offices.map((r) => (
                <tr key={r.officeId} style={{ borderTop: "1px solid #f0f1f3" }}>
                  <td>{r.officeName}</td><td>{format(r.spent)}</td><td>{(r.budgetUsedBps / 100).toFixed(1)}% of budget</td><td>= {format(r.spentInReportingCurrency)}</td>
                </tr>
              ))}
              <tr style={{ borderTop: "1px solid #e5e7eb", fontWeight: 700 }}><td colSpan={3}>Total, both offices</td><td>{format(view.report.total)}</td></tr>
            </tbody>
          </table>
          <p style={{ fontSize: 13 }}>{view.summary}</p>
        </section>
      </div>

      {/* ---------------------------------------------------------- timeline */}
      <section style={{ ...box, marginTop: 14 }}>
        <h3 style={{ marginTop: 0 }}>What happened (chat messages, HR, rule rejections)</h3>
        <ol style={{ listStyle: "none", padding: 0, margin: 0, fontSize: 13, maxHeight: 360, overflowY: "auto", display: "flex", flexDirection: "column-reverse" }}>
          {[...view.timeline].map((t, i) => (
            <li key={i} style={{ padding: "3px 0", borderTop: "1px solid #f0f1f3", display: "flex", gap: 8 }}>
              <span style={{ color: "#57606a", whiteSpace: "nowrap" }}>{t.at.slice(5, 16).replace("T", " ")}</span>
              <b style={{ color: KIND_COLOR[t.kind], minWidth: 58 }}>{t.kind}</b>
              <span>{t.text}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ office card

function OfficeCard({ o, view, act, amount, setAmount }: {
  o: OfficeView; view: SandboxView; act: (fn: (s: Sandbox) => unknown) => Promise<void>;
  amount: string; setAmount: (v: string) => void;
}) {
  const r: Refill | undefined = o.active;
  const id = o.office.id;
  const used = 100 - Math.max(0, Math.min(100, (o.budget.available.minor / o.office.monthlyBudget.minor) * 100));
  const someoneElse = view.people.find((p) => p.home === id && p.id !== r?.assigneeId)?.id ?? "";
  const reporter = view.people.find((p) => p.home === id)!.id;
  const num = Number(amount);

  return (
    <section style={box}>
      <h3 style={{ marginTop: 0 }}>{o.office.name} snack box <span style={{ fontWeight: 400, color: "#57606a", fontSize: 13 }}>({o.office.currency})</span></h3>

      {/* budget */}
      <div style={{ fontSize: 13 }}>
        Budget {format(o.office.monthlyBudget)} · spent {format(o.budget.spent)} · reserved {format(o.budget.reserved)} · <b>left {format(o.budget.available)}</b>
      </div>
      <div style={{ height: 8, background: "#eef0f2", borderRadius: 4, margin: "4px 0 10px" }}>
        <div style={{ width: `${used}%`, height: 8, borderRadius: 4, background: used > 90 ? "#cf222e" : "#3b82d4" }} />
      </div>

      {/* no active refill */}
      {!r && (
        <>
          <p style={{ margin: "4px 0", fontSize: 13 }}>Box is full. Nobody is assigned.</p>
          <button style={btn("primary")} onClick={() => act((s) => s.reportEmpty(id, reporter))}>Box is empty (report)</button>
          <button style={btn()} onClick={() => act((s) => s.spendBudget(id, id === "OSL" ? 5900 : 14800))}>Shortcut: use up most of the budget</button>
        </>
      )}

      {/* active refill */}
      {r && (
        <>
          <div style={{ display: "flex", gap: 3, flexWrap: "wrap", margin: "2px 0 6px" }}>
            {STEPS.map((s) => (
              <span key={s} style={{ fontSize: 11, padding: "2px 6px", borderRadius: 10, background: s === r.status ? "#3b82d4" : "#eef0f2", color: s === r.status ? "#fff" : "#57606a" }}>{s}</span>
            ))}
          </div>
          <p style={{ margin: "4px 0", fontSize: 13 }}>{STATUS_HELP[r.status]}</p>
          <p style={{ margin: "4px 0", fontSize: 13 }}>
            Owner: <b>{r.assigneeId ?? "nobody yet"}</b>
            {r.offerExpiresAt && ` · answer by ${r.offerExpiresAt.toISOString().slice(5, 16).replace("T", " ")}`}
            {r.commitDeadline && ` · buy by ${r.commitDeadline.toISOString().slice(5, 16).replace("T", " ")}`}
            {r.selfTakeOpen && " · open to any volunteer in the office"}
          </p>
          {r.flags.length > 0 && <p style={{ margin: "4px 0", fontSize: 12, color: "#cf222e" }}>Flags: {r.flags.join(", ")}</p>}
          {r.attempts.length > 0 && (
            <p style={{ margin: "4px 0", fontSize: 12, color: "#57606a" }}>
              Hand-overs: {r.attempts.map((a) => `${a.volunteerId} (${a.outcome})`).join(", ")}
            </p>
          )}

          {r.status === "OFFERED" && r.assigneeId && (
            <div>
              <button style={btn("primary")} onClick={() => act((s) => s.accept(r.id, r.assigneeId!))}>{r.assigneeId}: Accept</button>
              <button style={btn()} onClick={() => act((s) => s.decline(r.id, r.assigneeId!))}>{r.assigneeId}: Decline</button>
              <button style={btn("danger")} onClick={() => act((s) => s.raceAccept(r.id, r.assigneeId!))}>Break it: double-tap Accept</button>
              <button style={btn("danger")} onClick={() => act((s) => s.accept(r.id, someoneElse))}>Break it: {someoneElse} tries to accept</button>
              <button style={btn("danger")} onClick={() => act((s) => s.reportEmpty(id, someoneElse))}>Break it: duplicate "empty" report</button>
            </div>
          )}

          {r.status === "OPEN" && (
            <div>
              {r.selfTakeOpen && view.people.filter((p) => p.physicallyIn === id).slice(0, 1).map((p) => (
                <button key={p.id} style={btn("primary")} onClick={() => act((s) => s.accept(r.id, p.id))}>{p.id}: take it</button>
              ))}
              {r.flags.includes("BUDGET_BLOCKED") && (
                <button style={btn("primary")} onClick={() => act((s) => s.approveOverride(r.id, o.office.managerId))}>Manager approves budget override</button>
              )}
              <button style={btn()} onClick={() => act((s) => s.tick())}>Run scheduler</button>
            </div>
          )}

          {r.status === "COMMITTED" && r.assigneeId && (
            <div>
              <label style={{ fontSize: 13 }}>Receipt total ({o.office.currency}): </label>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 80 }} />
              <button style={btn("primary")} onClick={() => act((s) => s.purchase(r.id, r.assigneeId!, num))}>Upload receipt</button>
              <button style={btn()} onClick={() => act((s) => s.release(r.id, r.assigneeId!))}>Give job back</button>
              <div>
                <button style={btn("danger")} onClick={() => act((s) => s.purchase(r.id, r.assigneeId!, o.office.monthlyBudget.minor / 100 + 500))}>Break it: receipt above the monthly budget</button>
                <button style={btn("danger")} onClick={() => act((s) => s.purchase(r.id, r.assigneeId!, num, Math.max(1, Math.round(num / 2))))}>Break it: typed amount ≠ receipt (AI check)</button>
                <button style={btn()} onClick={() => act((s) => s.approveOverride(r.id, o.office.managerId))}>Manager approves override</button>
              </div>
            </div>
          )}
        </>
      )}

      {/* who is next */}
      <details style={{ marginTop: 8 }}>
        <summary style={{ fontSize: 13, cursor: "pointer" }}>Who would the system ask next? (fairness ranking)</summary>
        <ol style={{ fontSize: 13, margin: "4px 0", paddingLeft: 20 }}>
          {o.ranking.length === 0 && <li>Nobody is in the office - the channel would be asked.</li>}
          {o.ranking.map((c) => (
            <li key={c.id}>{c.id} · {c.presence === "today" ? "in office today" : "in office tomorrow"} · {c.recentRefills} refills, {c.outstandingClaims} claims waiting, {c.recentMisses} misses</li>
          ))}
        </ol>
      </details>

      {/* history */}
      {o.history.length > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ fontSize: 13, cursor: "pointer" }}>Earlier refills ({o.history.length})</summary>
          <ul style={{ fontSize: 13, margin: "4px 0", paddingLeft: 20 }}>
            {o.history.map((h) => (
              <li key={h.id}>{h.id} · {h.status}{h.purchase ? ` · ${format(h.purchase.amount)} by ${h.purchase.buyerId}` : ""}{h.flags.length ? ` · ${h.flags.join(", ")}` : ""}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
