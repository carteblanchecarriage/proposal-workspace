// A project's consultant proposals and its proposal check (QA/QC), on the project page.
//  - Proposals: each consultant's PDF is read on its own when it arrives; any two or more are compared later.
//  - Proposal check: the firm's own finished proposal, read once for simple mistakes and fit to the RFP review.

import { toDisciplines } from "../lib/disciplines";
import type { Comparison, Proposal, QaResult } from "../lib/claude";
import { type Usage } from "../lib/cost";
import { blockedInDemo, post } from "./api";
import { confirmModal, noticeModal } from "./modal";
import { uploadPdfVia } from "./rfp";
import {
  getReading,
  hashFile,
  projectLabel,
  saveComparison,
  saveReading,
  type ReceivedProposal,
  type SavedComparison,
  type SavedProject,
  type SavedRfp,
} from "./store";
import { AI_MARK, esc, firmName, statedTotal, type Sourced } from "./table";

export type ProposalsContext = {
  project: SavedProject;
  rfp: SavedRfp | undefined;
  comparisons: SavedComparison[];
  /** saves the project record */
  save: () => Promise<void>;
  /** redraws the project page */
  rerender: () => void;
};

// Vercel's request limit for a PDF sent straight to the reader (local development has none).
const MAX_BYTES = import.meta.env.PROD ? 4.4 * 1024 * 1024 : Infinity;
const isPdf = (f: File) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);

/** Proposals ticked for the next comparison (by id), on the project open now. */
let selected = new Set<string>();
let selectedFor = "";
/** What's being read right now, shown under the list. */
let readingStatus = "";
let checking = false;

const dayText = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
/** "Nov 17" this year, "Nov 17, 2025" otherwise. */
const shortDay = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(new Date(ms).getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }) });

/** A firm's disciplines in brief: Mechanical, Electrical and Plumbing together read as "MEP". */
function disciplinesBrief(raw: string[]): string {
  const ds: string[] = toDisciplines(raw);
  if (!ds.length) return raw.slice(0, 2).join(", ");
  const mep = ["Mechanical", "Electrical", "Plumbing"];
  if (mep.every((d) => ds.includes(d))) return ["MEP", ...ds.filter((d) => !mep.includes(d))].join(" + ");
  return ds.join(", ");
}

/** The Compare button and hint, for the number of proposals ticked. */
const compareLabel = (n: number) => (n === 1 ? "Analyze 1" : n ? `Compare ${n}` : "Compare");
const pickHint = (n: number) => (n ? "" : "Tick two or more proposals to compare them.");
const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/**
 * Proposals already inside the project's comparisons join its list (once), so they can be compared with ones that
 * arrive later. Returns true when the project changed and should be saved.
 */
export function adoptFromComparisons(p: SavedProject, comparisons: SavedComparison[]): boolean {
  const list = (p.proposals ??= []);
  const has = (s: Sourced) =>
    list.some((x) => (s.source_hash && x.hash === s.source_hash) || (firmName(x.proposal.firm) === firmName(s.firm) && x.fileName === (s.source_file ?? "")));
  let changed = false;
  for (const c of [...comparisons].sort((a, b) => a.savedAt - b.savedAt))
    for (const s of c.proposals) {
      if (has(s)) continue;
      const { source_file, file_id, pdf_tokens, source_hash, ...proposal } = s;
      list.push({ id: crypto.randomUUID(), fileName: source_file ?? "", receivedAt: c.savedAt, hash: source_hash ?? null, file_id, pdf_tokens, proposal });
      changed = true;
    }
  return changed;
}

// ---------- Proposals card ----------

export function proposalsHtml(p: SavedProject, comparisons: SavedComparison[]): string {
  if (selectedFor !== p.id) (selected = new Set()), (selectedFor = p.id), (readingStatus = "");
  const list = [...(p.proposals ?? [])].sort((a, b) => b.receivedAt - a.receivedAt);
  for (const id of selected) if (!list.some((x) => x.id === id)) selected.delete(id);
  const rows = list
    .map((r) => {
      const total = statedTotal(r.proposal);
      return `<li class="received">
        <label class="received-pick"><input type="checkbox" data-pick-proposal="${esc(r.id)}" ${selected.has(r.id) ? "checked" : ""} aria-label="Select ${esc(firmName(r.proposal.firm))}" /></label>
        <span class="received-main"><b>${esc(firmName(r.proposal.firm))}</b><span class="received-meta">${esc(
          [disciplinesBrief(r.proposal.disciplines), `Received ${shortDay(r.receivedAt)}`].filter(Boolean).join(" · "),
        )}</span></span>
        <span class="received-total">${total != null ? `${money(total)}${AI_MARK}` : ""}</span>
        <button class="link" data-remove-proposal="${esc(r.id)}">Remove</button>
      </li>`;
    })
    .join("");
  const n = selected.size;
  const cmpList = comparisons
    .map(
      (c) => `<li>
        <a class="link open" href="#proposals/${encodeURIComponent(c.id)}"><b>${esc(c.proposals.map((x) => firmName(x.firm)).join(", "))}</b></a>
        <span></span>
        <button class="link" data-unlink="${esc(c.id)}">Remove</button>
      </li>`,
    )
    .join("");
  return `
    ${rows ? `<ol class="received-list">${rows}</ol>` : `<p class="none">None yet. Add each consultant's proposal as it comes in.</p>`}
    <div class="actions">
      <label class="btn">Add proposals<input type="file" accept="application/pdf,.pdf" multiple hidden data-add-proposals /></label>
      ${rows ? `<button class="btn primary" data-compare-selected ${n < 1 || readingStatus ? "disabled" : ""}>${compareLabel(n)}</button>` : ""}
    </div>
    <p class="status" id="received-status">${esc(readingStatus || (rows ? pickHint(n) : ""))}</p>
    ${cmpList ? `<h3 class="proj-subhead">Comparisons</h3><ol>${cmpList}</ol>` : ""}`;
}

/** Reads newly added PDFs one at a time as they're added (two at once), each saved to the project when it's read. */
async function addProposals(files: File[], ctx: ProposalsContext) {
  if (!files.length || blockedInDemo()) return;
  const problems: string[] = [];
  const ok = files.filter((f) => {
    if (!isPdf(f)) return void problems.push(`${f.name}: not a PDF.`);
    if (f.size > MAX_BYTES) return void problems.push(`${f.name}: over 4.4 MB. Compress the PDF and add it again.`);
    return true;
  });
  const started = Date.now();
  let left = ok.length;
  const show = () => {
    readingStatus = left ? `Reading ${left} proposal${left === 1 ? "" : "s"}… ${Math.round((Date.now() - started) / 1000)}s (usually 1–2 minutes each)` : "";
    const el = document.getElementById("received-status");
    if (el) el.textContent = readingStatus;
  };
  const tick = setInterval(show, 1000);
  show();
  ctx.rerender();
  const queue = [...ok];
  await Promise.all(
    Array.from({ length: Math.min(2, queue.length) }, async () => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        try {
          const entry = await readOne(file, ctx.project);
          if (entry) {
            (ctx.project.proposals ??= []).push(entry);
            await ctx.save();
          } else problems.push(`${file.name}: already on this project.`);
        } catch (err) {
          problems.push(`${file.name}: ${(err as Error).message}`);
        }
        left--;
        show();
        ctx.rerender();
      }
    }),
  );
  clearInterval(tick);
  readingStatus = "";
  ctx.rerender();
  if (problems.length) await noticeModal("Some proposals weren't added", problems.join("\n"));
}

/** One PDF: an earlier reading of the same file is reused (no charge); otherwise it's read now. Null if it's already on the project. */
async function readOne(file: File, project: SavedProject): Promise<ReceivedProposal | null> {
  const hash = await hashFile(file);
  if (hash && project.proposals?.some((x) => x.hash === hash)) return null;
  const base = { id: crypto.randomUUID(), fileName: file.name, receivedAt: Date.now(), hash };
  const saved = hash ? await getReading(hash) : undefined;
  if (saved) return { ...base, proposal: saved.proposal, file_id: saved.file_id, uploadedAt: saved.uploadedAt, pdf_tokens: saved.pdf_tokens };
  const res = await post<{ proposal: Proposal; file_id: string; usage: Usage }>("/api/extract", file, {
    "content-type": "application/pdf",
    "x-filename": encodeURIComponent(file.name),
  });
  const uploadedAt = Date.now();
  if (hash) await saveReading({ hash, proposal: res.proposal, file_id: res.file_id, uploadedAt, pdf_tokens: res.usage.input_tokens });
  return { ...base, proposal: res.proposal, file_id: res.file_id, uploadedAt, pdf_tokens: res.usage.input_tokens };
}

/** Compares the ticked proposals (or analyzes one), saves the comparison to the project and opens it. */
async function compareSelected(ctx: ProposalsContext) {
  const picked = (ctx.project.proposals ?? []).filter((x) => selected.has(x.id));
  if (!picked.length || blockedInDemo()) return;
  const status = document.getElementById("received-status");
  const button = document.querySelector<HTMLButtonElement>("[data-compare-selected]");
  if (button) button.disabled = true;
  const started = Date.now();
  const label = picked.length === 1 ? "Analyzing" : "Comparing";
  const tick = setInterval(() => status && (status.textContent = `${label}… ${Math.round((Date.now() - started) / 1000)}s`), 1000);
  if (status) status.textContent = `${label}…`;
  try {
    const proposals: Sourced[] = picked.map((x) => ({ ...x.proposal, source_file: x.fileName, file_id: x.file_id, pdf_tokens: x.pdf_tokens, source_hash: x.hash ?? undefined }));
    const projectName = projectLabel(ctx.project);
    const { comparison: cmp, usage } = await post<{ comparison: Comparison; usage: Usage }>("/api/compare", JSON.stringify({ projectName, proposals }), {
      "content-type": "application/json",
    });
    const saved: SavedComparison = {
      id: crypto.randomUUID(),
      savedAt: Date.now(),
      projectName,
      projectId: ctx.project.id,
      proposals,
      cmp,
      messages: [],
      costUsd: usage.cost_usd ?? undefined,
      costPartial: usage.cost_usd == null,
    };
    await saveComparison(saved);
    selected.clear();
    location.hash = `#proposals/${encodeURIComponent(saved.id)}`;
  } catch (err) {
    await noticeModal(`Couldn't ${picked.length === 1 ? "analyze" : "compare"}`, (err as Error).message);
    ctx.rerender();
  } finally {
    clearInterval(tick);
  }
}

async function removeProposal(id: string, ctx: ProposalsContext) {
  const r = ctx.project.proposals?.find((x) => x.id === id);
  if (!r) return;
  const ok = await confirmModal({
    title: "Remove this proposal?",
    body: `${firmName(r.proposal.firm)}'s proposal comes off this project. Comparisons that include it are kept.`,
    confirm: "Remove",
  });
  if (!ok) return;
  ctx.project.proposals = ctx.project.proposals!.filter((x) => x.id !== id);
  selected.delete(id);
  try {
    await ctx.save();
  } catch (err) {
    await noticeModal("Not saved", (err as Error).message);
  }
  ctx.rerender();
}

// ---------- Proposal check (QA/QC) ----------

export function qaqcHtml(p: SavedProject, rfp: SavedRfp | undefined): string {
  const q = p.qaqc;
  const upload = `<label class="btn ${checking ? "disabled" : ""}">${q ? "Check again" : "Check our proposal"}<input type="file" accept="application/pdf,.pdf" hidden data-qaqc-file ${checking ? "disabled" : ""} /></label>`;
  const status = `<p class="status" id="qaqc-status">${checking ? "Checking…" : ""}</p>`;
  if (!q)
    return `<p class="none">Upload your finished proposal for a quick check: simple mistakes${rfp ? ", and anything that doesn't fit the RFP" : ""}.${rfp ? "" : " Review the RFP first to check it against the brief too."}</p>
      <div class="actions">${upload}</div>${status}`;
  const fixes = q.flags.filter((f) => f.severity === "fix").length;
  const looks = q.flags.length - fixes;
  const counts = q.flags.length ? [fixes ? `${fixes} to fix` : "", looks ? `${looks} to check` : ""].filter(Boolean).join(", ") : "Nothing flagged";
  return `
    <p class="qaqc-head"><b>${esc(counts)}</b> <span class="received-meta">${esc(q.fileName)} · ${dayText(q.checkedAt)}</span></p>
    ${q.summary ? `<p>${esc(q.summary)}</p>` : ""}
    ${
      q.flags.length
        ? `<ol class="qaqc-flags">${q.flags
            .map(
              (f) => `<li class="qaqc-${f.severity}">
              <span class="qaqc-tag">${f.severity === "fix" ? "Fix" : "Check"}${f.kind === "brief" ? " · Brief" : ""}${f.page ? ` · page ${f.page}` : ""}</span>
              <span>${esc(f.issue)}</span>
              ${f.fix ? `<span class="qaqc-suggest">${esc(f.fix)}</span>` : ""}
            </li>`,
            )
            .join("")}</ol>`
        : ""
    }
    <div class="actions">${upload}</div>${status}`;
}

const QAQC_MAX_BYTES = 60 * 1024 * 1024;

async function runQaqc(files: File[], ctx: ProposalsContext) {
  if (!files.length || checking || blockedInDemo()) return;
  const bad = files.find((f) => !isPdf(f));
  if (bad) return noticeModal("Not a PDF", `${bad.name} isn't a PDF. Export the proposal as a PDF and try again.`);
  const big = files.find((f) => f.size > QAQC_MAX_BYTES);
  if (big) return noticeModal("File too large", `${big.name} is over 60 MB. Export a smaller PDF (lower image quality) and try again.`);
  const ok = await confirmModal({
    title: "Check this proposal?",
    body: `AI reads ${files.map((f) => f.name).join(", ")} and flags simple mistakes (typos, wrong names, numbers or dates that don't agree)${
      ctx.rfp ? " and anything that doesn't fit the RFP review" : ""
    }. Check every flag yourself; it can miss things.`,
    confirm: "Check",
  });
  if (!ok) return;
  checking = true;
  ctx.rerender();
  const started = Date.now();
  const tick = setInterval(() => {
    const el = document.getElementById("qaqc-status");
    if (el) el.textContent = `Checking… ${Math.round((Date.now() - started) / 1000)}s (usually 1–3 minutes)`;
  }, 1000);
  try {
    const uploaded = await Promise.all(files.map(async (f) => ({ file_id: (await uploadPdfVia(f)).fileId, filename: f.name })));
    const res = await post<{ qa: QaResult; usage: Usage }>("/api/rfp", JSON.stringify({ files: uploaded, rfp: ctx.rfp?.rfp ?? null }), {
      "content-type": "application/json",
      "x-action": "qaqc",
    });
    ctx.project.qaqc = {
      fileName: files.map((f) => f.name).join(", "),
      checkedAt: Date.now(),
      summary: res.qa.summary,
      flags: res.qa.flags,
      costUsd: res.usage.cost_usd ?? null,
    };
    await ctx.save();
  } catch (err) {
    await noticeModal("Couldn't check the proposal", (err as Error).message);
  } finally {
    clearInterval(tick);
    checking = false;
    ctx.rerender();
  }
}

// ---------- Events (the project page passes them on) ----------

/** Handles a click in the Proposals or Proposal check card; true when it was one of theirs. */
export async function onProposalsClick(t: HTMLElement, ctx: ProposalsContext): Promise<boolean> {
  if (t.closest("[data-compare-selected]")) return void (await compareSelected(ctx)), true;
  const remove = t.closest("[data-remove-proposal]")?.getAttribute("data-remove-proposal");
  if (remove) return void (await removeProposal(remove, ctx)), true;
  return false;
}

/** Handles a change (file picked, proposal ticked) in those cards; true when it was one of theirs. */
export function onProposalsChange(el: HTMLInputElement, ctx: ProposalsContext): boolean {
  if (el.matches("[data-pick-proposal]")) {
    const id = el.getAttribute("data-pick-proposal")!;
    el.checked ? selected.add(id) : selected.delete(id);
    // Only the button and hint change, so the list keeps its place.
    const button = document.querySelector<HTMLButtonElement>("[data-compare-selected]");
    if (button) {
      button.textContent = compareLabel(selected.size);
      button.disabled = selected.size < 1 || !!readingStatus;
    }
    const hint = document.getElementById("received-status");
    if (hint && !readingStatus) hint.textContent = pickHint(selected.size);
    return true;
  }
  if (el.matches("[data-add-proposals]") || el.matches("[data-qaqc-file]")) {
    const files = [...(el.files ?? [])];
    el.value = "";
    void (el.matches("[data-add-proposals]") ? addProposals(files, ctx) : runQaqc(files, ctx));
    return true;
  }
  return false;
}
