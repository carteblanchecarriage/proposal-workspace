import { DISCIPLINES, firmDisciplines, toDisciplines } from "../lib/disciplines";
import { confirmDelete, confirmModal, formModal, noticeModal } from "./modal";
import { COLUMNS, downloadCsv, MAX_BYTES, planImport, templateCsv, type Issue } from "./consultants-csv";
import { deleteConsultant, listComparisons, listConsultants, saveConsultant, savesShared, type SavedConsultant } from "./store";
import { contactText, parseContacts, type Contact } from "./contacts";
import { esc, firmName } from "./table";
import { plural } from "../lib/format";

// Consultants: a directory kept in the database (add, edit, delete), plus any firm whose proposal has been read.
// Firms are grouped by governing discipline first, then by any other specialty, A–Z.

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type Firm = {
  key: string;
  name: string;
  disciplines: string[];
  specialties: string[];
  location?: string;
  contacts: Contact[];
  website?: string;
  certifications?: string;
  notes?: string;
  saved?: SavedConsultant;
};

let firms: Firm[] = [];
let filter = "";
let initialized = false;

/** "Smith Engineering, Inc." and "smith engineering" are the same firm. */
export const keyOf = (name: string) => firmName(name).toLowerCase().replace(/[^a-z0-9]/g, "");
const splitList = (s: string) => s.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
const uniq = (xs: string[]) => [...new Map(xs.map((x) => [x.toLowerCase(), x])).values()];
/** Only http(s) links become clickable. */
const safeUrl = (u?: string) => {
  if (!u) return "";
  try {
    const url = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
};

export async function showConsultants() {
  if (!initialized) {
    initialized = true;
    $("consultants-page").addEventListener("click", onClick);
    $("consultants-page").addEventListener("input", (e) => {
      const el = e.target as HTMLInputElement;
      if (!el.matches("[data-filter]")) return;
      filter = el.value;
      renderList();
    });
    $("consultants-page").addEventListener("change", (e) => {
      const el = e.target as HTMLInputElement;
      if (!el.matches("[data-import-csv]") || !el.files?.[0]) return;
      const file = el.files[0];
      el.value = "";
      void importCsv(file);
    });
  }
  await load();
  render();
}

async function load() {
  const [saved, cmps] = await Promise.all([listConsultants(), listComparisons()]);
  const byKey = new Map<string, Firm>();
  const get = (name: string) => {
    const key = keyOf(name);
    let f = byKey.get(key);
    if (!f) byKey.set(key, (f = { key, name: firmName(name), disciplines: [], specialties: [], contacts: [] }));
    return f;
  };
  for (const c of cmps)
    for (const p of c.proposals) {
      if (!p.firm) continue;
      const f = get(p.firm);
      f.disciplines = toDisciplines([...f.disciplines, ...(p.disciplines ?? [])]);
      if (!f.contacts.length) f.contacts = parseContacts(p.contact);
    }
  // The directory record wins over what was read from a proposal.
  for (const s of saved) {
    const f = get(s.name);
    Object.assign(f, {
      name: s.name,
      saved: s,
      // A specialty that names a governing discipline (e.g. "Food service") is listed under that discipline instead.
      disciplines: toDisciplines([...firmDisciplines(s), ...f.disciplines]),
      specialties: (s.specialties ?? []).filter((x) => !firmDisciplines({ specialties: [x] }).length),
      location: s.location,
      contacts: s.contacts ?? (s.contact ? parseContacts(s.contact) : f.contacts),
      website: s.website,
      certifications: s.certifications,
      notes: s.notes,
    });
  }
  firms = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function render() {
  $("consultants-page").innerHTML = `
    <input class="filter" data-filter type="search" placeholder="Search firms, disciplines, locations or certifications…" aria-label="Search consultants" value="${esc(filter)}" />
    <div class="consultants-actions">
      <button class="btn" data-add>Add consultant</button>
      <label class="btn">Import CSV<input type="file" accept=".csv,text/csv" hidden data-import-csv /></label>
      <button class="link" data-csv-template>Download CSV template</button>
    </div>
    <details class="csv-help">
      <summary>How the CSV import works</summary>
      <p>Download the template, fill it in (in Excel, Google Sheets or Numbers) and save it as CSV, then choose Import CSV. Use one row per contact: a firm with three contacts takes three rows with the same firm name.</p>
      <p><b>Columns:</b> ${COLUMNS.map(esc).join(", ")}. Only Firm name is required, plus at least one discipline per firm. Separate several disciplines with semicolons.</p>
      <p><b>Disciplines:</b> ${DISCIPLINES.map(esc).join("; ")}. Others, like Audiovisual, go in the Other disciplines column.</p>
      <p>You see what will be added before anything is saved. Firms already here get new disciplines and contacts, and empty details filled in; nothing saved is overwritten or deleted.</p>
    </details>
    ${savesShared() ? "" : `<p class="estimate">Saved in this browser only until the database is set up.</p>`}
    <div id="consultant-list"></div>`;
  renderList();
}

/** A labeled line on a card, e.g. "Location: Pittsburgh, PA". Value is already escaped HTML. */
const line = (label: string, html: string) => (html ? `<p><b>${label}:</b> ${html}</p>` : "");
export const siteLink = (website?: string) => {
  const url = safeUrl(website);
  return url ? `<a class="link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(new URL(url).hostname.replace(/^www\./, ""))}</a>` : "";
};
// 14px line icons: two overlapping sheets (copy), and a checkmark shown briefly after copying.
const COPY_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;
const DONE_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** One block per contact: name and role, then email (with a copy icon) and phone. */
export const contactsHtml = (cs: Contact[]) =>
  cs
    .map((c) => {
      const who = [c.name, c.role].filter(Boolean).map(esc).join(", ");
      const email = c.email
        ? `<a class="link" href="mailto:${esc(c.email)}">${esc(c.email)}</a><button class="copy-email" data-copy-email="${esc(c.email)}" aria-label="Copy ${esc(c.email)}" title="Copy email">${COPY_ICON}</button>`
        : "";
      return `<span class="contact">${[who, email, esc(c.phone)].filter(Boolean).join("<br />")}</span>`;
    })
    .join("");

/** Governing disciplines in list order, then other specialties A–Z, then firms with neither ("Other"). */
function renderList() {
  const el = document.getElementById("consultant-list");
  if (!el) return;
  const q = filter.trim().toLowerCase();
  const groups = new Map<string, Firm[]>();
  for (const f of firms) {
    const text = [f.name, f.location, ...f.contacts.map(contactText), f.certifications, f.notes].join(" ").toLowerCase();
    const all = [...f.disciplines, ...f.specialties];
    for (const g of all.length ? all : ["Other"]) {
      if (q && !text.includes(q) && !g.toLowerCase().includes(q)) continue;
      groups.set(g, [...(groups.get(g) ?? []), f]);
    }
  }
  const rank = (g: string) => {
    const i = (DISCIPLINES as readonly string[]).indexOf(g);
    return i >= 0 ? i : g === "Other" ? 2000 : 1000;
  };
  const sorted = [...groups].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
  el.innerHTML = sorted.length
    ? sorted.map(([g, fs]) => `<h2 class="group">${esc(g)}</h2><div class="cards">${fs.map(firmHtml).join("")}</div>`).join("")
    : `<p class="none">${firms.length ? "No consultants match." : "No consultants yet. Add one to get started."}</p>`;
}

function firmHtml(f: Firm): string {
  return `<div class="card">
    <h3>${esc(f.name)}</h3>
    <p class="disc">${esc([...f.disciplines, ...f.specialties].join(", "))}</p>
    <div class="card-body">
      ${line("Location", esc(f.location ?? ""))}
      ${line("Contacts", contactsHtml(f.contacts))}
      ${line("Website", siteLink(f.website))}
      ${line("Certifications", esc(f.certifications ?? ""))}
      ${line("Notes", esc(f.notes ?? ""))}
    </div>
    <div class="card-actions">
      <button class="link" data-edit="${esc(f.key)}">${f.saved ? "Edit" : "Add details"}</button>
      ${f.saved ? `<button class="link" data-delete="${esc(f.key)}">Delete</button>` : ""}
    </div>
  </div>`;
}

/** Every specialty in the directory (plus this firm's own), A–Z, offered as checkboxes. */
const knownSpecialties = (own: string[]) => uniq([...firms.flatMap((f) => f.specialties), ...own]).sort((a, b) => a.localeCompare(b));

/** Asks for a consultant's details and saves them; resolves false on cancel or failure. */
async function editConsultant(start: Partial<SavedConsultant>): Promise<boolean> {
  const values = await formModal({
    title: start.id ? "Edit consultant" : "Add consultant",
    fields: [
      { label: "Firm name", value: start.name ?? "", required: true },
      { label: "Disciplines", value: firmDisciplines(start).join("\n"), options: DISCIPLINES },
      { label: "Other disciplines", value: (start.specialties ?? []).filter((s) => !firmDisciplines({ specialties: [s] }).length).join("\n"), options: knownSpecialties(start.specialties ?? []) },
      { label: "New discipline", value: "", placeholder: "Not listed above? Type it, e.g. Audiovisual" },
      { label: "Location", value: start.location ?? "", placeholder: "City, state" },
      { label: "Contacts", value: JSON.stringify(start.contacts ?? parseContacts(start.contact)), contacts: true },
      { label: "Website", value: start.website ?? "" },
      { label: "Certifications", value: start.certifications ?? "", placeholder: "e.g. WBE, MBE, DBE" },
      { label: "Notes", value: start.notes ?? "" },
    ],
    confirm: "Save",
    // At least one discipline or specialty, so the firm shows up under a heading.
    validate: ([, disciplines, specialties, added]) => !!(disciplines || specialties || added.trim()),
  });
  if (!values) return false;
  const [name, disciplines, specialties, added, location, contacts, website, certifications, notes] = values;
  const record: SavedConsultant = {
    id: start.id ?? crypto.randomUUID(),
    savedAt: Date.now(),
    name,
    disciplines: toDisciplines(disciplines.split("\n")),
    specialties: uniq([...specialties.split("\n").map((s) => s.trim()).filter(Boolean), ...splitList(added)]).filter((s) => !toDisciplines([s]).some((d) => d === s)),
    location: location || undefined,
    contacts: JSON.parse(contacts) as Contact[],
    website: website || undefined,
    certifications: certifications || undefined,
    notes: notes || undefined,
    source: start.source ?? "manual",
  };
  try {
    await saveConsultant(record);
    return true;
  } catch (err) {
    await noticeModal("Not saved", (err as Error).message);
    return false;
  }
}

export async function copyEmail(button: HTMLElement) {
  const email = button.getAttribute("data-copy-email") ?? "";
  try {
    await navigator.clipboard.writeText(email);
  } catch {
    prompt("Copy this email:", email); // clipboard blocked (e.g. non-HTTPS page)
    return;
  }
  button.innerHTML = DONE_ICON;
  button.setAttribute("aria-label", `Copied ${email}`);
  setTimeout(() => {
    button.innerHTML = COPY_ICON;
    button.setAttribute("aria-label", `Copy ${email}`);
  }, 1500);
}

const issueList = (title: string, issues: Issue[], max = 15) =>
  issues.length
    ? `<h3 class="csv-issues-head">${esc(title)} (${issues.length})</h3><ul class="csv-issues">${issues
        .slice(0, max)
        .map((i) => `<li>${i.row ? `Row ${i.row}: ` : ""}${esc(i.message)}</li>`)
        .join("")}${issues.length > max ? `<li>…and ${issues.length - max} more.</li>` : ""}</ul>`
    : "";

/** Reads a CSV, shows what it would add (and any problems), then saves on confirmation. */
async function importCsv(file: File) {
  if (!/\.csv$/i.test(file.name) && file.type !== "text/csv")
    return noticeModal("Not a CSV file", "Save the spreadsheet as CSV (File → Save As or Download → CSV), then import that file.");
  if (file.size > MAX_BYTES) return noticeModal("File too large", "Import at most 2 MB at a time. Split the file and import each part.");
  const existing = await listConsultants();
  const plan = planImport(await file.text(), existing);
  if ("fatal" in plan) return noticeModal("Couldn't read the file", plan.fatal);
  const summary = plan.records.length
    ? `<p>${[
        plan.added ? `${plural(plan.added, "firm")} to add` : "",
        plan.updated ? `${plural(plan.updated, "firm")} already here to update` : "",
        plan.contacts ? `${plan.contacts} new contact${plan.contacts === 1 ? "" : "s"}` : "",
      ]
        .filter(Boolean)
        .join(", ")}.</p>`
    : `<p>Nothing to import${plan.errors.length ? ": every row has a problem" : ": everything in the file is already here"}.</p>`;
  const html = `${summary}${issueList("Left out", plan.errors)}${issueList("Notes", plan.warnings)}`;
  if (!plan.records.length) return void (await confirmModal({ title: "Import consultants", body: "", html, confirm: "OK", single: true, wide: true }));
  const ok = await confirmModal({
    title: "Import consultants",
    body: "",
    html,
    confirm: `Import ${plural(plan.records.length, "firm")}`,
    wide: true,
  });
  if (!ok) return;
  let saved = 0;
  const failed: string[] = [];
  const queue = [...plan.records];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        try {
          await saveConsultant(r);
          saved++;
        } catch {
          failed.push(r.name);
        }
      }
    }),
  );
  await load();
  render();
  if (failed.length) await noticeModal("Some firms weren't saved", `Saved ${plural(saved, "firm")}. Not saved: ${failed.join(", ")}. Try importing the file again; firms already saved won't be duplicated.`);
}

async function onClick(e: Event) {
  const t = e.target as HTMLElement;
  if (t.closest("[data-csv-template]")) return downloadCsv("Consultants template.csv", templateCsv());
  const firm = (attr: string) => firms.find((f) => f.key === t.closest(`[${attr}]`)?.getAttribute(attr));
  let changed = false;
  const copy = t.closest<HTMLElement>("[data-copy-email]");
  if (copy) return copyEmail(copy);
  if (t.closest("[data-add]")) changed = await editConsultant({});
  else if (t.closest("[data-edit]")) {
    const f = firm("data-edit");
    if (f) changed = await editConsultant(f.saved ?? { name: f.name, disciplines: f.disciplines, contacts: f.contacts });
  } else if (t.closest("[data-delete]")) {
    const f = firm("data-delete");
    if (!f?.saved || !(await confirmDelete("consultant"))) return;
    try {
      await deleteConsultant(f.saved.id);
      changed = true;
    } catch (err) {
      return noticeModal("Couldn't delete", (err as Error).message);
    }
  }
  if (changed) {
    await load();
    render();
  }
}
