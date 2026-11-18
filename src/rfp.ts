import { RFP_FACTS, type Fit, type Rfp, type RfpFactKey } from "../lib/claude";
import { showPdfPage } from "./pdf-page";
import { reviewContext } from "./worldview";
import { DISCIPLINES, toDisciplines, type Discipline } from "../lib/disciplines";
import { type Usage } from "../lib/cost";
import { post, postPdf } from "./api";
import { deleteRfp, listProjects, listRfps, projectLabel, saveProject, saveRfp, savesShared, type SavedProject, type SavedRfp, RFP_DOC_KINDS, type RfpDocKind } from "./store";
import { clearPendingProject, pendingProject } from "./pending";
import { askProjectName, confirmDelete, confirmModal, formModal, noticeModal } from "./modal";
import { copyShareLink } from "./share";
import { esc } from "./table";

// Vercel rejects request bodies over 4.5 MB, so larger PDFs go straight to storage first (see uploadRfpPdf).
// Locally there's no limit. Storage takes up to 50 MB per file.
const MAX_BYTES = import.meta.env.PROD ? 4.4 * 1024 * 1024 : Infinity;
const MAX_STORED = 50 * 1024 * 1024;

type Entry = { file: File; error?: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let entries: Entry[] = [];
let busy = false;
let current: SavedRfp | null = null;

export function initRfp() {
  const drop = $<HTMLLabelElement>("rfp-drop");
  const input = $<HTMLInputElement>("rfp-input");
  input.addEventListener("change", () => {
    if (input.files) addFiles(input.files);
    input.value = "";
  });
  for (const ev of ["dragenter", "dragover"]) drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.add("over")));
  for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files) addFiles(e.dataTransfer.files);
  });
  $("rfp-files").addEventListener("click", (e) => {
    const i = (e.target as HTMLElement).closest("[data-remove]")?.getAttribute("data-remove");
    if (i == null || busy) return;
    entries.splice(Number(i), 1);
    renderFiles();
  });
  $("rfp-run").addEventListener("click", run);
  $("rfp-results").addEventListener("click", onResultsClick);
  $("rfp-results").addEventListener("submit", addQuestion);
  $("rfp-results").addEventListener("submit", onEditSubmit);
  // Escape leaves an open edit form without saving (a dialog on top handles its own Escape first).
  addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !editing || $("rfp-results").hidden || document.querySelector("dialog[open]")) return;
    e.preventDefault();
    editing = null;
    rerenderInPlace();
  });
}

// ---------- Intake ----------

function addFiles(list: FileList) {
  for (const file of Array.from(list)) {
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    const entry: Entry = { file };
    if (!isPdf) entry.error = "Not a PDF";
    else if (file.size > MAX_STORED) entry.error = "Over 50 MB, compress or split it first";
    entries.push(entry);
  }
  renderFiles();
}

function renderFiles() {
  $("rfp-files").innerHTML = entries
    .map(
      (e, i) => `<li>
        <span class="name">${esc(e.file.name)}</span>
        <span class="state ${e.error ? "error" : ""}">${esc(e.error ?? "")}</span>
        <span>${busy ? "" : `<button data-remove="${i}">Remove</button>`}</span>
      </li>`,
    )
    .join("");
  const usable = entries.filter((e) => !e.error);
  const run = $<HTMLButtonElement>("rfp-run");
  run.disabled = busy || usable.length === 0;
  run.textContent = busy ? "Reviewing…" : "Review";
}

function setStatus(msg: string, isError = false) {
  const el = $("rfp-status");
  el.textContent = msg;
  el.classList.toggle("error", isError);
}

async function run() {
  const usable = entries.filter((e) => !e.error);
  if (!usable.length || busy) return;
  busy = true;
  renderFiles();
  const started = Date.now();
  const tick = setInterval(() => setStatus(`Reading… ${Math.round((Date.now() - started) / 1000)}s`), 1000);
  setStatus("Reading…");
  try {
    const reviewId = crypto.randomUUID();
    const uploads = await Promise.all(usable.map((e, i) => uploadKept(e.file, reviewId, i)));
    const files = uploads.map((u, i) => ({ file_id: u.fileId, filename: usable[i].file.name }));
    const stored = uploads.flatMap((u, i) => (u.path ? [{ name: usable[i].file.name, path: u.path }] : []));
    // The team's world view and past pursuits go with every review (see the World view page).
    const context = await reviewContext();
    const res = await post<{ rfp: Rfp; usage: Usage }>(
      "/api/rfp",
      JSON.stringify({ files, worldView: context.worldView, pursuits: context.pursuits, sections: context.sections }),
      { "content-type": "application/json" },
    );
    // Started from a project page: the review is that project's RFP review.
    const linkTo = pendingProject();
    current = {
      id: reviewId,
      savedAt: Date.now(),
      ...(linkTo ? { projectId: linkTo.id, project: linkTo.name } : {}),
      files: files.map((f) => f.filename),
      ...(stored.length ? { stored, storedAt: Date.now() } : {}),
      rfp: res.rfp,
      costUsd: res.usage.cost_usd,
      lens: context.lens,
    };
    editing = null;
    entries = [];
    setStatus("");
    showResults();
    // The review is already paid for, so a failed save keeps it on screen and says so.
    await saveRfp(current).catch((err) =>
      $("rfp-results").insertAdjacentHTML("afterbegin", `<p class="status error">Not saved: ${esc((err as Error).message)}</p>`),
    );
    if (linkTo) {
      clearPendingProject();
      const project = (await listProjects()).find((p) => p.id === linkTo.id);
      if (project && !project.rfpId) await saveProject({ ...project, rfpId: reviewId }).catch(() => {});
    }
  } catch (err) {
    setStatus((err as Error).message, true);
  } finally {
    clearInterval(tick);
    busy = false;
    renderFiles();
  }
}

/** Hands one PDF to Anthropic and returns its file_id: directly when small, through storage when over 4.4 MB. */
export async function uploadRfpPdf(file: File, keep?: { reviewId: string; index: number }): Promise<string> {
  return (await uploadPdfVia(file, keep)).fileId;
}

/**
 * Uploads one PDF. Kept files (an RFP review's) always go through storage and stay there for 30 days, so the review's
 * page references can open them; others go straight through when small, or through storage (then deleted) when large.
 */
export async function uploadPdfVia(file: File, keep?: { reviewId: string; index: number }): Promise<{ fileId: string; path?: string }> {
  if (!keep && file.size <= MAX_BYTES) return { fileId: (await postPdf<{ file_id: string }>("/api/upload", file)).file_id };
  const json = { "content-type": "application/json" };
  const { url, path } = await post<{ url: string; path: string }>("/api/upload", JSON.stringify(keep ?? {}), { ...json, "x-action": "sign" });
  const put = await fetch(url, { method: "PUT", body: file, headers: { "content-type": "application/pdf", "x-upsert": "false" } });
  if (!put.ok) throw new Error(`Couldn't upload ${file.name} (${put.status}).`);
  const fileId = (await post<{ file_id: string }>("/api/upload", JSON.stringify({ path, filename: file.name }), json)).file_id;
  return { fileId, path: keep ? path : undefined };
}

/** An RFP's PDF for a review, kept when storage allows (local setups without it just read the PDF). */
async function uploadKept(file: File, reviewId: string, index: number): Promise<{ fileId: string; path?: string }> {
  try {
    return await uploadPdfVia(file, { reviewId, index });
  } catch (err) {
    if ((err as { status?: number }).status === 503) return uploadPdfVia(file);
    throw err;
  }
}

/** Creates a project from this review (name confirmed by the user) and links the review to it. */
async function startProject(review: SavedRfp) {
  const entered = await askProjectName("Start a project", "Start project", { name: review.project || review.rfp.project_name });
  if (!entered) return;
  const project: SavedProject = { id: crypto.randomUUID(), savedAt: Date.now(), ...entered, rfpId: review.id };
  try {
    await saveProject(project);
    review.projectId = project.id;
    review.project = projectLabel(project);
    await saveRfp(review);
  } catch (err) {
    return noticeModal("Project not saved", (err as Error).message);
  }
  if (current === review) showResults();
}

/** The review on screen, if any. */
export const getCurrentRfp = () => current;

/** Opens a saved review by id (from the list or a shared link). */
/** A review is being read right now (its page stays reachable while it runs). */
export const rfpBusy = () => busy;

/** On the upload page, names the project the review is for (it's always started from a project page). */
export function showRfpIntakeProject() {
  const p = pendingProject();
  // No project, no upload: a review is always made for a project.
  $("rfp-drop").hidden = !p;
  $("rfp-intake-project").innerHTML = p
    ? `For project <a class="link" href="#project/${encodeURIComponent(p.id)}"><b>${esc(p.name)}</b></a>`
    : `RFP reviews start from a project. <a class="link" href="#project">Go to Projects</a>, open one (or make a new one), and choose Review the RFP.`;
}

/** The RFP tab's first page: the upload and the saved reviews (also where clicking the tab goes). */
export function showRfpStart() {
  if (busy) return; // a review is running; it shows itself when done
  editing = null;
  current = null;
  history.replaceState(null, "", "#rfp");
  $("rfp-results").hidden = true;
  $("rfp-intake").hidden = false;
  showRfpIntakeProject();
}

export async function openRfp(id: string) {
  const found = (await listRfps()).find((s) => s.id === id);
  if (!found) return noticeModal("Review not found", "It may have been deleted.");
  current = found;
  editing = null;
  showResults();
}

/** Deletes the review on screen (and its stored PDFs), then goes back to its project. */
async function deleteCurrentRfp() {
  const review = current;
  if (!review || busy || !(await confirmDelete("RFP review"))) return;
  try {
    const paths = review.stored?.map((f) => f.path) ?? [];
    // Best effort: anything left is removed after 30 days anyway.
    if (paths.length) await post("/api/upload", JSON.stringify({ paths }), { "content-type": "application/json", "x-action": "delete-stored" }).catch(() => {});
    await deleteRfp(review.id);
  } catch (err) {
    return noticeModal("Couldn't delete", (err as Error).message);
  }
  current = null;
  location.hash = review.projectId ? `#project/${encodeURIComponent(review.projectId)}` : "#project";
}

// ---------- Results ----------

/** Local-midnight date for "YYYY-MM-DD", or null. */
export const parseDay = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
};
/** Whether a date's day is before today (the due day itself still counts as upcoming). False when it has no specific day. */
export const isPast = (d: { date: string }) => {
  const day = parseDay(d.date);
  return !!day && day.getTime() < new Date().setHours(0, 0, 0, 0);
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * One display format for every date, whatever the RFP's wording: "Jul 12, 2023, 9:30 AM" for a specific day
 * (time kept when stated), "Sep 2023" for a month, and the original words otherwise ("After proposals, date TBD").
 */
export function formatWhen(d: { date: string; when: string }): string {
  const day = parseDay(d.date);
  if (day) {
    const t = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\b\.?/i.exec(d.when) ?? /\b(noon)\b/i.exec(d.when);
    const time = !t ? "" : t[1].toLowerCase() === "noon" ? "12:00 PM" : `${+t[1]}:${t[2] ?? "00"} ${t[3].toUpperCase()}M`;
    return `${MONTHS[day.getMonth()]} ${day.getDate()}, ${day.getFullYear()}${time ? `, ${time}` : ""}`;
  }
  const m = /^\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\s*$/i.exec(d.when);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1, 3).toLowerCase()} ${m[2]}`;
  const ym = /^\s*(\d{1,2})\/(\d{4})\s*$/.exec(d.when);
  if (ym && +ym[1] >= 1 && +ym[1] <= 12) return `${MONTHS[+ym[1] - 1]} ${ym[2]}`;
  return d.when;
}


export function proposalDue(rfp: Rfp) {
  return rfp.dates.find((d) => /proposal|submission|submittal|response|qualifications/i.test(d.label) && /due|deadline|submi/i.test(d.label));
}

const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** The open review's kept PDFs, while they're still stored (30 days). */
/** Whether one of the review's PDFs is still stored (each is kept 30 days from when it was added). */
const isKept = (f: { at?: number } | undefined) => !!f && !!current && Date.now() - (f.at ?? current.storedAt ?? 0) < KEEP_MS;
/** Page references point into the RFP itself (the first file): links while it's kept. */
const keptFiles = () => (isKept(current?.stored?.[0]) ? current!.stored! : null);

/** A page reference: a link that opens the original PDF at that page while it's kept, plain text after. */
const pg = (n: number) => {
  const page = Math.trunc(Number(n));
  if (!(page > 0)) return "";
  return keptFiles()
    ? ` <button class="pg pg-link" data-open-page="${page}" title="Show page ${page} of the RFP">page ${page}</button>`
    : ` <span class="pg">page ${page}</span>`;
};

function showResults() {
  if (!current) return;
  const { rfp } = current;
  const due = proposalDue(rfp);

  const next = rfp.dates.find((d) => parseDay(d.date) && !isPast(d));
  const dates = rfp.dates
    .map((d) => {
      const cls = [d === due ? "due" : "", isPast(d) ? "past" : "", d === next ? "next" : ""].filter(Boolean).join(" ");
      return `<tr class="${cls}">
        <td class="when">${esc(formatWhen(d))}<span class="rel">${esc(relDay(d))}</span></td>
        <td>${esc(d.label)}${d.mandatory ? ' <span class="must">Mandatory</span>' : ""}${d === next ? ' <span class="next-tag">Next</span>' : ""}</td>
      </tr>`;
    })
    .join("");

  const notes = (rfp as RfpWithNotes).notes ?? "";
  const canEditFacts = !Array.isArray(rfp.facts);
  $("rfp-results").innerHTML = `
    <div class="rfp-top">
      ${current.projectId ? `<a class="link" href="#project/${encodeURIComponent(current.projectId)}">← ${esc(current.project || "Project")}</a>` : `<a class="link" href="#project">← Projects</a>`}
      <span class="project-name">${
        // A linked review's project is the back link; an older one named a project without linking it.
        !current.projectId && current.project ? `Project: <b>${esc(current.project)}</b>` : ""
      }</span>
      <span class="tools">${current.projectId ? "" : '<button class="btn" data-start-project>Start project</button>'}${
        // The original RFP (the first file), while it's kept; opens the whole PDF in a new tab.
        isKept(current.stored?.[0]) ? `<button class="btn" data-open-file="0" title="Open ${esc(current.stored![0].name)}">View RFP</button>` : ""
      }<button class="btn" data-share>Share</button><button class="btn" data-print>Print</button><button class="btn" data-delete-rfp>Delete</button></span>
    </div>
    ${
      editing === "header"
        ? editForm(
            "header",
            `${field("Project name", `<input type="text" name="project_name" value="${esc(rfp.project_name)}" />`)}
             ${field("Client", `<input type="text" name="client" value="${esc(rfp.client)}" />`)}
             ${field("Summary", `<textarea name="summary" rows="5">${esc(rfp.summary)}</textarea>`)}`,
          )
        : `${fitPill()}<h1 class="headline">${esc(rfp.project_name)} ${editLink("header")}</h1>
    <p class="rfp-sub">${esc(rfp.client)}${
      due ? ` · <span class="due-line${isPast(due) ? " past" : ""}">Proposals due ${esc(formatWhen(due))} <b>${esc(relDay(due))}</b></span>` : ""
    }</p>
    <p class="overview">${esc(rfp.summary)}</p>
    ${glanceTiles(rfp, due, next)}`
    }
    ${
      editing === "notes"
        ? `<div class="block"><h2 class="label">Notes</h2>${editForm(
            "notes",
            `<textarea name="notes" rows="6" aria-label="Notes" placeholder="What you know beyond the RFP: calls with the client, site visits, past work with them, things to read between the lines…">${esc(notes)}</textarea>`,
          )}</div>`
        : notes
          ? `<div class="block rfp-notes"><h2 class="label">Notes ${editLink("notes")}</h2><p>${esc(notes).replace(/\n/g, "<br />")}</p></div>`
          : `<p class="rfp-add-notes"><button class="link" data-edit="notes">Add notes</button></p>`
    }

    ${addendaBlock()}
    ${fitBlock()}

    <div class="rfp-cols">
      <div>
        ${
          editing === "dates"
            ? editSection("Key dates", "dates", rowsHtml("dates", rfp.dates))
            : section(`Key dates ${editLink("dates")}`, `<table class="grid dates">${dates}</table>`, rfp.dates.length)
        }
        ${
          editing === "watch"
            ? editSection("Critical components", "watch", rowsHtml("watch", rfp.watch_outs))
            : section(
                `Critical components ${editLink("watch")}`,
                `<ul class="watch">${rfp.watch_outs
                  .map((w) => `<li class="${w.critical ? "critical" : ""}"><b>${esc(w.title)}</b>${pg(w.page)}<p>${esc(w.detail)}</p></li>`)
                  .join("")}</ul>`,
                rfp.watch_outs.length,
                "None found.",
              )
        }
        ${
          editing === "questions"
            ? editSection("Questions to ask", "questions", rowsHtml("questions", rfp.questions))
            : section(
          `Questions to ask <button class="link" data-copy>Copy</button> ${editLink("questions")}`,
          (rfp.questions.length
            ? `<ol class="qs">${rfp.questions
                .map((q, i) => `<li><span class="q-num">${i + 1}.</span><span class="q-text">${esc(q)}</span><button class="link q-remove" data-remove-q="${i}" aria-label="Remove question ${i + 1}">Remove</button></li>`)
                .join("")}</ol>`
            : `<p class="none">None.</p>`) +
            `<form class="q-add" data-add-q><input type="text" aria-label="New question" placeholder="Add a question" autocomplete="off" /><button class="btn" type="submit">Add</button></form>`,
          1,
        )
        }
      </div>
      <div>
        ${
          editing === "facts" && canEditFacts
            ? editSection(
                "Key facts",
                "facts",
                (Object.keys(RFP_FACTS) as RfpFactKey[])
                  .map((k) => field(RFP_FACTS[k], `<input type="text" name="fact:${k}" value="${esc(rfp.facts[k]?.value ?? "")}" />`))
                  .join(""),
              )
            : section(`Key facts ${canEditFacts ? editLink("facts") : ""}`, `<table class="grid facts">${factsRows(rfp.facts)}</table>`, 1)
        }
        ${
          editing === "scoring"
            ? editSection("Scoring", "scoring", rowsHtml("scoring", rfp.scoring))
            : section(`Scoring ${editLink("scoring")}`, scoringHtml(rfp.scoring), rfp.scoring.length)
        }
      </div>
    </div>
    <div class="rfp-wide">
        ${
          editing === "services"
            ? editSection(
                "Disciplines requested",
                "services",
                `<table class="grid services-edit">${servicesMatrix(rfp)
                  .map(
                    (r) => `<tr><th scope="row">${esc(r.discipline)}</th>
                      <td><select name="req:${esc(r.discipline)}" aria-label="${esc(r.discipline)}">${(Object.keys(REQUESTED) as ServiceRow["requested"][])
                        .map((k) => `<option value="${k}" ${k === r.requested ? "selected" : ""}>${REQUESTED[k]}</option>`)
                        .join("")}</select></td>
                      <td><input type="text" name="detail:${esc(r.discipline)}" value="${esc(r.detail)}" aria-label="${esc(r.discipline)} detail" placeholder="Detail" /></td></tr>`,
                  )
                  .join("")}</table>`,
              )
            : servicesBlock(rfp)
        }
    </div>
    ${outlineBlock()}
    <p class="estimate">${filesLine()}</p>
    <p class="print-note">AI can make mistakes, so check important details against the original documents.</p>`;

  $("rfp-intake").hidden = true;
  $("rfp-results").hidden = false;
  scrollTo(0, 0);
}

/** A titled block. Every review shows the same blocks in the same order; an empty one says so. */
const section = (title: string, body: string, count: number, empty = "Not stated in the RFP.") =>
  `<div class="block"><h2 class="label">${title}</h2>${count ? body : `<p class="none">${empty}</p>`}</div>`;

/** "needed": the RFP doesn't ask for it, but the team knows the project needs it (set by hand). */
export type ServiceRow = { discipline: Discipline; requested: "yes" | "needed" | "no" | "unclear" | "unknown"; detail: string; page: number };

/**
 * Every governing discipline with whether the RFP requests it. Reads reviews in every saved shape: the current
 * matrix; the earlier free-text list (listed = yes, the rest = no); and the oldest one-line summary (matches = yes,
 * the rest unknown). Anything that isn't a governing discipline is left out.
 */
/** Disciplines a project needs: those its RFP review requests, minus any removed on the project page. */
export function projectDisciplines(rfp: Rfp | undefined, removed: string[] = [], added: string[] = []): Discipline[] {
  const requested = rfp ? servicesMatrix(rfp).filter((x) => x.requested === "yes" || x.requested === "needed").map((x) => x.discipline) : [];
  const wanted = new Set<string>([...requested, ...added]);
  return DISCIPLINES.filter((d) => wanted.has(d) && !removed.includes(d));
}

export function servicesMatrix(rfp: Rfp): ServiceRow[] {
  type Saved = { discipline: string; detail: string; page: number; requested?: string };
  const list = (rfp as { services?: Saved[] }).services;
  const byName = new Map<Discipline, ServiceRow>();
  let rest: ServiceRow["requested"] = "unknown";
  if (Array.isArray(list) && list.some((s) => s.requested)) {
    for (const s of list) if ((DISCIPLINES as readonly string[]).includes(s.discipline)) byName.set(s.discipline as Discipline, s as ServiceRow);
  } else if (Array.isArray(list)) {
    rest = "no";
    for (const s of list) for (const d of toDisciplines([s.discipline])) byName.set(d, { discipline: d, requested: "yes", detail: s.detail, page: s.page });
  } else {
    const old = (rfp.facts as Partial<Record<string, { value: string; page: number }>>).services;
    for (const d of toDisciplines((old?.value ?? "").split(/[,;]/))) byName.set(d, { discipline: d, requested: "yes", detail: "", page: old?.page ?? 0 });
  }
  return DISCIPLINES.map((d) => byName.get(d) ?? { discipline: d, requested: rest, detail: "", page: 0 });
}

const REQUESTED = { yes: "Requested", needed: "Not requested, but needed", no: "Not requested", unclear: "Unclear", unknown: "Not stated" } as const;

/** Disciplines requested: every governing discipline, marked requested or not. */
function servicesBlock(rfp: Rfp): string {
  const all = servicesMatrix(rfp);
  const order: ServiceRow["requested"][] = ["yes", "needed", "unclear", "unknown"];
  const shown = all.filter((r) => r.requested !== "no").sort((a, b) => order.indexOf(a.requested) - order.indexOf(b.requested));
  const rows = shown
    .map(
      (r) =>
        `<tr class="req-${r.requested}"><th scope="row">${esc(r.discipline)}</th><td class="req"><span class="req-tag">${REQUESTED[r.requested]}</span></td><td>${esc(r.detail)}${pg(r.page)}</td></tr>`,
    )
    .join("");
  const not = all.filter((r) => r.requested === "no").map((r) => r.discipline);
  const notLine = not.length ? `<p class="req-not"><b>Not requested:</b> ${not.map(esc).join(", ")}</p>` : "";
  return section(`Disciplines requested ${editLink("services")}`, `${rows ? `<table class="grid services">${rows}</table>` : ""}${notLine}`, 1);
}

/** Scoring criteria with a bar for each weight, so the ones that matter most stand out. */
function scoringHtml(scoring: Rfp["scoring"]): string {
  const pct = (w: string) => {
    const m = String(w).match(/(\d+(?:\.\d+)?)\s*%/);
    return m ? Math.min(100, Number(m[1])) : null;
  };
  const max = Math.max(0, ...scoring.map((s) => pct(s.weight) ?? 0));
  return `<ul class="scoring">${scoring
    .map((s) => {
      const p = pct(s.weight);
      return `<li><span class="sc-name">${esc(s.criterion)}</span><span class="sc-weight">${esc(s.weight)}</span>${
        p != null && max ? `<span class="sc-bar" aria-hidden="true"><span style="width:${(p / max) * 100}%"></span></span>` : ""
      }</li>`;
    })
    .join("")}</ul>`;
}

/** "today", "in 6 days", "tomorrow", "3 days ago"; "" when the date can't be read (e.g. "Summer, two years out"). */
function relDay(d: { date: string }): string {
  const day = parseDay(d.date);
  if (!day) return "";
  const n = Math.round((day.getTime() - new Date().setHours(0, 0, 0, 0)) / 864e5);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n === -1) return "yesterday";
  if (n > 0) return n < 60 ? `in ${n} days` : `in ${Math.round(n / 30)} months`;
  return n > -60 ? `${-n} days ago` : "passed";
}

/** The essentials in four tiles: when proposals are due, the next mandatory date, the budget and the page limit. */
function glanceTiles(rfp: Rfp, due: Rfp["dates"][number] | undefined, next: Rfp["dates"][number] | undefined): string {
  const fact = (k: RfpFactKey) => (Array.isArray(rfp.facts) ? undefined : rfp.facts[k]?.value);
  const mandatory = rfp.dates.find((d) => d.mandatory && d !== due && parseDay(d.date) && !isPast(d));
  const tile = (label: string, value: string | undefined, sub = "", cls = "") =>
    value ? `<div class="glance-tile ${cls}"><span class="gt-label">${esc(label)}</span><span class="gt-value">${esc(value)}</span>${sub ? `<span class="gt-sub">${esc(sub)}</span>` : ""}</div>` : "";
  const tiles = [
    due ? tile("Proposals due", formatWhen(due), relDay(due), isPast(due) ? "past" : "due") : "",
    mandatory ? tile("Next mandatory", mandatory.label, `${formatWhen(mandatory)} · ${relDay(mandatory)}`) : next && next !== due ? tile("Next date", next.label, `${formatWhen(next)} · ${relDay(next)}`) : "",
    tile("Construction budget", fact("construction_budget")),
    tile("Page limit", fact("page_limit")),
  ].filter(Boolean);
  return tiles.length ? `<div class="rfp-glance">${tiles.join("")}</div>` : "";
}

/** Key facts in a fixed order. Reviews saved before the fixed list keep their own label/value pairs. */
function factsRows(facts: Rfp["facts"] | { label: string; value: string; page: number }[]): string {
  const rows = Array.isArray(facts)
    ? facts.map((f) => [f.label, f.value, f.page] as const)
    : (Object.keys(RFP_FACTS) as RfpFactKey[]).filter((k) => facts[k]).map((k) => [RFP_FACTS[k], facts[k].value, facts[k].page] as const);
  return rows
    .map(([label, value, page]) => `<tr><th scope="row">${esc(label)}${value ? pg(page) : ""}</th><td>${value ? esc(value) : "Not stated"}</td></tr>`)
    .join("");
}

/** Adds the typed question to the end of the list and saves the review. */
async function addQuestion(e: Event) {
  const form = (e.target as HTMLElement).closest("[data-add-q]");
  if (!form || !current) return;
  e.preventDefault();
  const text = form.querySelector("input")!.value.trim();
  if (!text) return;
  current.rfp.questions.push(text);
  const y = scrollY;
  showResults();
  scrollTo(0, y);
  $("rfp-results").querySelector<HTMLInputElement>("[data-add-q] input")?.focus();
  await saveRfp(current).catch((err) => noticeModal("Not saved", (err as Error).message));
}

async function onResultsClick(e: Event) {
  const t = e.target as HTMLElement;
  if (onEditClick(t)) return;
  const openPage = t.closest("[data-open-page]")?.getAttribute("data-open-page");
  if (openPage) return openOriginal(0, Number(openPage));
  const filePage = t.closest("[data-open-file-page]")?.getAttribute("data-open-file-page");
  if (filePage) {
    const [i, page] = filePage.split(":").map(Number);
    return openOriginal(i, page);
  }
  const openFile = t.closest("[data-open-file]")?.getAttribute("data-open-file");
  if (openFile) return openOriginal(Number(openFile));
  if (t.closest("[data-fit-pill]")) {
    e.preventDefault();
    document.getElementById("rfp-fit")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (t.closest("[data-print]")) {
    print();
  } else if (t.closest("[data-start-project]") && current) {
    await startProject(current);
  } else if (t.closest("[data-delete-rfp]") && current) {
    await deleteCurrentRfp();
  } else if (t.closest("[data-share]") && current) {
    await copyShareLink("rfp", current.id, t.closest("[data-share]") as HTMLElement);
  } else if (t.closest("[data-remove-q]") && current) {
    // Answered or not useful: drop it from the saved review, after a warning that it can't come back.
    const i = Number(t.closest("[data-remove-q]")!.getAttribute("data-remove-q"));
    const ok = await confirmModal({
      title: "Remove this question?",
      body: savesShared()
        ? "It will be permanently removed from this review for everyone. This can't be undone."
        : "It will be permanently removed from this review. This can't be undone.",
      confirm: "Remove",
      danger: true,
    });
    if (!ok || !current) return;
    current.rfp.questions.splice(i, 1);
    const y = scrollY;
    showResults();
    scrollTo(0, y);
    await saveRfp(current).catch((err) => noticeModal("Not saved", (err as Error).message));
  } else if (t.closest("[data-copy-outline]") && current) {
    const o = (current.rfp as { outline?: Outline }).outline;
    if (!o) return;
    await navigator.clipboard.writeText(outlineText(o)).catch(() => {});
    t.textContent = "Copied";
    setTimeout(() => (t.textContent = "Copy"), 1500);
  } else if (t.closest("[data-copy]") && current) {
    await navigator.clipboard.writeText(current.rfp.questions.map((q, i) => `${i + 1}. ${q}`).join("\n"));
    t.textContent = "Copied";
    setTimeout(() => (t.textContent = "Copy"), 1500);
  }
}

// ---------- Editing ----------
// Any section can be corrected or added to by hand: mistakes, things read between the lines, or information from
// outside the RFP. Text that's changed loses its page reference, since it no longer comes from the document.

/** The team's own notes, kept with the review (and passed to the AI with it). */
type RfpWithNotes = Rfp & { notes?: string };
type EditKey = "outline" | "fit" | "header" | "notes" | "dates" | "watch" | "questions" | "facts" | "services" | "scoring";
let editing: EditKey | null = null;

const editLink = (key: EditKey) => `<button class="link edit-link" data-edit="${key}">Edit</button>`;
const field = (label: string, control: string) => `<label class="edit-field"><span>${esc(label)}</span>${control}</label>`;
const editForm = (key: EditKey, inner: string) =>
  `<form class="rfp-edit" data-edit-form="${key}">${inner}<div class="actions"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-cancel-edit>Cancel</button></div></form>`;
const editSection = (title: string, key: EditKey, inner: string) => `<div class="block"><h2 class="label">${esc(title)}</h2>${editForm(key, inner)}</div>`;

type RowKey = "dates" | "watch" | "questions" | "scoring" | "outline";
const ADD_LABEL: Record<RowKey, string> = { dates: "+ Add date", watch: "+ Add item", questions: "+ Add question", scoring: "+ Add criterion", outline: "+ Add pages" };

/** One editable row; `item` undefined gives a blank one. The original text and page ride along to keep page refs. */
function rowHtml(key: RowKey, item?: unknown): string {
  const keep = (text: string, page: number) => `<input type="hidden" name="orig" value="${esc(text)}" /><input type="hidden" name="page" value="${page}" />`;
  const remove = `<button type="button" class="link" data-remove-row>Remove</button>`;
  if (key === "dates") {
    const d = (item as Rfp["dates"][number] | undefined) ?? { label: "", date: "", when: "", mandatory: false, page: 0 };
    return `<div class="edit-row edit-date">
      <input type="text" name="label" value="${esc(d.label)}" placeholder="What (e.g. Proposal due)" aria-label="What" />
      <input type="date" name="date" value="${esc(d.date)}" aria-label="Date" />
      <input type="text" name="when" value="${esc(d.when)}" placeholder="Time, or e.g. Spring 2028" aria-label="Time or wording" />
      <label class="check"><input type="checkbox" name="mandatory" ${d.mandatory ? "checked" : ""} /> Mandatory</label>
      ${keep(d.label + "|" + d.date + "|" + d.when, d.page)}${remove}</div>`;
  }
  if (key === "watch") {
    const w = (item as Rfp["watch_outs"][number] | undefined) ?? { critical: false, title: "", detail: "", page: 0 };
    return `<div class="edit-row edit-watch">
      <input type="text" name="title" value="${esc(w.title)}" placeholder="Title" aria-label="Title" />
      <textarea name="detail" rows="2" placeholder="Detail" aria-label="Detail">${esc(w.detail)}</textarea>
      <label class="check"><input type="checkbox" name="critical" ${w.critical ? "checked" : ""} /> Critical</label>
      ${keep(w.title + "|" + w.detail, w.page)}${remove}</div>`;
  }
  if (key === "outline") {
    const o = (item as OutlinePage | undefined) ?? { pages: "", section: "", content: [], answers: "" };
    return `<div class="edit-row edit-outline">
      <input type="text" name="pages" value="${esc(o.pages)}" placeholder="Pages" aria-label="Pages" />
      <input type="text" name="section" value="${esc(o.section)}" placeholder="Section" aria-label="Section" />
      <button type="button" class="link" data-remove-row>Remove</button>
      <textarea name="content" rows="3" placeholder="What goes there, one point per line" aria-label="What goes there">${esc(o.content.join("\n"))}</textarea>
      <input type="text" name="answers" value="${esc(o.answers)}" placeholder="RFP requirement or scoring criterion it answers" aria-label="Answers" />
    </div>`;
  }
  if (key === "questions") {
    const q = (item as string | undefined) ?? "";
    return `<div class="edit-row edit-question"><textarea name="text" rows="2" aria-label="Question" placeholder="Question">${esc(q)}</textarea>${remove}</div>`;
  }
  const s = (item as Rfp["scoring"][number] | undefined) ?? { criterion: "", weight: "" };
  return `<div class="edit-row edit-scoring">
    <input type="text" name="criterion" value="${esc(s.criterion)}" placeholder="Criterion" aria-label="Criterion" />
    <input type="text" name="weight" value="${esc(s.weight)}" placeholder="Weight (e.g. 25%)" aria-label="Weight" />
    ${remove}</div>`;
}

const rowsHtml = (key: RowKey, items: unknown[]) =>
  `<div class="edit-rows" data-rows="${key}">${items.map((it) => rowHtml(key, it)).join("")}</div><button type="button" class="link" data-add-row="${key}">${ADD_LABEL[key]}</button>`;

/** Reads a submitted edit form back into the review. */
function applyEdit(key: EditKey, form: HTMLFormElement) {
  if (!current) return;
  const rfp = current.rfp as RfpWithNotes;
  const val = (el: ParentNode, name: string) => (el.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value ?? "").trim();
  const checked = (el: ParentNode, name: string) => !!el.querySelector<HTMLInputElement>(`[name="${name}"]`)?.checked;
  const rows = [...form.querySelectorAll<HTMLElement>(".edit-row")];
  // A row keeps its page reference only while its text is unchanged.
  const pageIf = (row: HTMLElement, text: string) => (val(row, "orig") === text ? Number(val(row, "page")) || 0 : 0);

  if (key === "fit") {
    const verdict = val(form, "verdict") as Fit["verdict"];
    const reasons = (form.querySelector<HTMLTextAreaElement>('[name="reasons"]')?.value ?? "")
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    (rfp as { fit?: Fit }).fit = { verdict, reasons };
  } else if (key === "header") {
    rfp.project_name = val(form, "project_name") || rfp.project_name;
    rfp.client = val(form, "client");
    rfp.summary = val(form, "summary");
  } else if (key === "notes") {
    rfp.notes = val(form, "notes") || undefined;
  } else if (key === "facts") {
    for (const k of Object.keys(RFP_FACTS) as RfpFactKey[]) {
      const value = val(form, `fact:${k}`);
      const before = rfp.facts[k] ?? { value: "", page: 0 };
      rfp.facts[k] = { value, page: value === before.value ? before.page : 0 };
    }
  } else if (key === "services") {
    const before = servicesMatrix(rfp);
    (rfp as { services: unknown }).services = before.map((r) => {
      const requested = val(form, `req:${r.discipline}`) as ServiceRow["requested"];
      const detail = val(form, `detail:${r.discipline}`);
      return { discipline: r.discipline, requested, detail, page: detail === r.detail ? r.page : 0 };
    });
  } else if (key === "dates") {
    const dates = rows
      .map((row) => {
        const label = val(row, "label");
        const date = val(row, "date");
        const when = val(row, "when");
        return { label, date, when, mandatory: checked(row, "mandatory"), page: pageIf(row, `${label}|${date}|${when}`) };
      })
      .filter((d) => d.label || d.date || d.when);
    // Dated items in date order, then the rest as entered.
    rfp.dates = [...dates.filter((d) => parseDay(d.date)).sort((a, b) => a.date.localeCompare(b.date)), ...dates.filter((d) => !parseDay(d.date))];
  } else if (key === "watch") {
    rfp.watch_outs = rows
      .map((row) => {
        const title = val(row, "title");
        const detail = val(row, "detail");
        return { critical: checked(row, "critical"), title, detail, page: pageIf(row, `${title}|${detail}`) };
      })
      .filter((w) => w.title || w.detail);
  } else if (key === "questions") {
    rfp.questions = rows.map((row) => val(row, "text")).filter(Boolean);
  } else if (key === "scoring") {
    rfp.scoring = rows.map((row) => ({ criterion: val(row, "criterion"), weight: val(row, "weight") })).filter((s) => s.criterion || s.weight);
  } else if (key === "outline") {
    const before = (rfp as { outline?: Outline }).outline;
    const pageOf = new Map((before?.format ?? []).map((f) => [f.rule, f.page]));
    (rfp as { outline?: Outline }).outline = {
      page_limit: val(form, "page_limit"),
      // A requirement keeps its page reference only while its wording is unchanged.
      format: (form.querySelector<HTMLTextAreaElement>('[name="format"]')?.value ?? "")
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((rule) => ({ rule, page: pageOf.get(rule) ?? 0 })),
      notes: before?.notes ?? [],
      pages: rows
        .map((row) => ({
          pages: val(row, "pages"),
          section: val(row, "section"),
          content: (row.querySelector<HTMLTextAreaElement>('[name="content"]')?.value ?? "").split("\n").map((x) => x.trim()).filter(Boolean),
          answers: val(row, "answers"),
        }))
        .filter((o) => o.section || o.content.length),
    };
  }
}

/** Re-renders the review where it was, so opening or closing a form doesn't jump the page. */
function rerenderInPlace(focusKey?: EditKey) {
  const y = scrollY;
  showResults();
  scrollTo(0, y);
  if (focusKey) $("rfp-results").querySelector<HTMLElement>(`[data-edit-form="${focusKey}"] input:not([type=hidden]), [data-edit-form="${focusKey}"] textarea`)?.focus();
}

async function onEditSubmit(e: Event) {
  const form = (e.target as HTMLElement).closest<HTMLFormElement>("[data-edit-form]");
  if (!form || !current) return;
  e.preventDefault();
  applyEdit(form.getAttribute("data-edit-form") as EditKey, form);
  editing = null;
  rerenderInPlace();
  await saveRfp(current).catch((err) => noticeModal("Not saved", (err as Error).message));
}

/** Handles the edit links and the buttons inside edit forms. Returns true when it handled the click. */
function onEditClick(t: HTMLElement): boolean {
  const open = t.closest("[data-edit]")?.getAttribute("data-edit") as EditKey | null;
  if (open) {
    editing = open;
    rerenderInPlace(open);
    return true;
  }
  if (t.closest("[data-cancel-edit]")) {
    editing = null;
    rerenderInPlace();
    return true;
  }
  const add = t.closest("[data-add-row]")?.getAttribute("data-add-row") as RowKey | null;
  if (add) {
    const rows = $("rfp-results").querySelector(`[data-rows="${add}"]`)!;
    rows.insertAdjacentHTML("beforeend", rowHtml(add));
    rows.lastElementChild?.querySelector<HTMLElement>("input:not([type=hidden]), textarea")?.focus();
    return true;
  }
  if (t.closest("[data-remove-row]")) {
    t.closest(".edit-row")?.remove();
    return true;
  }
  return false;
}

// ---------- Fit ----------

const VERDICTS: Record<Fit["verdict"], string> = { pursue: "Pursue", consider: "Consider", pass: "Pass" };

/** What each verdict means, for the pill's tooltip. */
const VERDICT_HELP: Record<Fit["verdict"], string> = {
  pursue:
    "Pursue: this RFP lines up well with your firm, judged against your world view, the fee you'd expect at this budget and your past pursuits. Worth going after.",
  consider:
    "Consider: a judgment call, not a clear yes or no. The RFP has real strengths and real concerns, such as a tight fee for the budget, work outside your usual experience or an unclear scope. Read the reasons in the Fit section and decide as a team.",
  pass:
    "Pass: something here works against you, such as a deal-breaker from your world view or a fee too low for the budget. Probably not worth the effort of a proposal.",
};

/** The fit verdict as a pill, with a tooltip saying what the verdict means. A link when href is given. */
export function verdictPill(fit: Fit, href?: string, attrs = ""): string {
  const tip = `${VERDICT_HELP[fit.verdict]} You can change the verdict on the review.`;
  const tag = href ? "a" : "span";
  return `<${tag} class="fit-pill fit-pill-${esc(fit.verdict)}"${href ? ` href="${esc(href)}"` : ' tabindex="0"'} data-tip="${esc(tip)}" ${attrs}>${VERDICTS[fit.verdict]}</${tag}>`;
}

/** Whether to pursue it, and the world view it was judged with. Older reviews have no fit and show nothing here. */
function fitBlock(): string {
  if (!current) return "";
  const fit = (current.rfp as { fit?: Fit }).fit;
  const lens = current.lens;
  const judged = lens
    ? `<p class="fit-lens">Judged with the <a class="link" href="#worldview">world view</a>${lens.savedAt ? ` of ${esc(dayText(lens.savedAt))}` : ""}${lens.text ? "" : " (none written yet)"}</p>`
    : "";
  if (editing === "fit")
    return `<div class="block fit"><h2 class="label">Fit</h2>${editForm(
      "fit",
      `${field(
        "Verdict",
        `<select name="verdict">${(Object.keys(VERDICTS) as Fit["verdict"][])
          .map((v) => `<option value="${v}" ${fit?.verdict === v ? "selected" : ""}>${VERDICTS[v]}</option>`)
          .join("")}</select>`,
      )}${field("Reasons, one per line", `<textarea name="reasons" rows="4">${esc((fit?.reasons ?? []).join("\n"))}</textarea>`)}`,
    )}</div>`;
  if (!fit) return "";
  return `<div class="block fit fit-${fit.verdict}" id="rfp-fit">
    <h2 class="label">Fit ${editLink("fit")}</h2>
    <p class="fit-verdict">${VERDICTS[fit.verdict]}</p>
    ${fit.reasons.length ? `<ul class="fit-reasons">${fit.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
    ${judged}
  </div>`;
}

/** The verdict as a pill above the title; it jumps to the Fit section's reasons. None on reviews without a fit. */
function fitPill(): string {
  const fit = current && (current.rfp as { fit?: Fit }).fit;
  if (!fit) return "";
  return verdictPill(fit, "#rfp-fit", "data-fit-pill");
}

const dayText = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

// ---------- Proposal outline ----------

type Outline = NonNullable<Rfp["outline"]>;
type OutlinePage = Outline["pages"][number];

/** Our proposal page by page, written with the review. Older reviews have none and show nothing here. */
function outlineBlock(): string {
  const outline = current && (current.rfp as { outline?: Outline }).outline;
  if (editing === "outline")
    return `<div class="block rfp-outline"><h2 class="label">Proposal outline</h2>${editForm(
      "outline",
      `${field("Page limit", `<input type="text" name="page_limit" value="${esc(outline?.page_limit ?? "")}" placeholder="e.g. 20 pages; cover and tabs excluded" />`)}${field(
        "Formatting requirements, one per line",
        `<textarea name="format" rows="${Math.max(4, (outline?.format?.length ?? 0) + 1)}" placeholder="e.g. 11-point minimum font">${esc((outline?.format ?? []).map((f) => f.rule).join("\n"))}</textarea>`,
      )}${rowsHtml("outline", outline?.pages ?? [])}`,
    )}</div>`;
  if (!outline) return "";
  return `<div class="block rfp-outline">
    <h2 class="label">Proposal outline <button class="link" data-copy-outline>Copy</button> ${editLink("outline")}</h2>
    ${outline.page_limit ? `<p class="outline-limit">Page limit: ${esc(outline.page_limit)}</p>` : ""}
    ${
      outline.format?.length
        ? `<div class="outline-format"><h3>Formatting requirements</h3><ul>${outline.format.map((f) => `<li>${esc(f.rule)}${pg(f.page)}</li>`).join("")}</ul></div>`
        : ""
    }
    <table class="grid outline">
      <thead><tr><th>Pages</th><th>Section</th><th>What goes there</th><th>Answers</th></tr></thead>
      <tbody>${outline.pages
        .map(
          (o) => `<tr>
            <td class="outline-pages">${esc(o.pages)}</td>
            <th scope="row">${esc(o.section)}</th>
            <td>${o.content.length ? `<ul>${o.content.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}</td>
            <td class="outline-answers">${esc(o.answers)}</td>
          </tr>`,
        )
        .join("")}</tbody>
    </table>
    ${outline.notes.length ? `<ul class="outline-notes">${outline.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
  </div>`;
}

/** The outline as plain text, for pasting into a document. */
function outlineText(o: Outline): string {
  return [
    o.page_limit && `Page limit: ${o.page_limit}`,
    o.format?.length ? `Formatting requirements:\n${o.format.map((f) => `  - ${f.rule}${f.page > 0 ? ` (page ${f.page})` : ""}`).join("\n")}` : "",
    ...o.pages.map((p) => [`${p.pages ? `Page ${p.pages}` : ""}${p.pages && p.section ? " · " : ""}${p.section}`, ...p.content.map((c) => `  - ${c}`), p.answers && `  Answers: ${p.answers}`].filter(Boolean).join("\n")),
    o.notes.length ? `Notes:\n${o.notes.map((n) => `  - ${n}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ---------- The original PDFs ----------

/** The review's file names; each opens its PDF while kept. */
function filesLine(): string {
  if (!current) return "";
  const stored = current.stored ?? [];
  if (!stored.some(isKept)) return esc(current.files.join(", ")) + (stored.length ? " (originals deleted after 30 days)" : "");
  const unkept = current.files.filter((n) => !stored.some((f) => f.name === n));
  const days = (f: { at?: number }) => Math.max(1, Math.ceil(((f.at ?? current!.storedAt ?? 0) + KEEP_MS - Date.now()) / (24 * 60 * 60 * 1000)));
  const soonest = Math.min(...stored.filter(isKept).map(days));
  return `${[
    ...stored.map((f, i) => (isKept(f) ? `<button class="link" data-open-file="${i}">${esc(f.name)}</button>` : esc(f.name))),
    ...unkept.map(esc),
  ].join(", ")} <span class="note">kept ${soonest} more day${soonest === 1 ? "" : "s"}</span>`;
}

/**
 * Opens a kept PDF in a new tab, at a page when given. Page references don't say which file they're in, so they open
 * the first (the RFP itself; addenda follow it).
 */
async function openOriginal(index: number, page?: number) {
  const file = current?.stored?.[index];
  if (!file || !isKept(file)) return;
  if (page) {
    // A page reference shows that page here (see pdf-page.ts), with a link to the whole file.
    try {
      const { url } = await post<{ url: string }>("/api/upload", JSON.stringify({ path: file.path }), { "content-type": "application/json", "x-action": "view" });
      await showPdfPage(url, page, file.name);
    } catch (err) {
      await noticeModal("Couldn't open the PDF", (err as Error).message);
    }
    return;
  }
  const tab = window.open("", "_blank"); // opened now, while the click counts, so it isn't blocked as a pop-up
  try {
    const { url } = await post<{ url: string }>("/api/upload", JSON.stringify({ path: file.path }), { "content-type": "application/json", "x-action": "view" });
    if (tab) tab.location.href = url;
  } catch (err) {
    tab?.close();
    await noticeModal("Couldn't open the PDF", (err as Error).message);
  }
}

// ---------- Addenda ----------
// Added from the project page: each one updates the review and records what it changed.

const dateText = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/** What each added document updated, newest first; an update's page opens that document while it's kept. */
type AddedDoc = NonNullable<SavedRfp["addenda"]>[number];
/** An added document's title: the team's, or "Addendum 2" for older ones. */
export const docTitle = (a: AddedDoc) => a.title?.trim() || `${RFP_DOC_KINDS[a.kind ?? "addendum"]}${(a.kind ?? "addendum") === "addendum" ? ` ${a.number}` : ""}`;
/** Its kind, when the title doesn't already say it. */
export const docKindLabel = (a: AddedDoc) => {
  const label = RFP_DOC_KINDS[a.kind ?? "addendum"];
  return docTitle(a).toLowerCase().includes(label.toLowerCase()) ? "" : label;
};

function addendaBlock(): string {
  const addenda = current?.addenda ?? [];
  if (!addenda.length) return "";
  return `<div class="block rfp-addenda" id="rfp-addenda"><h2 class="label">Added documents</h2>${[...addenda]
    .sort((a, b) => b.number - a.number)
    .map((a) => {
      const kept = a.storedIndex != null && isKept(current!.stored?.[a.storedIndex]);
      const page = (n: number) =>
        n > 0
          ? kept
            ? ` <button class="pg pg-link" data-open-file-page="${a.storedIndex}:${n}" title="Open ${esc(docTitle(a))} at page ${n}">page ${n}</button>`
            : ` <span class="pg">page ${n}</span>`
          : "";
      return `<div class="addendum">
        <h3>${esc(docTitle(a))} <span class="note">${esc([docKindLabel(a), a.files.join(", "), dateText(a.at)].filter(Boolean).join(" · "))}</span></h3>
        <ul>${a.changes.map((c) => `<li><b>${esc(c.section)}:</b> ${esc(c.change)}${page(c.page)}</li>`).join("")}</ul>
      </div>`;
    })
    .join("")}</div>`;
}

/**
 * Reads an addendum into a saved review (from the project page): asks first, keeps the PDF with the
 * review for 30 days, updates the review and records what changed. Resolves the updated review, or null if cancelled.
 */
export async function addAddendum(review: SavedRfp, files: File[]): Promise<SavedRfp | null> {
  const number = (review.addenda?.length ?? 0) + 1;
  // Say what it is and name it, rather than guess from the file name.
  const kinds = Object.entries(RFP_DOC_KINDS) as [RfpDocKind, string][];
  const values = await formModal({
    title: `Add to the RFP review`,
    fields: [
      { label: "What is it?", value: RFP_DOC_KINDS.addendum, options: kinds.map(([, label]) => label), single: true },
      { label: "Title", value: "", placeholder: "e.g. Addendum 2, or Answers to RFI questions", required: true },
    ],
    confirm: "Add and update the review",
    validate: (v) => !!v[0] && !!v[1].trim(),
  });
  if (!values) return null;
  const kind = kinds.find(([, label]) => label === values[0])?.[0] ?? "addendum";
  const title = values[1].trim();
  const start = review.stored?.length ?? 0;
  const uploads = await Promise.all(files.map((f, i) => uploadKept(f, review.id, start + i)));
  const context = await reviewContext();
  const res = await post<{ rfp: Rfp; changes: { section: string; change: string; page: number }[]; usage: Usage }>(
    "/api/rfp",
    JSON.stringify({
      files: uploads.map((u, i) => ({ file_id: u.fileId, filename: files[i].name })),
      rfp: review.rfp,
      number,
      kind,
      title,
      worldView: context.worldView,
      pursuits: context.pursuits,
      sections: context.sections,
    }),
    { "content-type": "application/json", "x-action": "addendum" },
  );
  // The team's own additions stay as they were: notes, and disciplines marked "needed".
  const before = review.rfp as Rfp & { notes?: string };
  const next = res.rfp as Rfp & { notes?: string };
  if (before.notes) next.notes = before.notes;
  const needed = new Set(servicesMatrix(before).filter((s) => s.requested === "needed").map((s) => s.discipline));
  next.services = next.services.map((s) => (needed.has(s.discipline) && s.requested !== "yes" ? { ...s, requested: "needed" as never } : s));
  const now = Date.now();
  const kept = uploads.flatMap((u, i) => (u.path ? [{ name: files[i].name, path: u.path, at: now }] : []));
  const updated: SavedRfp = {
    ...review,
    rfp: next,
    files: [...review.files, ...files.map((f) => f.name)],
    stored: kept.length ? [...(review.stored ?? []), ...kept] : review.stored,
    addenda: [
      ...(review.addenda ?? []),
      { number, kind, title, files: files.map((f) => f.name), at: now, changes: res.changes, costUsd: res.usage.cost_usd ?? null, storedIndex: kept.length ? start : undefined },
    ],
  };
  await saveRfp(updated);
  if (current?.id === updated.id) current = updated;
  return updated;
}
