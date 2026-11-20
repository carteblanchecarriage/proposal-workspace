// The AI assistant: one side panel, the same on every project page (project, Consultants, RFP review, fee, schedule,
// proposal comparison). Each page registers what the assistant sees there and how to ask (setAssistantPage); the
// "Ask AI" button in the page's toolbar (assistantButton) opens it. A conversation belongs to one page and starts fresh
// on another: every turn resends the conversation, so a short one keeps the cost down. Along with the page itself the
// assistant gets a short digest of the rest of the project (project-digest.ts).
import type { AssistPage } from "../lib/assist";
import type { Usage } from "../lib/cost";
import { postJson } from "./api";
import { buildDigest, type DigestPart } from "./project-digest";
import { esc } from "./table";

export type Turn = { role: "user" | "assistant"; content: string };
/** An image or PDF attached to a question (schedule only), base64. */
export type Attachment = { name: string; mediaType: string; base64: string };
/** What was sent to answer: the page's data only, or the original PDFs too. */
export type Source = "data" | "pdfs";

export type Reply = {
  text: string;
  /** what the reply did, e.g. "Worksheet updated (2 changes)" */
  meta?: string;
  source?: Source;
  costUsd?: number | null;
  /** what the next turn sees as this reply, when it differs from text (e.g. a note of what was applied) */
  turn?: string;
  /** a follow-up the person can run on this reply, e.g. "Re-read the PDFs" (it replaces this reply) */
  retry?: { label: string; run: () => Promise<Reply> };
};

/** A saved message to show when the panel opens (the comparison keeps its conversation). */
export type ShownMessage = { role: "user" | "assistant"; text: string; meta?: string; source?: Source; costUsd?: number | null };

export type AssistantPage = {
  /** a different key starts a new conversation */
  key: string;
  title: string;
  /** shown in the empty conversation: what to ask here */
  hint: string;
  placeholder?: string;
  /** under the box, e.g. "Changes can be undone with Undo." */
  note?: string;
  /** the project, for the digest of its other parts; null when the page isn't linked to one */
  projectId: string | null;
  /** the part of the project this page shows in full (left out of the digest) */
  part: DigestPart;
  /** earlier messages, for a page that keeps its conversation */
  history?: ShownMessage[];
  attachments?: boolean;
  /** what the wait says, by seconds waited */
  progress?: (secs: number) => string;
  /** sends the conversation (ending with the new question) and returns the reply */
  ask: (turns: Turn[], ctx: { digest: string; attachment: Attachment | null }) => Promise<Reply>;
};

const MAX_TURNS = 20;
const MAX_FILE_BYTES = 3 * 1024 * 1024; // the request body limit is 4.5 MB and base64 adds a third

let page: AssistantPage | null = null;
let panel: HTMLElement | null = null;
let shownKey = "";
let turns: Turn[] = [];
let busy = false;
let attachment: Attachment | null = null;
const digests = new Map<string, Promise<string>>();

/** The toolbar button that opens the assistant; the same on every page. */
export const assistantButton = () => `<button class="btn" type="button" data-assistant>Ask AI</button>`;

/** What the assistant sees on the page now on screen; null when it has nothing to offer here. */
export function setAssistantPage(p: AssistantPage | null) {
  if (p?.key !== page?.key) closeAssistant();
  page = p;
}

export const assistantOpen = () => !!panel && !panel.hidden;
/** True while a question is being answered. */
export const assistantBusy = () => busy;

document.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest?.("[data-assistant]")) assistantOpen() ? closeAssistant() : openAssistant();
});

export function openAssistant() {
  if (!page) return;
  panel ??= build();
  if (shownKey !== page.key) reset();
  panel.hidden = false;
  document.body.classList.add("chat-open");
  box().focus();
}

export function closeAssistant() {
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  document.body.classList.remove("chat-open");
}


/** One turn with the project assistant on a page without an assistant of its own: questions and answers, no edits. */
export async function askProjectAssistant(page: AssistPage, pageContext: unknown, digest: string, turns: Turn[]): Promise<Reply> {
  const res = await postJson<{ reply: string; usage: Usage }>("/api/chat", { page, pageContext, digest, turns }, "assist");
  return { text: res.reply, source: "data", costUsd: res.usage.cost_usd };
}

// ---------- Panel ----------

const box = () => panel!.querySelector<HTMLTextAreaElement>("textarea")!;
const log = () => panel!.querySelector<HTMLElement>(".chat-log")!;

function build(): HTMLElement {
  const el = document.createElement("aside");
  el.className = "chat assistant";
  el.hidden = true;
  el.setAttribute("aria-label", "AI assistant");
  el.innerHTML = `
    <div class="chat-head"><span class="label" data-a-title></span><button class="link" type="button" data-a-close>Close</button></div>
    <div class="chat-log" aria-live="polite"></div>
    <form class="chat-form">
      <div class="a-chip" hidden><span data-a-file></span> <button class="link" type="button" data-a-unattach>Remove</button></div>
      <textarea rows="3" aria-label="Message"></textarea>
      <p class="estimate" data-a-note></p>
      <div class="chat-actions">
        <span class="status"><button class="link" type="button" data-a-attach hidden>Attach image or PDF</button><input type="file" accept="image/*,application/pdf" hidden /></span>
        <button class="btn primary" type="submit">Send</button>
      </div>
    </form>`;
  const form = el.querySelector("form")!;
  const file = el.querySelector<HTMLInputElement>('input[type="file"]')!;
  el.querySelector("[data-a-close]")!.addEventListener("click", closeAssistant);
  el.querySelector("[data-a-attach]")!.addEventListener("click", () => file.click());
  el.querySelector("[data-a-unattach]")!.addEventListener("click", () => setAttachment(null));
  file.addEventListener("change", () => void attach(file));
  el.querySelector("textarea")!.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.querySelector("dialog[open]")) closeAssistant();
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void send();
  });
  document.body.appendChild(el);
  return el;
}

function reset() {
  const p = page!;
  shownKey = p.key;
  turns = (p.history ?? []).map((m) => ({ role: m.role, content: m.text }));
  setAttachment(null);
  panel!.querySelector("[data-a-title]")!.textContent = p.title;
  panel!.querySelector("[data-a-note]")!.textContent = p.note ?? "";
  panel!.querySelector<HTMLElement>("[data-a-attach]")!.hidden = !p.attachments;
  box().placeholder = p.placeholder ?? "Ask a question…";
  log().innerHTML = `<p class="chat-hint">${esc(p.hint)}</p>`;
  for (const m of p.history ?? []) m.role === "user" ? addMessage("user", m.text) : addReply({ text: m.text, meta: m.meta, source: m.source, costUsd: m.costUsd });
}

function addMessage(role: "user" | "error", text: string): HTMLElement {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.innerHTML = esc(text).replace(/\n/g, "<br>");
  log().appendChild(div);
  log().scrollTop = log().scrollHeight;
  return div;
}

const SOURCE: Record<Source, string> = { data: "From page data", pdfs: "Read the PDFs" };

function addReply(r: Reply, replace?: HTMLElement): HTMLElement {
  const div = document.createElement("div");
  div.className = "msg assistant";
  const meta = [r.meta, r.source && SOURCE[r.source]].filter(Boolean).join(" · ");
  div.innerHTML = esc(r.text).replace(/\n/g, "<br>") + (meta ? `<span class="updated">${esc(meta)}</span>` : "");
  if (r.retry) {
    const btn = document.createElement("button");
    btn.className = "link a-retry";
    btn.type = "button";
    btn.textContent = r.retry.label;
    btn.addEventListener("click", () => void retry(div, r.retry!.run));
    div.appendChild(btn);
  }
  if (replace) replace.replaceWith(div);
  else log().appendChild(div);
  log().scrollTop = log().scrollHeight;
  return div;
}

/** The wait, so it's clear the question is being worked on. */
function waiting(): () => void {
  const el = document.createElement("div");
  el.className = "msg assistant pending";
  log().appendChild(el);
  const started = Date.now();
  const show = () => {
    const secs = Math.round((Date.now() - started) / 1000);
    el.innerHTML = `<span class="dots"><i></i><i></i><i></i></span> ${esc(page?.progress?.(secs) ?? "Thinking")}… <span class="secs">${secs}s</span>`;
    log().scrollTop = log().scrollHeight;
  };
  show();
  const tick = setInterval(show, 1000);
  return () => {
    clearInterval(tick);
    el.remove();
  };
}

function setBusy(on: boolean) {
  busy = on;
  box().disabled = on;
  panel!.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled = on;
  panel!.querySelectorAll<HTMLButtonElement>(".a-retry").forEach((b) => (b.disabled = on));
  if (!on) box().focus();
}

function digestFor(p: AssistantPage): Promise<string> {
  if (!p.projectId) return Promise.resolve("");
  const key = `${p.projectId}:${p.part}`;
  if (!digests.has(key)) digests.set(key, buildDigest(p.projectId, p.part).catch(() => ""));
  return digests.get(key)!;
}

async function send() {
  const p = page;
  const text = box().value.trim();
  if (!p || busy || (!text && !attachment)) return;
  if (turns.length >= MAX_TURNS) {
    addMessage("error", "This conversation is long. Close the panel and open it again to start a new one.");
    return;
  }
  const file = attachment;
  const question = text || `Look at the attached ${file?.mediaType === "application/pdf" ? "PDF" : "image"} and suggest changes.`;
  box().value = "";
  setAttachment(null);
  addMessage("user", file ? `${question}\n[Attached: ${file.name}]` : question);
  setBusy(true);
  const done = waiting();
  const sent: Turn[] = [...turns, { role: "user", content: question }];
  try {
    const reply = await p.ask(sent, { digest: await digestFor(p), attachment: file });
    if (page?.key !== p.key) return; // the page changed while waiting
    turns = [...sent, { role: "assistant", content: reply.turn ?? reply.text }];
    addReply(reply);
  } catch (err) {
    if (page?.key !== p.key) return;
    box().value = text; // give the question back for a retry
    if (file) setAttachment(file);
    addMessage("error", `Couldn't get an answer: ${(err as Error).message}`);
  } finally {
    done();
    setBusy(false);
  }
}

/** Runs a reply's follow-up (e.g. re-reading the PDFs); its answer takes the reply's place. */
async function retry(div: HTMLElement, run: () => Promise<Reply>) {
  const p = page;
  if (!p || busy) return;
  setBusy(true);
  const done = waiting();
  try {
    const reply = await run();
    if (page?.key !== p.key) return;
    if (turns.at(-1)?.role === "assistant") turns[turns.length - 1] = { role: "assistant", content: reply.turn ?? reply.text };
    addReply(reply, div);
  } catch (err) {
    if (page?.key === p.key) addMessage("error", `Couldn't get an answer: ${(err as Error).message}`);
  } finally {
    done();
    setBusy(false);
  }
}

// ---------- Attachments ----------

function setAttachment(a: Attachment | null) {
  attachment = a;
  const chip = panel!.querySelector<HTMLElement>(".a-chip")!;
  chip.hidden = !a;
  chip.querySelector("[data-a-file]")!.textContent = a ? a.name : "";
}

async function attach(input: HTMLInputElement) {
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) {
    addMessage("error", `${file.name} is over 3 MB. Try a screenshot of the pages that matter.`);
    return;
  }
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  setAttachment({ name: file.name, mediaType: file.type || "application/octet-stream", base64 });
}
