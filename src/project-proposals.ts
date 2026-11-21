// A project's consultant proposals and its proposal check (QA/QC), on the project page.
//  - Proposals: each consultant's PDF is read on its own when it arrives; any two or more are compared later.
//  - Proposal check: the firm's own finished proposal, read once for simple mistakes and fit to the RFP review.

import { toDisciplines } from "../lib/disciplines";
import type { Proposal, QaResult } from "../lib/claude";
import { type Usage } from "../lib/cost";
import { blockedInDemo, post, postJson } from "./api";
import { confirmModal, noticeModal } from "./modal";
import { uploadPdfVia } from "./rfp";
import {
  getReading,
  hashFile,
  saveReading,
  type ProjectFirm,
  type ReceivedProposal,
  type SavedComparison,
  type SavedProject,
  type SavedRfp,
} from "./store";
import { AI_MARK, esc, firmName, statedTotal, type Sourced } from "./table";
import { dateText, money, plural, shortDay } from "../lib/format";

export type ProposalsContext = {
  project: SavedProject;
  rfp: SavedRfp | undefined;
  /** saves the project record */
  save: () => Promise<void>;
  /** redraws the project page */
  rerender: () => void;
  /** links a proposal to its project firm (making the firm when it's new); returns the firm */
  linkFirm: (r: ReceivedProposal) => ProjectFirm | undefined;
};

// Vercel's request limit for a PDF sent straight to the reader (local development has none).
const MAX_BYTES = import.meta.env.PROD ? 4.4 * 1024 * 1024 : Infinity;
const isPdf = (f: File) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);

/** What's being read right now, shown under the list, and the project it's for. */
let readingStatus = "";
let statusFor = "";
let checking = false;


/** A firm's disciplines in brief: Mechanical, Electrical and Plumbing together read as "MEP". */
function disciplinesBrief(raw: string[]): string {
  const ds: string[] = toDisciplines(raw);
  if (!ds.length) return raw.slice(0, 2).join(", ");
  const mep = ["Mechanical", "Electrical", "Plumbing"];
  if (mep.every((d) => ds.includes(d))) return ["MEP", ...ds.filter((d) => !mep.includes(d))].join(" + ");
  return ds.join(", ");
}


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

// ---------- Consultants and their proposals ----------

/** The Consultant proposals card's actions, for its header. */
export function proposalsHeadHtml(p: SavedProject): string {
  const withProposals = (p.consultants ?? []).some((c) => proposalsOf(p, c.id!).latest);
  return `<span class="proj-card-links proposals-actions">
      <button class="link" data-add-firm>+ Add consultant</button>
      <label class="link received-new" title="Upload proposals from firms that aren't on the list yet">Upload from a new firm<input type="file" accept="application/pdf,.pdf" multiple hidden data-add-proposals /></label>
      ${withProposals ? `<a class="link" href="#project/${encodeURIComponent(p.id)}/consultants">See detailed comparison</a>` : ""}
    </span>`;
}
// The project's firms (the same ones as the consultant matrix): add the ones you're waiting on, then upload each
// proposal on its firm's row, so nothing is matched by name. Tick firms with proposals to compare them.

/** Firms whose proposal is being read right now. */
const readingFirms = new Set<string>();

/** A firm's proposals on this project, oldest first, and the latest. */
function proposalsOf(p: SavedProject, firmId: string) {
  const list = (p.proposals ?? []).filter((r) => r.firmId === firmId).sort((a, b) => a.receivedAt - b.receivedAt);
  return { list, latest: list.at(-1) };
}

export function proposalsHtml(p: SavedProject, comparisons: SavedComparison[]): string {
  if (statusFor !== p.id) (statusFor = p.id), (readingStatus = "");
  const firms = p.consultants ?? [];
  const rows = firms
    .map((c) => {
      const { list, latest } = proposalsOf(p, c.id!);
      const total = latest ? statedTotal(latest.proposal) : null;
      const reading = readingFirms.has(c.id!);
      const state = reading
        ? "Reading the proposal…"
        : latest
          ? `Received ${shortDay(latest.receivedAt)}${list.length > 1 ? ` · ${list.length} versions` : ""}`
          : "Waiting for proposal";
      // The proposal says what a firm covers; until it's in, the scope expected from it.
      const disciplines = disciplinesBrief(latest ? (latest.proposal.disciplines ?? []) : c.disciplines);
      return `<li class="received${latest ? "" : " waiting"}">
        <span class="received-main"><b>${esc(c.name)}</b><span class="received-meta">${esc([disciplines, state].filter(Boolean).join(" · "))}</span></span>
        <span class="received-total">${total != null ? `${money(total)}${AI_MARK}` : ""}</span>
        <span class="received-actions">
          <label class="link${reading ? " disabled" : ""}">${latest ? "Upload new version" : "Upload proposal"}<input type="file" accept="application/pdf,.pdf" hidden data-upload-for="${esc(c.id!)}" ${reading ? "disabled" : ""} /></label>
          <button class="link" data-remove-firm="${esc(c.id!)}">Remove</button>
        </span>
      </li>`;
    })
    .join("");
  // Sections of the Consultants page aren't listed here; earlier comparisons are.
  const cmpList = comparisons
    .filter((c) => !c.group)
    .map(
      (c) => `<li>
        <a class="link open" href="#proposals/${encodeURIComponent(c.id)}"><b>${esc(c.proposals.map((x) => firmName(x.firm)).join(", "))}</b></a>
        <span></span>
        <button class="link" data-unlink="${esc(c.id)}">Remove</button>
      </li>`,
    )
    .join("");
  // The card's actions are in its header (proposalsHeadHtml), so they're never scrolled out of sight.
  return `
    <p class="status" id="received-status">${esc(readingStatus)}</p>
    ${rows ? `<ol class="received-list">${rows}</ol>` : `<p class="none">None yet. Add the consultants you're waiting on, then upload each proposal when it comes in.</p>`}
    ${cmpList ? `<h3 class="proj-subhead">Earlier comparisons</h3><ol>${cmpList}</ol>` : ""}`;
}

/**
 * Reads newly added PDFs, two at once, each saved to the project when it's read. With a firm (uploaded on its row),
 * each belongs to that firm; otherwise each is matched to a firm by name, or makes a new one.
 */
async function addProposals(files: File[], ctx: ProposalsContext, firmId?: string) {
  if (!files.length || blockedInDemo()) return;
  const problems: string[] = [];
  const ok = files.filter((f) => {
    if (!isPdf(f)) return void problems.push(`${f.name}: not a PDF.`);
    if (f.size > MAX_BYTES) return void problems.push(`${f.name}: over 4.4 MB. Compress the PDF and add it again.`);
    return true;
  });
  if (firmId) readingFirms.add(firmId);
  const started = Date.now();
  let left = ok.length;
  const show = () => {
    readingStatus = left ? `Reading ${plural(left, "proposal")}… ${Math.round((Date.now() - started) / 1000)}s (usually 1–2 minutes each)` : "";
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
            const firm = firmId ? ctx.project.consultants?.find((c) => c.id === firmId) : undefined;
            if (firm) entry.firmId = firm.id;
            // The firm (this row's, or matched by name, or a new one) gains an X for each discipline the proposal covers.
            ctx.linkFirm(entry);
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
  if (firmId) readingFirms.delete(firmId);
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
    <p class="qaqc-head"><b>${esc(counts)}</b> <span class="received-meta">${esc(q.fileName)} · ${dateText(q.checkedAt)}</span></p>
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
    const res = await postJson<{ qa: QaResult; usage: Usage }>("/api/rfp", { files: uploaded, rfp: ctx.rfp?.rfp ?? null }, "qaqc");
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

/** Handles a file picked in the Proposals or Proposal check card; true when it was one of theirs. */
export function onProposalsChange(el: HTMLInputElement, ctx: ProposalsContext): boolean {
  if (el.matches("[data-add-proposals], [data-upload-for], [data-qaqc-file]")) {
    const files = [...(el.files ?? [])];
    el.value = "";
    if (el.matches("[data-qaqc-file]")) void runQaqc(files, ctx);
    else void addProposals(files, ctx, el.getAttribute("data-upload-for") ?? undefined);
    return true;
  }
  return false;
}
