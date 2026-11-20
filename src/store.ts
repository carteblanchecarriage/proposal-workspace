import { cleanFeeStyle, type FeeStyle } from "./fee-style";
import { emptyWorldView, type Pursuit, type WorldView } from "../lib/worldview";
import type { Comparison, Proposal, QaResult, Rfp } from "../lib/claude";
import type { Contact } from "./contacts";
import type { Sourced } from "./table";
import { authHeaders, authHeadersNow, refreshAuth } from "./auth";
import { unauthorized } from "./api";


export type ChatMessage = { role: "user" | "assistant"; text: string; updated?: boolean; cost?: number | null; /** what the answer read: the page data, or the PDFs too (older messages: the PDFs) */ source?: "data" | "pdfs" };

export type SavedComparison = {
  id: string;
  savedAt: number;
  projectName: string | null;
  projectId?: string;
  proposals: Sourced[];
  cmp: Comparison;
  messages: ChatMessage[];
  /** Total API spend on this comparison (reading, comparing, chat); costPartial if any step's cost was unknown. */
  costUsd?: number;
  costPartial?: boolean;
  /**
   * A section of the project's Consultants page: the discipline row it compares, and which proposals it compared
   * (each one's file hash or name, sorted), so the page can tell when it's out of date.
   */
  group?: { key: string; label: string; signature: string[]; /** 2: compared for this discipline only */ v?: number };
};

/** A PDF's reading, saved by a hash of the file's contents so the same PDF is never paid for twice. */
export type SavedReading = {
  hash: string;
  proposal: Proposal;
  file_id: string;
  /** when file_id was uploaded; Anthropic copies are deleted after a day */
  uploadedAt: number;
  pdf_tokens?: number;
};

export type RfpDocKind = "addendum" | "answers" | "meeting" | "other";
export const RFP_DOC_KINDS: Record<RfpDocKind, string> = {
  addendum: "Addendum",
  answers: "Answers to questions",
  meeting: "Pre-proposal meeting minutes",
  other: "Other document",
};

export type SavedRfp = {
  id: string;
  savedAt: number;
  files: string[];
  rfp: Rfp;
  project?: string | null;
  projectId?: string;
  costUsd?: number | null;
  /** the original PDFs, kept in storage for 30 days from storedAt so page references can open them */
  stored?: { name: string; path: string; /** when this file was kept (addenda come later); else storedAt */ at?: number }[];
  storedAt?: number;
  /** addenda read into the review after it was made, with what each changed (pages are the addendum's) */
  /** Documents added after the RFP (addenda, answers to questions, meeting minutes...), each read into the review. */
  addenda?: {
    number: number;
    /** what it is (older entries are addenda) */
    kind?: RfpDocKind;
    /** the team's title for it, e.g. "Addendum 2" or "Answers to RFI questions" */
    title?: string;
    files: string[];
    at: number;
    changes: { section: string; change: string; page: number }[];
    costUsd: number | null;
    /** where the addendum's first PDF sits in stored, when it was kept */
    storedIndex?: number;
  }[];
  /** the team's world view this review was judged with, and when that world view was saved */
  lens?: { text: string; savedAt: number };
};

const DB = "proposal-comparison";
const STORE = "comparisons";
const READINGS = "readings";
const RFPS = "rfps";
const PROJECTS = "projects";
const CONSULTANTS = "consultants";
const SCHEDULES = "schedules";
const FEES = "fees";
const SETTINGS = "settings";
const PURSUITS = "pursuits";

/** A consultant firm in the directory. Firms from proposals that aren't saved are listed from the proposals. */
export type SavedConsultant = {
  id: string;
  savedAt: number;
  name: string;
  /** from the governing discipline list */
  disciplines: string[];
  /** anything else they do (Audiovisual, Lighting design, ...) */
  specialties?: string[];
  location?: string;
  contacts?: Contact[];
  /** contacts saved before they had separate fields ("Name (Role), email, phone; next person…") */
  contact?: string;
  website?: string;
  certifications?: string;
  notes?: string;
  source: "manual" | "list";
};

/** A consultant's proposal on a project: what was read from its PDF, and when it came in. */
export type ReceivedProposal = {
  id: string;
  /** the project firm (consultant matrix column) it's from: set when it's added, or when the project opens */
  firmId?: string;
  /** the PDF's file name */
  fileName: string;
  receivedAt: number;
  /** content hash of the PDF (the same file isn't read twice) */
  hash?: string | null;
  /** the PDF's copy at the AI provider, for the comparison's chat; deleted there after a day */
  file_id?: string;
  uploadedAt?: number;
  pdf_tokens?: number;
  proposal: Proposal;
};

/** Where a firm stood per discipline, in projects saved before firms had a single decision (ProjectFirm.statuses). */
type ConsultantStatus = "candidate" | "asked" | "teaming";

/** A firm column in the project's consultant matrix. */
export type ProjectFirm = {
  /** stable id for the column (older entries get one when the project opens) */
  id?: string;
  name: string;
  /** the firm's record in the Consultants directory, when there is one */
  consultantId?: string;
  /** what it covers on this project: governing disciplines, or "row:<id>" for the team's own rows */
  disciplines: string[];
  /** using them on this proposal, or getting a fee from them (the default) */
  decision?: "using" | "fee";
  /** the team's note on the firm for this project */
  note?: string;
  /**
   * The team's own marks in the consultant matrix, by row key, over what the proposal (or the firm's disciplines)
   * says: "proposal" (solid, in the proposal), "expected" (hollow) or "none" (empty). Unset: as read.
   */
  cells?: Record<string, "proposal" | "expected" | "none">;
  /** older entries: where the firm stood per discipline */
  statuses?: Record<string, ConsultantStatus>;
};

export type SavedProject = {
  id: string;
  savedAt: number;
  name: string;
  /** The firm's own project number, optional; shown before the name. */
  number?: string;
  rfpId?: string;
  /** Consultants added to the project by hand (firms whose proposals are linked are shown from the proposals). */
  /**
   * Firms for the project's disciplines and where each stands for each discipline (statuses, by discipline): a
   * candidate we're considering, asked (we've reached out), or teaming (willing to propose with us). A discipline with
   * no status counts as asked (entries saved before statuses existed).
   */
  consultants?: ProjectFirm[];
  /** The team's own rows in the consultant matrix (e.g. "Energy and LCA"); cells use "row:<id>" as the discipline. */
  customRows?: { id: string; label: string }[];
  /** Disciplines the RFP review requests that this project doesn't need a consultant for. */
  disciplinesRemoved?: string[];
  /** Disciplines the team added to this project's consultant list (beyond what the RFP review requests). */
  disciplinesAdded?: string[];
  /** Consultant proposals received for the project, each read on its own when it arrived (compared later, any mix). */
  proposals?: ReceivedProposal[];
  /** The last QA/QC check of the firm's own finished proposal. */
  qaqc?: { fileName: string; checkedAt: number; summary: string; flags: QaResult["flags"]; costUsd: number | null };
};

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 8);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(READINGS)) db.createObjectStore(READINGS, { keyPath: "hash" });
      if (!db.objectStoreNames.contains(RFPS)) db.createObjectStore(RFPS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(CONSULTANTS)) db.createObjectStore(CONSULTANTS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(SCHEDULES)) db.createObjectStore(SCHEDULES, { keyPath: "id" });
      if (!db.objectStoreNames.contains(FEES)) db.createObjectStore(FEES, { keyPath: "id" });
      if (!db.objectStoreNames.contains(SETTINGS)) db.createObjectStore(SETTINGS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(PURSUITS)) db.createObjectStore(PURSUITS, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>, store = STORE): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------- Where records are saved ----------
// Supabase (through /api/db, so the key stays on the server) when it's configured; otherwise this browser's
// IndexedDB. The server answers 503 when Supabase isn't set up, and the app then stays local for the session.

type Kind = "comparisons" | "rfps" | "readings" | "projects" | "consultants" | "schedules" | "fees" | "settings" | "pursuits";
const LOCAL: Record<Kind, string> = { comparisons: STORE, rfps: RFPS, readings: READINGS, projects: PROJECTS, consultants: CONSULTANTS, schedules: SCHEDULES, fees: FEES, settings: SETTINGS, pursuits: PURSUITS };
let local = false;
/** False once the app has fallen back to this browser's storage (Supabase not configured). */
export const savesShared = () => !local;

// ---------- Demo ----------
// The demo keeps everything in memory, seeded with sample data: visitors can change things, nothing is saved anywhere,
// and a reload starts fresh. Nothing reaches the server while it's on.
type Row = Record<string, unknown>;
let demo: Map<Kind, Map<string, Row>> | null = null;
const keyOf = (kind: Kind, r: Row) => String(kind === "readings" ? r.hash : r.id);
const copy = <T>(v: T): T => structuredClone(v);

export function startDemo(seed: Record<Kind, object[]>): void {
  demo = new Map((Object.keys(LOCAL) as Kind[]).map((k) => [k, new Map((seed[k] ?? []).map((r) => [keyOf(k, r as Row), copy(r as Row)]))]));
}
export const isDemo = () => demo !== null;

async function remote<T>(method: string, kind: Kind, opts: { key?: string; body?: unknown; keepalive?: boolean } = {}): Promise<T | undefined> {
  if (local || demo) return undefined;
  const q = new URLSearchParams({ table: kind, ...(opts.key ? { key: opts.key } : {}) });
  const send = async () => fetch(`/api/db?${q}`, {
    method,
    headers: { ...(opts.keepalive ? authHeadersNow() : await authHeaders()), ...(opts.body ? { "content-type": "application/json" } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    // Lets a save started as the page closes finish after it's gone.
    keepalive: opts.keepalive,
  });
  let res = await send();
  if (res.status === 401 && !opts.keepalive && (await refreshAuth())) res = await send();
  if (res.status === 503) {
    local = true;
    return undefined;
  }
  if (res.status === 401) unauthorized();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Couldn't save (${res.status}).`);
  return data as T;
}

async function saveRecord(kind: Kind, record: object, keepalive = false): Promise<void> {
  if (demo) return void demo.get(kind)!.set(keyOf(kind, record as Row), copy(record as Row));
  if (!local) {
    await remote("POST", kind, { body: record, keepalive });
    if (!local) return;
  }
  try {
    await run("readwrite", (s) => s.put(record), LOCAL[kind]);
  } catch {} // storage can be unavailable (private windows, blocked site data)
}

async function listRecords<T extends { savedAt: number }>(kind: Kind): Promise<T[]> {
  if (demo) return ([...demo.get(kind)!.values()].map(copy) as T[]).sort((a, b) => b.savedAt - a.savedAt);
  try {
    const rows = (await remote<T[]>("GET", kind)) ?? (await run<T[]>("readonly", (s) => s.getAll(), LOCAL[kind]));
    return rows.sort((a, b) => b.savedAt - a.savedAt);
  } catch (err) {
    console.error(err);
    return [];
  }
}

async function deleteRecord(kind: Kind, key: string): Promise<void> {
  if (demo) return void demo.get(kind)!.delete(key);
  if (!local) {
    await remote("DELETE", kind, { key });
    if (!local) return;
  }
  try {
    await run("readwrite", (s) => s.delete(key), LOCAL[kind]);
  } catch {}
}

export const saveComparison = (c: SavedComparison) => saveRecord("comparisons", c);
export const listComparisons = () => listRecords<SavedComparison>("comparisons");
export const deleteComparison = (id: string) => deleteRecord("comparisons", id);
export const saveRfp = (r: SavedRfp) => saveRecord("rfps", r);
export const listRfps = () => listRecords<SavedRfp>("rfps");
export const deleteRfp = (id: string) => deleteRecord("rfps", id);
/** "24-017 Gas Dynamics Lab", or just the name when there's no number. Reviews and comparisons show this. */
export const projectLabel = (p: SavedProject) => (p.number ? `${p.number} ${p.name}` : p.name);


export const saveProject = (p: SavedProject) => saveRecord("projects", p);
export const listProjects = () => listRecords<SavedProject>("projects");
export const deleteProject = (id: string) => deleteRecord("projects", id);
export const saveConsultant = (c: SavedConsultant) => saveRecord("consultants", c);
export const listConsultants = () => listRecords<SavedConsultant>("consultants");
export const deleteConsultant = (id: string) => deleteRecord("consultants", id);

/** A schedule, as the schedule editor keeps it (title, tasks, legend, view…); linked to a project by workspaceProjectId. */
export type SavedSchedule = { id: string; savedAt: number; createdAt?: number; title?: string; workspaceProjectId?: string } & Record<string, unknown>;
/** keepalive: for the last save as the page closes. */
export const saveSchedule = (s: SavedSchedule, keepalive = false) => saveRecord("schedules", s, keepalive);
export const listSchedules = () => listRecords<SavedSchedule>("schedules");
export const deleteSchedule = (id: string) => deleteRecord("schedules", id);

/** A role on the fee (Principal, Project Manager, ...) with its hourly billing rate. */
/** A role on the fee with its hourly rate; short is its abbreviation in table headings (e.g. PM). */
export type FeeRole = { id: string; name: string; rate: number | null; short?: string };
export type FeeTask = { id: string; name: string; /** hours by role id */ hours: Record<string, number> };
export type FeePhase = { id: string; name: string; /** typical share of labor, in percent */ targetShare: number; tasks: FeeTask[] };
/**
 * A "below the line" item: a service the firm can offer at a stated price but that isn't in the fee (not asked for,
 * or optional). Never counted in any total; listed under the proposal table.
 */
export type BelowLineItem = {
  id: string;
  label: string;
  basis: BelowLineBasis;
  amount: number | null;
  note: string;
  /** who provides it: "architecture", or the id of a consultant with a fee on this fee; unset until chosen */
  by?: string;
};
export type BelowLineBasis = "lump" | "hourly" | "nte" | "allowance" | "request";
export const BELOW_LINE_BASIS: Record<BelowLineBasis, string> = {
  lump: "Lump sum",
  hourly: "Hourly",
  nte: "Not to exceed",
  allowance: "Allowance",
  request: "Upon request",
};

export type FeeConsultant = { id: string; discipline: string; firm: string; /** quoted fee by phase id */ byPhase: Record<string, number> };

/** A fee being built for a project: labor by phase and role, consultants with a management markup, and a budget. */
export type SavedFee = {
  id: string;
  savedAt: number;
  title: string;
  workspaceProjectId?: string;
  /** Draft until the team marks it final (editing a final fee makes it a draft again). */
  status?: "draft" | "final";
  /** when it was marked final */
  finalAt?: number;
  /** the template it started from */
  template: string;
  /** construction budget: typed as an amount, or worked out as area × cost per square foot */
  budget: {
    /** how the budget is set: an amount typed in, or area × cost per square foot (older fees: worked out) */
    by?: "amount" | "area";
    amount: number | null;
    area: number | null;
    costPerSf: number | null;
  };
  /** the top-down fee, as a percent of the construction budget */
  targetPercent: number | null;
  roles: FeeRole[];
  phases: FeePhase[];
  consultants: FeeConsultant[];
  /** the architect's management markup on consultant fees, in percent */
  markupPercent: number;
  /** reimbursable expenses */
  expenses: number | null;
  /** services offered outside the fee (see BelowLineItem) */
  belowLine?: BelowLineItem[];
  /** how long the project runs, in months, for the hours-over-time chart */
  durationMonths?: number | null;
  /** the world view an AI draft was made with, and when that world view was saved */
  lens?: { text: string; savedAt: number };
  /** the target percent comes from the World view's fee curve, and follows the budget until someone types one */
  targetFromCurve?: boolean;
  /** set when the fee was drafted by AI from the RFP review: what it assumed, and what the draft cost */
  draft?: {
    basis: string;
    assumptions: string[];
    costUsd: number | null;
    at: number;
    /** "notes" when the list was started on the worksheet or by the assistant, not drafted from the RFP review */
    source?: "notes";
    /** when the AI assistant last revised the list */
    revisedAt?: number;
  };
};

export const saveFee = (f: SavedFee, keepalive = false) => saveRecord("fees", f, keepalive);
export const listFees = () => listRecords<SavedFee>("fees");
export const deleteFee = (id: string) => deleteRecord("fees", id);
export const saveReading = (r: SavedReading) => saveRecord("readings", r).catch(console.error);

export async function getReading(hash: string): Promise<SavedReading | undefined> {
  if (demo) return copy(demo.get("readings")!.get(hash)) as SavedReading | undefined;
  try {
    const row = await remote<SavedReading | null>("GET", "readings", { key: hash });
    if (!local) return row ?? undefined;
    return await run<SavedReading | undefined>("readonly", (s) => s.get(hash), READINGS);
  } catch {
    return undefined;
  }
}

/** SHA-256 of the file's bytes, or null where the browser doesn't allow it (non-HTTPS pages). */
export async function hashFile(file: File): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

// ---------- World view ----------

/** The team's world view, or the starting one (empty text, placeholder fee curve) until someone saves it. */
export async function getWorldView(): Promise<WorldView> {
  const saved = (await listRecords<WorldView>("settings")).find((r) => r.id === "worldview");
  return saved ? { ...emptyWorldView(), ...saved } : emptyWorldView();
}
export const saveWorldView = (w: WorldView, keepalive = false) => saveRecord("settings", w, keepalive);

// ---------- Schedule colors ----------

/**
 * The organization's schedule style (src/schedule/lib/palette.js): colors by category and badge, the font, and whether
 * the Today line shows by default. Missing pieces mean the standard look.
 */
/**
 * conventions: the organization's own schedule conventions for the AI (unset: the starting ones, lib/schedule-style.ts).
 * notes: the notes every new schedule starts with, one per line (unset: none).
 */
export type ScheduleStyle = { colors: Record<string, string>; font?: string; showToday?: boolean; conventions?: string; notes?: string };
type ScheduleStyleRecord = ScheduleStyle & { id: "schedule-style"; savedAt: number };
export async function getScheduleStyle(): Promise<ScheduleStyle> {
  const saved = (await listRecords<ScheduleStyleRecord>("settings")).find((r) => r.id === "schedule-style");
  return { colors: saved?.colors ?? {}, font: saved?.font, showToday: saved?.showToday, conventions: saved?.conventions, notes: saved?.notes };
}
export const saveScheduleStyle = (style: ScheduleStyle) =>
  saveRecord("settings", { id: "schedule-style", savedAt: Date.now(), ...style } satisfies ScheduleStyleRecord);

/** The proposal fee table's look (one settings record per organization); the standard look until it's changed. */
type FeeStyleRecord = Partial<FeeStyle> & { id: "fee-style"; savedAt: number };
export async function getFeeStyle(): Promise<FeeStyle> {
  return cleanFeeStyle((await listRecords<FeeStyleRecord>("settings")).find((r) => r.id === "fee-style"));
}
export const saveFeeStyle = (style: FeeStyle) => saveRecord("settings", { id: "fee-style", savedAt: Date.now(), ...cleanFeeStyle(style) } satisfies FeeStyleRecord);

// ---------- Qualifications and exclusions ----------

/** The organization's standard qualifications and exclusions, one item each (one settings record per organization). */
type QualificationsRecord = { id: "qualifications"; savedAt: number; items: string[] };
/** The list; empty until the organization writes its own. */
export async function getQualifications(): Promise<string[]> {
  const saved = (await listRecords<QualificationsRecord>("settings")).find((r) => r.id === "qualifications");
  return Array.isArray(saved?.items) ? saved.items.filter((i) => typeof i === "string" && i.trim()) : [];
}
export const saveQualifications = (items: string[]) => saveRecord("settings", { id: "qualifications", savedAt: Date.now(), items } satisfies QualificationsRecord);

// ---------- Open Calls sources ----------

/** A website where the organization watches for RFPs (an agency's bids page, a procurement portal). */
export type CallSource = { id: string; code: string; name: string; scope: string; url: string };
type CallSources = { id: "open-calls"; savedAt: number; sources: CallSource[] };

/** The organization's own list of RFP sources (one settings record per organization); [] until it adds one. */
export async function getCallSources(): Promise<CallSource[]> {
  const saved = (await listRecords<CallSources>("settings")).find((r) => r.id === "open-calls");
  return saved?.sources ?? [];
}
export const saveCallSources = (sources: CallSource[]) => saveRecord("settings", { id: "open-calls", savedAt: Date.now(), sources } satisfies CallSources);

export const listPursuits = () => listRecords<Pursuit>("pursuits");
export const savePursuit = (p: Pursuit) => saveRecord("pursuits", p);
export const deletePursuit = (id: string) => deleteRecord("pursuits", id);
