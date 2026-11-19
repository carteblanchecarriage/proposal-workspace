// A short plain-text digest of a project for the AI assistant (assistant.ts): the key facts of each part (RFP review,
// fee, schedule, consultants, comparisons) so a question on one page can draw on the others. The page on screen is
// sent in full by that page and left out here. Kept small (a few thousand characters) because it rides on every turn.
import { totals } from "./fee-calc";
import { proposalDue } from "./rfp";
import { listComparisons, listFees, listProjects, listRfps, listSchedules, projectLabel } from "./store";
import { firmName, statedTotal } from "./table";

export type DigestPart = "project" | "rfp" | "consultants" | "fee" | "schedule" | "comparison";

const MAX_CHARS = 8_000;
const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The digest for a project, leaving out the part the page shows in full ("project": everything). */
export async function buildDigest(projectId: string, part: DigestPart): Promise<string> {
  const [projects, rfps, fees, schedules, comparisons] = await Promise.all([listProjects(), listRfps(), listFees(), listSchedules(), listComparisons()]);
  const p = projects.find((x) => x.id === projectId);
  if (!p) return "";
  const out: string[] = [`Project: ${projectLabel(p)}`];

  const saved = rfps.find((r) => r.id === p.rfpId) ?? rfps.find((r) => r.projectId === p.id);
  if (saved && part !== "rfp") {
    const r = saved.rfp;
    const due = proposalDue(r);
    const facts = Object.entries(r.facts ?? {})
      .filter(([, f]) => f?.value)
      .map(([k, f]) => `${k.replace(/_/g, " ")}: ${cut(f.value, 160)}`);
    const requested = (r.services ?? []).filter((s) => s.requested === "yes").map((s) => s.discipline);
    out.push(
      [
        "RFP review:",
        `${r.project_name} for ${r.client}${due ? `; proposals due ${due.when || due.date}` : ""}`,
        r.fit ? `Fit: ${r.fit.verdict}` : "",
        `Summary: ${cut(r.summary, 600)}`,
        ...facts,
        requested.length ? `Consultant services requested: ${requested.join(", ")}` : "",
        r.dates?.length ? `Key dates: ${r.dates.slice(0, 12).map((d) => `${d.label} ${d.when || d.date}`).join("; ")}` : "",
        r.scoring?.length ? `Scoring: ${r.scoring.map((s) => `${s.criterion}${s.weight ? ` (${s.weight})` : ""}`).join("; ")}` : "",
        r.watch_outs?.length ? `Watch-outs: ${r.watch_outs.filter((w) => w.critical).map((w) => w.title).join("; ") || "none critical"}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (part !== "fee") {
    for (const f of fees.filter((x) => x.workspaceProjectId === p.id)) {
      const t = totals(f);
      out.push(
        [
          `Fee "${f.title}" (${f.status ?? "draft"}): total ${money(t.total)}${t.percentOfBudget != null ? `, ${t.percentOfBudget.toFixed(1)}% of construction` : ""}`,
          `Labor ${money(t.labor)} (${Math.round(t.laborHours)} h), consultants ${money(t.consultants)}, markup ${money(t.markup)}, expenses ${money(t.expenses)}`,
          `Phases: ${f.phases.map((ph, i) => `${ph.name} ${money(t.phases[i].cost)}`).join("; ")}`,
          f.consultants.length ? `Consultants on the fee: ${f.consultants.map((c) => `${c.discipline}${c.firm ? ` (${c.firm})` : ""}`).join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
  }

  if (part !== "schedule") {
    for (const s of schedules.filter((x) => x.workspaceProjectId === p.id)) {
      const tasks = (Array.isArray(s.tasks) ? s.tasks : []) as { name?: string; type?: string; start?: string; end?: string; date?: string }[];
      const lines = tasks.slice(0, 40).map((t) => (t.type === "milestone" ? `${t.name} ${t.date ?? ""}` : `${t.name} ${t.start ?? ""} to ${t.end ?? ""}`));
      out.push(`Schedule "${s.title || "Untitled"}":\n${lines.join("\n")}`);
    }
  }

  if (part !== "consultants") {
    const firms = p.consultants ?? [];
    const received = p.proposals ?? [];
    if (firms.length || received.length) {
      const lines = firms.map((c) => `${c.name}: ${c.disciplines.filter((d) => !d.startsWith("row:")).join(", ") || "no discipline"}${c.decision === "using" ? " (using)" : ""}`);
      const props = received.map((r) => {
        const t = statedTotal(r.proposal);
        return `${firmName(r.proposal.firm)}: ${r.proposal.disciplines.join(", ")}${t != null ? `, stated total ${money(t)}` : ""}`;
      });
      out.push(["Consultants:", ...lines, props.length ? "Proposals received:" : "", ...props].filter(Boolean).join("\n"));
    }
  }

  if (part !== "comparison") {
    const cmps = comparisons.filter((c) => c.projectId === p.id).sort((a, b) => b.savedAt - a.savedAt).slice(0, 6);
    for (const c of cmps) out.push(`Comparison${c.group ? ` (${c.group.label})` : ""}: ${cut(c.cmp.briefing.headline, 300)}`);
  }

  if (p.check) out.push(`Proposal check: ${cut(p.check.summary, 400)}`);
  if (p.qaqc) out.push(`QA/QC of our proposal (${p.qaqc.fileName}): ${cut(p.qaqc.summary, 300)}`);

  return cut(out.join("\n\n"), MAX_CHARS);
}
