// Consultants to and from a spreadsheet: a CSV template to fill in, and an import with plain checks (no AI).
// One row per contact; a firm with several contacts takes several rows with the same firm name.

import { DISCIPLINES, toDisciplines } from "../lib/disciplines";
import { parseContacts, type Contact } from "./contacts";
import type { SavedConsultant } from "./store";
import { firmName } from "./table";

export const COLUMNS = [
  "Firm name",
  "Disciplines",
  "Other disciplines",
  "Location",
  "Website",
  "Certifications",
  "Notes",
  "Contact name",
  "Contact role",
  "Contact email",
  "Contact phone",
] as const;
type Column = (typeof COLUMNS)[number];

/** Other headings people use for the same columns. */
const ALIASES: Record<string, Column> = {
  firm: "Firm name", company: "Firm name", firmname: "Firm name", companyname: "Firm name", name: "Firm name",
  discipline: "Disciplines", specialty: "Other disciplines", specialties: "Other disciplines", otherdiscipline: "Other disciplines", city: "Location", website: "Website", url: "Website",
  certification: "Certifications", note: "Notes",
  contact: "Contact name", contactname: "Contact name", role: "Contact role", title: "Contact role",
  email: "Contact email", phone: "Contact phone", telephone: "Contact phone",
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
const COLUMN_BY_NORM = new Map<string, Column>([...COLUMNS.map((c) => [norm(c), c] as [string, Column]), ...Object.entries(ALIASES)]);

const EXAMPLE_FIRM = "Example Engineering";
export const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 5000;

// ---------- CSV ----------

const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const toCsv = (rows: string[][]) => rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";

/**
 * Parses CSV text (quoted fields, doubled quotes, line breaks inside quotes, CRLF or LF). A semicolon-separated file
 * (some regional Excel versions) is read too. Throws on an unclosed quote.
 */
export function parseCsv(text: string): string[][] {
  text = text.replace(/^﻿/, "");
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const sep = !firstLine.includes(",") && firstLine.includes(";") ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === sep) row.push(field), (field = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field), rows.push(row), (row = []), (field = "");
    } else field += ch;
  }
  if (quoted) throw new Error("A quoted field is never closed (a missing \" somewhere). Check the file in a spreadsheet and save it as CSV again.");
  if (field !== "" || row.length) row.push(field), rows.push(row);
  return rows;
}

/** The template: the headings and an example firm with two contacts (the import skips the example). */
export function templateCsv(): string {
  return (
    "﻿" + // so Excel reads accents and symbols correctly
    toCsv([
      [...COLUMNS],
      [EXAMPLE_FIRM, "Mechanical; Electrical; Plumbing", "Lighting design", "Cleveland, OH", "exampleeng.com", "WBE", "Teamed on two library projects", "Jane Smith", "Principal", "jane@exampleeng.com", "216-555-0100"],
      [EXAMPLE_FIRM, "", "", "", "", "", "", "Sam Lee", "Project Manager", "sam@exampleeng.com", "216-555-0101"],
    ])
  );
}

export function downloadCsv(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------- Import ----------

export type Issue = { row: number | null; message: string };
export type ImportPlan = {
  /** records to save: new firms, and existing firms with what the file adds */
  records: SavedConsultant[];
  added: number;
  updated: number;
  contacts: number;
  errors: Issue[];
  warnings: Issue[];
};

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
const keyOf = (name: string) => firmName(name).toLowerCase().replace(/[^a-z0-9]/g, "");
const list = (s: string) => s.split(/[;\n]|,(?!\s*(?:Inc|LLC|Ltd)\b)/i).map((x) => x.trim()).filter(Boolean);
const okUrl = (u: string) => {
  try {
    const url = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.includes(".");
  } catch {
    return false;
  }
};
const sameContact = (a: Contact, b: Contact) =>
  a.email && b.email ? a.email.toLowerCase() === b.email.toLowerCase() : !!a.name && a.name.toLowerCase() === b.name.toLowerCase();

/** Reads the file's rows into firms, checks them, and works out what importing would add. Saves nothing. */
export function planImport(text: string, existing: SavedConsultant[]): ImportPlan | { fatal: string } {
  let rows: string[][];
  try {
    rows = parseCsv(text);
  } catch (err) {
    return { fatal: (err as Error).message };
  }
  rows = rows.filter((r) => r.some((c) => c.trim()));
  if (rows.length < 2) return { fatal: "The file has no rows under the headings." };
  if (rows.length - 1 > MAX_ROWS) return { fatal: `The file has ${rows.length - 1} rows; import at most ${MAX_ROWS} at a time.` };

  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  // Columns by heading, in any order.
  const index = new Map<Column, number>();
  rows[0].forEach((h, i) => {
    const col = COLUMN_BY_NORM.get(norm(h));
    if (col && !index.has(col)) index.set(col, i);
    else if (h.trim()) warnings.push({ row: 1, message: `The column “${h.trim()}” isn't one of the template's, so it's ignored.` });
  });
  if (!index.has("Firm name")) return { fatal: "No “Firm name” column. Start from the template so the headings match." };
  const get = (r: string[], c: Column) => (index.has(c) ? (r[index.get(c)!] ?? "").trim() : "");

  type Draft = { name: string; rows: number[]; disciplines: Set<string>; specialties: Set<string>; contacts: Contact[]; fields: Partial<Record<"location" | "website" | "certifications" | "notes", string>> };
  const drafts = new Map<string, Draft>();
  let exampleSkipped = false;

  rows.slice(1).forEach((r, i) => {
    const line = i + 2; // the spreadsheet's row number (the headings are row 1)
    const name = get(r, "Firm name");
    if (!name) return void errors.push({ row: line, message: "No firm name, so this row is left out." });
    const key = keyOf(name);
    if (!key) return void errors.push({ row: line, message: `“${name}” isn't a usable firm name, so this row is left out.` });
    if (key === keyOf(EXAMPLE_FIRM)) return void (exampleSkipped = true);

    const contact: Contact = { name: get(r, "Contact name"), role: get(r, "Contact role"), email: get(r, "Contact email"), phone: get(r, "Contact phone") };
    if (contact.email && !EMAIL.test(contact.email))
      return void errors.push({ row: line, message: `“${contact.email}” isn't a valid email address, so this row is left out.` });
    if (contact.phone && (contact.phone.replace(/\D/g, "").length < 7 || contact.phone.replace(/\D/g, "").length > 15))
      warnings.push({ row: line, message: `Check the phone number “${contact.phone}”; it's kept as written.` });

    let d = drafts.get(key);
    if (!d) drafts.set(key, (d = { name, rows: [], disciplines: new Set(), specialties: new Set(), contacts: [], fields: {} }));
    d.rows.push(line);

    for (const item of list(get(r, "Disciplines"))) {
      const exact = DISCIPLINES.find((x) => x.toLowerCase() === item.toLowerCase());
      if (exact) d.disciplines.add(exact);
      else {
        const mapped = toDisciplines([item]);
        if (mapped.length) {
          mapped.forEach((m) => d!.disciplines.add(m));
          warnings.push({ row: line, message: `“${item}” read as ${mapped.join(", ")}.` });
        } else {
          d.specialties.add(item);
          warnings.push({ row: line, message: `“${item}” isn't on the discipline list, so it's added as another discipline.` });
        }
      }
    }
    for (const s of list(get(r, "Other disciplines"))) {
      const asDiscipline = DISCIPLINES.find((x) => x.toLowerCase() === s.toLowerCase());
      asDiscipline ? d.disciplines.add(asDiscipline) : d.specialties.add(s);
    }

    const fields = { location: get(r, "Location"), website: get(r, "Website"), certifications: get(r, "Certifications"), notes: get(r, "Notes") };
    if (fields.website && !okUrl(fields.website)) {
      warnings.push({ row: line, message: `“${fields.website}” doesn't look like a website, so it's left out.` });
      fields.website = "";
    }
    for (const [k, v] of Object.entries(fields) as [keyof Draft["fields"], string][]) {
      if (!v) continue;
      if (!d.fields[k]) d.fields[k] = v;
      else if (d.fields[k] !== v) warnings.push({ row: line, message: `${name} has a different ${k} on an earlier row; the first is kept.` });
    }

    if (contact.name || contact.email || contact.phone || contact.role) {
      if (d.contacts.some((c) => sameContact(c, contact))) warnings.push({ row: line, message: `${contact.email || contact.name} is listed twice for ${name}; once is kept.` });
      else d.contacts.push(contact);
    }
  });
  if (exampleSkipped) warnings.unshift({ row: null, message: `The template's example firm (${EXAMPLE_FIRM}) is skipped.` });

  const byKey = new Map(existing.map((c) => [keyOf(c.name), c]));
  const records: SavedConsultant[] = [];
  let added = 0;
  let updated = 0;
  let contacts = 0;
  for (const [key, d] of drafts) {
    const old = byKey.get(key);
    const disciplines = DISCIPLINES.filter((x) => d.disciplines.has(x) || old?.disciplines.includes(x));
    const specialties = [...new Map([...(old?.specialties ?? []), ...d.specialties].map((s) => [s.toLowerCase(), s])).values()];
    if (!disciplines.length && !specialties.length) {
      errors.push({ row: d.rows[0], message: `${d.name} has no discipline, so it's left out (each firm needs one to be listed).` });
      continue;
    }
    if (!old) {
      added++;
      contacts += d.contacts.length;
      records.push({
        id: crypto.randomUUID(),
        savedAt: Date.now(),
        name: firmName(d.name),
        disciplines,
        specialties,
        contacts: d.contacts,
        ...Object.fromEntries(Object.entries(d.fields).filter(([, v]) => v)),
        source: "manual",
      });
      continue;
    }
    // Already in the directory: add what's new, fill in what's empty, never overwrite or remove.
    const oldContacts = old.contacts ?? parseContacts(old.contact);
    const newContacts = d.contacts.filter((c) => !oldContacts.some((o) => sameContact(o, c)));
    const fills = Object.fromEntries(Object.entries(d.fields).filter(([k, v]) => v && !old[k as keyof typeof d.fields]));
    for (const [k, v] of Object.entries(d.fields))
      if (v && old[k as keyof typeof d.fields] && old[k as keyof typeof d.fields] !== v)
        warnings.push({ row: d.rows[0], message: `${old.name} already has a ${k}; the saved one is kept.` });
    const changed =
      newContacts.length || Object.keys(fills).length || disciplines.length !== old.disciplines.length || specialties.length !== (old.specialties ?? []).length;
    if (!changed) continue;
    updated++;
    contacts += newContacts.length;
    records.push({ ...old, savedAt: Date.now(), disciplines, specialties, contacts: [...oldContacts, ...newContacts], ...fills });
  }
  errors.sort((a, b) => (a.row ?? 0) - (b.row ?? 0));
  return { records, added, updated, contacts, errors, warnings };
}
