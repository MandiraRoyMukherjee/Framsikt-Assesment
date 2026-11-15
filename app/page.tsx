import { runScenario } from "../src/demo/scenario";
import { format } from "../src/domain/money";

// The scenario is deterministic (fake clock, fake HR/chat), so the page can be built statically.
export const dynamic = "force-static";

const colors: Record<string, string> = { ACTION: "#3b82d4", SYSTEM: "#7c5cd8", CHAT: "#57606a", HR: "#1a7f37" };

const card = { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: 16, marginBottom: 16 } as const;
const th = { textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #e5e7eb", fontWeight: 600 } as const;
const td = { padding: "6px 8px", borderBottom: "1px solid #f0f1f3" } as const;

export default async function Page() {
  const { timeline, report } = await runScenario();

  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: "32px 16px" }}>
      <h1 style={{ marginBottom: 4 }}>Snack Counter Automation</h1>
      <p style={{ color: "#57606a", marginTop: 0 }}>
        Live run of the real core logic (refill lifecycle, volunteer selection, budget check) against simulated chat, HR,
        directory and clock. Same code the automated tests exercise. JSON:{" "}
        <a href="/api/scenario">/api/scenario</a>
      </p>

      <section style={card}>
        <h2 style={{ marginTop: 0 }}>Monthly report - {report.month}</h2>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr>
              <th style={th}>Office</th>
              <th style={th}>Spent (native)</th>
              <th style={th}>Budget</th>
              <th style={th}>Used</th>
              <th style={th}>In {report.reportingCurrency}</th>
              <th style={th}>Top items</th>
            </tr>
          </thead>
          <tbody>
            {report.offices.map((o) => (
              <tr key={o.officeId}>
                <td style={td}>{o.officeName}</td>
                <td style={td}>{format(o.spent)}</td>
                <td style={td}>{format(o.budget)}</td>
                <td style={td}>{(o.budgetUsedBps / 100).toFixed(1)}%</td>
                <td style={td}>{format(o.spentInReportingCurrency)}</td>
                <td style={td}>{o.topItems.map((i) => `${i.name} x${i.quantity}`).join(", ")}</td>
              </tr>
            ))}
            <tr>
              <td style={{ ...td, fontWeight: 700 }} colSpan={4}>
                Total, both offices
              </td>
              <td style={{ ...td, fontWeight: 700 }} colSpan={2}>
                {format(report.total)}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section style={card}>
        <h2 style={{ marginTop: 0 }}>Timeline</h2>
        <ol style={{ listStyle: "none", padding: 0, margin: 0, fontSize: 13 }}>
          {timeline.map((t, i) => (
            <li key={i} style={{ padding: "4px 0", borderBottom: "1px solid #f0f1f3", display: "flex", gap: 8 }}>
              <span style={{ color: "#57606a", whiteSpace: "nowrap" }}>{t.at.slice(0, 16).replace("T", " ")}</span>
              <span style={{ color: colors[t.kind], fontWeight: 600, minWidth: 52 }}>{t.kind}</span>
              <span>{t.text}</span>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
