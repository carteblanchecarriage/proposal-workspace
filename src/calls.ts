import { confirmDelete, formModal, noticeModal } from "./modal";
import { getCallSources, saveCallSources, type CallSource } from "./store";
import { esc } from "./table";

// Open Calls: RFPs and design selections advertised by the organization's own sources (agency bids pages, procurement
// portals), which each organization adds, edits and removes. Calls themselves aren't collected yet; the page is laid
// out so they can be filled in once requests to the sources are built.

/** One advertised opportunity, as it will come from a source. */
export type OpenCall = {
  source: CallSource["id"];
  issuer: string;
  title: string;
  /** "YYYY-MM-DD", or "" when the listing doesn't give one */
  due: string;
  url: string;
};

// Filled in once requests to the sources exist.
const calls: OpenCall[] = [];

let sources: CallSource[] = [];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dueText = (due: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due);
  return m ? `Due ${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}` : "Due date not listed";
};
const external = (url: string, text: string) => `<a class="link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`;

/** A web address as typed ("example.gov/bids" or a full link), as an http(s) link; null if it isn't one. */
function webAddress(typed: string): string | null {
  const t = typed.trim();
  if (!t || /\s/.test(t)) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname.includes(".") ? u.href : null;
  } catch {
    return null;
  }
}

/** Initials for a source without a short name: "Cleveland State University" → "CSU". */
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]/.test(w) && !/^(of|the|and|for|&)$/i.test(w))
    .map((w) => w[0].toUpperCase())
    .join("")
    .slice(0, 6);

export async function showCalls() {
  const page = document.getElementById("calls-page")!;
  page.innerHTML = `<h2 class="group">Open calls</h2><span class="status">Loading…</span>`;
  try {
    sources = await getCallSources();
  } catch (err) {
    page.innerHTML = `<h2 class="group">Open calls</h2><span class="status error">${esc((err as Error).message)}</span>`;
    return;
  }
  render();
}

function render() {
  // Soonest deadline first; calls without a due date last.
  const sorted = [...calls].sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
  const page = document.getElementById("calls-page")!;
  page.innerHTML = `
    <h2 class="group">Open calls</h2>
    ${
      sorted.length
        ? `<div class="cards">${sorted
            .map(
              (c) => `<div class="card call">
                <p class="call-issuer">${esc(c.issuer)}</p>
                <h3>${esc(c.title)}</h3>
                <div class="card-body"><p>${esc(dueText(c.due))}</p></div>
                <div class="card-actions">${external(c.url, "View listing")}</div>
              </div>`,
            )
            .join("")}</div>`
        : `<p class="none">None collected yet. Until then, check your sources below.</p>`
    }

    <h2 class="group">Sources <button class="link edit-link" type="button" data-add-source>+ Add source</button></h2>
    ${
      sources.length
        ? `<div class="cards sources">${sources
            .map(
              (s) => `<div class="card source">
        <p class="source-code">${esc(s.code)}</p>
        <h3>${esc(s.name)}</h3>
        <div class="card-body"><p>${esc(s.scope)}</p></div>
        <div class="card-actions">${external(s.url, "Open site")}<button class="link" type="button" data-edit-source="${esc(s.id)}">Edit</button><button class="link" type="button" data-delete-source="${esc(s.id)}">Delete</button></div>
      </div>`,
            )
            .join("")}</div>`
        : `<p class="none">No sources yet. Add the websites where your firm watches for RFPs: a city or county bids page, a school district, a university, a state design-selection page.</p>`
    }`;
}

/** The add / edit form. Returns the source, or null if cancelled. */
async function sourceForm(existing?: CallSource): Promise<CallSource | null> {
  const values = await formModal({
    title: existing ? "Edit source" : "Add a source",
    fields: [
      { label: "Name", value: existing?.name ?? "", placeholder: "e.g. Cuyahoga County Public Works", required: true },
      { label: "Website (its bids or RFP page)", value: existing?.url ?? "", placeholder: "e.g. cuyahogacounty.gov/publicworks/…", required: true },
      { label: "What it covers (optional)", value: existing?.scope ?? "", placeholder: "e.g. County buildings, roads and bridges." },
      { label: "Short name (optional)", value: existing?.code ?? "", placeholder: "e.g. CCPW" },
    ],
    confirm: existing ? "Save" : "Add source",
    validate: (v) => !!v[0].trim() && !!webAddress(v[1]),
  });
  if (!values) return null;
  const [name, url, scope, code] = values.map((v) => v.trim());
  return {
    id: existing?.id ?? crypto.randomUUID(),
    name: name.slice(0, 160),
    url: webAddress(url)!,
    scope: scope.slice(0, 400),
    code: (code || initials(name)).slice(0, 12),
  };
}

async function save(next: CallSource[]) {
  try {
    await saveCallSources(next);
    sources = next;
    render();
  } catch (err) {
    await noticeModal("Couldn't save", (err as Error).message);
  }
}

document.getElementById("calls-page")?.addEventListener("click", async (e) => {
  const t = e.target as HTMLElement;
  if (t.closest("[data-add-source]")) {
    const s = await sourceForm();
    if (s) await save([...sources, s]);
    return;
  }
  const editId = t.closest<HTMLElement>("[data-edit-source]")?.dataset.editSource;
  if (editId) {
    const existing = sources.find((s) => s.id === editId);
    const s = existing && (await sourceForm(existing));
    if (s) await save(sources.map((x) => (x.id === s.id ? s : x)));
    return;
  }
  const deleteId = t.closest<HTMLElement>("[data-delete-source]")?.dataset.deleteSource;
  if (deleteId && (await confirmDelete("source"))) await save(sources.filter((s) => s.id !== deleteId));
});
