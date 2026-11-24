// Saving fees: one request per fee at a time, in order, kept and tried again when one fails, and never over someone
// else's newer save. A save says which version it started from; when another person (or tab, even with the same
// sign-in) has saved since, the server saves nothing and answers with theirs, and both sets of changes are combined.
import { mergeFees } from "./fee-merge";
import { askConflicts, askDeleted } from "./schedule/lib/conflict.js";
import { feeVersion, fetchFee, listFees, saveFeeFrom, type SavedFee } from "./store";

const DEBOUNCE_MS = 800;
const RETRY_MS = 10_000;
const WATCH_MS = 20_000;
/** this tab, in what it saves */
const TAB = Math.random().toString(36).slice(2, 12);

type Saved = SavedFee & { savedBy?: string };
const base = new Map<string, { version: string; fee: SavedFee }>();
const pending = new Map<string, SavedFee>();
const sending = new Map<string, SavedFee>();
const inFlight = new Map<string, Promise<void>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const sentAt = new Map<string, number>();
const deleted = new Set<string>();
/** saves in a row that were refused because someone else had saved; see TOO_MANY */
const refused = new Map<string, number>();
/** Past this many in a row it isn't people taking turns: stop, rather than save and be refused forever. */
const TOO_MANY = 6;
const unresolved = new Set<string>();

/** The fee page's side (fee.ts). */
export type FeeHooks = {
  /** the fee open on the page, as it is now */
  open: () => SavedFee | null;
  /** shows the open fee combined with someone else's; rebase carries their changes into an earlier state (the undo steps) */
  adopt: (merged: SavedFee, rebase: (f: SavedFee) => SavedFee) => void;
  /** the open fee was deleted by someone else, and isn't being kept */
  gone: (id: string, why?: string) => void;
  /** a save failed ("" once it works again) */
  error: (message: string, fee: SavedFee) => void;
  notice: (message: string) => void;
  /** typing in one of the fee's boxes */
  typing: () => boolean;
};
let hooks: FeeHooks = { open: () => null, adopt: () => {}, gone: () => {}, error: () => {}, notice: () => {}, typing: () => false };
export const setFeeHooks = (h: FeeHooks) => (hooks = h);

let pressed = false;
if (typeof window !== "undefined") {
  addEventListener("pointerdown", () => (pressed = true), true);
  for (const e of ["pointerup", "pointercancel"]) addEventListener(e, () => (pressed = false), true);
  // Released outside the window, where no "up" is heard: the next move says no button is down.
  addEventListener("pointermove", (e) => !e.buttons && (pressed = false), true);
  addEventListener("blur", (e) => e.target === window && (pressed = false));
  // A change that couldn't be saved yet, or a conflict left undecided, isn't saved anywhere.
  addEventListener("beforeunload", (e) => (unresolved.size || failed.size) && e.preventDefault());
}
/** fees whose last save failed */
const failed = new Set<string>();

const strip = (f: SavedFee): SavedFee => {
  const { _v, ...rest } = f;
  return rest;
};

/** A fee by id and the whole list, with this tab's unsaved changes in place of what the server has. */
export async function loadFees(): Promise<SavedFee[]> {
  const saving = new Map(sending);
  const rows = await listFees();
  return rows.map((r) => {
    const kept = pending.get(r.id) ?? sending.get(r.id) ?? saving.get(r.id);
    if (kept) return structuredClone(kept);
    const fee = strip(r);
    // The open fee's base only moves with the fee itself (refresh, or its own save).
    if (r._v && hooks.open()?.id !== r.id) base.set(r.id, { version: r._v, fee: structuredClone(fee) });
    return fee;
  });
}

/** Saves the fee shortly (changes close together make one save). */
export function queueFee(f: SavedFee, wait = DEBOUNCE_MS) {
  if (deleted.has(f.id)) return;
  pending.set(f.id, structuredClone(f));
  clearTimeout(timers.get(f.id));
  timers.set(f.id, setTimeout(() => void send(f.id), wait));
}

/** Sends every unsaved change now. keepalive lets the requests finish if the page is closing. */
export const flushFees = (keepalive = false) => Promise.all([...pending.keys()].map((id) => send(id, keepalive)));

/** Stops saving a fee that's being deleted here. */
export function forgetFee(id: string) {
  deleted.add(id);
  pending.delete(id);
  failed.delete(id);
  unresolved.delete(id);
  base.delete(id);
  clearTimeout(timers.get(id));
}
/** The delete failed: the fee is still there. */
export const unforgetFee = (id: string) => deleted.delete(id);

async function send(id: string, keepalive = false): Promise<void> {
  clearTimeout(timers.get(id));
  while (inFlight.has(id)) await inFlight.get(id);
  const fee = pending.get(id);
  if (!fee || deleted.has(id)) return;
  pending.delete(id);
  sending.set(id, fee);
  const from = base.get(id);
  const lastSent = sentAt.get(id);
  const savedAt = Date.now();
  sentAt.set(id, savedAt);
  const record: Saved = { ...fee, savedAt, savedBy: TAB };
  const p = saveFeeFrom(record, from?.version, keepalive)
    .then(async (res) => {
      if (res.conflict) {
        refused.set(id, (refused.get(id) ?? 0) + 1);
        if (refused.get(id)! > TOO_MANY || !from) throw new Error("the fee keeps changing. Reload the page to see it as it is now.");
        await reconcile(id, from.fee, fee, res.record ?? null, lastSent);
      } else {
        refused.delete(id);
        if (res.version) base.set(id, { version: res.version, fee });
      }
      failed.delete(id);
      hooks.error("", fee);
    })
    .catch((err: Error) => {
      if (deleted.has(id)) return;
      if (!pending.has(id)) pending.set(id, fee);
      if (!unresolved.has(id)) {
        refused.delete(id);
        failed.add(id);
        // Tried again by itself, so an outage ends without anyone retyping anything.
        clearTimeout(timers.get(id));
        timers.set(id, setTimeout(() => void send(id), RETRY_MS));
      }
      hooks.error(err.message, fee);
    })
    .finally(() => {
      inFlight.delete(id);
      sending.delete(id);
    });
  inFlight.set(id, p);
  await p;
}

const released = async () => {
  for (let i = 0; pressed && i < 300; i++) await new Promise((r) => setTimeout(r, 100));
};

async function reconcile(id: string, from: SavedFee, sent: SavedFee, record: Saved | null, lastSent?: number) {
  if (deleted.has(id)) return;
  const open = () => (hooks.open()?.id === id ? hooks.open() : null);
  const mine = () => structuredClone(open() ?? pending.get(id) ?? sent);
  if (!record) {
    if (await askDeleted(sent.title)) {
      base.delete(id);
      queueFee(mine());
    } else {
      forgetFee(id);
      hooks.gone(id);
    }
    return;
  }
  const theirs = strip(record);
  // The fee being edited was deleted, and another made for the project since: they're not to be combined.
  if (record.createdAt !== from.createdAt) {
    pending.delete(id);
    base.delete(id);
    hooks.gone(id, "It was deleted by someone else, and a new fee was made for the project.");
    return;
  }
  // This tab's own last save, whose answer never arrived: nothing to combine.
  if (record.savedBy === TAB && record.savedAt === lastSent) {
    base.set(id, { version: record._v!, fee: theirs });
    return queueFee(mine(), 0);
  }
  await released();
  let choices: Record<string, "mine" | "theirs"> = {};
  const first = mergeFees(from, mine(), theirs);
  if (first.conflicts.length) {
    const picked = await askConflicts(sent.title, first.conflicts);
    if (!picked) {
      unresolved.add(id);
      throw new Error("someone else changed the same thing. Your next change will ask again.");
    }
    choices = picked;
  }
  unresolved.delete(id);
  if (deleted.has(id)) return;
  const { merged } = mergeFees(from, mine(), theirs, choices); // with anything edited meanwhile
  base.set(id, { version: record._v!, fee: theirs });
  if (open()) hooks.adopt(merged, (f) => mergeFees(from, f, theirs).merged);
  queueFee(merged, 0);
  hooks.notice("Combined with someone else’s changes");
}

/** Brings in someone else's save of the open fee, unless this tab has changes of its own (its save combines them). */
async function refresh() {
  const fee = hooks.open();
  if (!fee) return;
  const id = fee.id;
  const from = base.get(id);
  const busy = () => pending.has(id) || inFlight.has(id) || pressed || hooks.typing() || hooks.open()?.id !== id;
  if (!from || busy()) return;
  try {
    const version = await feeVersion(id);
    if (version === undefined || version === from.version) return;
    const row = version ? await fetchFee(id) : null;
    if (deleted.has(id) || busy() || base.get(id) !== from) return;
    if (!row || row.createdAt !== from.fee.createdAt) return hooks.error("someone else deleted this fee.", fee);
    const theirs = strip(row);
    base.set(id, { version: row._v!, fee: theirs });
    hooks.adopt(structuredClone(theirs), (f) => mergeFees(from.fee, f, theirs).merged);
    hooks.notice("Updated with someone else’s changes");
  } catch {
    // A missed check: the next one, or the save itself, catches it.
  }
}

let watching = false;
/** Keeps the open fee current: every 20 seconds while the tab is showing, and on coming back to it. */
export function watchFees() {
  if (watching) return;
  watching = true;
  const check = () => document.visibilityState === "visible" && void refresh();
  setInterval(check, WATCH_MS);
  document.addEventListener("visibilitychange", check);
  addEventListener("focus", check);
}
