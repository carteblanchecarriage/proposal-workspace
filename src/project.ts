import { DISCIPLINES, firmDisciplines, toDisciplines } from "../lib/disciplines";
import { removeFirms } from "../lib/comparison-edit";
import { defaultScheduleNotes, setScheduleNotes } from "./org";
import { askProjectName, confirmModal, confirmTyped, formModal, noticeModal } from "./modal";
import { makeFee, withWaiting } from "./fee";
import { scheduleSnapshotHtml } from "./schedule-snapshot";
import { SCHEDULE_TEMPLATES } from "./schedule/lib/data/templates.js";
import { blockedInDemo, post, postJson } from "./api";
import { type Usage } from "../lib/cost";
import type { Comparison, Proposal, ScheduleDraft } from "../lib/claude";
import { consultantTotal, proposalTable, roundedTable, totals } from "./fee-calc";
import { DEFAULT_FEE_STYLE, roundFee, type FeeRounding } from "./fee-style";
import { feeStatusHtml, setFeeStatus } from "./fee-status";
import { deleteProject, isDemo, listFees, saveFee, type SavedFee, projectLabel, listComparisons, listProjects, listSchedules, getScheduleStyle, type ScheduleStyle, savesShared, listRfps, getFeeStyle, saveComparison, saveProject, saveRfp, saveSchedule, listConsultants, type SavedConsultant, type SavedComparison, type SavedProject, type SavedRfp, type SavedSchedule, type ProjectFirm, type ReceivedProposal } from "./store";
import { addAddendum, docKindLabel, docTitle, formatWhen, physicalSubmission, printBy, parseDay, projectDisciplines, proposalDue, verdictPill } from "./rfp";
import { setPendingProject } from "./pending";
import { markRevealed, type DemoPart } from "./demo/ids";
import { adoptFromComparisons, onProposalsChange, proposalsHeadHtml, proposalsHtml, qaqcHtml, type ProposalsContext } from "./project-proposals";
import { AI_MARK, briefingDetails, esc, feeTable, firmName, glanceHtml, scopeTable, statedTotal, type Sourced } from "./table";
import { contactsHtml, copyEmail, keyOf, siteLink } from "./consultants";
import { parseContacts } from "./contacts";
import { askProjectAssistant, assistantButton, setAssistantPage } from "./assistant";
import { money, plural, shortDay } from "../lib/format";

// A project page: its RFP review, consultant proposals (and their comparisons), the proposal check, consultants by
// discipline, schedule and fee.

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let project: SavedProject | null = null;
let rfp: SavedRfp | undefined;
let comparisons: SavedComparison[] = [];
let schedules: SavedSchedule[] = [];
let fees: SavedFee[] = [];
/** the Consultants directory, for contact details */
let directory: SavedConsultant[] = [];

// "Review the RFP" and "Compare proposals" on a project page: what's started next belongs to this project.
export { pendingProject, clearPendingProject } from "./pending";

export function initProject() {
  $("project-page").addEventListener("click", onClick);
  // Escape leaves the consultant matrix's edit mode, like Done (its edits are already saved; a note being typed is
  // saved first). A dialog on top handles its own Escape first.
  addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !matrixEditing || $("project-page").closest("[hidden]") || document.querySelector("dialog[open]")) return;
    (document.activeElement as HTMLElement | null)?.blur?.();
    matrixEditing = false;
    render();
  });
}

/** Asks for a new project's number and name, saves it, and returns it (null if cancelled or not saved). */
export async function newProject(): Promise<SavedProject | null> {
  const entered = await askProjectName("New project", "Create project", { name: "" });
  if (!entered) return null;
  const p: SavedProject = { id: crypto.randomUUID(), savedAt: Date.now(), ...entered };
  try {
    await saveProject(p);
    return p;
  } catch (err) {
    await noticeModal("Project not saved", (err as Error).message);
    return null;
  }
}

export async function openProject(id: string) {
  const nextView = location.hash.split("/")[2] === "consultants" ? "consultants" : "dash";
  const key = `project:${id}:${nextView}`;
  const token = beginView(key);
  const found = (await listProjects()).find((p) => p.id === id);
  if (token !== viewToken) return;
  if (!found) {
    endView("");
    return noticeModal("Project not found", "It may have been deleted.");
  }
  const same = project?.id === id;
  project = found;
  if (!same) matrixEditing = false;
  view = nextView;
  await load();
  if (token !== viewToken) return; // a later switch is on its way
  render();
  endView(key);
  scrollTo(0, 0);
}

/** The organization's schedule style (colors, font, Today line), for the schedule snapshot. */
let scheduleStyle: ScheduleStyle = { colors: {} };
/** The organization's fee rounding (Organization settings), so the dashboard's fee matches the Proposal table. */
let feeRounding: FeeRounding = DEFAULT_FEE_STYLE.rounding;

async function load() {
  if (!project) return;
  const id = project.id;
  const [rfps, cmps, scheds, fs, dir, style, feeStyle] = await Promise.all([
    listRfps(),
    listComparisons(),
    listSchedules(),
    listFees(),
    listConsultants().catch(() => [] as SavedConsultant[]),
    // The organization's schedule colors and font, so the snapshot matches the schedule maker.
    getScheduleStyle().catch(() => ({ colors: {} }) as ScheduleStyle),
    getFeeStyle().catch(() => DEFAULT_FEE_STYLE),
  ]);
  if (project?.id !== id) return; // another project opened meanwhile; its own load fills these in
  directory = dir;
  scheduleStyle = style;
  feeRounding = feeStyle.rounding;
  setScheduleNotes(style.notes);
  rfp = rfps.find((r) => r.id === project!.rfpId) ?? rfps.find((r) => r.projectId === id);
  comparisons = cmps.filter((c) => c.projectId === id);
  // Proposals inside the project's comparisons join its proposal list (once), to compare with later ones.
  // Firms whose proposals are on the project get matrix columns; every firm gets an id and its directory link.
  const adopted = adoptFromComparisons(project, comparisons);
  const synced = syncFirms(project);
  if (adopted || synced) await saveProject(project).catch(console.error);
  schedules = scheds.filter((s) => s.workspaceProjectId === id);
  fees = fs.filter((f) => f.workspaceProjectId === id);
}


/** All projects, newest first, each opening its page. */
/**
 * Switching what the Projects tab shows (another project, the list, the Consultants page): the old page is hidden
 * until the new one is drawn, so it doesn't flash before the data arrives. Only the latest switch is drawn.
 */
let shownKey = "";
let viewToken = 0;
function beginView(key: string): number {
  if (shownKey !== key) $("project-page").dataset.loading = "1";
  return ++viewToken;
}
function endView(key: string) {
  shownKey = key;
  delete $("project-page").dataset.loading;
}

export async function showProjectList() {
  const token = beginView("list");
  const [projects, rfps] = await Promise.all([listProjects(), listRfps()]);
  if (token !== viewToken) return; // a later switch is on its way
  project = null;
  $("project-page").classList.remove("is-dash");
  // Sorted by project number, highest first; projects without a number last, newest first.
  const rows = projects.map((p) => {
    const r = rfps.find((x) => x.id === p.rfpId) ?? rfps.find((x) => x.projectId === p.id);
    const due = r ? proposalDue(r.rfp) : undefined;
    return { p, r, due };
  });
  const num = (p: SavedProject) => {
    const n = parseInt(String(p.number ?? "").replace(/\D/g, ""), 10);
    return Number.isFinite(n) ? n : null;
  };
  rows.sort((a, b) => {
    const x = num(a.p), y = num(b.p);
    if (x != null && y != null && x !== y) return y - x;
    if ((x == null) !== (y == null)) return x == null ? 1 : -1;
    return b.p.savedAt - a.p.savedAt;
  });
  const items = rows
    .map(({ p, r, due }) => {
      return `<li>
        <a class="link open" href="#project/${encodeURIComponent(p.id)}"><b>${esc(projectLabel(p))}</b> <span>${esc(r?.rfp.client ?? "")}</span></a>
        <span class="when">${due ? `Due ${esc(formatWhen(due))}` : ""}</span>
        <button class="link" data-delete-project="${esc(p.id)}">Delete</button>
      </li>`;
    })
    .join("");
  $("project-page").innerHTML = `
    <div class="saved project-list">
      <div class="project-list-head"><h2 class="label">Projects</h2><button class="btn primary" data-new-project>New project</button></div>
      ${items ? `<ol>${items}</ol>` : `<p class="none">No projects yet. Everything starts from a project: its RFP review, proposals, fee and schedule.</p>`}
    </div>`;
  endView("list");
}

/** The project page shows its dashboard, or its Consultants page (#project/<id>/consultants). */
let view: "dash" | "consultants" = "dash";

function render() {
  if (!project) return;
  if (view === "consultants") return renderConsultantsPage();
  const p = project;


  const due = rfp ? proposalDue(rfp.rfp) : undefined;
  const sub = [due ? `Proposals due ${formatWhen(due)}` : ""].filter(Boolean).map((x) => esc(String(x))).join(" · ");
  const fee = fees[0];
  const sched = schedules[0];

  $("project-page").classList.add("is-dash");
  setAssistantPage({
    key: `project:${p.id}`,
    title: "Ask AI about this project",
    hint: 'Ask about anything in this project: the RFP, fee, schedule, consultants and comparisons. For example, "Does the schedule leave time for the DD client review the RFP asks for?" or "Which requested consultant services don\'t have a proposal yet?"',
    projectId: p.id,
    part: "project",
    ask: (turns, { digest }) => askProjectAssistant("project", dashboardContext(p), digest, turns),
  });
  // A dashboard: the RFP review, schedule and fee on top; the consultants (proposals and matrix) and proposal check below. On a large enough screen it fits the window (see fitDashboard); long lists scroll inside their card.
  $("project-page").innerHTML = `
    <div class="proj-head">
      <div class="proj-title">
        <h1 class="headline">${esc(projectLabel(p))}</h1>
        ${sub ? `<p class="proj-sub">${sub}</p>` : ""}
      </div>
      <span class="tools">${assistantButton()}<button class="btn" data-rename>Edit</button><button class="btn" data-delete-project="${esc(p.id)}">Delete</button></span>
    </div>

    <div class="proj-grid">
      <div class="proj-card proj-rfp">
        <div class="proj-card-head">
          <h2 class="label">${cardTitle("RFP review", rfp ? `#rfp/${encodeURIComponent(rfp.id)}` : "")}</h2>
        </div>
        <div class="proj-card-body">
          ${
            rfp
              ? `${rfp.rfp.fit ? `<p>${verdictPill(rfp.rfp.fit, `#rfp/${encodeURIComponent(rfp.id)}`)}</p>` : ""}
                 ${due ? `<p>Proposals due ${esc(formatWhen(due))}</p>` : ""}
                 ${(() => {
                   const pb = printBy(rfp.rfp);
                   return pb ? `<p class="print-flag" title="${esc(physicalSubmission(rfp.rfp)?.detail ?? "")}"><b>Printed submission:</b> send to printer by ${esc(formatWhen(pb))}</p>` : "";
                 })()}
                 ${rfpSourcesHtml(rfp)}
                 <div class="actions"><label class="btn" title="An addendum, answers to questions, meeting minutes or another document">Add document<input type="file" accept="application/pdf,.pdf" multiple hidden data-addendum /></label><span class="status" id="addendum-status"></span></div>`
              : `<p class="none">None yet.</p><div class="actions"><button class="btn" data-review-rfp>Review the RFP</button></div>`
          }
        </div>
      </div>

      <div class="proj-card proj-schedule">
        <div class="proj-card-head">
          <h2 class="label">${cardTitle("Schedule", sched ? `#schedule/${encodeURIComponent(sched.id)}` : "")}</h2>
        </div>
        <div class="proj-card-body">
          ${
            sched
              ? scheduleSnapshotHtml(sched, scheduleStyle) ||
                `<p class="none">${esc(String(sched.title || "Untitled schedule"))} has no dated tasks yet. <a class="link" href="#schedule/${encodeURIComponent(sched.id)}">Open it</a>.</p>`
              : isDemo()
                ? demoRevealHtml("schedule", "Draft the schedule")
                : `<p class="none">None yet.</p><div class="actions"><button class="btn" data-make-schedule>Make schedule</button></div>`
          }
        </div>
      </div>

      <div class="proj-card proj-fee">
        <div class="proj-card-head">
          <h2 class="label">${cardTitle("Architecture fee", fee ? `#fee/${encodeURIComponent(fee.id)}` : "")}</h2>
        </div>
        <div class="proj-card-body">${fee ? feeStatusHtml(fee, true) : ""}${feeSummaryHtml(fee)}</div>
      </div>

      <div class="proj-card proj-team saved">
        <div class="proj-card-head"><h2 class="label">${cardTitle("Consultants", `#project/${encodeURIComponent(p.id)}/consultants`)}</h2>${proposalsHeadHtml(p)}</div>
        <div class="proj-card-body proj-team-body">
          <div class="proj-team-list">${isDemo() && !(p.consultants ?? []).length ? demoRevealHtml("proposals", "Add the sample MEP proposals") : proposalsHtml(p, comparisons)}</div>
          <div class="proj-team-matrix">
            <div class="proj-team-sub"><span class="m-key" title="A green row: a chosen firm covers that discipline. While editing, click a cell to cycle: empty, waiting on a proposal, in their proposal."><i class="m-key-prop"></i>In their proposal<i class="m-key-exp"></i>Waiting on a proposal<i class="m-key-using"></i>Discipline covered</span><button class="link" data-matrix-edit>${matrixEditing ? "Done" : "Edit"}</button></div>
            ${consultantsHtml(p)}
          </div>
        </div>
      </div>
    </div>

      <div class="proj-card proj-qaqc proj-below">
        <div class="proj-card-head"><h2 class="label">Proposal check</h2></div>
        <div class="proj-card-body">${qaqcHtml(p, rfp)}</div>
      </div>
`;
  fitDashboard();
}


/** A card's title: a link to that section's page when there is one. */
// ---------- The demo's one-click parts ----------
// The demo's sample project starts with only its RFP to review. Its schedule, fee and consultant proposals are each
// one click: a few seconds of what a real draft works from, then the sample (demo/data.ts, demoPart). The tour points
// at these buttons.

const DEMO_STEPS: Record<DemoPart, string[]> = {
  schedule: ["Reading the RFP's dates", "Laying out design phases and owner reviews", "Adding permitting, bidding and construction"],
  fee: ["Reading the construction budget", "Starting from your fee curve", "Estimating hours by phase and role"],
  proposals: ["Reading Copperleaf Engineering's proposal", "Reading Halvorsen Lake Engineers' proposal", "Reading Twin Spruce MEP's proposal", "Lining up scope and fees"],
};
const DEMO_NOTE: Record<DemoPart, string> = {
  schedule: "In your account, AI drafts it from the RFP review, or you start from a template.",
  fee: "In your account, AI drafts the hours from the RFP review and your fee curve.",
  proposals: "In your account, you drop in each consultant's proposal PDF as it arrives.",
};

function demoRevealHtml(part: DemoPart, label: string): string {
  return `<p class="none">${esc(DEMO_NOTE[part])}</p><div class="actions"><button class="btn primary" data-demo-reveal="${part}">${esc(label)}</button><span class="status" data-demo-status="${part}"></span></div>`;
}

async function revealDemoPart(part: DemoPart) {
  const p = project;
  const button = document.querySelector<HTMLButtonElement>(`[data-demo-reveal="${part}"]`);
  const status = document.querySelector<HTMLElement>(`[data-demo-status="${part}"]`);
  if (!p || !button || button.disabled) return;
  button.disabled = true;
  for (const step of DEMO_STEPS[part]) {
    if (status) status.textContent = `${step}…`;
    await new Promise((r) => setTimeout(r, 650));
  }
  const { demoPart } = await import("./demo/data");
  const made = demoPart(part);
  if (made.schedule) await saveSchedule({ ...made.schedule, workspaceProjectId: p.id });
  if (made.fee) await saveFee({ ...made.fee, workspaceProjectId: p.id });
  if (made.comparison) {
    await saveComparison({ ...made.comparison, projectId: p.id });
    await saveProject({ ...p, consultants: made.consultants ?? [] });
  }
  markRevealed(part);
  if (project?.id !== p.id) return;
  if (made.consultants) project = { ...p, consultants: made.consultants };
  await load();
  render();
}

const cardTitle = (text: string, href: string) => (href ? `<a class="card-title-link" href="${href}">${esc(text)}</a>` : esc(text));

/** What the RFP review is built from: the RFP itself, then each document added since (newest last). */
function rfpSourcesHtml(r: SavedRfp): string {
  const href = `#rfp/${encodeURIComponent(r.id)}`;
  const original = r.files.slice(0, r.files.length - (r.addenda ?? []).reduce((n, a) => n + a.files.length, 0));
  const rows = [
    `<li><b>RFP</b><span class="src-meta">${esc(original.join(", ") || "Original documents")}</span></li>`,
    ...[...(r.addenda ?? [])]
      .sort((a, b) => a.number - b.number)
      .map(
        (a) =>
          `<li><a class="link" href="${href}"><b>${esc(docTitle(a))}</b></a><span class="src-meta">${esc(
            [docKindLabel(a), shortDay(a.at), `${plural(a.changes.length, "update")}`].filter(Boolean).join(" · "),
          )}</span></li>`,
      ),
  ];
  return `<h3 class="proj-subhead">Read into the review</h3><ul class="rfp-sources">${rows.join("")}</ul>`;
}

/** The fee in brief: each phase's total, the fee, and how it compares with the construction budget. Opens the fee. */
function feeSummaryHtml(f: SavedFee | undefined): string {
  if (!f) return isDemo() ? demoRevealHtml("fee", "Draft the fee") : `<p class="none">None yet.</p><div class="actions"><button class="btn" data-make-fee>Make fee</button></div>`;
  // The firm's own fee only: the proposal table's Architecture column (its labor and markup on consultants;
  // reimbursable expenses are listed below, not in it). Consultant fees are worked on in the fee itself.
  // Rounded as the organization rounds its fee table, so it shows the same amounts as the Proposal table.
  const table = roundedTable(proposalTable(f), (n) => roundFee(n, feeRounding));
  const t = totals(f);
  const arch = table.totals[0] ?? 0;
  const cents = feeRounding === 0.01;
  const amount = (n: number) => (cents ? n.toLocaleString("en-US", { style: "currency", currency: "USD" }) : money(n));
  const href = `#fee/${encodeURIComponent(f.id)}`;
  const firms = f.consultants.filter((c) => consultantTotal(c, f.phases) > 0).length;
  const consultantsNote = `<p class="proj-fee-note">${
    firms
      ? `Plus ${firms} consultant fee${firms === 1 ? "" : "s"}, in the <a class="link" href="${href}">fee workspace</a>.`
      : `Consultant fees are added and worked on in the <a class="link" href="${href}">fee workspace</a>.`
  }</p>`;
  if (!arch) return `<p class="none">${esc(f.title || "Untitled fee")} has no amounts yet. <a class="link" href="${href}">Open it</a>.</p>${consultantsNote}`;
  return `<a class="proj-fee-link" href="${href}" aria-label="Open the fee">
      <p class="proj-fee-total">${amount(arch)}</p>
      ${t.budget ? `<p class="proj-fee-pct">${((arch / t.budget) * 100).toFixed(1)}% of a ${money(t.budget)} construction budget</p>` : ""}
    </a>
    ${consultantsNote}
    <a class="proj-fee-link" href="${href}" tabindex="-1" aria-hidden="true">
      <table class="proj-fee-table">
        <tbody>${table.rows.map((r) => `<tr><th scope="row">${esc(r.label)}</th><td class="num">${amount(r.amounts[0] ?? 0)}</td></tr>`).join("")}${
          table.expenses ? `<tr class="proj-fee-expenses"><th scope="row">Reimbursable expenses <span class="note">not in total</span></th><td class="num">${money(table.expenses)}</td></tr>` : ""
        }</tbody>
      </table>
    </a>`;
}

/**
 * On a large enough window, sizes the dashboard to the space between the header and the footer, so the page doesn't
 * scroll (cards scroll inside instead). Elsewhere (phones, short windows) the cards stack and the page scrolls.
 */
function fitDashboard() {
  const grid = document.querySelector<HTMLElement>("#project-page .proj-grid");
  const page = $("project-page");
  const on = !!grid && !!page.offsetParent && innerWidth >= 1100 && innerHeight >= 680;
  document.documentElement.classList.toggle("project-dash", on);
  if (!grid) return;
  if (!on) return void (grid.style.height = "");
  const footer = document.querySelector<HTMLElement>("footer.site")?.offsetHeight ?? 0;
  const avail = innerHeight - (grid.getBoundingClientRect().top + scrollY) - footer - 32;
  grid.style.height = avail >= 420 ? `${avail}px` : "";
}
addEventListener("resize", () => fitDashboard());
// Leaving the project page drops the fitted layout (the tab is hidden by then).
addEventListener("hashchange", () => requestAnimationFrame(fitDashboard));

const MONTH_MS = 31 * 864e5;
const firstOfMonth = (t: number) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), 1);
};
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Starts a schedule for this project, in the schedule editor's own format (as its blank template makes them), with the
 * RFP's dated items (proposal due, interviews, award, design and construction milestones) as milestones.
 */
/** Makes the project's schedule; a project has at most one, so if it already has one, opens that instead. */
const AI_SCHEDULE = "Draft from the RFP review (AI)";
// The colours the schedule templates use, by kind of task, so drafted schedules look like the rest.
const KIND_COLOR: Record<string, string> = {
  design: "#00914D",
  review: "#949494",
  permit: "#D83968",
  bidding: "#282829",
  construction: "#6D245D",
  closeout: "#282829",
};
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Makes the project's schedule (a project has at most one; if it already has one, that opens). Starts from the same
 * templates as the Schedule tab, or is drafted by AI from the RFP review. Either way it's named after the project, and
 * a template also gets the RFP's dated items as milestones.
 */
async function makeSchedule() {
  if (!project) return;
  const p = project;
  const existing = (await listSchedules()).find((s) => s.workspaceProjectId === p.id);
  if (existing) {
    location.hash = `#schedule/${encodeURIComponent(existing.id)}`;
    return;
  }
  const options = [...(rfp ? [AI_SCHEDULE] : []), ...SCHEDULE_TEMPLATES.map((t) => t.label)];
  const picked = await formModal({
    title: "New schedule",
    fields: [{ label: "Start from", value: SCHEDULE_TEMPLATES[2].label, options, single: true, required: true }],
    confirm: "Make schedule",
  });
  if (!picked || project !== p) return;

  let schedule: SavedSchedule;
  if (picked[0] === AI_SCHEDULE && rfp) {
    const ok = await confirmModal({
      title: "Draft the schedule with AI?",
      body: `AI reads the RFP review and drafts the phases, reviews and milestones, with its assumptions in the schedule's notes.`,
      confirm: "Draft",
    });
    if (!ok) return;
    const review = rfp;
    const res = await withWaiting("Drafting the schedule from the RFP review…", () =>
      postJson<{ draft: ScheduleDraft; usage: Usage }>("/api/schedule-ai", { rfp: review.rfp }, "draft"),
    ).catch((err: Error) => noticeModal("Couldn't draft the schedule", err.message).then(() => null));
    if (!res) return;
    schedule = scheduleFromDraft(res.draft);
  } else {
    const tpl = SCHEDULE_TEMPLATES.find((t) => t.label === picked[0]) ?? SCHEDULE_TEMPLATES[2];
    schedule = withRfpMilestones(tpl.make() as unknown as SavedSchedule);
  }
  Object.assign(schedule, {
    savedAt: Date.now(),
    createdAt: Date.now(),
    workspaceProjectId: p.id,
    title: p.name,
    number: p.number ?? "",
    client: rfp?.rfp.client ?? "",
    colorVersion: 2,
  });
  try {
    await saveSchedule(schedule);
  } catch (err) {
    return noticeModal("Schedule not saved", (err as Error).message);
  }
  location.hash = `#schedule/${encodeURIComponent(schedule.id)}`;
}

/** Adds the RFP review's dated items (proposal due, interviews, construction start…) to a template as milestones. */
function withRfpMilestones(s: SavedSchedule): SavedSchedule {
  const dated = (rfp?.rfp.dates ?? []).filter((d) => parseDay(d.date)).sort((a, b) => a.date.localeCompare(b.date));
  if (!dated.length) return s;
  const tasks = (s.tasks as { id: number }[]) ?? [];
  let next = Math.max(0, ...tasks.map((t) => t.id)) + 1;
  const added = dated.map((d) => ({ id: next++, name: d.label, type: "milestone", date: d.date }));
  const times = dated.map((d) => parseDay(d.date)!.getTime());
  const vs = parseDay(String(s.viewStart))?.getTime() ?? Date.now();
  const ve = parseDay(String(s.viewEnd))?.getTime() ?? Date.now();
  return {
    ...s,
    tasks: [...added, ...tasks],
    nextTaskId: next,
    viewStart: iso(firstOfMonth(Math.min(vs, ...times))),
    viewEnd: iso(firstOfMonth(Math.max(ve, ...times.map((t) => t + MONTH_MS)))),
  };
}

/** Turns an AI draft into a schedule in the editor's format: known colours, checked dates, a month of space each side. */
function scheduleFromDraft(d: ScheduleDraft): SavedSchedule {
  const tasks = d.tasks
    .map((t, i) => {
      const id = i + 1;
      if (t.kind === "milestone") return ISO_DAY.test(t.date) ? { id, name: t.name, type: "milestone", date: t.date } : null;
      if (!ISO_DAY.test(t.start) || !ISO_DAY.test(t.end)) return null;
      const [start, end] = t.start <= t.end ? [t.start, t.end] : [t.end, t.start];
      return { id, name: t.name, type: "bar", color: KIND_COLOR[t.kind] ?? "#00914D", start, end };
    })
    .filter((t): t is NonNullable<typeof t> => !!t)
    .map((t, i) => ({ ...t, id: i + 1 }));
  const days = tasks.flatMap((t) => ("date" in t ? [t.date] : [t.start, t.end])).map((x) => parseDay(x ?? "")?.getTime()).filter((x): x is number => x != null);
  const first = days.length ? Math.min(...days) : Date.now();
  const last = days.length ? Math.max(...days) : Date.now() + 12 * MONTH_MS;
  const start = firstOfMonth(first - MONTH_MS);
  const end = firstOfMonth(last + MONTH_MS);
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    savedAt: Date.now(),
    notes: [...d.notes, defaultScheduleNotes()].filter(Boolean).join("\n"),
    date: "",
    viewStart: iso(start),
    viewEnd: iso(end),
    todayMark: iso(new Date()),
    nextTaskId: tasks.length + 1,
    tasks: tasks.length ? tasks : [{ id: 1, name: "Project Kick-Off", type: "milestone", date: iso(start) }],
    legend: legendFromDraft(d),
  };
}

/**
 * The legend for an AI-drafted schedule, built the way the templates build theirs: drawings due at the end of each
 * design phase, cost estimates at the end of SD and DD, bidding kick-off, substantial completion, occupancy, and the
 * permit approval. Only what the draft has a date for.
 */
function legendFromDraft(d: ScheduleDraft) {
  const ok = (s: string) => ISO_DAY.test(s);
  const bars = d.tasks.filter((t) => t.kind !== "milestone" && ok(t.start) && ok(t.end)).map((t) => (t.start <= t.end ? t : { ...t, start: t.end, end: t.start }));
  const lastEnd = (kind: string, name?: RegExp) => bars.filter((t) => t.kind === kind && (!name || name.test(t.name))).map((t) => t.end).sort().pop() ?? "";
  const firstStart = (kind: string) => bars.filter((t) => t.kind === kind).map((t) => t.start).sort()[0] ?? "";
  const milestone = (name: RegExp) => d.tasks.find((t) => t.kind === "milestone" && name.test(t.name) && ok(t.date))?.date ?? "";
  const prog = lastEnd("design", /program|pre-?design/i);
  const sd = lastEnd("design", /schematic|\bSD\b/i);
  const dd = lastEnd("design", /design dev|\bDD\b/i);
  const cd = lastEnd("design", /construction doc|\bCDs?\b/i);
  const bid = firstStart("bidding");
  const built = lastEnd("construction");
  const occupancy = milestone(/occupan/i) || lastEnd("closeout");
  const permit = lastEnd("permit");
  const keep = <T extends { date: string }>(items: T[]) => items.filter((i) => i.date);
  return {
    deliverables: keep([
      { num: 1, text: "Programming Document", label: "", date: prog },
      { num: 2, text: "Schematic Design Drawings", label: "", date: sd },
      { num: 3, text: "Design Development Drawings", label: "", date: dd },
      { num: 4, text: "100% Construction Drawings", label: "", date: cd },
    ]).map((x, i) => ({ ...x, num: i + 1 })),
    milestones: keep([
      { color: "#282829", code: "BK", text: "Bidding Kick-Off", date: bid },
      { color: "#6D245D", code: "SC", text: "Substantial Completion", date: built },
      { color: "#20ABE2", code: "OC", text: "Project Occupancy / Beneficial Occupancy", date: occupancy },
    ]),
    estimates: keep([
      { color: "#00914D", code: "SD", text: "Schematic Design", date: sd },
      { color: "#00914D", code: "DD", text: "Design Development", date: dd },
    ]),
    approvals: keep([{ text: "Building Permit Approval", date: permit }]),
  };
}

/**
 * Rows of the project's consultant list. Mechanical, electrical, plumbing and fire protection are almost always one
 * firm's proposal, so they're one row (MEP/FP); every other discipline is its own row.
 */
type Group = { key: string; label: string; members: string[] };
const MEP_FP = ["Mechanical", "Electrical", "Plumbing", "Fire Protection"];
const GROUPS: Group[] = (() => {
  const out: Group[] = [];
  for (const d of DISCIPLINES) {
    if (MEP_FP.includes(d)) {
      if (!out.some((g) => g.key === "MEP/FP")) out.push({ key: "MEP/FP", label: "MEP/FP", members: MEP_FP });
    } else out.push({ key: d, label: d, members: [d] });
  }
  return out;
})();
const groupOf = (key: string) => GROUPS.find((g) => g.key === key);

const IN_HOUSE: string[] = ["Architecture", "Interiors", "FF&E"];
const neededDisciplines = (p: SavedProject) => projectDisciplines(rfp?.rfp, p.disciplinesRemoved, p.disciplinesAdded);

// ---------- Consultant matrix ----------
// Firms across the top, disciplines down the side, an X where a firm covers a discipline; then whether its fee is in,
// and a note. Proposals fill it in (a firm whose proposal is on the project gets a column with its disciplines); the
// team corrects anything by clicking. Each firm is selected (green), passed (gray) or still being decided.

type Row = { key: string; label: string; members: string[]; custom?: boolean };

/** The matrix rows: the project's consultant disciplines (MEP/FP as one), any a firm covers, then the team's own. */
function matrixRows(p: SavedProject): Row[] {
  const needed = new Set<string>(neededDisciplines(p));
  const removed = new Set(p.disciplinesRemoved ?? []);
  const covered = new Set((p.consultants ?? []).flatMap((c) => [...coverage(p, c).set]));
  const rows: Row[] = GROUPS.filter((g) => !IN_HOUSE.includes(g.key))
    .filter((g) => !g.members.every((d) => removed.has(d)) && g.members.some((d) => needed.has(d) || covered.has(d)))
    .map((g) => ({ ...g }));
  for (const r of p.customRows ?? []) rows.push({ key: `row:${r.id}`, label: r.label, members: [`row:${r.id}`], custom: true });
  return rows;
}
const rowOf = (p: SavedProject, key: string): Row | undefined =>
  groupOf(key) ?? (p.customRows ?? []).filter((r) => `row:${r.id}` === key).map((r) => ({ key, label: r.label, members: [key], custom: true }))[0];

/** Using the firm on this proposal, or getting a fee from it (the default; older "teaming" entries count as using). */
const decisionOf = (c: ProjectFirm): "using" | "fee" => c.decision ?? (Object.values(c.statuses ?? {}).includes("teaming") ? "using" : "fee");

/**
 * A proposal's project firm: the column it already points to, else the firm with the same directory record or name,
 * else a new column ("Getting a fee", with the disciplines read from the proposal). Links the proposal to it.
 */
function linkFirm(p: SavedProject, r: ReceivedProposal): ProjectFirm | undefined {
  const list = (p.consultants ??= []);
  const found = list.find((c) => c.id === r.firmId);
  if (found) return found;
  const k = keyOf(r.proposal.firm || "");
  if (!k) return undefined;
  const d = directory.find((x) => keyOf(x.name) === k);
  let firm = list.find((c) => (d && c.consultantId === d.id) || keyOf(c.name) === k);
  if (!firm) {
    firm = { id: crypto.randomUUID(), name: d?.name ?? firmName(r.proposal.firm), consultantId: d?.id, disciplines: toDisciplines(r.proposal.disciplines ?? []), decision: "fee" };
    list.push(firm);
  }
  r.firmId = firm.id;
  return firm;
}

/**
 * What a firm covers on this project. Its proposal is the source: once one is in, the latest proposal's disciplines
 * (as read from the PDF) are what it covers. Until then, the scope the team expects from it, set by hand. The team's
 * own rows (e.g. "Energy and LCA") aren't on the governing list, so they're always marked by hand.
 */
function coverage(p: SavedProject, c: ProjectFirm): { set: Set<string>; fromProposal: boolean } {
  const latest = firmProposals(p, c).list.at(-1);
  const own = c.disciplines.filter((d) => d.startsWith("row:"));
  if (latest) return { set: new Set<string>([...toDisciplines(latest.proposal.disciplines ?? []), ...own]), fromProposal: true };
  return { set: new Set(c.disciplines), fromProposal: false };
}
type CellState = "proposal" | "expected" | "none";
/** A matrix cell as read: from the proposal (solid), expected while it's still out (hollow), or empty. */
function baseCell(p: SavedProject, c: ProjectFirm, r: Row): CellState {
  const cov = coverage(p, c);
  return !r.members.some((d) => cov.set.has(d)) ? "none" : cov.fromProposal ? "proposal" : "expected";
}
/** A matrix cell as shown: the team's own mark when they've set one, otherwise as read. */
const cellState = (p: SavedProject, c: ProjectFirm, r: Row): CellState => c.cells?.[r.key] ?? baseCell(p, c, r);
const covers = (p: SavedProject, c: ProjectFirm, r: Row) => cellState(p, c, r) !== "none";

/**
 * Keeps firms and proposals on one source when the project opens: every firm has an id and its directory link (by
 * name, once), and every proposal points to its firm. Returns true when the project changed and should be saved.
 */
function syncFirms(p: SavedProject): boolean {
  let changed = false;
  for (const c of p.consultants ?? []) {
    if (!c.id) (c.id = crypto.randomUUID()), (changed = true);
    if (!c.consultantId) {
      const d = directory.find((x) => keyOf(x.name) === keyOf(c.name));
      if (d) (c.consultantId = d.id), (changed = true);
    }
    // The directory is the source of a linked firm's name: a rename there shows here.
    const d = c.consultantId ? directory.find((x) => x.id === c.consultantId) : undefined;
    if (d && d.name !== c.name) (c.name = d.name), (changed = true);
  }
  for (const r of p.proposals ?? []) {
    const before = r.firmId;
    if (!(p.consultants ?? []).some((c) => c.id === before)) {
      linkFirm(p, r);
      if (r.firmId !== before) changed = true;
    }
  }
  return changed;
}

/** A firm's proposals on this project, and their stated total (the latest proposal's). */
function firmProposals(p: SavedProject, c: ProjectFirm) {
  const list = (p.proposals ?? []).filter((r) => r.firmId === c.id).sort((a, b) => a.receivedAt - b.receivedAt);
  const latest = list.at(-1);
  return { list, total: latest ? statedTotal(latest.proposal) : null };
}

/**
 * The consultant matrix reads as a table until Edit, so a stray click can't change it; Edit turns on the X toggles,
 * each firm's Using / Getting a fee, removing, and adding firms and disciplines, until Done.
 */
let matrixEditing = false;

function consultantsHtml(p: SavedProject): string {
  const firms = p.consultants ?? [];
  const rows = matrixRows(p);
  const editing = matrixEditing;
  // Adding firms and disciplines only while editing (Edit / Done is in the card's header).
  const actions = editing
    ? `<div class="actions matrix-actions"><button class="link" data-add-discipline>+ Add discipline</button></div>`
    : "";
  if (!firms.length)
    return `<p class="none">${rows.length ? `${plural(rows.length, "discipline")} to cover. ` : ""}${
      editing ? "Add the firms you're using or getting fees from." : "Choose Edit to add the firms you're using or getting fees from."
    }</p>${actions}`;
  const dec = (c: ProjectFirm) => decisionOf(c);
  const STATUS = { using: "Chosen", fee: "Getting a fee" } as const;
  const head = firms
    .map(
      (c) => `<th scope="col" class="m-firm dec-${dec(c)}">
        <span class="m-firm-name">${contactButton(c.name)}</span>
        ${
          editing
            ? `<select class="m-decision" data-firm-decision="${esc(c.id!)}" aria-label="Where ${esc(c.name)} stands">
          ${(Object.keys(STATUS) as (keyof typeof STATUS)[])
            .map((v) => `<option value="${v}" ${v === dec(c) ? "selected" : ""}>${STATUS[v]}</option>`)
            .join("")}
        </select><button class="link m-remove" data-remove-firm="${esc(c.id!)}" aria-label="Remove ${esc(c.name)}" title="Remove ${esc(c.name)}">×</button>`
            : dec(c) === "using"
              ? `<span class="m-using-tag">Chosen</span>`
              : `<span class="visually-hidden">${STATUS[dec(c)]}</span>`
        }${(() => {
          const f = firmProposals(p, c);
          return f.total != null ? `<span class="m-fee">${money(f.total)}${AI_MARK}</span>` : f.list.length ? `<span class="m-fee">Proposal in</span>` : "";
        })()}
      </th>`,
    )
    .join("");
  const body = rows
    .map((r) => {
      const cells = firms
        .map((c) => {
          // In the proposal (solid), expected while it's still out (hollow), or empty. While editing, a click cycles
          // empty → expected → in proposal → empty, so the team can correct anything, including what a proposal read.
          const state = cellState(p, c, r);
          const kind = state === "proposal" ? " on" : state === "expected" ? " on expected" : "";
          const marked = c.cells?.[r.key] !== undefined && state !== baseCell(p, c, r);
          const what = state === "proposal" ? `In ${c.name}'s proposal` : state === "expected" ? `Expected from ${c.name}; no proposal yet` : `${c.name} doesn't cover ${r.label}`;
          const label = `${what}${marked ? " (set by hand)" : ""}`;
          return `<td class="dec-${dec(c)}">${
            editing
              ? `<button class="m-cell" data-toggle-cell="${esc(c.id!)}" data-row="${esc(r.key)}" aria-label="${esc(`${r.label}, ${c.name}: ${label}. Click to change.`)}" title="${esc(`${label}. Click to change.`)}"><span class="m-dot${kind}" aria-hidden="true"></span></button>`
              : state !== "none"
                ? `<span class="m-dot${kind}" role="img" aria-label="${esc(label)}" title="${esc(label)}"></span>`
                : ""
          }</td>`;
        })
        .join("");
      const covered = firms.some((c) => decisionOf(c) === "using" && covers(p, c, r));
      // A decided discipline (a firm you're using covers it): the whole row is light green.
      return `<tr class="${covered ? "m-decided" : ""}"${covered ? ' title="Decided: a firm you are using covers this"' : ""}><th scope="row">${esc(r.label)}${
        editing ? `<button class="link team-remove" data-remove-discipline="${esc(r.key)}" aria-label="Remove ${esc(r.label)}" title="Remove ${esc(r.label)} from this project">Remove</button>` : ""
      }</th>${cells}</tr>`;
    })
    .join("");
  return `<div class="matrix-wrap"><table class="matrix${editing ? " editing" : ""}">
      <thead><tr><th class="m-corner"></th>${head}</tr></thead>
      <tbody>${body}
        <tr class="m-notes"><th scope="row">Notes</th>${firms
          .map((c) =>
            editing
              ? `<td class="dec-${dec(c)}"><textarea class="m-note" data-firm-note="${esc(c.id!)}" rows="3" aria-label="Notes on ${esc(c.name)}" placeholder="Notes">${esc(c.note ?? "")}</textarea></td>`
              : `<td class="dec-${dec(c)}"><span class="m-note-text" title="${esc(c.note ?? "")}">${esc(c.note ?? "")}</span></td>`,
          )
          .join("")}</tr>
      </tbody>
    </table></div>${actions}`;
}

// ---------- The project's Consultants page ----------
// One page for every consultant on the project: the matrix (who covers what), then one comparison per discipline
// row of the latest proposal from every firm marked for it. A firm covering several rows is compared in each. Each
// section remembers which proposals it compared; when they change it's out of date until Update comparison runs it.

const proposalKey = (r: ReceivedProposal) => r.hash || r.fileName;

type ReviewGroup = {
  row: Row;
  firms: ProjectFirm[];
  proposals: ReceivedProposal[];
  waiting: ProjectFirm[];
  signature: string[];
  saved?: SavedComparison;
  stale: boolean;
};

// ---------- AI assistant ----------

/** The dashboard as the assistant sees it; the RFP, fee, schedule and consultants come in the project digest. */
function dashboardContext(p: SavedProject) {
  return {
    project: projectLabel(p),
    qaqc: p.qaqc ? { file: p.qaqc.fileName, summary: p.qaqc.summary, flags: p.qaqc.flags } : null,
  };
}

/** The Consultants page: each discipline's firms, proposals (the main terms, not every fee line) and comparison. */
function consultantsContext(groups: ReviewGroup[]) {
  return groups.map((g) => ({
    discipline: g.row.label,
    firms: g.firms.map((c) => ({ name: c.name, decision: decisionOf(c), note: c.note ?? "" })),
    waiting_for: g.waiting.map((c) => c.name),
    proposals: g.proposals.map((r) => {
      const pr = r.proposal;
      return {
        firm: firmName(pr.firm),
        received: new Date(r.receivedAt).toISOString().slice(0, 10),
        stated_total: statedTotal(pr),
        fee_structure: pr.fee_structure,
        disciplines: pr.disciplines,
        ca_site_visits: pr.ca_site_visits,
        schedule: pr.schedule,
        reimbursables: pr.reimbursables,
        additional_services: pr.additional_services,
        exclusions: pr.exclusions,
        assumptions: pr.assumptions,
        clarifications: pr.clarifications,
      };
    }),
    comparison: g.saved
      ? { compared: new Date(g.saved.savedAt).toISOString().slice(0, 10), out_of_date: g.stale, headline: g.saved.cmp.briefing.headline, overview: g.saved.cmp.briefing.overview, flags: g.saved.cmp.briefing.flags.map((f) => `${f.level}: ${f.title}. ${f.detail}`) }
      : null,
  }));
}

function reviewGroups(p: SavedProject): ReviewGroup[] {
  const firms = p.consultants ?? [];
  return matrixRows(p).map((row) => {
    const covering = firms.filter((c) => covers(p, c, row));
    const latest = covering.map((c) => firmProposals(p, c).list.at(-1)).filter((r): r is ReceivedProposal => !!r);
    const signature = latest.map(proposalKey).sort();
    const saved = comparisons.filter((c) => c.group?.key === row.key).sort((a, b) => b.savedAt - a.savedAt)[0];
    const stale = latest.length > 0 && (!saved || saved.group!.v !== 2 || saved.group!.signature.join("|") !== signature.join("|"));
    return { row, firms: covering, proposals: latest, waiting: covering.filter((c) => !firmProposals(p, c).list.length), signature, saved, stale };
  });
}

/**
 * What's open on the Consultants page (disciplines, and their Flags / Fees / Scope parts), kept while the page is
 * redrawn; everything starts closed so the page reads as a list of disciplines.
 */
const openParts = new Set<string>();
addEventListener(
  "toggle",
  (e) => {
    const d = e.target as HTMLDetailsElement;
    const key = d.dataset?.part;
    if (!key) return;
    // The matrix starts open, so it's remembered when closed; everything else when opened.
    if (key === "matrix") return void (d.open ? openParts.delete("matrix-closed") : openParts.add("matrix-closed"));
    d.open ? openParts.add(key) : openParts.delete(key);
  },
  true,
);
const isOpen = (key: string) => (openParts.has(key) ? "open" : "");

function renderConsultantsPage() {
  const p = project!;
  document.documentElement.classList.remove("project-dash");
  $("project-page").classList.add("is-dash");
  const groups = reviewGroups(p);
  setAssistantPage({
    key: `consultants:${p.id}`,
    title: "Ask AI about the consultants",
    hint: 'Ask about the consultant proposals on this page. For example, "Who excludes CA site visits?" or "Which disciplines are still waiting on a proposal?" For fee lines and scope detail, open a discipline\'s comparison and ask there.',
    projectId: p.id,
    part: "consultants",
    ask: (turns, { digest }) => askProjectAssistant("consultants", consultantsContext(groups), digest, turns),
  });
  const stale = groups.filter((g) => g.stale);
  const received = (p.proposals ?? []).length;

  // A discipline in one line: proposals in, the lowest stated fee, who you're using, and whether it's current.
  const summaryLine = (g: ReviewGroup) => {
    const totals = g.proposals.map((r) => ({ name: firmById(r.firmId ?? "")?.name ?? firmName(r.proposal.firm), t: statedTotal(r.proposal) }));
    const known = totals.filter((x): x is { name: string; t: number } => x.t != null);
    const low = known.length > 1 ? known.reduce((a, b) => (b.t < a.t ? b : a)) : known[0];
    const using = g.firms.filter((c) => decisionOf(c) === "using").map((c) => c.name);
    const status = !g.saved ? "not compared yet" : g.stale ? `out of date (compared ${shortDay(g.saved.savedAt)})` : `compared ${shortDay(g.saved.savedAt)}`;
    return [
      plural(g.proposals.length, "proposal"),
      low ? `${known.length > 1 ? "lowest " : ""}${money(low.t)} (${low.name})` : "",
      using.length ? `using ${using.join(", ")}` : "",
      g.waiting.length ? `waiting for ${g.waiting.length}` : "",
      status,
    ]
      .filter(Boolean)
      .map((x, k, a) => (k === a.length - 1 && g.stale ? `<b class="cg-stale">${esc(x)}</b>` : esc(x)))
      .join(" · ");
  };

  const section = (g: ReviewGroup) => {
    const c = g.saved;
    const key = `cg:${g.row.key}`;
    const part = (name: string, title: string, body: string) =>
      `<details class="cg-part" data-part="${esc(`${key}:${name}`)}" ${isOpen(`${key}:${name}`)}><summary>${title}</summary><div class="cg-part-body">${body}</div></details>`;
    const flags = c ? c.cmp.briefing.flags.length : 0;
    const questions = c ? c.cmp.briefing.questions.reduce((n, q) => n + q.items.length, 0) : 0;
    return `<details class="cgroup${g.stale ? " stale" : ""}" id="cg-${esc(g.row.key)}" data-part="${esc(key)}" ${isOpen(key)}>
      <summary class="cgroup-summary"><span class="cgroup-title">${esc(g.row.label)}</span><span class="cgroup-line">${summaryLine(g)}</span></summary>
      <div class="cgroup-body">
        ${g.waiting.length ? `<p class="cgroup-waiting">Waiting for: ${g.waiting.map((w) => esc(w.name)).join(", ")}</p>` : ""}
        ${
          c
            ? `<div class="glance">${glanceHtml(c.proposals, c.cmp)}</div>
               <p class="cg-headline">${esc(c.cmp.briefing.headline)}</p>
               <p class="cg-overview">${esc(c.cmp.briefing.overview)}</p>
               ${flags || questions ? part("brief", `Flags and questions <span class="cg-count">${[flags ? plural(flags, "flag") : "", questions ? plural(questions, "question") : ""].filter(Boolean).join(", ")}</span>`, briefingDetails(c.proposals, c.cmp)) : ""}
               ${part("fees", "Fees", `<div class="scroll"><table class="grid">${feeTable(c.proposals, c.cmp)}</table></div>`)}
               ${part("scope", "Scope", `<p class="legend"><span><b class="st-included">✓ Included</b></span><span><b class="st-optional">+ Optional</b></span><span><b class="st-excluded">✕ Excluded</b></span><span><b class="st-not_mentioned">? Not mentioned</b></span><span><b class="diff-dot">•</b> firms differ</span></p><div class="scroll"><table class="grid">${scopeTable(c.proposals, c.cmp)}</table></div>`)}
               <p class="cg-open"><a class="link" href="#proposals/${encodeURIComponent(c.id)}">Open with Ask / correct</a></p>`
            : `<p class="none">${g.proposals.length === 1 ? "This proposal hasn't" : "These proposals haven't"} been compared yet. Choose Update comparison at the top.</p>`
        }
      </div>
    </details>`;
  };

  const withProposals = groups.filter((g) => g.proposals.length);
  const waitingOnly = groups.filter((g) => !g.proposals.length);
  $("project-page").innerHTML = `
    <div class="proj-head">
      <div class="proj-title">
        <a class="link" href="#project/${encodeURIComponent(p.id)}">← ${esc(projectLabel(p))}</a>
        <h1 class="headline">Consultant proposals</h1>
        <p class="proj-sub">${plural((p.consultants ?? []).length, "firm")} · ${plural(received, "proposal")} received</p>
      </div>
      <span class="tools">${
        stale.length
          ? `<button class="btn primary" data-update-review>Update comparison (${plural(stale.length, "discipline")})</button>`
          : received
            ? `<span class="cgroup-status">Up to date</span>`
            : ""
      }${assistantButton()}</span>
    </div>
    <details class="block cpage-matrix" data-part="matrix" ${openParts.has("matrix-closed") ? "" : "open"}>
      <summary class="cgroup-summary"><span class="cgroup-title">Who covers what</span><span class="cgroup-line">${plural((p.consultants ?? []).length, "firm")} across ${plural(groups.length, "discipline")}</span></summary>
      <div class="cgroup-body"><div class="cpage-matrix-tools"><span class="m-key" title="A green row: a chosen firm covers that discipline. While editing, click a cell to cycle: empty, waiting on a proposal, in their proposal."><i class="m-key-prop"></i>In their proposal<i class="m-key-exp"></i>Waiting on a proposal<i class="m-key-using"></i>Discipline covered</span><button class="link" data-matrix-edit>${matrixEditing ? "Done" : "Edit"}</button></div>${consultantsHtml(p)}</div>
    </details>
    <h2 class="cpage-h2">By discipline</h2>
    ${withProposals.length ? withProposals.map(section).join("") : `<p class="none">No proposals yet. Upload them on the project page's Consultant proposals card.</p>`}
    ${
      waitingOnly.length
        ? `<div class="cg-waiting-list"><h3 class="cgroup-sub">No proposals yet</h3><ul>${waitingOnly
            .map((g) => `<li><b>${esc(g.row.label)}</b>${g.waiting.length ? `: waiting for ${g.waiting.map((w) => esc(w.name)).join(", ")}` : ": no firm marked yet"}</li>`)
            .join("")}</ul></div>`
        : ""
    }`;
}

/** Compares, for each out-of-date section, the latest proposal from every firm marked for it, and saves each. */
async function updateReview() {
  const p = project;
  if (!p || blockedInDemo()) return;
  const todo = reviewGroups(p).filter((g) => g.stale);
  if (!todo.length) return;
  const ok = await confirmModal({
    title: "Update the comparison?",
    body: `AI compares the proposals in ${todo.map((g) => g.row.label).join(", ")}. Check what it finds against the proposals themselves.`,
    confirm: "Update",
  });
  if (!ok || project !== p) return;
  const button = document.querySelector<HTMLButtonElement>("[data-update-review]");
  const projectName = projectLabel(p);
  const failed: string[] = [];
  for (const [n, g] of todo.entries()) {
    if (button) (button.disabled = true), (button.textContent = `Comparing ${g.row.label} (${n + 1} of ${todo.length})…`);
    try {
      const sourced = (r: ReceivedProposal): Sourced => ({ ...r.proposal, firm: firmById(r.firmId ?? "")?.name ?? r.proposal.firm, source_file: r.fileName, file_id: r.file_id, pdf_tokens: r.pdf_tokens, source_hash: r.hash ?? undefined });
      // Compared for this discipline only: a firm proposing several disciplines is leveled on this one's scope and fee.
      const focus = { label: g.row.label, disciplines: g.row.custom ? [g.row.label] : g.row.members };
      const json = { "content-type": "application/json" };
      let proposals: Sourced[];
      let result: { comparison: Comparison; usage: Usage };
      if (g.saved && g.saved.group?.v === 2) {
        // Already compared: take out the proposals that went, add only the new ones (the rest isn't redone).
        const key = (x: Sourced) => x.source_hash || x.source_file || "";
        const now = new Map(g.proposals.map((r) => [proposalKey(r), r]));
        const before = g.saved.proposals;
        const gone = before.map((x, i) => (now.has(key(x)) ? -1 : i)).filter((i) => i >= 0);
        // The firms staying keep their saved reading, with today's firm name.
        const existing = before.filter((_, i) => !gone.includes(i)).map((x) => ({ ...x, firm: firmById(now.get(key(x))?.firmId ?? "")?.name ?? x.firm }));
        const added = g.proposals.filter((r) => !before.some((x) => key(x) === proposalKey(r))).map(sourced);
        if (existing.length) {
          result = await post<{ comparison: Comparison; usage: Usage }>(
            "/api/compare",
            JSON.stringify({ projectName, cmp: removeFirms(g.saved.cmp, gone), existing, added, focus }),
            { ...json, "x-action": "extend" },
          );
          proposals = [...existing, ...added];
        } else {
          proposals = g.proposals.map(sourced);
          result = await post<{ comparison: Comparison; usage: Usage }>("/api/compare", JSON.stringify({ projectName, proposals, focus }), json);
        }
      } else {
        // First comparison for this discipline: compare them all.
        proposals = g.proposals.map(sourced);
        result = await post<{ comparison: Comparison; usage: Usage }>("/api/compare", JSON.stringify({ projectName, proposals, focus }), json);
      }
      const { comparison: cmp, usage } = result;
      // Replaces the section's earlier comparison (its chat starts over, since the proposals changed).
      await saveComparison({
        id: g.saved?.id ?? crypto.randomUUID(),
        savedAt: Date.now(),
        projectName,
        projectId: p.id,
        proposals,
        cmp,
        messages: [],
        costUsd: usage.cost_usd ?? undefined,
        costPartial: usage.cost_usd == null,
        group: { key: g.row.key, label: g.row.label, signature: g.signature, v: 2 },
      });
    } catch (err) {
      failed.push(`${g.row.label}: ${(err as Error).message}`);
    }
  }
  if (project !== p) return;
  await load();
  render();
  if (failed.length) await noticeModal("Some sections weren't updated", failed.join("\n"));
}

const firmById = (id: string) => project?.consultants?.find((c) => c.id === id);

async function saveAndRender() {
  if (!project) return;
  await saveProject(project).catch((err) => noticeModal("Not saved", (err as Error).message));
  render();
}

/** Toggles a firm's X for a row (all of MEP/FP at once). */
async function toggleCell(firmId: string, rowKey: string) {
  const c = firmById(firmId);
  const r = project && rowOf(project, rowKey);
  if (!c || !r) return;
  const p = project!;
  const NEXT: Record<CellState, CellState> = { none: "expected", expected: "proposal", proposal: "none" };
  const next = NEXT[cellState(p, c, r)];
  // Without a proposal (or on the team's own rows) the firm's disciplines say what it's expected to cover, so they follow.
  if (!coverage(p, c).fromProposal || r.custom)
    c.disciplines = next === "none" ? c.disciplines.filter((d) => !r.members.includes(d)) : [...new Set([...c.disciplines, ...r.members])];
  // Anything that still differs from what's read is kept as the team's own mark.
  const cells = { ...c.cells };
  delete cells[r.key];
  if (next !== baseCell(p, c, r)) cells[r.key] = next;
  c.cells = Object.keys(cells).length ? cells : undefined;
  await saveAndRender();
}

/** Takes a firm off the project's consultants. */
async function removeFirm(firmId: string) {
  const p = project;
  const c = firmById(firmId);
  if (!p || !c) return;
  const theirs = (p.proposals ?? []).filter((r) => r.firmId === firmId);
  const ok = await confirmModal({
    title: `Remove ${c.name}?`,
    body: `Its column comes off this project's consultants${
      theirs.length ? `, and its proposal${theirs.length === 1 ? "" : "s"} come${theirs.length === 1 ? "s" : ""} off Consultant proposals` : ""
    }. The directory and any comparisons are kept.`,
    confirm: "Remove",
  });
  if (!ok || project !== p) return;
  p.consultants = (p.consultants ?? []).filter((x) => x.id !== firmId);
  if (theirs.length) p.proposals = (p.proposals ?? []).filter((r) => r.firmId !== firmId);
  await saveAndRender();
}

/**
 * Adds the firms the team is using or getting fees from: from this project's proposals, the Consultants directory, or
 * typed in. Each starts as "Getting a fee", with an X for the project's rows it covers.
 */
async function addFirm() {
  const p = project;
  if (!p) return;
  const taken = new Set((p.consultants ?? []).map((c) => keyOf(c.name)));
  const proposalFirms = new Map<string, Proposal>();
  for (const pr of [...(p.proposals ?? []).map((r) => r.proposal), ...comparisons.flatMap((x) => x.proposals)])
    if (pr.firm && !taken.has(keyOf(pr.firm)) && !proposalFirms.has(keyOf(pr.firm))) proposalFirms.set(keyOf(pr.firm), pr);
  const fromProposals = [...proposalFirms.values()].map((pr) => firmName(pr.firm)).sort((a, b) => a.localeCompare(b));
  const names = directory
    .filter((c) => !taken.has(keyOf(c.name)) && !proposalFirms.has(keyOf(c.name)))
    .map((c) => c.name)
    .sort((a, b) => a.localeCompare(b));
  const values = await formModal({
    title: "Add consultants",
    fields: [
      ...(fromProposals.length ? [{ label: "Sent a proposal for this project", value: "", options: fromProposals }] : []),
      ...(names.length ? [{ label: "From the directory", value: "", options: names }] : []),
      { label: fromProposals.length || names.length ? "Or another firm" : "Firm", value: "", placeholder: "Firm name" },
    ],
    confirm: "Add",
    validate: (v) => v.some((x) => x.trim()),
  });
  if (!values || project !== p) return;
  const picked = values.slice(0, -1).flatMap((v) => v.split("\n").filter(Boolean));
  const typed = values[values.length - 1].trim();
  const rows = matrixRows(p);
  for (const name of [...picked, ...(typed ? [typed] : [])]) {
    if ((p.consultants ?? []).some((c) => keyOf(c.name) === keyOf(name))) continue;
    const d = directory.find((x) => keyOf(x.name) === keyOf(name));
    // It starts with an X for each of the project's rows its proposal (or its directory entry) covers.
    const covers: string[] = proposalFirms.has(keyOf(name)) ? toDisciplines(proposalFirms.get(keyOf(name))!.disciplines ?? []) : d ? firmDisciplines(d) : [];
    const disciplines = rows.filter((r) => !r.custom && r.members.some((m) => covers.includes(m))).flatMap((r) => r.members);
    (p.consultants ??= []).push({ id: crypto.randomUUID(), name: d?.name ?? name, consultantId: d?.id, disciplines, decision: "fee" });
  }
  await saveAndRender();
}

/** Takes a whole row off the matrix: a discipline (or MEP/FP), or one of the team's own rows. */
async function removeDiscipline(key: string) {
  const p = project;
  const r = p && rowOf(p, key);
  if (!p || !r) return;
  const firms = (p.consultants ?? []).filter((c) => covers(p, c, r));
  const ok = await confirmModal({
    title: `Remove ${r.label}?`,
    body: `${r.label} comes off this project's consultants${firms.length ? `, along with the X's for ${firms.map((c) => c.name).join(", ")}` : ""}. You can add it back with Add discipline. The RFP review isn't changed.`,
    confirm: "Remove",
  });
  if (!ok || project !== p) return;
  if (r.custom) p.customRows = (p.customRows ?? []).filter((x) => `row:${x.id}` !== key);
  else {
    p.disciplinesRemoved = [...new Set([...(p.disciplinesRemoved ?? []), ...r.members])];
    p.disciplinesAdded = (p.disciplinesAdded ?? []).filter((d) => !r.members.includes(d));
  }
  for (const c of firms) c.disciplines = c.disciplines.filter((d) => !r.members.includes(d));
  await saveAndRender();
}

/** Adds rows: disciplines not on the matrix (MEP/FP as one), or the team's own (e.g. "Energy and LCA"). */
async function addDiscipline() {
  const p = project;
  if (!p) return;
  const shown = new Set(matrixRows(p).map((r) => r.key));
  const options = GROUPS.filter((g) => !IN_HOUSE.includes(g.key) && !shown.has(g.key)).map((g) => g.label);
  const values = await formModal({
    title: "Add disciplines",
    fields: [
      ...(options.length ? [{ label: "Disciplines this project needs", value: "", options }] : []),
      { label: options.length ? "Or your own" : "Discipline", value: "", placeholder: "e.g. Energy and LCA" },
    ],
    confirm: "Add",
    validate: (v) => v.some((x) => x.trim()),
  });
  if (!values || project !== p) return;
  const picked = options.length ? values[0].split("\n").filter(Boolean) : [];
  const members = picked.map((label) => GROUPS.find((g) => g.label === label)).flatMap((g) => g?.members ?? []);
  const typed = values[values.length - 1].trim();
  if (typed) {
    // A typed name that's one of the governing disciplines joins that row instead of making a duplicate.
    const known = toDisciplines([typed]);
    const exact = GROUPS.find((g) => g.label.toLowerCase() === typed.toLowerCase());
    if (exact) members.push(...exact.members);
    else if (known.length === 1 && known[0].toLowerCase() === typed.toLowerCase()) members.push(known[0]);
    else if (!(p.customRows ?? []).some((r) => r.label.toLowerCase() === typed.toLowerCase()))
      (p.customRows ??= []).push({ id: crypto.randomUUID(), label: typed });
  }
  if (members.length) {
    p.disciplinesAdded = [...new Set([...(p.disciplinesAdded ?? []), ...members])];
    p.disciplinesRemoved = (p.disciplinesRemoved ?? []).filter((d) => !members.includes(d));
  }
  await saveAndRender();
}

async function rename() {
  if (!project) return;
  const p = project;
  const entered = await askProjectName("Edit project", "Save", p);
  if (!entered || (entered.name === p.name && entered.number === p.number)) return;
  p.name = entered.name;
  p.number = entered.number;
  const name = projectLabel(p);
  try {
    await saveProject(p);
    // Reviews and comparisons show the project's name, so keep theirs in step.
    if (rfp) await saveRfp({ ...rfp, project: name });
    await Promise.all(comparisons.map((c) => saveComparison({ ...c, projectName: name })));
    // Its schedule is named after it (title and project number), so it follows too.
    await Promise.all(schedules.map((s) => saveSchedule({ ...s, title: p.name, number: p.number ?? "" })));
  } catch (err) {
    await noticeModal("Not saved", (err as Error).message);
  }
  await load();
  render();
}

async function unlink(id: string) {
  const c = comparisons.find((x) => x.id === id);
  if (!c) return;
  const ok = await confirmModal({
    title: "Remove from project?",
    body: "The comparison itself is kept. It just won't be part of this project.",
    confirm: "Remove",
  });
  if (!ok) return;
  try {
    await saveComparison({ ...c, projectId: undefined, projectName: null });
  } catch (err) {
    return noticeModal("Not saved", (err as Error).message);
  }
  await load();
  render();
}

/** Deletes a project. Its RFP review and comparisons are kept, just no longer linked to it. */
async function remove(id: string) {
  const target = (await listProjects()).find((p) => p.id === id);
  if (!target) return;
  const ok = await confirmTyped({
    title: "Delete this project?",
    name: projectLabel(target),
    body: `Its RFP review, comparisons and schedules are kept; they just won't be linked to a project. ${
      savesShared() ? "The project is removed for everyone who uses this app." : "The project is removed from this browser."
    } This can't be undone.`,
    confirm: "Delete project",
  });
  if (!ok) return;
  try {
    const [rfps, cmps] = await Promise.all([listRfps(), listComparisons()]);
    await Promise.all([
      ...rfps.filter((r) => r.projectId === id).map((r) => saveRfp({ ...r, projectId: undefined, project: null })),
      ...cmps.filter((c) => c.projectId === id).map((c) => saveComparison({ ...c, projectId: undefined, projectName: null })),
      ...(await listSchedules()).filter((s) => s.workspaceProjectId === id).map((s) => saveSchedule({ ...s, workspaceProjectId: undefined })),
      ...(await listFees()).filter((f) => f.workspaceProjectId === id).map((f) => saveFee({ ...f, workspaceProjectId: undefined })),
    ]);
    await deleteProject(id);
  } catch (err) {
    return noticeModal("Couldn't delete", (err as Error).message);
  }
  if (location.hash === "#project") showProjectList();
  else location.hash = "#project";
}

/** What the Proposals and Proposal check cards need from the page. */
const proposalsContext = (): ProposalsContext => ({
  project: project!,
  rfp,
  save: () => saveProject(project!),
  rerender: () => project && render(),
  linkFirm: (r) => (project ? linkFirm(project, r) : undefined),
});

async function onClick(e: Event) {
  const t = e.target as HTMLElement;
  const contact = t.closest<HTMLElement>("[data-contact]");
  if (contact) return openContactCard(contact);
  const del = t.closest("[data-delete-project]")?.getAttribute("data-delete-project");
  if (del) await remove(del);
  else if (t.closest("[data-remove-discipline]")) await removeDiscipline(t.closest("[data-remove-discipline]")!.getAttribute("data-remove-discipline")!);
  else if (t.closest("[data-demo-reveal]")) await revealDemoPart(t.closest("[data-demo-reveal]")!.getAttribute("data-demo-reveal") as DemoPart);
  else if (t.closest("[data-make-schedule]")) await makeSchedule();
  else if (t.closest("[data-make-fee]") && project) await makeFee(project);
  else if (t.closest("[data-add-discipline]")) await addDiscipline();
  else if (t.closest("[data-fee-final]") || t.closest("[data-fee-draft]")) {
    const f = fees.find((x) => x.id === (t.closest("[data-fee-final]") ?? t.closest("[data-fee-draft]"))!.getAttribute(t.closest("[data-fee-final]") ? "data-fee-final" : "data-fee-draft"));
    const next = f && (await setFeeStatus(f, t.closest("[data-fee-final]") ? "final" : "draft"));
    if (!next) return;
    try {
      await saveFee({ ...next, savedAt: Date.now() });
      fees = fees.map((x) => (x.id === next.id ? next : x));
    } catch (err) {
      return noticeModal("Not saved", (err as Error).message);
    }
    render();
  }
  else if (t.closest("[data-toggle-cell]")) {
    const el = t.closest("[data-toggle-cell]")!;
    await toggleCell(el.getAttribute("data-toggle-cell")!, el.getAttribute("data-row")!);
  } else if (t.closest("[data-remove-firm]")) await removeFirm(t.closest("[data-remove-firm]")!.getAttribute("data-remove-firm")!);
  else if (t.closest("[data-add-firm]")) await addFirm();
  else if (t.closest("[data-update-review]")) await updateReview();
  else if (t.closest("[data-matrix-edit]")) {
    matrixEditing = !matrixEditing;
    render();
  }
  else if (t.closest("[data-rename]")) await rename();
  else if (t.closest("[data-unlink]")) await unlink(t.closest("[data-unlink]")!.getAttribute("data-unlink")!);
  else if (t.closest("[data-new-project]")) {
    const p = await newProject();
    if (p) location.hash = `#project/${encodeURIComponent(p.id)}`;
  } else if (t.closest("[data-review-rfp]") && project) {
    // The review is read on the RFP page and links itself to this project when it's done.
    setPendingProject({ id: project.id, name: projectLabel(project) });
    location.hash = "#rfp";
  }
}

// ---------- Contact cards ----------
// A consultant's name opens a small card with their contacts from the Consultants directory.

const findFirm = (name: string) => directory.find((c) => keyOf(c.name) === keyOf(name));

const contactButton = (name: string) => `<button class="contact-name" data-contact="${esc(name)}" aria-haspopup="dialog">${esc(name)}</button>`;

function closeContactCard() {
  document.getElementById("contact-card")?.remove();
}

function openContactCard(button: HTMLElement) {
  const already = document.getElementById("contact-card");
  closeContactCard();
  if (already?.dataset.for === button.dataset.contact) return; // a second click closes it
  const name = button.dataset.contact ?? "";
  const firm = findFirm(name);
  const contacts = firm ? (firm.contacts ?? parseContacts(firm.contact)) : [];
  const card = document.createElement("div");
  card.id = "contact-card";
  card.className = "contact-card";
  card.dataset.for = name;
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", `${name} contacts`);
  card.innerHTML = firm
    ? `<h3>${esc(firm.name)}</h3>
       ${contacts.length ? contactsHtml(contacts) : `<p class="none">No contacts saved.</p>`}
       ${firm.website ? `<p>${siteLink(firm.website)}</p>` : ""}
       <p><a class="link" href="#consultants">Open the directory</a></p>`
    : `<h3>${esc(name)}</h3><p class="none">Not in the Consultants directory yet.</p><p><a class="link" href="#consultants">Add them there</a></p>`;
  document.body.appendChild(card);
  const box = button.getBoundingClientRect();
  const left = Math.min(box.left + scrollX, scrollX + document.documentElement.clientWidth - card.offsetWidth - 12);
  card.style.left = `${Math.max(scrollX + 12, left)}px`;
  card.style.top = `${box.bottom + scrollY + 6}px`;
}

// Clicks inside the card (copying an email) stay open; anywhere else, Escape or leaving the page closes it.
document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const copy = t.closest<HTMLElement>("#contact-card [data-copy-email]");
  if (copy) return void copyEmail(copy);
  if (t.closest("#contact-card") || t.closest("[data-contact]")) return;
  closeContactCard();
});
addEventListener("keydown", (e) => e.key === "Escape" && closeContactCard());
addEventListener("hashchange", closeContactCard);

// The consultant matrix's edits: a firm's decision (using it, or getting a fee) and its note.
document.addEventListener("change", async (e) => {
  const el = e.target as HTMLInputElement;
  if (!project || !el.closest?.("#project-page .matrix")) return;
  const c = firmById(el.dataset.firmDecision ?? el.dataset.firmNote ?? "");
  if (!c) return;
  if (el.dataset.firmNote != null) {
    // Saved when the box is left; no redraw, so the next box can be clicked straight away.
    c.note = el.value.trim() || undefined;
    return void saveProject(project).catch((err) => noticeModal("Not saved", (err as Error).message));
  }
  c.decision = el.value === "using" ? "using" : "fee";
  await saveAndRender();
});

// Consultant proposals (added, ticked) and the proposal check's PDF.
document.addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement;
  if (!project || !el.closest?.("#project-page")) return;
  onProposalsChange(el, proposalsContext());
});

// ---------- Addenda ----------
// Picking an addendum's PDF reads it into the project's RFP review, which then lists what changed.
document.addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  if (!input.matches?.("#project-page [data-addendum]") || !rfp || !project) return;
  const files = [...(input.files ?? [])];
  input.value = "";
  if (!files.length) return;
  if (files.some((f) => !/\.pdf$/i.test(f.name) && f.type !== "application/pdf")) return noticeModal("Not a PDF", "Addenda have to be PDFs.");
  const status = document.getElementById("addendum-status");
  const started = Date.now();
  const tick = setInterval(() => status && (status.textContent = `Reading… ${Math.round((Date.now() - started) / 1000)}s`), 1000);
  try {
    const updated = await addAddendum(rfp, files);
    if (!updated) return;
    rfp = updated;
    render();
    const last = updated.addenda!.at(-1)!;
    const go = await confirmModal({
      title: `${docTitle(last)} added`,
      body: `${plural(last.changes.length, "update")} to the RFP review. The review lists each one.`,
      confirm: "See the updates",
    });
    if (go) location.hash = `#rfp/${encodeURIComponent(updated.id)}`;
  } catch (err) {
    await noticeModal("Couldn't read the document", (err as Error).message);
  } finally {
    clearInterval(tick);
    if (status) status.textContent = "";
  }
});
