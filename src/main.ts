import "@fontsource-variable/inter";
import type { ChatResponse, Comparison, Proposal } from "../lib/claude";
import { type Usage } from "../lib/cost";
import {
  deleteComparison,
  getReading,
  hashFile,
  isDemo,
  listComparisons,
  startDemo,
  saveComparison,
  saveReading,
  type ChatMessage,
  type SavedComparison,
} from "./store";
import { post, setDemoBlockedHandler, setUnauthorizedHandler } from "./api";
import { setOrgName } from "./org";
import { startAnalytics } from "./analytics";

// The current year in the footers; cookie-free page-view analytics (src/analytics.ts).
document.querySelectorAll("[data-year]").forEach((el) => (el.textContent = String(new Date().getFullYear())));
startAnalytics();
import { authEnabled, currentEmail, hasSession, initAuth, isInviteOnly, isRecovering, sendPasswordReset, sendSignInLink, setNewPassword, signInWithPassword, signOut, signUp } from "./auth";
import { confirmDelete, confirmModal, formModal, noticeModal } from "./modal";
import { getCurrentRfp, initRfp, openRfp, rfpBusy, showRfpIntakeProject, showRfpStart } from "./rfp";
import { showCalls } from "./calls";
import { showConsultants } from "./consultants";
import { flushFee, showFee } from "./fee";
import { closeFeeChat } from "./fee-chat";
import { showWorldView } from "./worldview";
import { showOrg } from "./org-page";
import { typeSplash } from "./splash";
import { clearPendingProject, initProject, openProject, pendingProject, showProjectList } from "./project";
import { setPrintName } from "./print";
import { initTooltips } from "./tooltip";
import { copyShareLink, parseHash } from "./share";
import { briefingHtml, comparisonTitle, esc, feeTable, firmName, glanceHtml, notesHtml, scopeTable, type Sourced } from "./table";

// Opening straight onto a schedule screen: hide the footer (and, for the print preview, the header) from the first
// paint, so they don't flash before the schedule loads (e.g. inside the print panel's preview).
if (/^#schedule[-/]/.test(location.hash) && !location.hash.startsWith("#schedule-prompt")) {
  document.documentElement.classList.add("schedule-on", "schedule-full");
  if (location.hash.startsWith("#schedule-print")) document.documentElement.classList.add("schedule-print");
}

// Vercel rejects request bodies over 4.5 MB; locally there's no limit.
const MAX_BYTES = import.meta.env.PROD ? 4.4 * 1024 * 1024 : Infinity;
const CONCURRENCY = 4;

type Entry = {
  id: number;
  file: File;
  state: "queued" | "reading" | "done" | "error";
  started?: number;
  result?: Proposal;
  fileId?: string;
  usage?: Usage;
  /** content hash; a saved reading under it is reused instead of paying to read the PDF again */
  hash?: string | null;
  reused?: boolean;
  uploadedAt?: number;
  pdfTokens?: number;
  error?: string;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const drop = $<HTMLLabelElement>("drop");
const input = $<HTMLInputElement>("file-input");
const filesEl = $<HTMLOListElement>("files");
const runBtn = $<HTMLButtonElement>("run");
const clearBtn = $<HTMLButtonElement>("clear");
const statusEl = $<HTMLSpanElement>("status");
const results = $<HTMLElement>("results");

let entries: Entry[] = [];
let nextId = 1;
let busy = false;

// ---------- File intake ----------

function addFiles(list: FileList | File[]) {
  for (const file of Array.from(list)) {
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    const entry: Entry = { id: nextId++, file, state: "queued" };
    if (!isPdf) Object.assign(entry, { state: "error", error: "Not a PDF" });
    else if (file.size > MAX_BYTES) Object.assign(entry, { state: "error", error: "Over 4.4 MB — compress the PDF and retry" });
    entries.push(entry);
  }
  render();
  reuseOrEstimate();
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function reuseOrEstimate() {
  await Promise.all(
    entries
      .filter((e) => e.state === "queued" && e.hash === undefined)
      .map(async (e) => {
        e.hash = await hashFile(e.file);
        const saved = e.hash ? await getReading(e.hash) : undefined;
        if (saved && e.state === "queued") {
          Object.assign(e, {
            state: "done",
            reused: true,
            result: saved.proposal,
            fileId: saved.file_id,
            uploadedAt: saved.uploadedAt,
            pdfTokens: saved.pdf_tokens,
          });
        }
      }),
  );
  render();
}

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

filesEl.addEventListener("click", (e) => {
  if (busy) return;
  const target = e.target as HTMLElement;
  const remove = target.closest("button[data-remove]");
  const reread = target.closest("button[data-reread]");
  if (remove) {
    entries = entries.filter((x) => x.id !== Number(remove.getAttribute("data-remove")));
    render();
  } else if (reread) {
    const entry = entries.find((x) => x.id === Number(reread.getAttribute("data-reread")));
    if (!entry) return;
    Object.assign(entry, { state: "queued", reused: false, result: undefined, fileId: undefined, usage: undefined });
    render();
  }
});

clearBtn.addEventListener("click", () => resetProposals());

/** The Proposals tab's first page: an empty upload and the saved comparisons (also where clicking the tab goes). */
function resetProposals() {
  if (busy) return;
  entries = [];
  results.hidden = true;
  current = null;
  history.replaceState(null, "", "#proposals");
  resetChat();
  setChatOpen(false);
  setStatus("");
  render();
  showIntakeProject();
}

// ---------- Rendering ----------

const fmtSize = (b: number) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);

function stateLabel(e: Entry) {
  if (e.state === "reading") return `Reading… ${Math.round((Date.now() - (e.started ?? Date.now())) / 1000)}s`;
  if (e.state === "error") return esc(e.error);
  if (e.state === "done" && e.reused) return "Read before";
  if (e.state === "done") return "Done";
  if (e.hash === undefined) return "Checking…";
  return "Ready";
}

function render() {
  filesEl.innerHTML = entries
    .map(
      (e) => `<li>
        <span class="name">${esc(e.file.name)} ${e.result ? `<span class="firm">— ${esc(firmName(e.result.firm))}</span>` : ""}</span>
        <span class="state ${e.state}">${stateLabel(e)}</span>
        <span>${
          busy
            ? fmtSize(e.file.size)
            : `${e.reused ? `<button data-reread="${e.id}" title="Read this PDF again from scratch">Re-read</button> · ` : ""}<button data-remove="${e.id}" title="Remove">Remove</button>`
        }</span>
      </li>`,
    )
    .join("");
  const usable = entries.filter((e) => e.state !== "error" || e.error?.startsWith("Server:"));
  runBtn.disabled = busy || usable.length < 1;
  runBtn.textContent = busy ? "Working…" : usable.length === 1 ? "Analyze" : "Compare";
  clearBtn.hidden = entries.length === 0 || busy;
  drop.style.pointerEvents = busy ? "none" : "";
}

function setStatus(msg: string, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}

// ---------- API ----------

async function extract(e: Entry) {
  e.state = "reading";
  e.started = Date.now();
  render();
  try {
    const res = await post<{ proposal: Proposal; file_id: string; usage: Usage }>("/api/extract", e.file, {
      "content-type": "application/pdf",
      "x-filename": encodeURIComponent(e.file.name),
    });
    e.result = res.proposal;
    e.fileId = res.file_id;
    e.usage = res.usage;
    e.uploadedAt = Date.now();
    e.pdfTokens = res.usage.input_tokens;
    if (e.hash) await saveReading({ hash: e.hash, proposal: res.proposal, file_id: res.file_id, uploadedAt: e.uploadedAt, pdf_tokens: e.pdfTokens });
    e.state = "done";
  } catch (err) {
    e.state = "error";
    e.error = `Server: ${(err as Error).message}`;
  }
  render();
}

async function pool(items: Entry[], n: number, fn: (e: Entry) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift()!);
  }));
}

runBtn.addEventListener("click", async () => {
  busy = true;
  results.hidden = true;
  setStatus("Reading proposals. This usually takes 1–3 minutes.");
  const tick = setInterval(render, 1000);
  try {
    // Re-use earlier extractions; retry ones that failed on the server.
    const todo = entries.filter((e) => e.state === "queued" || e.error?.startsWith("Server:"));
    await pool(todo, CONCURRENCY, extract);

    // Reused readings older than a day have had their PDF deleted from Anthropic; re-upload (free) for the chat.
    const stale = entries.filter((e) => e.state === "done" && e.reused && Date.now() - (e.uploadedAt ?? 0) > DAY_MS - 60 * 60 * 1000);
    await pool(stale, CONCURRENCY, async (e) => {
      try {
        const res = await post<{ file_id: string }>("/api/upload", e.file, {
          "content-type": "application/pdf",
          "x-filename": encodeURIComponent(e.file.name),
        });
        e.fileId = res.file_id;
        e.uploadedAt = Date.now();
        if (e.hash && e.result)
          await saveReading({ hash: e.hash, proposal: e.result, file_id: e.fileId, uploadedAt: e.uploadedAt, pdf_tokens: e.pdfTokens });
      } catch {
        // Not fatal: the comparison still works; the chat will offer to re-attach the PDF.
      }
    });

    const done = entries.filter((e) => e.state === "done" && e.result);
    if (done.length < 1) throw new Error("No proposals could be read.");

    setStatus(done.length === 1 ? "Analyzing…" : "Comparing scopes…");
    const proposals: Sourced[] = done.map((e) => ({
      ...e.result!,
      source_file: e.file.name,
      file_id: e.fileId,
      pdf_tokens: e.pdfTokens,
      source_hash: e.hash ?? undefined,
    }));
    // Started from a project page: link the comparison to that project.
    const linkTo = pendingProject();
    const projectName = linkTo?.name ?? null;
    const { comparison: cmp, usage } = await post<{ comparison: Comparison; usage: Usage }>(
      "/api/compare",
      JSON.stringify({ projectName, proposals }),
      { "content-type": "application/json" },
    );
    // Reused readings cost nothing this time.
    const costs = [...done.map((e) => (e.reused ? 0 : e.usage?.cost_usd)), usage.cost_usd];
    const costUsd = costs.reduce<number>((a, c) => a + (c ?? 0), 0);
    const partial = costs.some((c) => c == null);
    current = { id: crypto.randomUUID(), savedAt: Date.now(), proposals, cmp, projectName, projectId: linkTo?.id, messages: [], costUsd, costPartial: partial };
    clearPendingProject();
    showIntakeProject();
    resetChat();
    showResults(true);
    const saveError = await persist().then(() => "", (err: Error) => ` Not saved: ${err.message}`);
    const failed = entries.length - done.length;
    setStatus(
      `Done${failed ? `, ${failed} file(s) skipped` : ""}.${saveError}`,
      !!saveError,
    );
  } catch (err) {
    setStatus((err as Error).message, true);
  } finally {
    clearInterval(tick);
    busy = false;
    render();
  }
});

// ---------- Results ----------

/** Back to the comparison's project (or Projects, for one saved before projects). */
function setBackLink() {
  const back = $<HTMLAnchorElement>("cmp-back");
  const c = current;
  back.href = c?.projectId ? `#project/${encodeURIComponent(c.projectId)}` : "#project";
  back.textContent = `← ${c?.projectId && c.projectName ? c.projectName : "Projects"}`;
}

const scopeEl = $<HTMLTableElement>("scope");
$("print").addEventListener("click", () => window.print());
$("share").addEventListener("click", (e) => current && copyShareLink("proposals", current.id, e.currentTarget as HTMLElement));
$("delete-comparison").addEventListener("click", async () => {
  const c = current;
  if (!c || busy || chatting || !(await confirmDelete("comparison"))) return;
  try {
    await deleteComparison(c.id);
  } catch (err) {
    return noticeModal("Couldn't delete", (err as Error).message);
  }
  current = null;
  results.hidden = true;
  setChatOpen(false);
  location.hash = c.projectId ? `#project/${encodeURIComponent(c.projectId)}` : "#project";
});

// The analysis currently on screen (saved in this browser); chat corrections replace parts of it.
let current: SavedComparison | null = null;

async function persist() {
  if (!current) return;
  current.savedAt = Date.now();
  await saveComparison(current);
}

function showResults(scroll: boolean) {
  if (!current) return;
  const { proposals, cmp, projectName } = current;
  $("cmp-title").textContent = comparisonTitle(proposals);
  $("cmp-sub").textContent = [
    `${proposals.length} firm${proposals.length === 1 ? "" : "s"}`,
    `compared ${new Date(current.savedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`,
  ].join(" · ");
  $("glance").innerHTML = glanceHtml(proposals, cmp);
  $("briefing").innerHTML = briefingHtml(proposals, cmp);
  results.style.setProperty("--min-table", `${160 + 130 * proposals.length}px`);
  $("fees").innerHTML = feeTable(proposals, cmp);
  scopeEl.innerHTML = scopeTable(proposals, cmp);
  $("notes").innerHTML = notesHtml(proposals);
  setBackLink();
  $("print-meta").textContent = [projectName, new Date().toLocaleDateString()].filter(Boolean).join(" — ");
  results.hidden = false;
  if (scroll) results.scrollIntoView({ behavior: "smooth" });
}

// ---------- Chat ----------

const chatEl = $<HTMLElement>("chat");
const chatLog = $<HTMLDivElement>("chat-log");
const chatForm = $<HTMLFormElement>("chat-form");
const chatInput = $<HTMLTextAreaElement>("chat-input");
const chatSend = $<HTMLButtonElement>("chat-send");
const chatStatus = $<HTMLSpanElement>("chat-status");
const reattachInput = $<HTMLInputElement>("reattach-input");
const chatHint = chatLog.innerHTML;
let chatting = false;

function setChatOpen(open: boolean) {
  chatEl.hidden = !open;
  document.body.classList.toggle("chat-open", open);
  if (open) chatInput.focus();
}
$("chat-open").addEventListener("click", () => setChatOpen(!document.body.classList.contains("chat-open")));
$("chat-close").addEventListener("click", () => setChatOpen(false));

function resetChat() {
  chatLog.innerHTML = chatHint;
  for (const msg of current?.messages ?? []) addMessage(msg.role, msg.text, msg.updated, msg.cost);
}

function addMessage(role: ChatMessage["role"] | "error", text: string, updated = false, cost?: number | null): HTMLDivElement {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  const meta = updated ? "Analysis updated" : "";
  div.innerHTML = esc(text).replace(/\n/g, "<br>") + (meta ? `<span class="updated">${meta}</span>` : "");
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return div;
}

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || chatting || !current) return;
  const c = current;
  chatting = true;
  chatSend.disabled = true;
  chatInput.value = "";
  addMessage("user", text);
  const turns = [...c.messages, { role: "user" as const, text }].map((msg) => ({ role: msg.role, content: msg.text }));
  // Visible placeholder reply so it's obvious the question is being worked on.
  const pending = document.createElement("div");
  pending.className = "msg assistant pending";
  chatLog.appendChild(pending);
  const started = Date.now();
  const showProgress = () => {
    const secs = Math.round((Date.now() - started) / 1000);
    const why =
      secs < 15
        ? "Checking the proposals"
        : secs < 45
          ? "Still working: re-reading the PDFs takes a little longer on the first question"
          : "Still working: corrections and detailed checks can take a minute or two";
    pending.innerHTML = `<span class="dots"><i></i><i></i><i></i></span> ${why}… <span class="secs">${secs}s</span>`;
    chatLog.scrollTop = chatLog.scrollHeight;
  };
  showProgress();
  const tick = setInterval(showProgress, 1000);
  chatInput.disabled = true;
  try {
    const res = await post<ChatResponse & { usage: Usage }>(
      "/api/chat",
      JSON.stringify({ projectName: c.projectName, proposals: c.proposals, comparison: c.cmp, turns }),
      { "content-type": "application/json" },
    );
    for (const u of res.updated_proposals) {
      const prev = c.proposals[u.firm_index];
      if (!prev) continue;
      c.proposals[u.firm_index] = { ...u.proposal, source_file: prev.source_file, file_id: prev.file_id, pdf_tokens: prev.pdf_tokens, source_hash: prev.source_hash };
      if (prev.source_hash) {
        const saved = await getReading(prev.source_hash);
        if (saved) await saveReading({ ...saved, proposal: u.proposal });
      }
    }
    if (res.updated_comparison) c.cmp = res.updated_comparison;
    const updated = res.updated_proposals.length > 0 || !!res.updated_comparison;
    if (updated && current === c) showResults(false);
    const cost = res.usage.cost_usd;
    c.messages.push({ role: "user", text }, { role: "assistant", text: res.reply, updated, cost });
    c.costUsd = (c.costUsd ?? 0) + (cost ?? 0);
    if (cost == null) c.costPartial = true;
    if (current === c) {
      addMessage("assistant", res.reply, updated, cost);
    }
    await saveComparison(c);
  } catch (err) {
    // Give the question back for a retry; it isn't added to the saved conversation.
    chatInput.value = text;
    const div = addMessage("error", (err as Error).message);
    if ((err as { status?: number }).status === 410) {
      const btn = document.createElement("button");
      btn.className = "btn";
      btn.textContent = "Re-attach PDFs";
      btn.addEventListener("click", () => reattachInput.click());
      div.appendChild(btn);
    }
  } finally {
    clearInterval(tick);
    pending.remove();
    chatStatus.textContent = "";
    chatting = false;
    chatSend.disabled = false;
    chatInput.disabled = false;
    chatInput.focus();
  }
});

// Re-uploads the original PDFs for a saved comparison whose files expired, matched by file name.
reattachInput.addEventListener("change", async () => {
  const files = Array.from(reattachInput.files ?? []);
  reattachInput.value = "";
  if (!current || !files.length) return;
  const c = current;
  chatStatus.textContent = "Re-attaching…";
  let matched = 0;
  const missing: string[] = [];
  try {
    for (const p of c.proposals) {
      const file = files.find((f) => f.name === p.source_file);
      if (!file) {
        missing.push(p.source_file ?? p.firm);
        continue;
      }
      const res = await post<{ file_id: string }>("/api/upload", file, {
        "content-type": "application/pdf",
        "x-filename": encodeURIComponent(file.name),
      });
      p.file_id = res.file_id;
      matched++;
    }
    await saveComparison(c);
    addMessage(
      "error",
      missing.length
        ? `Re-attached ${matched} of ${c.proposals.length}. Still missing: ${missing.join(", ")}. Pick those files (same names) to continue.`
        : "PDFs re-attached. Send your question again.",
    );
  } catch (err) {
    addMessage("error", (err as Error).message);
  } finally {
    chatStatus.textContent = "";
  }
});

/** Opens a saved comparison by id (from its project or a shared link). */
async function openComparison(id: string) {
  const saved = (await listComparisons()).find((s) => s.id === id);
  if (!saved) return noticeModal("Comparison not found", "It may have been deleted.");
  current = saved;
  resetChat();
  showResults(true);
}

/** True once the app has loaded (after sign-in). */
let started = false;

// ---------- Sign-in (Supabase Auth; the server decides whether login is on) ----------
// A sign-in is remembered in this browser: the session is saved and refreshes itself, so people sign in once and
// stay signed in until they choose Sign out. Anyone can create an account; it comes with its own organization.

const gate = $<HTMLDivElement>("gate");
const gateForm = $<HTMLFormElement>("gate-form");
const gateTitle = $<HTMLHeadingElement>("gate-title");
const gateEmail = $<HTMLInputElement>("gate-email");
const gatePassword = $<HTMLInputElement>("gate-password");
const gatePasswordLabel = $<HTMLSpanElement>("gate-password-label");
const gateSubmit = $<HTMLButtonElement>("gate-submit");
const gateLink = $<HTMLButtonElement>("gate-link");
const gateError = $<HTMLSpanElement>("gate-error");
const signoutBtn = $<HTMLButtonElement>("signout");
const orgName = $<HTMLSpanElement>("org-name");
type Me = { ok: boolean; email: string | null; org: { name: string; role: string } | null };
let me: Me | null = null;

// The schedule print page only shows the schedule handed to it in this browser (it's what the server opens to make a
// PDF), so it needs no sign-in; every API call still checks one.
const onPrintPage = () => location.hash.startsWith("#schedule-print");

type GateMode = "signin" | "signup" | "forgot" | "reset";
const GATE: Record<GateMode, { title: string; submit: string; password: string | null }> = {
  signin: { title: "Sign in", submit: "Sign in", password: "Password" },
  signup: { title: "Create an account", submit: "Create account", password: "Password (8+ characters)" },
  forgot: { title: "Reset your password", submit: "Email me a reset link", password: null },
  reset: { title: "Choose a new password", submit: "Save password", password: "New password (8+ characters)" },
};
let gateMode: GateMode = "signin";

function setGateMode(mode: GateMode) {
  gateMode = mode;
  const m = GATE[mode];
  gateTitle.textContent = m.title;
  gateSubmit.textContent = m.submit;
  gatePasswordLabel.textContent = m.password ?? "";
  gatePassword.autocomplete = mode === "signin" ? "current-password" : "new-password";
  gateForm.querySelectorAll<HTMLElement>("[data-show]").forEach((el) => {
    const modes = el.dataset.show!.split(" ");
    // "forgot" shows the email field only.
    el.hidden = !(modes.includes(mode) || (mode === "forgot" && el.contains(gateEmail)));
  });
  setGateMessage("");
}

function showGate(mode: GateMode = gateMode) {
  if (onPrintPage()) return;
  document.documentElement.classList.remove("gate-checking");
  signoutBtn.hidden = true;
  orgName.hidden = true;
  landing.hidden = true;
  gate.hidden = false;
  setGateMode(mode);
  (mode === "reset" || gateEmail.value ? gatePassword : gateEmail).focus();
}
setUnauthorizedHandler(() => showGate("signin"));

// ---------- Landing page and demo (signed-out visitors) ----------
// Signed-out visitors see the landing page. "Try the demo" opens the real app on sample data kept in memory (see
// startDemo in store.ts): they can click around and change things, nothing is saved, and anything that would reach the
// server (AI, uploads, PDFs) offers an account instead. The demo lasts for the browser tab; a reload starts it fresh.

const landing = $<HTMLDivElement>("landing");
const demoBanner = $<HTMLDivElement>("demo-banner");
const DEMO_FLAG = "demo";
/** Set when someone leaves the demo to make an account, so the reload opens the sign-up form. */
const AFTER_DEMO = "after-demo";
const session = {
  get: (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch {} },
  del: (k: string) => { try { sessionStorage.removeItem(k); } catch {} },
};

/** The landing page's sample dates, counted from today like the demo's RFP (e.g. "Tue, Dec 1, 2026 · 10:00 AM"). */
function fillLandingDates() {
  landing.querySelectorAll<HTMLElement>("[data-in-days]").forEach((el) => {
    const d = new Date(Date.now() + Number(el.dataset.inDays) * 24 * 60 * 60 * 1000);
    // Weekends move to Monday, as in the demo's sample RFP (src/demo/data.ts, weekdayIn).
    d.setDate(d.getDate() + (d.getDay() === 6 ? 2 : d.getDay() === 0 ? 1 : 0));
    const day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    el.textContent = el.dataset.time ? `${day} · ${el.dataset.time}` : day;
  });
}

function showLanding() {
  fillLandingDates();
  document.documentElement.classList.remove("gate-checking");
  gate.hidden = true;
  landing.hidden = false;
  landing.scrollTop = 0;
  typeSplash("landing-line");
}

/** Opens the demo; page is where to start (a #hash such as "#worldview"), the projects list by default. */
async function enterDemo(page?: string) {
  const { demoSeed } = await import("./demo/data");
  // The firm's name first: the sample schedule's notes name it.
  setOrgName("Demo Architects");
  startDemo(demoSeed());
  session.set(DEMO_FLAG, "1");
  gate.hidden = true;
  landing.hidden = true;
  document.documentElement.classList.remove("gate-checking");
  demoBanner.hidden = false;
  orgName.textContent = "Demo Architects";
  orgName.hidden = false;
  // Open on the page asked for, or the projects list, like the app.
  if (page) history.replaceState(null, "", page);
  else if (!started && !parseHash().tab) history.replaceState(null, "", "#project");
  start();
}

/** "Request access" (while sign-ups are invite-only): a short form, saved for the team to review and invite from. */
async function requestAccess() {
  const values = await formModal({
    title: "Request access",
    fields: [
      { label: "Name", value: "", required: true },
      { label: "Work email", value: "", required: true, placeholder: "you@yourfirm.com" },
      { label: "Firm", value: "" },
      { label: "Anything you'd like us to know (optional)", value: "" },
    ],
    confirm: "Send request",
    validate: (v) => !!v[0].trim() && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v[1].trim()),
  });
  if (!values) return;
  const [name, email, firm, note] = values.map((v) => v.trim());
  // Sent without the API helper: it's public (no sign-in), and the demo blocks the helper's server calls.
  const res = await fetch("/api/auth", {
    method: "POST",
    headers: { "content-type": "application/json", "x-action": "request-access" },
    body: JSON.stringify({ name, email, firm, note }),
  }).catch(() => null);
  const data = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
  if (res?.ok) await noticeModal("Thanks!", `We've got your request. We'll email ${email} when your invite is ready.`);
  else await noticeModal("Couldn't send", data?.error ?? "Couldn't reach the server. Try again in a moment.");
}

/** Leaves the demo (its data goes with it), optionally straight to the sign-up or sign-in form. */
function leaveDemo(then?: "signup" | "signin") {
  session.del(DEMO_FLAG);
  if (then) session.set(AFTER_DEMO, then);
  // Drop the #page and reload (changing only the # wouldn't reload, and the demo's data would stay).
  history.replaceState(null, "", location.pathname);
  location.reload();
}

document.addEventListener("click", (e) => {
  const action = (e.target as HTMLElement).closest<HTMLElement>("[data-landing]")?.dataset.landing;
  if (!action) return;
  if (action === "request") return void requestAccess();
  if (action === "demo") {
    // A link into a particular demo page (data-open="#worldview"); only the app's own page names are allowed.
    const open = (e.target as HTMLElement).closest<HTMLElement>("[data-landing]")?.dataset.open;
    return void enterDemo(open && /^#[a-z]+$/.test(open) ? open : undefined);
  }
  const mode = action === "signup" ? "signup" : "signin";
  if (isDemo()) leaveDemo(mode);
  else showGate(mode);
});
$("demo-exit").addEventListener("click", () => leaveDemo());

setDemoBlockedHandler(async () => {
  if (isInviteOnly()) {
    const ok = await confirmModal({
      title: "Not available in the demo",
      body: "The demo runs on sample data, so it can't read files or use AI. Accounts are invite only for now: request access and we'll email you an invite.",
      confirm: "Request access",
    });
    if (ok) await requestAccess();
    return;
  }
  const ok = await confirmModal({
    title: "Create an account to use this",
    body: "The demo runs on sample data, so it can't read files or use AI. With an account you can run this on your own RFPs and proposals.",
    confirm: "Create an account",
  });
  if (ok) leaveDemo("signup");
});

function setGateMessage(text: string, isError = true) {
  gateError.textContent = text;
  gateError.classList.toggle("error", isError);
}

/** Asks the server whether this browser's sign-in is good (or that none is needed); it also makes a new account's organization. */
/**
 * Asks the server whether this browser's sign-in is good. "no" only when the server says so (401/403); "error" when
 * it couldn't answer (a cold start, a timeout, a network blip), which must never be mistaken for being signed out.
 */
async function signedIn(): Promise<"ok" | "no" | "error"> {
  try {
    me = await post<Me>("/api/auth", "", {});
    setOrgName(me?.org?.name);
    return me?.ok ? "ok" : "error";
  } catch (err) {
    const status = (err as { status?: number }).status;
    return status === 401 || status === 403 ? "no" : "error";
  }
}

/** On page load with a saved sign-in: retries a server that couldn't answer, before giving up. */
async function confirmSignIn(): Promise<"ok" | "no" | "error"> {
  for (const wait of [0, 800, 2000, 4000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const result = await signedIn();
    if (result !== "error") return result;
  }
  return "error";
}

async function enter() {
  gate.hidden = true;
  landing.hidden = true;
  session.del(DEMO_FLAG);
  document.documentElement.classList.remove("gate-checking");
  if (authEnabled()) {
    signoutBtn.hidden = false;
    signoutBtn.title = me?.email ?? (await currentEmail()) ?? "";
    orgName.textContent = me?.org?.name ?? "";
    orgName.title = `${me?.org?.name ?? ""}: organization settings`;
    orgName.hidden = !me?.org;
  }
  start();
}

/** Supabase's messages, in plain words where they're unclear. */
function friendly(err: string): string {
  if (/invalid login/i.test(err)) return "That email and password don't match.";
  if (/email not confirmed/i.test(err)) return "Confirm your email first: open the link we sent you.";
  if (/already registered/i.test(err)) return "There's already an account for that email. Sign in instead.";
  if (/signups not allowed/i.test(err)) return "New accounts aren't open right now.";
  if (/rate limit/i.test(err)) return "Too many emails just now. Wait a minute and try again.";
  return err;
}

gateForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = gateEmail.value.trim();
  const password = gatePassword.value;
  setGateMessage("");
  if (gateMode !== "reset" && !gateEmail.reportValidity()) return;
  if (!email && gateMode !== "reset") return setGateMessage("Enter your email.");
  if (gateMode !== "forgot" && gateMode !== "signin" && password.length < 8) return setGateMessage("Use at least 8 characters.");
  gateSubmit.disabled = true;
  try {
    if (gateMode === "forgot") {
      const err = await sendPasswordReset(email);
      return err ? setGateMessage(friendly(err)) : setGateMessage(`Check ${email} for a link to choose a new password.`, false);
    }
    if (gateMode === "signup") {
      const { error, confirm } = await signUp(email, password);
      if (error) return setGateMessage(friendly(error));
      gatePassword.value = "";
      if (confirm) return setGateMessage(`Almost done: open the link we sent to ${email} (in this browser) to finish.`, false);
    } else if (gateMode === "reset") {
      const err = await setNewPassword(password);
      if (err) return setGateMessage(friendly(err));
      gatePassword.value = "";
    } else {
      if (!password) return sendLink();
      const err = await signInWithPassword(email, password);
      if (err) {
        setGateMessage(friendly(err));
        gatePassword.select();
        return;
      }
      gatePassword.value = "";
    }
    if ((await signedIn()) === "ok") enter();
    else setGateMessage("This account doesn't have access.");
  } finally {
    gateSubmit.disabled = false;
  }
});

async function sendLink() {
  const email = gateEmail.value.trim();
  if (!email || !gateEmail.reportValidity()) return setGateMessage("Enter your email.");
  gateLink.disabled = true;
  const err = await sendSignInLink(email);
  gateLink.disabled = false;
  if (err) setGateMessage(/signups not allowed|not found/i.test(err) ? "There's no account for that email." : friendly(err));
  else setGateMessage(`Check ${email} for a sign-in link. Open it in this browser.`, false);
}
gateLink.addEventListener("click", sendLink);
gateForm.addEventListener("click", (e) => {
  const go = (e.target as HTMLElement).closest<HTMLElement>("[data-go]")?.dataset.go as GateMode | "landing" | undefined;
  if (go === "landing") showLanding();
  else if (go) showGate(go);
});

signoutBtn.addEventListener("click", async () => {
  await signOut();
  location.reload();
});

// The gate is shown from the first paint; nothing loads until the sign-in checks out (or none is required).
(async () => {
  if (onPrintPage()) {
    // Wait for the rest of this file to finish loading first: showTab uses things defined further down.
    await Promise.resolve();
    gate.hidden = true;
    started = true;
    return showTab();
  }
  try {
    const loginOn = await initAuth();
    document.documentElement.classList.toggle("invite-only", isInviteOnly());
    // Opened from a password-reset email: choose a new password before going in.
    if (isRecovering()) return showGate("reset");
    if (!loginOn || hasSession()) {
      const result = await confirmSignIn();
      if (result === "ok") return enter();
      if (result === "error") {
        // Signed in, but the server couldn't confirm it: say so, rather than show the sign-in form as if signed out.
        showGate("signin");
        return setGateMessage("Couldn't reach the server to confirm your sign-in. Refresh the page in a moment.");
      }
    }
    // Signed out. A link to a page in the app (a teammate sharing #rfp/<id>, #project/<id>, …) or the team's sign-in
    // link (#signin) goes straight to the sign-in form, and the page opens once they're in. Otherwise: back into the
    // demo if this tab was in it, to the form they left the demo for, or the landing page.
    const { tab, id } = parseHash();
    if (tab === "signin" || tab === "login") {
      history.replaceState(null, "", location.pathname);
      return showGate("signin");
    }
    // A reload inside the demo stays in it (its pages and sample records); a link to a real record means sign in.
    const realRecord = !!id && !id.startsWith("demo-");
    if (session.get(DEMO_FLAG) && !realRecord) return enterDemo();
    if (tab) {
      session.del(DEMO_FLAG);
      return showGate("signin");
    }
    const after = session.get(AFTER_DEMO);
    session.del(AFTER_DEMO);
    if (after === "signup" || after === "signin") return showGate(after);
    showLanding();
  } catch {
    showGate("signin");
    setGateMessage("Can't reach the server. Refresh to try again.");
  }
})();

// Default PDF name: the open RFP review or comparison on the visible tab.
setPrintName(() => {
  const tab = parseHash().tab || "project";
  if (tab === "rfp") {
    const r = getCurrentRfp();
    return r && { kind: "RFP Review", name: r.project || r.rfp.project_name };
  }
  if (tab === "proposals" && current && !results.hidden) {
    return { kind: "Proposal Comparison", name: current.projectName || current.proposals.map((p) => firmName(p.firm)).join(" ") };
  }
  return null;
});

function start() {
  if (started) return;
  started = true;
  initTooltips();
  initRfp();
  initProject();
  showTab();
}

// ---------- Tabs ----------

const TABS = ["rfp", "proposals", "fee", "project", "consultants", "calls", "worldview", "org"];
// The schedule screens (#schedule, #schedule/<id>, …) are loaded only when first opened.
type ScheduleModule = typeof import("./schedule/mount");
let schedule: ScheduleModule | null = null;
const onSchedule = () => location.hash.startsWith("#schedule");

/** Set by a click on a tab link, so showTab opens that tab's first page. */
let fromTabClick = false;

function showTab() {
  const reset = fromTabClick;
  fromTabClick = false;
  if (onSchedule()) {
    if (!started) return; // waits for sign-in; start() calls showTab again
    for (const t of TABS) $(`tab-${t}`).hidden = true;
    // Schedules belong to projects: the Projects tab stays highlighted.
    document.querySelectorAll("nav.tabs a, a.worldview-link, a.org-name").forEach((a) => a.classList.toggle("on", a.getAttribute("data-tab") === "project"));
    setChatOpen(false);
    flushFee();
    closeFeeChat();
    import("./schedule/mount").then((m) => {
      schedule = m;
      if (onSchedule()) m.showSchedule(location.hash);
    });
    return;
  }
  schedule?.hideSchedule();
  const { tab: t, id } = parseHash();
  // Opening the site (no page in the address, or the name in the header) shows the projects list.
  const tab = TABS.includes(t) ? t : "project";
  // RFP reviews, proposal comparisons and fees live inside projects: their start pages only open from a project (which
  // says what they'll belong to), so anything made there is linked to it. Without one, go to Projects.
  if (started && !id && needsProject(tab)) return void location.replace("#project");
  for (const t of TABS) $(`tab-${t}`).hidden = t !== tab;
  const navTab = ["rfp", "proposals", "fee"].includes(tab) ? "project" : tab;
  document.querySelectorAll("nav.tabs a, a.worldview-link, a.org-name").forEach((a) => a.classList.toggle("on", a.getAttribute("data-tab") === navTab));
  if (reset && started) {
    if (tab === "rfp") showRfpStart();
    if (tab === "proposals") resetProposals();
  }
  if (tab === "proposals") showIntakeProject();
  if (tab === "rfp") showRfpIntakeProject();
  if (tab !== "proposals") setChatOpen(false);
  // A shared link (#rfp/<id> or #proposals/<id>) opens that item once signed in.
  if (id && started) tab === "rfp" ? openRfp(id) : tab === "proposals" ? openComparison(id) : tab === "project" && openProject(id);
  if (!id && tab === "project" && started) showProjectList();
  if (tab === "consultants" && started) showConsultants();
  if (tab === "calls" && started) showCalls();
  if (tab === "worldview" && started) showWorldView();
  if (tab === "org" && started) showOrg();
  if (tab === "fee" && started) showFee(id);
  else {
    flushFee();
    closeFeeChat();
  }
}

/**
 * A tool's start page opened with nothing to belong to: no project chose it, and nothing is running or on screen.
 * (Fees always open by id, from their project.)
 */
function needsProject(tab: string): boolean {
  if (tab === "fee") return true;
  if (tab === "rfp") return !pendingProject() && !rfpBusy() && !getCurrentRfp();
  // Comparisons are made from a project's proposal list; this page only shows one.
  if (tab === "proposals") return !busy && !current;
  return false;
}

/** On the intake, names the project the next comparison belongs to (it's always started from a project page). */
function showIntakeProject() {
  const p = pendingProject();
  // No project, no upload: a comparison is always made for a project.
  $("drop").hidden = !p;
  const el = $("intake-project");
  el.hidden = false;
  el.innerHTML = p
    ? `For project <a class="link" href="#project/${encodeURIComponent(p.id)}"><b>${esc(p.name)}</b></a>`
    : `Proposals are compared within a project. <a class="link" href="#project">Go to Projects</a>, open one, and choose Compare proposals.`;
}
addEventListener("hashchange", showTab);

// Clicking a tab (or World view) always opens its first page, not the review, comparison or item last open in it.
// Some pages open items without changing the address, so a click on the current tab's link must reset it too.
document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("nav.tabs a[data-tab], a.worldview-link");
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const href = a.getAttribute("href") ?? "";
  fromTabClick = true;
  if (location.hash === href) {
    e.preventDefault();
    showTab();
  }
});
showTab();

// ---------- Feedback ----------

const feedbackForm = $<HTMLFormElement>("feedback-form");
const feedbackInput = $<HTMLTextAreaElement>("feedback-input");
const feedbackStatus = $("feedback-status");
function setFeedbackOpen(open: boolean) {
  feedbackForm.hidden = !open;
  feedbackStatus.textContent = "";
  if (open) feedbackInput.focus();
}
$("feedback-toggle").addEventListener("click", () => setFeedbackOpen(feedbackForm.hidden !== false));
$("feedback-close").addEventListener("click", () => setFeedbackOpen(false));
feedbackForm.addEventListener("keydown", (e) => {
  if (e.key === "Escape") setFeedbackOpen(false);
});
// Lift the widget above the blue footer while the footer is on screen.
const footer = document.querySelector("footer.site") as HTMLElement;
const liftFeedback = () => {
  // A hidden footer (schedule editor) reports top 0, which would push the widget off screen.
  const visible = footer.offsetParent ? Math.max(0, innerHeight - footer.getBoundingClientRect().top) : 0;
  document.body.style.setProperty("--footer-lift", `${visible}px`);
};
addEventListener("scroll", liftFeedback, { passive: true });
addEventListener("resize", liftFeedback);
new ResizeObserver(liftFeedback).observe(document.body);
liftFeedback();
feedbackForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = feedbackInput.value.trim();
  if (!message) return;
  feedbackStatus.classList.remove("error");
  feedbackStatus.textContent = "Sending…";
  try {
    await post("/api/feedback", JSON.stringify({ message, tab: location.hash.slice(1) || "home" }), { "content-type": "application/json" });
    feedbackInput.value = "";
    feedbackStatus.textContent = "Thanks!";
    setTimeout(() => setFeedbackOpen(false), 1200);
  } catch (err) {
    feedbackStatus.classList.add("error");
    feedbackStatus.textContent = (err as Error).message;
  }
});

render();
