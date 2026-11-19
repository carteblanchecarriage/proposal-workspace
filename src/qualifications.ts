// The organization's standard qualifications and exclusions, on the Organization page: a numbered list the team keeps
// once and copies into proposals. Empty until the organization writes its own; read-only until Edit, and saved only
// on Save (Cancel or Escape drops the changes).
import { confirmModal } from "./modal";
import { getQualifications, saveQualifications } from "./store";
import { esc } from "./table";

const MAX_ITEMS = 100;
const MAX_ITEM = 1_000;

let items: string[] = [];
let draft: string | null = null;
let root: HTMLElement | null = null;
let status = "";
let statusError = false;
let loadFailed = false;
let bound = false;

/** Fills the Qualifications and exclusions section of the Organization page. */
export async function renderQualifications(section: HTMLElement) {
  root = section;
  draft = null;
  status = "";
  section.innerHTML = `<span class="status">Loading…</span>`;
  section.addEventListener("click", onClick);
  if (!bound) {
    bound = true;
    // Escape leaves editing without saving, like Cancel (a dialog on top handles its own Escape first).
    addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || draft == null || !root?.isConnected || document.querySelector("dialog[open]")) return;
      draft = null;
      render();
    });
  }
  try {
    items = await getQualifications();
    loadFailed = false;
  } catch {
    items = [];
    loadFailed = true; // editing stays off, so an empty list can't be saved over the real one
  }
  render();
}

/** One item per line; bullets and numbering typed or pasted in front are dropped. */
const parse = (text: string) =>
  text
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-–•*·]|\d+[.)])\s*/, "").trim().slice(0, MAX_ITEM))
    .filter(Boolean)
    .slice(0, MAX_ITEMS);

function render() {
  if (!root?.isConnected) return;
  const editing = draft != null;
  root.classList.toggle("editing", editing);
  root.innerHTML = `
    <div class="settings-head">
      <h2 class="label">Qualifications and exclusions</h2>
      ${
        editing
          ? `<span class="settings-editing">Editing</span>`
          : loadFailed
            ? ""
            : `<span class="tools"><button class="btn" data-qual-copy ${items.length ? "" : "disabled"}>Copy</button><button class="btn" data-qual-edit>Edit</button></span>`
      }
    </div>
    ${loadFailed ? `<p class="status error">Couldn't load your qualifications and exclusions. Reload the page to edit them.</p>` : ""}
    ${
      editing
        ? `<label class="edit-field"><span>One per line; they're numbered in order</span><textarea data-qual-text rows="${Math.max(8, items.length + 2)}">${esc(draft!)}</textarea></label>
           <div class="actions"><button class="btn primary" data-qual-save>Save</button><button class="btn" data-qual-cancel>Cancel</button></div>`
        : items.length
          ? `<ol class="qual-list">${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ol>`
          : `<p class="none">None yet.</p>`
    }
    <span class="status ${statusError ? "error" : ""}" data-qual-status>${esc(status)}</span>`;
  if (editing) root.querySelector<HTMLTextAreaElement>("[data-qual-text]")?.focus();
}

async function onClick(e: Event) {
  const t = e.target as HTMLElement;
  if (t.closest("[data-qual-edit]")) {
    draft = items.join("\n");
    status = "";
  } else if (t.closest("[data-qual-cancel]")) draft = null;
  else if (t.closest("[data-qual-copy]")) return copy();
  else if (t.closest("[data-qual-save]") && draft != null) {
    const next = parse(root!.querySelector<HTMLTextAreaElement>("[data-qual-text]")?.value ?? "");
    if (next.join("\n") === items.join("\n")) {
      draft = null;
      return render();
    }
    const ok = await confirmModal({
      title: "Save the qualifications and exclusions?",
      body: "They're shared by everyone in the organization.",
      confirm: "Save",
    });
    if (!ok) return;
    try {
      await saveQualifications(next);
      items = next;
      draft = null;
      statusError = false;
      status = "Saved.";
    } catch (err) {
      statusError = true;
      status = (err as Error).message;
    }
  } else return;
  render();
}

/** Copies the list numbered: a real numbered list in Word and Google Docs, "1. " lines anywhere else. */
async function copy() {
  const el = root?.querySelector<HTMLElement>("[data-qual-status]");
  const html = `<ol>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ol>`;
  const text = items.map((i, n) => `${n + 1}. ${i}`).join("\n");
  try {
    await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })]);
  } catch {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      if (el) (el.textContent = "Couldn't copy. Select the list and copy it instead."), el.classList.add("error");
      return;
    }
  }
  if (el) (el.textContent = `Copied ${items.length === 1 ? "1 item" : `${items.length} items`}.`), el.classList.remove("error");
}
