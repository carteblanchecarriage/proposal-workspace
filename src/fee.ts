import { feeStatusHtml, isFinal, setFeeStatus } from "./fee-status";
import { DEFAULT_FEE_STYLE, FEE_ROUNDINGS, feeMoney, feeTableCss, roundFee, type FeeRounding, type FeeStyle } from "./fee-style";
import { budgetBy, budgetOf, cleanNumber, readAmount, readArea, consultantTotal, hasFee, proposalTable, roundedTable, taskCost, taskHours, totals, type ProposalTable } from "./fee-calc";
import { DEFAULT_ROLES, shortPhase, shortRole, TEMPLATES, templateFor, templatePhases } from "./fee-templates";
import { confirmDelete, confirmModal, formModal, noticeModal } from "./modal";
import { projectDisciplines } from "./rfp";
import { BELOW_LINE_BASIS, type BelowLineBasis, getFeeStyle, getWorldView, deleteFee, listComparisons, listFees, listProjects, listRfps, projectLabel, createFee, type SavedFee, type SavedProject } from "./store";
import { esc, firmName } from "./table";
import { postJson } from "./api";
import { feeCurveAt, type FeePoint } from "../lib/worldview";
import { contextForRfp } from "./worldview";
import type { FeeDraft } from "../lib/claude";
import { type Usage } from "../lib/cost";
import { applyFeeChanges, worksheetFor } from "./fee-chat";
import { assistantButton, setAssistantPage, type AssistantPage } from "./assistant";
import type { FeeChat } from "../lib/claude";
import { feeTimeHtml, hideFeeTimeTip, onFeeTimeMove } from "./fee-time";
import { dateText, money, plural } from "../lib/format";
import { flushFees, forgetFee, loadFees, queueFee, setFeeHooks, unforgetFee, watchFees } from "./fee-sync";

// Fee builder: labor by phase (hours per role × the role's rate), consultants with a management markup, and a
// construction budget to check the total against as a percentage. One fee per project; also usable on its own.

const $ = (id: string) => document.getElementById(id)!;

let fee: SavedFee | null = null;
// Undo: snapshots of the fee kept in memory while it's open (cleared on leaving it or reloading). A snapshot is
// taken each time an edit is finished (leaving a box, adding or removing a row), so one undo steps back one edit.
const UNDO_LIMIT = 50;
let undoStack: string[] = [];
let committed = "";

/** Records the finished edit, so Undo can step back to before it. */
function checkpoint() {
  if (!fee) return;
  let now = JSON.stringify(fee);
  if (now === committed) return;
  // Edited after it was marked final: it's a draft again (saved with the edit).
  if (isFinal(fee)) {
    fee.status = "draft";
    delete fee.finalAt;
    now = JSON.stringify(fee);
    queueFee(fee);
    const banner = document.querySelector("#fee-page .fee-state");
    if (banner) banner.outerHTML = feeStatusHtml(fee);
    scheduleStatusNote();
  }
  undoStack.push(committed);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  committed = now;
  updateUndo();
}

/** Says, once, that editing a final fee made it a draft again. */
const scheduleStatusNote = () => say("Edited, so it's a draft again.");

function updateUndo() {
  const b = document.querySelector<HTMLButtonElement>("#fee-page [data-undo]");
  if (b) b.disabled = !undoStack.length;
}

/** Steps back one finished edit, and saves the fee as it was. */
function undo() {
  if (!fee) return;
  checkpoint(); // an edit still being typed counts as finished
  const prev = undoStack.pop();
  if (!prev) return;
  fee = JSON.parse(prev) as SavedFee;
  committed = prev;
  rerender(false);
  changed();
}

/** The summary's lines while they're being edited, apart from the fee until Save is clicked; else null. */
let summaryEdit: { basis: string; assumptions: string[] } | null = null;

/** phases whose task tables are open (the rest show one summary line each) */
const openPhases = new Set<string>();
/** The Summary section starts collapsed; opening it keeps it open through redraws. */
let summaryOpen = false;
let projects: SavedProject[] = [];
let initialized = false;
/** Which opening of the page is the latest: an earlier one still loading gives up. */
let opening = 0;

const hrs = (n: number) => (n ? n.toLocaleString("en-US", { maximumFractionDigits: 1 }) : "—");
const pct = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : `${n.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`);
/** "$1,250,000", "12.5%", "1,200" → number; blank or unreadable → null. */
const parseNum = (s: string) => {
  const n = parseFloat(s.replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** A number as shown in an input: with thousands commas ("4,500,000"), blank for none. */
const numValue = (n: number | null | undefined) => (n == null ? "" : n.toLocaleString("en-US", { maximumFractionDigits: 2 }));

/**
 * Adds thousands commas to a number box while typing, keeping the caret beside the same digit. Whatever has been
 * typed after a decimal point is left alone, so "12." and "1.50" stay as typed.
 */
function addCommas(el: HTMLInputElement, opts: { units?: boolean; negative?: boolean }) {
  const before = el.value;
  const caret = el.selectionStart ?? before.length;
  const digitsBefore = before.slice(0, caret).replace(/[^\d.]/g, "").length;
  const clean = cleanNumber(before, opts);
  const [int, dec] = clean.split(".");
  const next = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (dec != null ? "." + dec : "");
  if (next === before) return;
  el.value = next;
  if (caret === before.length) return el.setSelectionRange(next.length, next.length);
  // Put the caret after the same number of digits (and decimal point) as before.
  let pos = 0;
  for (let seen = 0; pos < next.length && seen < digitsBefore; pos++) if (/[\d.]/.test(next[pos])) seen++;
  el.setSelectionRange(pos, pos);
}

// ---------- Entry points ----------

// The World view's fee curve (expected fee percent by construction budget), loaded with the page.
let curve: FeePoint[] = [];
const curveTarget = (budget: number | null) => {
  const p = feeCurveAt(curve, budget);
  return p == null ? null : Math.round(p * 10) / 10;
};

/** Moves a curve-based target to the curve's value at the fee's current budget, in the model and its box. */
function followCurve(f: SavedFee) {
  const p = curveTarget(budgetOf(f));
  if (p == null) return;
  f.targetPercent = p;
  const box = document.querySelector<HTMLInputElement>('#fee-page [data-k="targetPercent"]');
  if (box) box.value = numValue(p);
}

export async function showFee(id: string | null) {
  const mine = ++opening;
  const [world, style] = await Promise.all([getWorldView().catch(() => null), getFeeStyle().catch(() => DEFAULT_FEE_STYLE)]);
  if (mine !== opening) return; // another fee was opened, or the page left, while this was loading
  curve = world?.feeCurve ?? [];
  feeStyle = style;
  if (!initialized) {
    initialized = true;
    const page = $("fee-page");
    page.addEventListener("click", onClick);
    setFeeHooks({
      open: () => fee,
      adopt: adoptFee,
      gone: (id, why) => {
        if (why) void noticeModal("This fee was replaced", why);
        if (fee?.id !== id) return;
        fee = null;
        location.hash = "#project";
      },
      error: saveProblem,
      notice: say,
      typing: () => !!(document.activeElement as HTMLElement | null)?.matches?.("#fee-page .fee-in"),
    });
    watchFees();
    page.addEventListener("input", onInput);
    // "toggle" doesn't bubble, so it's caught on the way down.
    page.addEventListener("toggle", (e) => {
      if ((e.target as HTMLElement).matches?.(".fee-summary-block")) summaryOpen = (e.target as HTMLDetailsElement).open;
    }, true);
    page.addEventListener("mousemove", (e) => onFeeTimeMove(e, fee));
    page.addEventListener("mouseleave", hideFeeTimeTip);
    // Fires when an edited box is left or Enter is pressed: recalculate then.
    page.addEventListener("change", (e) => {
      // Summary lines count only when Save is clicked, so leaving one mid-edit isn't an undo step.
      if (fee && (e.target as HTMLElement).matches(".fee-in:not(.fee-sum-in)")) {
        refresh();
        checkpoint();
      }
    });
    // Ctrl+Z / Cmd+Z undoes the last finished edit, except while typing in a box (where it undoes the typing).
    addEventListener("keydown", (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== "z") return;
      if (!fee || page.closest("[hidden]") || document.querySelector("dialog[open]")) return;
      if ((e.target as HTMLElement).matches?.("input, textarea, select")) return;
      e.preventDefault();
      undo();
    });
    page.addEventListener("keydown", (e) => {
      const el = e.target as HTMLInputElement;
      if (e.key === "Escape" && summaryEdit && !document.querySelector("dialog[open]")) return cancelSummaryEdit();
      if (e.key === "Enter" && el.matches(".fee-in")) {
        e.preventDefault(); // summary lines wrap but stay one line each
        el.blur();
      }
    });
    addEventListener("pagehide", () => {
      checkpoint(); // an edit still being typed: a final fee it changes is a draft
      void flushFees(true);
    });
  }
  if (fee && fee.id !== id) closeFee();
  if (id) return openFee(id, mine, world?.phaseShares ?? []);
  closeFee(); // fees open by id, from their project (main.ts sends anyone else to Projects)
}

/** Leaves the fee page: saves what's unsaved, and forgets the fee, so coming back shows it as it is then. */
export function leaveFee() {
  opening++;
  closeFee();
}
function closeFee() {
  if (fee) finishTyping();
  void flushFees();
  fee = null;
  summaryEdit = null;
  undoStack = [];
}
/** A box still being typed in counts as finished. */
function finishTyping() {
  const el = document.activeElement as HTMLElement | null;
  if (el?.matches?.("#fee-page .fee-in")) el.blur();
  checkpoint();
}

/** Shows the open fee combined with someone else's changes. They go into the undo steps too: Undo reverses only yours. */
function adoptFee(merged: SavedFee, rebase: (f: SavedFee) => SavedFee) {
  if (!fee || fee.id !== merged.id) return;
  const through = (s: string) => JSON.stringify(rebase(JSON.parse(s) as SavedFee));
  undoStack = undoStack.map(through);
  committed = through(committed);
  fee = merged;
  rerender(false);
}

/** The AI assistant on the open fee (see fee-chat.ts): its edits are one step, undone with one Undo, and saved. */
function feeAssistant(f: SavedFee): AssistantPage {
  return {
    key: `fee:${f.id}`,
    title: "Ask AI about this fee",
    hint: 'Ask about this fee, or ask for a change to its tasks, hours or consultants. For example, "Break schematic design into more tasks" or "Add Acme Engineering for MEP at $48,000". It can move the fee up or down when that\'s what your question comes down to. Rates, phases and the budget stay as you set them.',
    placeholder: "Ask a question or ask for a change…",
    note: "Changes can be undone with Undo.",
    projectId: f.workspaceProjectId ?? null,
    part: "fee",
    ask: async (turns, { digest }) => {
      // The fee as it is now (Undo replaces the object, so it's read at the time of asking).
      // A copy: the answer's ids are places on the worksheet as sent, even if it's edited meanwhile.
      const now = structuredClone(fee?.id === f.id ? fee : f);
      const res = await postJson<{ answer: FeeChat; usage: Usage }>("/api/fee-draft", { worksheet: worksheetFor(now), rfp: await linkedRfp(now).catch(() => null), turns, digest }, "chat");
      if (fee?.id !== f.id) return { text: res.answer.reply, meta: res.answer.changes.length ? "The fee was closed before the answer came, so nothing was changed" : "" };
      const { changes, assumptions } = res.answer;
      const { applied, skipped } = changes.length || assumptions.length ? applyAssistant(changes, assumptions, now) : { applied: 0, skipped: 0 };
      const meta = [applied ? `Worksheet updated (${plural(applied, "change")})` : "", skipped ? `${plural(skipped, "change")} couldn't be applied` : ""]
        .filter(Boolean)
        .join(" · ");
      // The next turn sees what was done; the worksheet itself is resent fresh each time.
      return { text: res.answer.reply, meta, source: "data", costUsd: res.usage.cost_usd, turn: res.answer.reply + (applied ? `\n\n[Applied ${applied} change(s) to the worksheet.]` : "") };
    },
  };
}

/** The linked project's RFP review, for the assistant. */
async function linkedRfp(f: SavedFee) {
  const project = projects.find((p) => p.id === f.workspaceProjectId);
  if (!project) return null;
  const rfps = await listRfps();
  return (rfps.find((r) => r.id === project.rfpId) ?? rfps.find((r) => r.projectId === project.id))?.rfp ?? null;
}

function applyAssistant(changes: FeeChat["changes"], assumptions: string[], sent: SavedFee) {
  if (!fee) return { applied: 0, skipped: changes.length };
  if (summaryEdit && assumptions.some((a) => a.trim())) cancelSummaryEdit(); // the assistant's list replaces an unsaved edit
  checkpoint(); // anything typed before asking is its own step
  const result = applyFeeChanges(fee, changes, sent);
  result.phases.forEach((id) => openPhases.add(id)); // show what changed
  // The summary at the top, revised to match (same undo step).
  const lines = assumptions.map((a) => a.trim().slice(0, 500)).filter(Boolean).slice(0, 12);
  if (lines.length) {
    fee.draft ??= { basis: "", assumptions: [], costUsd: null, at: Date.now(), source: "notes" };
    fee.draft.assumptions = lines;
    fee.draft.revisedAt = Date.now();
  }
  if (result.applied || lines.length) rerender();
  return result;
}

/**
 * Makes a project's fee and opens it. It's named after the project, starts with the RFP review's budget and
 * area (when they're plain numbers), the template that suits that budget, and a row per discipline it needs.
 * A project has at most one fee: if it already has one, that opens instead.
 */
export async function makeFee(project: SavedProject) {
  const [fees, rfps, cmps] = await Promise.all([listFees(), listRfps(), listComparisons()]);
  const existing = fees.find((f) => f.workspaceProjectId === project.id);
  if (existing) return void (location.hash = `#fee/${encodeURIComponent(existing.id)}`);
  const rfp = rfps.find((r) => r.id === project.rfpId) ?? rfps.find((r) => r.projectId === project.id);
  const budget = rfp ? readAmount(rfp.rfp.facts.construction_budget?.value ?? "") : null;
  const area = rfp ? readArea(rfp.rfp.facts.building_size?.value ?? "") : null;

  // Make fee can run from a project page before the Fee tab has loaded the fee curve.
  const world = await getWorldView().catch(() => null);
  curve = world?.feeCurve ?? curve;
  const suggested = templateFor(budget);
  const options = [...(rfp ? [AI_DRAFT] : []), ...TEMPLATES.map((t) => t.name)];
  const picked = await formModal({
    title: "New fee",
    fields: [{ label: "Start from", value: suggested.name, options, single: true, required: true }],
    confirm: "Make fee",
  });
  if (!picked) return;
  const template = TEMPLATES.find((t) => t.name === picked[0]) ?? suggested;

  // Firms already proposing on the project, by discipline.
  const firms = new Map<string, string>();
  for (const c of cmps.filter((c) => c.projectId === project.id))
    for (const p of c.proposals) for (const d of p.disciplines ?? []) if (p.firm && !firms.has(d)) firms.set(d, firmName(p.firm));
  // Consultant rows for the disciplines the project needs, apart from the firm's own work.
  const IN_HOUSE: string[] = ["Architecture", "Interiors", "FF&E"];
  const disciplines = projectDisciplines(rfp?.rfp, project.disciplinesRemoved, project.disciplinesAdded).filter((d) => !IN_HOUSE.includes(d));

  const record: SavedFee = {
    // A project's fee has the project's own id in it, so two people making it at once can't make two (createFee).
    id: `fee-${project.id}`,
    savedAt: Date.now(),
    createdAt: Date.now(),
    title: projectLabel(project),
    workspaceProjectId: project.id,
    template: template.key,
    // The review's own budget when it has one (worked out from a rounded cost per SF, it would come out slightly off).
    budget: { by: area && budget == null ? "area" : "amount", amount: budget, area, costPerSf: area && budget ? Math.round((budget / area) * 100) / 100 : null },
    // From the World view's fee curve when there's a budget, else the template's typical percent.
    targetPercent: curveTarget(budget) ?? template.targetPercent,
    targetFromCurve: curveTarget(budget) != null,
    roles: DEFAULT_ROLES.map((r) => ({ ...r })),
    phases: templatePhases(template, world?.phaseShares),
    consultants: disciplines.map((d) => ({ id: crypto.randomUUID(), discipline: d, firm: firms.get(d) ?? "", byPhase: {} })),
    markupPercent: 10,
    expenses: null,
  };
  if (picked[0] === AI_DRAFT && rfp) {
    const context = await contextForRfp(rfp);
    const drafted = await withWaiting("Drafting the fee from the RFP review…", () =>
      postJson<{ draft: FeeDraft; usage: Usage }>("/api/fee-draft", { rfp: rfp.rfp, roles: record.roles, worldView: context.worldView, pursuits: context.pursuits }),
    ).catch((err: Error) => noticeModal("Couldn't draft the fee", err.message).then(() => null));
    if (!drafted) return;
    record.lens = context.lens;
    applyDraft(record, drafted.draft, drafted.usage);
  }
  try {
    let saved = await createFee(record);
    if (saved.conflict && saved.record?.workspaceProjectId !== project.id) {
      // That id is a fee that's no longer this project's: this one gets an id of its own.
      record.id = crypto.randomUUID();
      saved = await createFee(record);
    }
    if (saved.conflict) await noticeModal("This project already has a fee", "Someone else made one just now. It opens instead of making another.");
    else unforgetFee(record.id); // a fee deleted here earlier may have had the same id
  } catch (err) {
    return noticeModal("Not saved", (err as Error).message);
  }
  location.hash = `#fee/${encodeURIComponent(record.id)}`;
}

const AI_DRAFT = "Draft from the RFP review (AI)";

/** Shows a "please wait" dialog while `work` runs. */
export async function withWaiting<T>(message: string, work: () => Promise<T>): Promise<T> {
  const dialog = document.createElement("dialog");
  dialog.className = "modal";
  dialog.innerHTML = `<h2>${esc(message)}</h2><p>This usually takes under a minute.</p>`;
  dialog.addEventListener("cancel", (e) => e.preventDefault()); // stays up until the draft is back
  document.body.appendChild(dialog);
  dialog.showModal();
  try {
    return await work();
  } finally {
    dialog.close();
    dialog.remove();
  }
}

/**
 * Fills a new fee from an AI draft: budget, target, and the firm's own phases and tasks (known roles only).
 * Consultant rows stay as they were, without fees, to be filled in from their proposals.
 */
function applyDraft(f: SavedFee, d: FeeDraft, usage: Usage) {
  const roleIds = new Set(f.roles.map((r) => r.id));
  const whole = (n: number) => Math.max(0, Math.round(n));
  f.template = "ai";
  f.budget = {
    by: d.budget.by,
    amount: d.budget.amount != null ? whole(d.budget.amount) : null,
    area: d.budget.area != null ? whole(d.budget.area) : null,
    costPerSf: d.budget.cost_per_sf != null ? whole(d.budget.cost_per_sf) : null,
  };
  f.targetPercent = Math.round(d.target_percent * 10) / 10;
  f.targetFromCurve = false;
  f.phases = d.phases.map((p) => ({
    id: crypto.randomUUID(),
    name: p.name,
    targetShare: Math.round(p.target_share),
    tasks: p.tasks.map((t) => ({
      id: crypto.randomUUID(),
      name: t.name,
      hours: Object.fromEntries(t.hours.filter((h) => roleIds.has(h.role_id) && h.hours > 0).map((h) => [h.role_id, whole(h.hours)])),
    })),
  }));
  f.expenses = d.expenses != null ? whole(d.expenses) : null;
  f.draft = { basis: d.budget.basis, assumptions: d.assumptions, costUsd: usage.cost_usd ?? null, at: Date.now() };
}


/**
 * Keeps a fee's phases in line with the World view's standard split: "Pre-design" is called Programming, and a phase
 * with the same name as one in the split takes its typical share from there. Returns whether anything changed.
 */
function matchPhaseSplit(f: SavedFee, split: { name: string; percent: number }[]): boolean {
  let changed = false;
  const key = (n: string) => n.trim().toLowerCase();
  for (const p of f.phases) {
    if (/^pre-?\s?design$/i.test(p.name.trim())) {
      p.name = "Programming";
      changed = true;
    }
    const s = split.find((x) => key(x.name) === key(p.name));
    if (s && s.percent !== p.targetShare) {
      p.targetShare = s.percent;
      changed = true;
    }
  }
  return changed;
}

/**
 * A fee with no rates entered at all (made before the rate sheet was the default) gets the standard roles and rates.
 * Roles with the same id keep their hours; names follow the rate sheet. Returns whether anything changed.
 */
function fillRates(f: SavedFee): boolean {
  if (f.roles.some((r) => r.rate != null)) return false;
  const custom = f.roles.filter((r) => !DEFAULT_ROLES.some((d) => d.id === r.id));
  f.roles = [...DEFAULT_ROLES.map((r) => ({ ...r })), ...custom];
  return true;
}

// ---------- Editor ----------

async function openFee(id: string, mine: number, split: { name: string; percent: number }[]) {
  const [fees, ps] = await Promise.all([loadFees(), listProjects()]);
  if (mine !== opening) return;
  projects = ps;
  const found = fees.find((f) => f.id === id);
  if (!found) {
    fee = null;
    $("fee-page").innerHTML = `<p class="none">This fee wasn't found. It may have been deleted. <a class="link" href="#project">Projects</a></p>`;
    return;
  }
  if (fee?.id !== id) {
    fee = found;
    summaryEdit = null;
    undoStack = [];
    // A fee with no hours yet opens every phase, ready to fill in; otherwise each phase is one line.
    openPhases.clear();
    if (!found.phases.some((p) => p.tasks.some((t) => Object.values(t.hours).some((h) => h > 0)))) found.phases.forEach((p) => openPhases.add(p.id));
    // Never a final fee: opening it mustn't change what was marked final.
    if (!isFinal(fee)) {
      const rates = fillRates(fee);
      if (matchPhaseSplit(fee, split) || rates) changed();
    }
    committed = JSON.stringify(fee); // undo goes back no further than the fee as opened
  }
  render();
  scrollTo(0, 0);
}

const input = (attrs: string, value: string, cls = "", placeholder = "") =>
  `<input type="text" class="fee-in ${cls}" ${attrs} value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" />`;

function render() {
  if (!fee) return;
  const f = fee;
  setAssistantPage(feeAssistant(f));
  const project = projects.find((p) => p.id === f.workspaceProjectId);
  const by = budgetBy(f);
  $("fee-page").innerHTML = `
    ${feeStatusHtml(f)}
    <div class="rfp-top">
      ${project ? `<a class="link" href="#project/${encodeURIComponent(project.id)}">← ${esc(projectLabel(project))}</a>` : `<a class="link" href="#project">← Projects</a>`}
      <span class="status error" id="fee-save-error"></span>
      <div class="actions">${assistantButton()}<button class="btn" data-undo title="Undo (Ctrl+Z)" ${undoStack.length ? "" : "disabled"}>Undo</button><button class="btn" data-export-excel>Export to Excel</button><button class="btn" data-delete-fee>Delete</button></div>
    </div>
    ${input('data-k="title" aria-label="Fee title"', f.title, "fee-title")}
    <p class="fee-project">${
      project
        ? `For project <a class="link" href="#project/${encodeURIComponent(project.id)}">${esc(projectLabel(project))}</a>`
        : "Its project was deleted."
    }</p>
    ${summaryHtml(f)}

    <div class="fee-top">
    <div class="block">
      <h2 class="label">Construction budget</h2>
      <table class="grid facts fee-budget">
        <tr><th scope="row">Set by</th><td><div class="fee-choice" role="radiogroup" aria-label="Set the budget by">
          <label><input type="radio" name="fee-budget-by" value="amount" data-budget-by ${by === "amount" ? "checked" : ""} /> Amount</label>
          <label><input type="radio" name="fee-budget-by" value="area" data-budget-by ${by === "area" ? "checked" : ""} /> Area × cost per SF</label>
        </div></td></tr>
        ${
          by === "amount"
            ? `<tr><th scope="row">Construction budget</th><td>${input('data-k="budget.amount" inputmode="decimal" aria-label="Construction budget"', numValue(f.budget.amount), "money", "$")}</td></tr>`
            : `<tr><th scope="row">Area (SF)</th><td>${input('data-k="budget.area" inputmode="decimal" aria-label="Area in square feet"', numValue(f.budget.area), "", "SF")}</td></tr>
        <tr><th scope="row">Cost per SF</th><td>${input('data-k="budget.costPerSf" inputmode="decimal" aria-label="Cost per square foot"', numValue(f.budget.costPerSf), "", "$/SF")}</td></tr>
        <tr><th scope="row">Construction budget</th><td data-out="budget"></td></tr>`
        }
        <tr><th scope="row">Fee curve at this budget</th><td><span data-out="curve-at"></span> <span class="note">from the <a class="link" href="#worldview">World view</a></span></td></tr>
        <tr><th scope="row">Target fee, % of construction</th><td><div class="fee-pair">${input('data-k="targetPercent" inputmode="decimal" aria-label="Target fee percent"', numValue(f.targetPercent), "", "%")} <span data-out="target"></span></div></td></tr>
        <tr><th scope="row">Reimbursable expenses</th><td>${input('data-k="expenses" inputmode="decimal" aria-label="Reimbursable expenses"', numValue(f.expenses), "money", "$")}</td></tr>
      </table>
    </div>

    <div class="block">
      <h2 class="label">Rates</h2>
      <div class="scroll"><table class="grid fee-table fee-rates">
        <thead><tr><th>Role</th><th>Short</th><th class="num">Rate ($/hr)</th><th class="num">Hours</th><th class="num">Cost</th><th></th></tr></thead>
        <tbody>${f.roles
          .map(
            (r) => `<tr>
              <td>${input(`data-role="${esc(r.id)}" data-f="name" aria-label="Role name"`, r.name)}</td>
              <td class="fee-short">${input(`data-role="${esc(r.id)}" data-f="short" aria-label="${esc(r.name)} short name" maxlength="5"`, r.short ?? "", "", shortRole(r))}</td>
              <td class="num">${input(`data-role="${esc(r.id)}" data-f="rate" inputmode="decimal" aria-label="${esc(r.name)} rate"`, numValue(r.rate), "num")}</td>
              <td class="num" data-out="role-hours:${esc(r.id)}"></td>
              <td class="num" data-out="role-cost:${esc(r.id)}"></td>
              <td><button class="link" data-remove-role="${esc(r.id)}" aria-label="Remove ${esc(r.name)}" title="Remove">×</button></td>
            </tr>`,
          )
          .join("")}</tbody>
      </table></div>
      <div class="actions"><button class="btn" data-add-role>Add role</button></div>
    </div>
    </div>

    <div class="block">
      <h2 class="label">Phases <button class="link edit-link" data-phases-all>${f.phases.every((p) => openPhases.has(p.id)) ? "Close all" : "Open all"}</button></h2>
      <div class="fee-phases">${f.phases.map(phaseHtml).join("")}</div>
      <div class="actions"><button class="btn" data-add-phase>Add phase</button></div>
    </div>

    <div class="block">
      <h2 class="label">Consultants</h2>
      <div class="scroll"><table class="grid fee-table fee-cons">
        <thead><tr><th>Discipline</th><th>Firm</th>${f.phases.map((p) => `<th class="num" data-phase-head="${esc(p.id)}" title="${esc(p.name)}">${esc(shortPhase(p.name))}</th>`).join("")}<th class="num">Fee</th><th></th></tr></thead>
        <tbody>${f.consultants
          .map(
            (c) => `<tr>
              <td>${input(`data-cons="${esc(c.id)}" data-f="discipline" aria-label="Discipline"`, c.discipline)}</td>
              <td>${input(`data-cons="${esc(c.id)}" data-f="firm" aria-label="Firm"`, c.firm, "", "Firm")}</td>
              ${f.phases.map((p) => `<td class="num">${input(`data-cons="${esc(c.id)}" data-f="p:${esc(p.id)}" inputmode="decimal" aria-label="${esc(c.discipline || "Consultant")} ${esc(p.name)} fee"`, numValue(c.byPhase?.[p.id] ?? null), "num", "$")}</td>`).join("")}
              <td class="num" data-out="cons-total:${esc(c.id)}"></td>
              <td><button class="link" data-remove-cons="${esc(c.id)}" aria-label="Remove consultant" title="Remove">×</button></td>
            </tr>`,
          )
          .join("")}</tbody>
        <tfoot>
          <tr><th scope="row" colspan="${f.phases.length + 2}"><div class="fee-pair">Management markup ${input('data-k="markupPercent" inputmode="decimal" aria-label="Management markup percent"', numValue(f.markupPercent), "pct")} %</div></th><td class="num" data-out="markup"></td><td></td></tr>
          <tr><th scope="row" colspan="${f.phases.length + 2}">Consultants with markup</th><td class="num" data-out="consultants-total"></td><td></td></tr>
        </tfoot>
      </table></div>
      <div class="actions"><button class="btn" data-add-cons>Add consultant</button></div>
    </div>

    <div class="block">
      <h2 class="label">Additional scope items</h2>
      <p class="fee-intro">Services that aren't in the fee: not asked for, or optional. They appear in the proposal table under its total, in the Total Fee column and under whoever provides them, with their own total; they never count toward the fee.</p>
      ${
        (f.belowLine ?? []).length
          ? `<div class="scroll"><table class="grid fee-table fee-below">
        <thead><tr><th>Service</th><th>By</th><th>Basis</th><th class="num">Amount</th><th>Note</th><th></th></tr></thead>
        <tbody>${(f.belowLine ?? [])
          .map(
            (b) => `<tr>
              <td>${input(`data-below="${esc(b.id)}" data-f="label" aria-label="Service"`, b.label, "", "e.g. LEED documentation")}</td>
              <td><select class="fee-in fee-basis" data-below="${esc(b.id)}" data-f="by" aria-label="Provided by">${byOptions(f, b.by)}</select></td>
              <td><select class="fee-in fee-basis" data-below="${esc(b.id)}" data-f="basis" aria-label="Basis">${(Object.keys(BELOW_LINE_BASIS) as BelowLineBasis[])
                .map((k) => `<option value="${k}" ${k === b.basis ? "selected" : ""}>${BELOW_LINE_BASIS[k]}</option>`)
                .join("")}</select></td>
              <td class="num">${input(`data-below="${esc(b.id)}" data-f="amount" inputmode="decimal" aria-label="Amount"`, numValue(b.amount), "num", b.basis === "request" ? "" : "$")}</td>
              <td>${input(`data-below="${esc(b.id)}" data-f="note" aria-label="Note"`, b.note, "", "Optional")}</td>
              <td><button class="link" data-remove-below="${esc(b.id)}" aria-label="Remove item" title="Remove">×</button></td>
            </tr>`,
          )
          .join("")}</tbody>
      </table></div>`
          : `<p class="none">None yet.</p>`
      }
      <div class="actions"><button class="btn" data-add-below>Add item</button></div>
    </div>

    <details class="block more fee-summary-block" ${summaryOpen ? "open" : ""}>
      <summary class="label">Summary</summary>
      <div id="fee-summary"></div>
    </details>

    <div class="block">
      <h2 class="label">Hours over time</h2>
      <div class="fee-pair fee-duration">Project duration ${input('data-k="durationMonths" inputmode="decimal" aria-label="Project duration in months"', numValue(f.durationMonths), "", "months")} months</div>
      <div id="fee-time"></div>
    </div>

    <div class="block">
      <h2 class="label">Proposal table</h2>
      <div class="scroll"><div id="fee-proposal"></div></div>
      <p class="org-muted" id="fee-rounding-note"></p>
      <div class="actions"><button class="btn" data-copy-table>Copy table</button><button class="btn" data-save-png title="A 300 dpi image of the table, for InDesign and other layout apps">Save as PNG</button><span class="status" id="fee-copy-status"></span></div>
    </div>`;
  refresh();
  fitSummaryLines($("fee-page"));
}


/**
 * The fee's summary at the top: the AI draft's budget basis and assumptions, or the team's own list. Every line can be
 * edited, removed or added; the AI assistant revises it when it changes the fee.
 */
function summaryHtml(f: SavedFee): string {
  const d = f.draft;
  const fromRfp = !!d && d.source !== "notes";
  const editing = !!summaryEdit;
  // Read as plain text; Edit (with Save / Cancel, Escape to cancel) makes the lines editable, so nothing changes by accident.
  const line = (key: string, value: string) =>
    editing
      ? `<li class="fee-sum-line"><textarea class="fee-in fee-sum-in" data-sum="${key}" rows="1" aria-label="Summary line" placeholder="Add a line">${esc(value)}</textarea><button class="link" data-del-sum="${key}" aria-label="Remove line" title="Remove">×</button></li>`
      : `<li>${esc(value)}</li>`;
  const shown = summaryEdit ?? d;
  const lines = shown ? [...(shown.basis ? [line("basis", shown.basis)] : []), ...shown.assumptions.map((a, i) => (editing || a.trim() ? line(`a:${i}`, a) : ""))].filter(Boolean) : [];
  const notes = [
    fromRfp && f.lens
      ? `Drafted with the <a class="link" href="#worldview">world view</a>${f.lens.savedAt ? ` of ${esc(dateText(f.lens.savedAt))}` : ""}${f.lens.text ? "" : " (none written yet)"}`
      : "",
    d?.revisedAt ? `Revised by the AI assistant ${esc(dateText(d.revisedAt))}` : "",
  ].filter(Boolean);
  return `<div class="block fee-draft">
      <h2 class="label">${fromRfp ? "Architecture and interiors drafted by AI from the RFP review. Check every number." : "Assumptions"}${editing ? "" : ` <button class="link edit-link" data-edit-sum>Edit</button>`}</h2>
      ${lines.length ? `<ul class="fee-sum${editing ? " editing" : ""}">${lines.join("")}</ul>` : editing ? "" : `<p class="none">None yet.</p>`}
      ${editing ? `<button class="link" data-add-sum>+ Add line</button><div class="actions"><button class="btn primary" data-save-sum>Save</button><button class="btn" data-cancel-sum>Cancel</button></div>` : ""}
      ${notes.length ? `<p class="note">${notes.join(" · ")}</p>` : ""}
    </div>`;
}

/** One line per phase (name, typical share, hours, cost); its task table opens below it. */
function phaseHtml(p: SavedFee["phases"][number]): string {
  const f = fee!;
  const open = openPhases.has(p.id);
  return `<div class="fee-phase${open ? " open" : ""}">
    <div class="fee-phase-head">
      <button class="fee-toggle" data-toggle-phase="${esc(p.id)}" aria-expanded="${open}" aria-label="${open ? "Close" : "Open"} ${esc(p.name)}">${open ? "▾" : "▸"}</button>
      ${input(`data-phase="${esc(p.id)}" data-f="name" aria-label="Phase name"`, p.name, "fee-phase-name")}
      <span class="note">Typical <span data-out="typical:${esc(p.id)}"></span></span>
      <span class="fee-phase-sum"><span data-out="phase-hours:${esc(p.id)}"></span> hrs · <b data-out="phase-cost:${esc(p.id)}"></b></span>
      <span class="fee-move">
        <button class="link" data-move-phase="${esc(p.id)}" data-dir="-1" aria-label="Move ${esc(p.name)} up" title="Move up" ${f.phases[0] === p ? "disabled" : ""}>↑</button>
        <button class="link" data-move-phase="${esc(p.id)}" data-dir="1" aria-label="Move ${esc(p.name)} down" title="Move down" ${f.phases[f.phases.length - 1] === p ? "disabled" : ""}>↓</button>
      </span>
      <button class="link" data-remove-phase="${esc(p.id)}">Remove</button>
    </div>
    ${
      open
        ? `<div class="scroll"><table class="grid fee-table fee-tasks">
      <thead><tr><th>Task</th>${f.roles.map((r) => `<th class="num" data-role-head="${esc(r.id)}" title="${esc(r.name)}">${esc(shortRole(r))}</th>`).join("")}<th class="num">Hrs</th><th class="num">Cost</th><th></th></tr></thead>
      <tbody>${p.tasks
        .map(
          (t) => `<tr>
            <td>${input(`data-task="${esc(p.id)}:${esc(t.id)}" data-f="name" aria-label="Task"`, t.name)}</td>
            ${f.roles.map((r) => `<td class="num">${input(`data-task="${esc(p.id)}:${esc(t.id)}" data-f="h:${esc(r.id)}" inputmode="decimal" aria-label="${esc(r.name)} hours"`, numValue(t.hours[r.id] ?? null), "num")}</td>`).join("")}
            <td class="num" data-out="task-hours:${esc(t.id)}"></td>
            <td class="num" data-out="task-cost:${esc(t.id)}"></td>
            <td><button class="link" data-remove-task="${esc(p.id)}:${esc(t.id)}" aria-label="Remove task" title="Remove">×</button></td>
          </tr>`,
        )
        .join("")}</tbody>
    </table></div>
    <button class="link fee-add-task" data-add-task="${esc(p.id)}">+ Add task</button>`
        : ""
    }
  </div>`;
}

/** Updates every figure on the page from the fee, without touching the inputs (so typing keeps focus). */
function refresh() {
  if (!fee) return;
  const f = fee;
  const t = totals(f);
  const out = (key: string, text: string) => {
    document.querySelectorAll(`#fee-page [data-out="${CSS.escape(key)}"]`).forEach((el) => (el.textContent = text));
  };
  out("budget", money(budgetOf(f)));
  out("target", t.target != null ? `= ${money(t.target)}` : "");
  const atCurve = curveTarget(budgetOf(f));
  out("curve-at", atCurve != null && t.budget ? `${pct(atCurve)} = ${money((t.budget * atCurve) / 100)}` : "Set a budget");
  for (const r of f.roles) {
    out(`role-hours:${r.id}`, hrs(t.roleHours[r.id] ?? 0));
    out(`role-cost:${r.id}`, money((t.roleHours[r.id] ?? 0) * (r.rate ?? 0)));
  }
  for (const p of t.phases) {
    out(`typical:${p.phase.id}`, pct(p.typical));
    out(`phase-hours:${p.phase.id}`, hrs(p.hours));
    out(`phase-cost:${p.phase.id}`, money(p.cost));
    for (const task of p.phase.tasks) {
      out(`task-hours:${task.id}`, hrs(taskHours(task)));
      out(`task-cost:${task.id}`, money(taskCost(task, f.roles)));
    }
  }
  for (const c of f.consultants) out(`cons-total:${c.id}`, money(consultantTotal(c, f.phases)));
  out("markup", money(t.markup));
  out("consultants-total", money(t.consultants + t.markup));

  // A phase whose share of labor is more than 5 points off its typical share is marked.
  const off = (share: number | null, target: number) => share != null && Math.abs(share - target) > 5;
  const diff = t.target != null ? t.total - t.target : null;
  const sign = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "");
  const table = proposalTable(f);
  $("fee-proposal").innerHTML = proposalHtml(table);
  // When rounding moves the table's total off the worksheet's, say by how much, so the two never silently disagree.
  const shown = proposalRounded(table).total;
  const gap = Math.round(shown - table.total);
  const to = FEE_ROUNDINGS.find((r) => r.value === feeStyle.rounding)!;
  $("fee-rounding-note").textContent =
    feeStyle.rounding > 1 && gap
      ? `Amounts rounded to the ${to.value === 1000 ? "nearest $1,000" : to.value === 100 ? "nearest $100" : "nearest $10"} (Organization settings). The table's total is ${feeMoney(Math.abs(gap))} ${gap > 0 ? "more" : "less"} than the worksheet's.`
      : "";
  $("fee-time").innerHTML = feeTimeHtml(f);
  $("fee-summary").innerHTML = `
    <div class="scroll"><table class="grid fee-table fee-summary">
      <thead><tr><th>Phase</th><th class="num">Hours</th><th class="num">Labor</th><th class="num">Share</th><th class="num">Typical</th></tr></thead>
      <tbody>
        ${t.phases
          .map(
            (p) => `<tr${p.typical != null && off(p.share, p.typical) ? ' class="off"' : ""}><th scope="row">${esc(p.phase.name)}</th><td class="num">${hrs(p.hours)}</td><td class="num">${money(p.cost)}</td><td class="num">${pct(p.share)}</td><td class="num">${pct(p.typical)}</td></tr>`,
          )
          .join("")}
        <tr class="subtotal"><th scope="row">Labor</th><td class="num">${hrs(t.laborHours)}</td><td class="num">${money(t.labor)}</td><td></td><td></td></tr>
        <tr><th scope="row">Consultants</th><td></td><td class="num">${money(t.consultants)}</td><td></td><td></td></tr>
        <tr><th scope="row">Management markup (${pct(f.markupPercent)})</th><td></td><td class="num">${money(t.markup)}</td><td></td><td></td></tr>
        <tr class="total"><th scope="row">Total fee</th><td></td><td class="num">${money(t.total)}</td><td></td><td></td></tr>
        <tr><th scope="row">Reimbursable expenses <span class="note">not included in the total</span></th><td></td><td class="num">${money(t.expenses)}</td><td></td><td></td></tr>
      </tbody>
    </table></div>
    <table class="grid facts fee-check">
      <tr><th scope="row">Construction budget</th><td>${money(t.budget)}</td></tr>
      <tr><th scope="row">Fee as % of construction</th><td>${pct(t.percentOfBudget)}</td></tr>
      <tr><th scope="row">Target</th><td>${f.targetPercent != null ? `${pct(f.targetPercent)} = ${money(t.target)}${f.targetFromCurve ? ` <span class="note">from the <a class="link" href="#worldview">fee curve</a></span>` : ""}` : "—"}</td></tr>
      <tr><th scope="row">Difference from target</th><td>${diff != null ? `${sign(diff)}${money(Math.abs(diff))}` : "—"}</td></tr>
    </table>`;
}

// ---------- Proposal table ----------
// Laid out like the fee tables in proposals: a colored header, a dark Total Fee column and a dark Total row, in the
// organization's colors and font (src/fee-style.ts; set on the Organization page). Styles are inline so the formatting
// survives being pasted into Word, Google Docs or InDesign.

/** The organization's fee table style, loaded when a fee opens. */
let feeStyle: FeeStyle = DEFAULT_FEE_STYLE;

/** The table as the organization rounds it (fee-style.ts): every amount rounded, totals adding the rounded amounts. */
export const proposalRounded = (t: ProposalTable, look: FeeStyle = feeStyle) => roundedTable(t, (n) => roundFee(n, look.rounding));

export function proposalHtml(table: ProposalTable, look: FeeStyle = feeStyle): string {
  const t = proposalRounded(table, look);
  const below = t.belowLine ?? [];
  if (!table.rows.some((r) => r.amounts.some((a) => a)) && !below.length && !t.expenses) return `<p class="none">Add hours, rates or consultant fees to fill in the table.</p>`;
  const PT = feeTableCss(look);
  const ptMoney = (n: number) => feeMoney(n, look.rounding);
  const belowLineValue = (b: { basis: BelowLineBasis; amount: number | null }) => belowLineText(b, look.rounding === 0.01 ? 0.01 : 1);
  const th = (style: string, html: string) => `<th style="${PT.border} ${style}">${html}</th>`;
  const td = (style: string, html: string, span = 1) => `<td style="${PT.border} ${style}"${span > 1 ? ` colspan="${span}"` : ""}>${html}</td>`;
  const head = t.columns
    .map((c) => th(PT.head, c.firm ? `${esc(c.firm)}<br />(${esc(c.discipline || "Consultant")})` : esc(c.discipline)))
    .join("");
  const cols = t.columns.length;
  // Additional scope items, in the same table: a section heading, a row per item (its amount in its provider's column,
  // once chosen, and the Total Fee column) and their own total. None of it is in the Total row above.
  const belowRows = below.length
    ? [
        `<tr>${td(PT.section, `Additional scope items <span style="font-weight: 400; text-transform: none; letter-spacing: 0;">(not included in the total fee)</span>`, cols + 2)}</tr>`,
        ...below.map(
          (b) =>
            `<tr>${td(PT.phase, `${esc(b.label)}${b.note ? `<span style="${PT.note}">${esc(b.note)}</span>` : ""}`)}${t.columns.map((_, col) => td(PT.cell, col === b.column ? esc(belowLineValue(b)) : "")).join("")}${td(PT.cellTotal, esc(belowLineValue(b)))}</tr>`,
        ),
        ...(t.belowLineTotal
          ? [`<tr>${td(PT.footLabel, "Total additional scope")}${(t.belowLineTotals ?? []).map((a) => td(PT.foot, a ? ptMoney(a) : "")).join("")}${td(PT.foot, ptMoney(t.belowLineTotal))}</tr>`]
          : []),
      ].join("")
    : "";
  return `<table class="fee-proposal" style="${PT.font} border-collapse: collapse;">
    <thead><tr>${th(PT.head + " text-align: left;", "Phase")}${head}${th(PT.headTotal, "Total Fee")}</tr></thead>
    <tbody>${t.rows
      .map((r) => `<tr>${td(PT.phase, esc(r.label))}${r.amounts.map((a) => td(PT.cell, ptMoney(a))).join("")}${td(PT.cellTotal, ptMoney(r.total))}</tr>`)
      .join("")}
    <tr>${td(PT.footLabel, "Total")}${t.totals.map((a) => td(PT.foot, ptMoney(a))).join("")}${td(PT.foot, ptMoney(t.total))}</tr>
    ${
      t.expenses
        ? `<tr>${td(PT.phase, `Reimbursable Expenses<span style="${PT.note}">Not included in the total fee</span>`)}${t.columns
            .map((_, col) => td(PT.cell, col === 0 ? ptMoney(t.expenses!) : ""))
            .join("")}${td(PT.cellTotal, ptMoney(t.expenses))}</tr>`
        : ""
    }
    ${belowRows}</tbody>
  </table>`;
}

/**
 * Who can provide an additional scope item: Architecture, or a consultant with a fee on this fee. "Not assigned"
 * until chosen (the amount then shows only in the Total Fee column). A consultant whose fee was cleared stays listed
 * while an item still points to them, marked so.
 */
function byOptions(f: SavedFee, by: string | undefined): string {
  const used = f.consultants.filter((c) => hasFee(c, f.phases));
  const name = (c: SavedFee["consultants"][number]) => [c.firm, c.discipline && `(${c.discipline})`].filter(Boolean).join(" ") || "Consultant";
  const stale = by && by !== "architecture" && !used.some((c) => c.id === by) ? f.consultants.find((c) => c.id === by) : undefined;
  const opts: [string, string][] = [
    ["", "Not assigned"],
    ["architecture", "Architecture"],
    ...used.map((c) => [c.id, name(c)] as [string, string]),
    ...(stale ? [[stale.id, `${name(stale)}, no fee yet`] as [string, string]] : []),
  ];
  return opts.map(([v, label]) => `<option value="${esc(v)}" ${v === (by ?? "") ? "selected" : ""}>${esc(label)}</option>`).join("");
}

/**
 * "$ 12,000", "$ 175/hr", "Not to exceed $ 8,000", "$ 5,000 allowance", "Upon request". Typed amounts, so shown in
 * whole dollars (or cents, when the organization shows cents), never rounded further.
 */
function belowLineText(b: { basis: BelowLineBasis; amount: number | null }, to: FeeRounding): string {
  if (b.basis === "request" || b.amount == null) return "Upon request";
  const amt = feeMoney(b.amount, to);
  if (b.basis === "hourly") return `${amt}/hr`;
  if (b.basis === "nte") return `Not to exceed ${amt}`;
  if (b.basis === "allowance") return `${amt} allowance`;
  return amt;
}

/** Plain-text version (tab-separated) for apps that don't take formatted text. */
function proposalText(source: ProposalTable): string {
  const t = proposalRounded(source);
  const head = ["Phase", ...t.columns.map((c) => (c.firm ? `${c.firm} (${c.discipline})` : c.discipline)), "Total Fee"];
  const ptMoney = (n: number) => feeMoney(n, feeStyle.rounding);
  const belowLineValue = (b: { basis: BelowLineBasis; amount: number | null }) => belowLineText(b, feeStyle.rounding === 0.01 ? 0.01 : 1);
  const rows = t.rows.map((r) => [r.label, ...r.amounts.map(ptMoney), ptMoney(r.total)]);
  const expenses = t.expenses ? [["Reimbursable Expenses (not included in the total fee)", ...t.columns.map((_, col) => (col === 0 ? ptMoney(t.expenses!) : "")), ptMoney(t.expenses)]] : [];
  const table = [head, ...rows, [feeStyle.capitals ? "TOTAL" : "Total", ...t.totals.map(ptMoney), ptMoney(t.total)], ...expenses].map((r) => r.join("\t")).join("\n");
  const items = t.belowLine ?? [];
  if (!items.length) return table;
  const below = items.map((b) =>
    [b.label + (b.note ? ` (${b.note})` : ""), ...t.columns.map((_, col) => (col === b.column ? belowLineValue(b) : "")), belowLineValue(b)].join("\t"),
  );
  const total = t.belowLineTotal ? [["Total additional scope", ...(t.belowLineTotals ?? []).map((a) => (a ? ptMoney(a) : "")), ptMoney(t.belowLineTotal)].join("\t")] : [];
  return [table, "Additional scope items (not included in the total fee)", ...below, ...total].join("\n");
}

/** Downloads the open fee as an Excel workbook (fee-excel.ts). */
async function exportExcel(button: HTMLButtonElement) {
  if (!fee) return;
  const project = projects.find((p) => p.id === fee!.workspaceProjectId);
  button.disabled = true;
  button.textContent = "Exporting…";
  try {
    const { exportFeeExcel } = await import("./fee-excel");
    await exportFeeExcel(fee, { project: project ? projectLabel(project) : "", style: feeStyle });
  } catch (err) {
    await noticeModal("Couldn't export the fee", (err as Error).message);
  } finally {
    button.disabled = false;
    button.textContent = "Export to Excel";
  }
}

/** Saves the Proposal table as a 300 dpi PNG (fee-png.ts), drawn from the table on the page. */
async function saveTablePng(button: HTMLButtonElement) {
  if (!fee) return;
  const table = document.querySelector<HTMLTableElement>("#fee-proposal table");
  const status = document.getElementById("fee-copy-status");
  if (!table) return noticeModal("Nothing to save yet", "Add hours, rates or consultant fees to fill in the table first.");
  const project = projects.find((p) => p.id === fee!.workspaceProjectId);
  button.disabled = true;
  try {
    const [{ tablePng, download }, { fileName }] = await Promise.all([import("./fee-png"), import("./fee-excel")]);
    download(await tablePng(table), fileName(fee, project ? projectLabel(project) : "", "png", " table"));
    if (status) status.textContent = "Saved. Place it in InDesign at 100%.";
  } catch (err) {
    await noticeModal("Couldn't save the image", (err as Error).message);
  } finally {
    button.disabled = false;
  }
}

async function copyProposalTable() {
  if (!fee) return;
  const t = proposalTable(fee);
  const status = document.getElementById("fee-copy-status");
  const html = proposalHtml(t);
  let copied = true;
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([proposalText(t)], { type: "text/plain" }),
      }),
    ]);
  } catch {
    // Clipboard API blocked: copy the table on the page as a selection instead.
    const el = document.getElementById("fee-proposal")!;
    const range = document.createRange();
    range.selectNode(el);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    copied = document.execCommand("copy");
    getSelection()?.removeAllRanges();
  }
  if (status) {
    status.textContent = copied ? "Copied" : "Couldn't copy. Select the table and copy it.";
    setTimeout(() => (status.textContent = ""), copied ? 1500 : 6000);
  }
}

function showSaveError(message: string) {
  const el = document.getElementById("fee-save-error");
  if (!el || (!message && !el.textContent?.startsWith("Not saved"))) return; // a notice there stays
  el.classList.add("error");
  el.textContent = message ? `Not saved: ${message}` : "";
}

function changed() {
  if (fee) queueFee(fee);
}

/** A save that failed (or, with "", one that worked). Said on the fee's page; in a dialog, once, when it isn't showing. */
let problemShown = false;
function saveProblem(message: string, f: SavedFee) {
  if (fee?.id === f.id) return showSaveError(message);
  if (!message) return void (problemShown = false);
  if (problemShown) return;
  problemShown = true;
  void noticeModal("A fee wasn't saved", `“${f.title || "Untitled fee"}”: ${message} It's tried again every few seconds; keep this tab open until then, or open the fee to check it.`);
}

/** Says something briefly beside the fee's buttons, unless a problem is showing there. */
function say(text: string) {
  const el = document.getElementById("fee-save-error");
  if (!el || el.textContent?.startsWith("Not saved")) return;
  el.classList.remove("error");
  el.textContent = text;
  setTimeout(() => {
    if (el.textContent === text) el.textContent = "";
    el.classList.add("error");
  }, 6000);
}

/** Leaves the summary as it was before Edit. */
function cancelSummaryEdit() {
  if (!fee || !summaryEdit) return;
  summaryEdit = null;
  rerender(false);
}

/** Summary lines wrap like text: each grows to fit (browsers without field-sizing: content). */
function fitSummaryLines(root: ParentNode = document) {
  root.querySelectorAll<HTMLTextAreaElement>("textarea.fee-sum-in").forEach((t) => {
    t.style.height = "auto";
    t.style.height = `${t.scrollHeight}px`;
  });
}

function onInput(e: Event) {
  const el = e.target as HTMLInputElement;
  if (el.matches("textarea.fee-sum-in")) fitSummaryLines(el.parentElement!);
  if (!fee || !el.matches(".fee-in, [data-budget-by]")) return;
  if (el.matches("[data-budget-by]")) {
    fee.budget.by = el.value === "area" ? "area" : "amount";
    if (fee.targetFromCurve) followCurve(fee);
    return rerender();
  }
  if (el.inputMode === "decimal") {
    const k = el.dataset.k ?? "";
    addCommas(el, {
      units: k.startsWith("budget.") || k === "expenses" || !!el.dataset.cons || !!el.dataset.below,
      negative: !!el.dataset.cons || !!el.dataset.below, // a consultant's or scope item's credit
    });
  }
  const f = fee;
  const v = el.value;
  const field = el.dataset.f ?? "";
  if (el.dataset.k) {
    const k = el.dataset.k;
    if (k === "title") f.title = v;
    else if (k === "budget.amount") f.budget.amount = parseNum(v);
    else if (k === "budget.area") f.budget.area = parseNum(v);
    else if (k === "budget.costPerSf") f.budget.costPerSf = parseNum(v);
    else if (k === "targetPercent") {
      f.targetPercent = parseNum(v);
      f.targetFromCurve = false; // typed by hand: it stays put from now on
    }
    else if (k === "markupPercent") f.markupPercent = parseNum(v) ?? 0;
    else if (k === "expenses") f.expenses = parseNum(v);
    else if (k === "durationMonths") {
      const n = parseNum(v);
      f.durationMonths = n != null && n > 0 ? Math.min(n, 240) : null;
    }
    // A target from the fee curve follows the budget.
    if (k.startsWith("budget.") && f.targetFromCurve) followCurve(f);
  } else if (el.dataset.sum) {
    const key = el.dataset.sum;
    if (!summaryEdit) return;
    if (key === "basis") summaryEdit.basis = v;
    else if (key.startsWith("a:")) summaryEdit.assumptions[Number(key.slice(2))] = v;
    return; // kept when Save is clicked
  } else if (el.dataset.role) {
    const r = f.roles.find((x) => x.id === el.dataset.role);
    if (!r) return;
    if (field === "name") r.name = v;
    else if (field === "short") r.short = v.trim() || undefined;
    else r.rate = parseNum(v);
    // Roles head the phase tables' columns by short name, with the full name on hover.
    document.querySelectorAll<HTMLElement>(`#fee-page [data-role-head="${CSS.escape(r.id)}"]`).forEach((th) => {
      th.textContent = shortRole(r);
      th.title = r.name;
    });
  } else if (el.dataset.phase) {
    const p = f.phases.find((x) => x.id === el.dataset.phase);
    if (!p) return;
    if (field === "name") {
      p.name = v;
      // Phases head the consultants' columns by short name, with the full name on hover.
      document.querySelectorAll<HTMLElement>(`#fee-page [data-phase-head="${CSS.escape(p.id)}"]`).forEach((th) => {
        th.textContent = shortPhase(v);
        th.title = v;
      });
    }
  } else if (el.dataset.task) {
    const [pid, tid] = el.dataset.task.split(":");
    const t = f.phases.find((x) => x.id === pid)?.tasks.find((x) => x.id === tid);
    if (!t) return;
    if (field === "name") t.name = v;
    else if (field.startsWith("h:")) {
      const n = parseNum(v);
      if (n == null) delete t.hours[field.slice(2)];
      else t.hours[field.slice(2)] = n;
    }
  } else if (el.dataset.below) {
    const b = f.belowLine?.find((x) => x.id === el.dataset.below);
    if (!b) return;
    if (field === "label") b.label = v;
    else if (field === "note") b.note = v;
    else if (field === "amount") b.amount = parseNum(v);
    else if (field === "basis" && v in BELOW_LINE_BASIS) b.basis = v as BelowLineBasis;
    else if (field === "by") b.by = v === "architecture" || f.consultants.some((c) => c.id === v) ? v : undefined;
  } else if (el.dataset.cons) {
    const c = f.consultants.find((x) => x.id === el.dataset.cons);
    if (!c) return;
    if (field === "discipline") c.discipline = v;
    else if (field === "firm") c.firm = v;
    else if (field.startsWith("p:")) {
      const n = parseNum(v);
      c.byPhase ??= {};
      if (n == null) delete c.byPhase[field.slice(2)];
      else c.byPhase[field.slice(2)] = n;
    }
  }
  // Saved as typed, but the figures only recalculate once the entry is finished (see the "change" listener), so
  // retyping 20 as 22 doesn't flash every total through 2 on the way.
  changed();
}

/** The box being typed in, to go back to after the page is drawn again (same box, same place in it). */
function focusedBox(): (() => void) | null {
  const el = document.activeElement as HTMLInputElement | null;
  if (!el?.matches?.("#fee-page .fee-in")) return null;
  const attrs = ["k", "role", "phase", "task", "cons", "below", "sum", "f"].filter((a) => el.dataset[a] != null);
  const selector = `#fee-page .fee-in${attrs.map((a) => `[data-${a}="${CSS.escape(el.dataset[a]!)}"]`).join("")}`;
  const { selectionStart: from, selectionEnd: to, value } = el;
  return () => {
    const box = document.querySelector<HTMLInputElement>(selector);
    if (!box || !attrs.length) return;
    box.focus({ preventScroll: true });
    if (box.value === value && from != null) box.setSelectionRange(from, to);
  };
}

/** Re-renders after a structural change (rows added or removed), keeping the scroll position. */
function rerender(save = true) {
  const y = scrollY;
  const at = focusedBox();
  render();
  scrollTo(0, y);
  at?.();
  if (save) {
    changed();
    checkpoint();
  }
  updateUndo();
}

async function onClick(e: Event) {
  const t = e.target as HTMLElement;
  const attr = (name: string) => t.closest(`[${name}]`)?.getAttribute(name) ?? null;
  if (t.closest("[data-copy-table]")) return copyProposalTable();
  if (t.closest("[data-save-png]")) return saveTablePng(t.closest<HTMLButtonElement>("[data-save-png]")!);
  if (t.closest("[data-export-excel]")) return exportExcel(t.closest<HTMLButtonElement>("[data-export-excel]")!);
  if (t.closest("[data-undo]")) return undo();
  if (!fee) return;
  if (t.closest("[data-fee-final]") || t.closest("[data-fee-draft]")) {
    const next = await setFeeStatus(fee, t.closest("[data-fee-final]") ? "final" : "draft");
    if (!next || !fee || next.id !== fee.id) return;
    fee = next;
    committed = JSON.stringify(fee); // a status change isn't an edit (and isn't undone by Undo)
    queueFee(fee, 0);
    return render();
  }
  const f = fee;
  let id: string | null;
  if (t.closest("[data-delete-fee]")) {
    if (!(await confirmDelete("fee"))) return;
    forgetFee(f.id);
    try {
      await deleteFee(f.id);
    } catch (err) {
      unforgetFee(f.id);
      if (fee) queueFee(fee); // still there: anything unsaved still counts
      return noticeModal("Couldn't delete", (err as Error).message);
    }
    fee = null;
    // Back to the fee's project (fees live inside projects).
    location.hash = f.workspaceProjectId ? `#project/${encodeURIComponent(f.workspaceProjectId)}` : "#project";
  } else if ((id = attr("data-toggle-phase"))) {
    if (openPhases.has(id)) openPhases.delete(id);
    else openPhases.add(id);
    rerender(false);
  } else if (t.closest("[data-phases-all]")) {
    const allOpen = f.phases.every((p) => openPhases.has(p.id));
    openPhases.clear();
    if (!allOpen) f.phases.forEach((p) => openPhases.add(p.id));
    rerender(false);
  } else if (t.closest("[data-edit-sum]")) {
    summaryEdit = { basis: f.draft?.basis ?? "", assumptions: [...(f.draft?.assumptions ?? [])] };
    if (!summaryEdit.basis && !summaryEdit.assumptions.some((a) => a.trim())) summaryEdit.assumptions = [""]; // an empty summary starts with a line to type in
    rerender(false);
    document.querySelector<HTMLTextAreaElement>("#fee-page [data-sum]")?.focus();
  } else if (t.closest("[data-add-sum]")) {
    summaryEdit?.assumptions.push("");
    rerender(false);
    const boxes = document.querySelectorAll<HTMLTextAreaElement>("#fee-page [data-sum]");
    boxes[boxes.length - 1]?.focus();
  } else if ((id = attr("data-del-sum")) && summaryEdit) {
    if (id === "basis") summaryEdit.basis = "";
    else summaryEdit.assumptions.splice(Number(id.slice(2)), 1);
    rerender(false);
  } else if (t.closest("[data-save-sum]")) {
    const basis = summaryEdit?.basis.trim() ?? "";
    const assumptions = (summaryEdit?.assumptions ?? []).map((a) => a.trim()).filter(Boolean);
    const was = f.draft;
    const unchanged = basis === (was?.basis ?? "") && JSON.stringify(assumptions) === JSON.stringify((was?.assumptions ?? []).filter((a) => a.trim()));
    if (summaryEdit && !unchanged) f.draft = { ...(was ?? { costUsd: null, at: Date.now(), source: "notes" as const }), basis, assumptions };
    summaryEdit = null;
    rerender(!unchanged); // saved, and one Undo step
  } else if (t.closest("[data-cancel-sum]")) {
    cancelSummaryEdit();
  } else if (t.closest("[data-add-role]")) {
    f.roles.push({ id: crypto.randomUUID(), name: "New role", rate: null });
    rerender();
  } else if ((id = attr("data-remove-role"))) {
    const roleId = id;
    const role = f.roles.find((r) => r.id === roleId);
    const hours = totals(f).roleHours[roleId] ?? 0;
    if (!role) return;
    if (hours) {
      const ok = await confirmModal({
        title: `Remove ${role.name.trim() || "this role"}?`,
        body: `It has ${hrs(hours)} hours on this fee, which are removed with it. Undo brings them back.`,
        confirm: "Remove",
        danger: true,
      });
      if (!ok || fee?.id !== f.id) return;
    }
    // The fee as it is now (it may have been combined with someone else's while the question was up).
    fee.roles = fee.roles.filter((r) => r.id !== roleId);
    for (const p of fee.phases) for (const task of p.tasks) delete task.hours[roleId];
    rerender();
  } else if (t.closest("[data-add-phase]")) {
    const phase = { id: crypto.randomUUID(), name: "New phase", targetShare: 0, tasks: [] };
    f.phases.push(phase);
    openPhases.add(phase.id);
    rerender();
  } else if ((id = attr("data-move-phase"))) {
    // One place up or down; the summary, consultants, proposal table and hours chart follow the new order.
    const i = f.phases.findIndex((p) => p.id === id);
    const j = i + Number(t.closest("[data-move-phase]")!.getAttribute("data-dir"));
    if (i < 0 || j < 0 || j >= f.phases.length) return;
    [f.phases[i], f.phases[j]] = [f.phases[j], f.phases[i]];
    rerender();
    document.querySelector<HTMLButtonElement>(`#fee-page [data-move-phase="${CSS.escape(id)}"][data-dir="${j < i ? -1 : 1}"]:not(:disabled)`)?.focus();
  } else if ((id = attr("data-remove-phase"))) {
    f.phases = f.phases.filter((p) => p.id !== id);
    rerender();
  } else if ((id = attr("data-add-task"))) {
    f.phases.find((p) => p.id === id)?.tasks.push({ id: crypto.randomUUID(), name: "", hours: {} });
    openPhases.add(id);
    rerender();
    const inputs = document.querySelectorAll<HTMLInputElement>(`[data-task^="${CSS.escape(id)}:"][data-f="name"]`);
    inputs[inputs.length - 1]?.focus();
  } else if ((id = attr("data-remove-task"))) {
    const [pid, tid] = id.split(":");
    const p = f.phases.find((x) => x.id === pid);
    if (p) p.tasks = p.tasks.filter((x) => x.id !== tid);
    rerender();
  } else if (t.closest("[data-add-cons]")) {
    f.consultants.push({ id: crypto.randomUUID(), discipline: "", firm: "", byPhase: {} });
    rerender();
  } else if ((id = attr("data-remove-cons"))) {
    f.consultants = f.consultants.filter((c) => c.id !== id);
    for (const b of f.belowLine ?? []) if (b.by === id) b.by = undefined; // an item they were to provide isn't assigned
    rerender();
  } else if (t.closest("[data-add-below]")) {
    (f.belowLine ??= []).push({ id: crypto.randomUUID(), label: "", basis: "lump", amount: null, note: "" });
    rerender();
    document.querySelector<HTMLInputElement>("#fee-page .fee-below tbody tr:last-child input")?.focus();
  } else if ((id = attr("data-remove-below"))) {
    f.belowLine = (f.belowLine ?? []).filter((b) => b.id !== id);
    rerender();
  }
}
