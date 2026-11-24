import { writable } from 'svelte/store';
import { deleteSchedule, fetchSchedule, listSchedules, saveScheduleFrom, scheduleVersion } from '../../../store';
import { askConflicts, askDeleted, tellReplaced } from '../conflict.js';
import { mergeSchedules, newUid, withUids } from '../utils/merge.js';
import { addDays, hasDates, isDate, isView, projectDateRange, toISO, parseDate, toWeekday, MAX_VIEW_YEARS } from '../utils/dates.js';
import { isScheduleCode } from '../../../../lib/schedule-style';

// The schedule editor's store (a "project" here is one schedule). Same interface as in the schedule maker;
// saving now goes through this app's database (/api/db, behind the access code) instead of Supabase in the browser.

const { subscribe, update, set } = writable([]);

// Undo history: Map<projectId, snapshot[]>, capped at 50 entries per project.
const HISTORY_LIMIT = 50;
const _history = new Map();
const { subscribe: subscribeHistoryDepth, update: updateHistoryDepth } = writable({});

function _pushHistory(projectId, project) {
  const stack = _history.get(projectId) ?? [];
  stack.push(JSON.parse(JSON.stringify(project)));
  if (stack.length > HISTORY_LIMIT) stack.shift();
  _history.set(projectId, stack);
  updateHistoryDepth(d => ({ ...d, [projectId]: stack.length }));
}

function _popHistory(projectId) {
  const stack = _history.get(projectId) ?? [];
  if (!stack.length) return null;
  const snapshot = stack.pop();
  _history.set(projectId, stack);
  updateHistoryDepth(d => ({ ...d, [projectId]: stack.length }));
  return snapshot;
}

/** Forgets undo history (when leaving a schedule), so Undo never reaches into another visit. */
export function clearHistory(projectId) {
  _history.delete(projectId);
  updateHistoryDepth(d => ({ ...d, [projectId]: 0 }));
}

export const historyDepth = { subscribe: subscribeHistoryDepth };

// ── Saving ──
// Debounced (coalesces rapid updates, e.g. dragging bars), one request per schedule at a time so saves
// can't land out of order, and flushed when leaving the schedule or closing the page.
const DEBOUNCE_MS = 800;
const _timers = new Map();   // id → timeout
const _pending = new Map();  // id → latest unsaved version
const _inFlight = new Map(); // id → promise of the save in progress
const _sending = new Map();  // id → the version being saved

export const saveError = writable('');

function _saveProject(project) {
  _pending.set(project.id, project);
  clearTimeout(_timers.get(project.id));
  _timers.set(project.id, setTimeout(() => _send(project.id), DEBOUNCE_MS));
}

async function _send(id, keepalive = false) {
  clearTimeout(_timers.get(id));
  _timers.delete(id);
  // Wait for the previous save of this schedule, then send whatever is newest by then.
  while (_inFlight.has(id)) await _inFlight.get(id);
  const project = _pending.get(id);
  if (!project || _deleted.has(id)) return;
  _pending.delete(id);
  _sending.set(id, project);
  const base = _base.get(id);
  const savedAt = Date.now();
  const lastSent = _sentAt.get(id);
  _sentAt.set(id, savedAt);
  const p = saveScheduleFrom({ ...project, savedAt, savedBy: TAB }, base?.version, keepalive)
    .then(res => {
      if (res.conflict) {
        _refused.set(id, (_refused.get(id) ?? 0) + 1);
        if (_refused.get(id) > TOO_MANY || !base) {
          _refused.delete(id);
          throw new Error('the schedule keeps changing. Reload the page to see it as it is now.');
        }
        return _reconcile(id, base, project, res.record, lastSent);
      }
      _refused.delete(id);
      if (res.version) _base.set(id, { version: res.version, project });
      saveError.set('');
    })
    .catch(err => {
      console.error('[schedules] save failed:', err.message);
      saveError.set(`Not saved: ${err.message}`);
      if (!_pending.has(id)) _pending.set(id, project); // keep it for the next try
    })
    .finally(() => { _inFlight.delete(id); _sending.delete(id); });
  _inFlight.set(id, p);
  await p;
}

// ── Other people's saves ──
// A save says which version it started from. When someone else (or another tab, even with the same sign-in) has saved
// since, the server saves nothing and answers with theirs; both sets of changes are combined and saved again.
const TAB = newUid();        // this tab, in what it saves
const _base = new Map();     // id → { version, project }: what's on the server, as this tab last knew it
const _sentAt = new Map();   // id → savedAt of this tab's last save, whether or not its answer arrived
const _refused = new Map();  // id → saves in a row refused because someone else had saved
const TOO_MANY = 6;          // past this it isn't people taking turns: stop, rather than be refused forever
const _deleted = new Map();  // deleted in this tab: id → when the deleted one was made
const _unresolved = new Set(); // conflicts closed without choosing

/** Someone else's changes just came in. */
export const notice = writable('');
let _noticeTimer;
function _tell(text) {
  notice.set(text);
  clearTimeout(_noticeTimer);
  _noticeTimer = setTimeout(() => notice.set(''), 6000);
}

// Nothing is replaced under the pointer in the middle of a drag.
let _pressed = false;
if (typeof window !== 'undefined') {
  addEventListener('pointerdown', () => { _pressed = true; }, true);
  for (const e of ['pointerup', 'pointercancel']) addEventListener(e, () => { _pressed = false; }, true);
  // Released outside the window, where no "up" is heard: the next move says no button is down.
  addEventListener('pointermove', e => { if (!e.buttons) _pressed = false; }, true);
  addEventListener('blur', e => { if (e.target === window) _pressed = false; });
  // A conflict left undecided isn't saved anywhere yet.
  addEventListener('beforeunload', e => { if (_unresolved.size) e.preventDefault(); });
}
/** Typing in one of the schedule's fields. */
const _typing = () => {
  const el = document.activeElement;
  return !!el && (el.isContentEditable || (el.tagName === 'INPUT' && el.type === 'date'));
};
async function _released() {
  for (let i = 0; _pressed && i < 300; i++) await new Promise(r => setTimeout(r, 100));
}

let _all = [];
subscribe(ps => { _all = ps; });
const _current = id => _all.find(p => p.id === id);

/** Shows a schedule combined with someone else's, and carries their changes into the undo steps (Undo reverses only mine). */
function _adopt(id, base, theirs, merged, ids) {
  const stack = _history.get(id);
  if (stack) _history.set(id, stack.map(snap => mergeSchedules(base, snap, theirs, {}, ids).merged));
  update(ps => ps.map(p => (p.id === id ? merged : p)));
}

async function _reconcile(id, base, sent, record, lastSent) {
  if (_deleted.has(id)) return;
  const mine = () => _pending.get(id) ?? _current(id) ?? sent;
  if (!record) {
    if (await askDeleted(sent.title)) { _base.delete(id); _saveProject(mine()); }
    else { _pending.delete(id); _base.delete(id); update(ps => ps.filter(p => p.id !== id)); }
    saveError.set('');
    return;
  }
  const theirs = normalizeProject(record);
  const version = record._v;
  // The schedule being edited was deleted, and another made for the project since: they're not to be combined.
  if (record.createdAt !== base.project.createdAt) {
    _pending.delete(id);
    _unresolved.delete(id);
    clearHistory(id);
    _base.set(id, { version, project: theirs });
    update(ps => ps.map(p => (p.id === id ? theirs : p)));
    saveError.set('');
    await tellReplaced(sent.title);
    return;
  }
  // This tab's own last save, whose answer never arrived: nothing to combine.
  if (record.savedBy === TAB && record.savedAt === lastSent) {
    _base.set(id, { version, project: theirs });
    _saveProject(mine());
    return;
  }
  await _released();
  const ids = new Map();
  let { merged, conflicts } = mergeSchedules(base.project, mine(), theirs, {}, ids);
  if (conflicts.length) {
    const choices = await askConflicts(sent.title, conflicts);
    if (!choices) {
      _unresolved.add(id);
      throw new Error('someone else changed the same thing. Your next change will ask again.');
    }
    ({ merged } = mergeSchedules(base.project, mine(), theirs, choices, ids)); // with anything edited meanwhile
  }
  _unresolved.delete(id);
  if (_deleted.has(id)) return;
  merged.legend = _sortLegend(merged.legend);
  _adopt(id, base.project, theirs, merged, ids);
  _base.set(id, { version, project: theirs });
  _saveProject(merged);
  saveError.set('');
  _tell('Combined with someone else’s changes');
}

/** Brings in someone else's save of an open schedule, unless this tab has changes of its own waiting (its save combines them). */
async function _refresh(id) {
  const busy = () => _pending.has(id) || _inFlight.has(id) || _pressed || _typing();
  const base = _base.get(id);
  if (!base || busy()) return;
  try {
    const version = await scheduleVersion(id);
    if (version === undefined || version === base.version) return;
    const row = version && (await fetchSchedule(id));
    if (_deleted.has(id) || busy() || _base.get(id) !== base) return;
    if (!row || row.createdAt !== base.project.createdAt) { saveError.set('Someone else deleted this schedule.'); return; }
    const theirs = normalizeProject(row);
    _adopt(id, base.project, theirs, theirs, new Map());
    _base.set(id, { version: row._v, project: theirs });
    _tell('Updated with someone else’s changes');
  } catch { /* a missed check: the next one, or the save itself, catches it */ }
}

const WATCH_MS = 20_000;
/** Keeps an open schedule current: checks every 20 seconds while the tab is showing, and on coming back to it. */
export function watchSchedule(id) {
  const check = () => { if (document.visibilityState === 'visible') _refresh(id); };
  const timer = setInterval(check, WATCH_MS);
  document.addEventListener('visibilitychange', check);
  window.addEventListener('focus', check);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', check);
    window.removeEventListener('focus', check);
  };
}

/** Sends every unsaved change now. keepalive lets the requests finish if the page is closing. */
export function flushSaves(keepalive = false) {
  return Promise.all([..._pending.keys()].map(id => _send(id, keepalive)));
}

/** Deletes a schedule; it stays in the list until it's really gone. A failed delete leaves it as it was, and throws. */
async function _deleteProject(id) {
  const waiting = _pending.get(id);
  _deleted.set(id, _current(id)?.createdAt);
  _pending.delete(id);
  clearTimeout(_timers.get(id));
  try {
    await deleteSchedule(id);
  } catch (err) {
    console.error('[schedules] delete failed:', err.message);
    _deleted.delete(id);
    const unsaved = _pending.get(id) ?? waiting;
    if (unsaved) _saveProject(unsaved);
    throw err;
  }
  _base.delete(id);
  _pending.delete(id);
  _unresolved.delete(id);
  update(ps => ps.filter(p => p.id !== id));
}

// Point-in-time markers (milestones, deliverables, approvals, estimates) can't land on weekends.
/**
 * Guardrails on what the assistant writes (whatever its instructions or the organization's conventions said): a known
 * task type, colors that are schedule category codes (the organization's style decides how they look), and a bar
 * that ends after it starts, within fifteen years. Returns the cleaned fields, or null when the task makes no sense.
 */
const MAX_SPAN_DAYS = 15 * 366;
function _cleanAiTask(fields, before = null) {
  const out = { ...fields };
  for (const k of ['start', 'end', 'date']) {
    if (out[k] == null || out[k] === '') delete out[k]; // a date is never cleared, only changed
    else if (!isDate(out[k])) return null;
  }
  if ('type' in out && out.type !== 'bar' && out.type !== 'milestone') delete out.type;
  if ('color' in out && !isScheduleCode(out.color)) delete out.color;
  const t = { ...before, ...out };
  // A bar made a milestone without a date goes at the bar's end.
  if (t.type === 'milestone' && !isDate(t.date) && isDate(t.end)) t.date = out.date = t.end;
  // A new task, or one whose dates or shape change, has to be one that can be drawn.
  if ((!before || ['type', 'start', 'end', 'date'].some((k) => k in out)) && !hasDates(t)) return null;
  if ((t.type ?? 'bar') === 'bar' && isDate(t.start) && isDate(t.end)) {
    const days = (Date.parse(t.end) - Date.parse(t.start)) / 86_400_000;
    if (days < 0 || days > MAX_SPAN_DAYS) return null;
  }
  return out;
}

function _weekdayDate(obj) {
  if (!obj) return obj;
  let out = obj.date ? { ...obj, date: toWeekday(obj.date) } : obj;
  // A milestone's extra marks on its row: valid days only, on weekdays, at most 30.
  if ('extraDates' in out) {
    const list = Array.isArray(out.extraDates) ? out.extraDates : [];
    out = { ...out, extraDates: list.filter(isDate).slice(0, 30).map(toWeekday) };
  }
  return out;
}

/** Parts missing or of the wrong kind (an older or half-written schedule): set right, so every screen can rely on them. */
function _fixShape(p) {
  p.tasks = (Array.isArray(p.tasks) ? p.tasks : []).filter(t => t && typeof t === 'object');
  const used = new Set();
  let next = Math.max(0, ...p.tasks.map(t => t.id).filter(Number.isSafeInteger)) + 1;
  for (const t of p.tasks) {
    // Every task its own number (two with the same one can't be drawn).
    if (!Number.isSafeInteger(t.id) || used.has(t.id)) t.id = next++;
    used.add(t.id);
    t.name = String(t.name ?? '');
    if ('extraDates' in t) t.extraDates = (Array.isArray(t.extraDates) ? t.extraDates : []).filter(isDate);
  }
  const legend = p.legend && typeof p.legend === 'object' ? p.legend : {};
  p.legend = { ...legend };
  for (const k of LEGEND_SECTIONS) {
    p.legend[k] = (Array.isArray(legend[k]) ? legend[k] : [])
      .filter(x => x && typeof x === 'object')
      .map(x => (x.date == null || isDate(x.date) ? x : { ...x, date: null }));
  }
  for (const k of ['title', 'date', 'number', 'client', 'notes']) if (p[k] != null && typeof p[k] !== 'string') p[k] = String(p[k]);
}

/** A timeline that can't be drawn (reversed, or centuries long) is set from the tasks' dates. */
function _fixView(p) {
  if (isView(p.viewStart, p.viewEnd)) return p;
  const { start, end } = projectDateRange(p.tasks ?? []);
  return { ...p, ...viewAround(start ?? toISO(new Date()), end ?? addDays(start ?? toISO(new Date()), 365)) };
}

/** The timeline covering two dates, with a month to spare at each end (within MAX_VIEW_YEARS). */
export function viewAround(start, end) {
  const s = parseDate(start), e = parseDate(end);
  const vs = new Date(s.getFullYear(), s.getMonth() - 1, 1);
  const ve = new Date(e.getFullYear(), e.getMonth() + 1, 1);
  const last = new Date(vs.getFullYear() + MAX_VIEW_YEARS, vs.getMonth(), 1);
  return { viewStart: toISO(vs), viewEnd: toISO(ve > last ? last : ve) };
}

// Brings previously saved projects up to the current color conventions:
//  - olive (#8B9A3A) was retired in favour of lime
//  - blue review bars (client / owner / design reviews, not permit/AHJ) moved to 50% gray
//    (runs once, so later picks stick)
const isReviewBar = t =>
  t.type === 'bar' && /review/i.test(t.name ?? '') && !/permit|ahj|regulatory/i.test(t.name ?? '') &&
  /^#(20ABE2|90D5F1)$/i.test(t.color ?? '');
export function normalizeProject(project) {
  const p = JSON.parse(JSON.stringify(project).replace(/#8B9A3A/gi, '#00914D'));
  _fixShape(p);
  if ((p.colorVersion ?? 1) < 2) {
    p.tasks = (p.tasks ?? []).map(t => isReviewBar(t) ? { ...t, color: '#949494' } : t);
    p.colorVersion = 2;
  }
  delete p._v; // kept apart from the schedule (_base)
  p.legend = _sortLegend(withUids(p.legend));
  // Empty fields used to be saved as the hint they showed.
  for (const [k, hint] of [['date', 'Date'], ['number', 'Project Number'], ['client', 'Client']]) if (p[k] === hint) p[k] = '';
  return _fixView(p);
}

// What the assistant may change on a task or legend item (never ids or links).
const TASK_FIELDS = ['name', 'type', 'color', 'start', 'end', 'date', 'extraDates', 'msRef', 'note'];
const LEGEND_FIELDS = ['text', 'label', 'date', 'color', 'code'];

// Legend sections are always kept in ascending date order (undated items last).
const LEGEND_SECTIONS = ['deliverables', 'milestones', 'estimates', 'approvals'];
function _byDate(items) {
  return [...(items ?? [])].sort((a, b) =>
    !a.date ? (b.date ? 1 : 0) : !b.date ? -1 : a.date.localeCompare(b.date)
  );
}
function _sortLegend(legend) {
  if (!legend) return legend;
  const out = { ...legend };
  for (const k of LEGEND_SECTIONS) if (out[k]) out[k] = _byDate(out[k]);
  return out;
}

function _updateAndSave(projectId, fn) {
  let saved = null;
  update(ps => ps.map(p => {
    if (p.id !== projectId) return p;
    _pushHistory(projectId, p);
    saved = fn(p);
    return saved;
  }));
  if (saved) _saveProject(saved);
}

let _loaded = null;

export const projectStore = {
  subscribe,

  /** Loads every schedule once per visit (oldest first, as before). Unlike the old app, never inserts a sample. */
  init(force = false) {
    if (_loaded && !force) return _loaded;
    // Saves under way as the load starts: the rows may have been read before they landed.
    const saving = new Map(_sending);
    _loaded = listSchedules().then(rows => {
      const sorted = [...rows].sort((a, b) => (a.createdAt ?? a.savedAt ?? 0) - (b.createdAt ?? b.savedAt ?? 0));
      // Keep any in-memory edits that haven't been saved yet, or were being saved meanwhile.
      set(sorted.map(r => {
        // Made again for the project after this tab deleted the one before it (a project's schedule keeps its id).
        if (_deleted.has(r.id) && _deleted.get(r.id) !== r.createdAt) _deleted.delete(r.id);
        const kept = _pending.get(r.id) ?? _sending.get(r.id) ?? saving.get(r.id);
        if (kept) return kept;
        const project = normalizeProject(r);
        if (r._v) _base.set(r.id, { version: r._v, project });
        return project;
      }));
    });
    return _loaded;
  },

  addProject(project) {
    project = { ...project, colorVersion: 2, legend: _sortLegend(withUids(project.legend)), createdAt: Date.now() };
    update(ps => [...ps, project]);
    _saveProject(project);
    return project;
  },

  deleteProject(id) {
    return _deleteProject(id);
  },

  updateProject(id, patch) {
    // A schedule's id and project link never change through an edit.
    const { id: _id, workspaceProjectId: _link, ...safe } = patch ?? {};
    _updateAndSave(id, p => ({ ...p, ...safe }));
  },

  /**
   * Applies the assistant's changes as one edit (one Undo reverses the whole reply), checking each first: the view
   * can only move its date range, tasks keep their ids, new tasks always get an unused id, and legend changes must
   * name a real section and item. Anything else in a change is ignored.
   */
  /**
   * Applies the assistant's changes; returns how many applied and how many were skipped (bad ids, fields, dates).
   * Its legend indexes are places in the legend as it was sent (`sent`): each item is found by its own id, wherever
   * it is now (the legend may have been edited while it answered, and re-sorts as this reply's own changes are made).
   */
  applyChanges(projectId, changes, sent = _current(projectId)) {
    const result = { applied: 0, skipped: 0 };
    if (!Array.isArray(changes) || !changes.length) return result;
    _updateAndSave(projectId, p => {
      let next = { ...p, tasks: [...(p.tasks ?? [])], legend: { ...(p.legend ?? {}) } };
      const legendAt = (section, index) => {
        const uid = Number.isInteger(index) ? sent?.legend?.[section]?.[index]?.uid : undefined;
        return uid === undefined ? -1 : (next.legend[section] ?? []).findIndex(x => x.uid === uid);
      };
      const pick = (obj, keys) => Object.fromEntries(Object.entries(obj ?? {}).filter(([k]) => keys.includes(k)));
      for (const c of changes) {
        const before = JSON.stringify(next);
        if (c?.type === 'updateView') {
          const v = pick(c.patch, ['viewStart', 'viewEnd']);
          if (!isView(v.viewStart ?? next.viewStart, v.viewEnd ?? next.viewEnd)) { result.skipped++; continue; }
          next = { ...next, ...v };
        } else if (c?.type === 'updateTask') {
          const current = next.tasks.find(t => t.id === c.taskId);
          const patch = current && _weekdayDate(_cleanAiTask(pick(c.patch, TASK_FIELDS), current));
          if (!patch) { result.skipped++; continue; }
          next.tasks = next.tasks.map(t => (t.id === c.taskId ? { ...t, ...patch } : t));
        } else if (c?.type === 'addTask' && c.task) {
          const used = new Set(next.tasks.map(t => t.id));
          const nextId = Math.max(0, ...used, (next.nextTaskId ?? 1) - 1) + 1;
          const fields = _cleanAiTask(pick(c.task, TASK_FIELDS));
          if (!fields || !String(fields.name ?? '').trim()) { result.skipped++; continue; }
          // A bar without a usable color gets the design phases' (it can be changed in the editor).
          if ((fields.type ?? 'bar') === 'bar' && !fields.color) fields.color = '#00914D';
          const task = _weekdayDate({ ...fields, id: used.has(c.task.id) || typeof c.task.id !== 'number' ? nextId : c.task.id });
          const at = c.insertAfterId != null ? next.tasks.findIndex(t => t.id === c.insertAfterId) : -1;
          if (at !== -1) next.tasks.splice(at + 1, 0, task);
          else next.tasks.push(task);
          next.nextTaskId = Math.max(...next.tasks.map(t => t.id)) + 1;
        } else if (c?.type === 'deleteTask') {
          next.tasks = next.tasks.filter(t => t.id !== c.taskId);
        } else if (c?.type === 'updateLegendItem' && LEGEND_SECTIONS.includes(c.section)) {
          const items = next.legend[c.section] ?? [];
          const at = legendAt(c.section, c.index);
          if (at < 0) { result.skipped++; continue; }
          const raw = pick(c.patch, LEGEND_FIELDS);
          if (raw.date === '') raw.date = null;
          if (raw.date != null && !isDate(raw.date)) { result.skipped++; continue; }
          const patch = _weekdayDate(raw);
          if ('color' in patch && !isScheduleCode(patch.color)) delete patch.color;
          next.legend[c.section] = _byDate(items.map((it, i) => (i === at ? { ...it, ...patch } : it)));
        } else if (c?.type === 'addLegendItem' && LEGEND_SECTIONS.includes(c.section) && c.item && typeof c.item === 'object') {
          const raw = pick(c.item, LEGEND_FIELDS);
          if (!isDate(raw.date)) delete raw.date;
          const item = { ..._weekdayDate(raw), uid: newUid() };
          if (item.color && !isScheduleCode(item.color)) delete item.color;
          if (!String(item.text ?? '').trim()) { result.skipped++; continue; }
          next.legend[c.section] = _byDate([...(next.legend[c.section] ?? []), item]);
        } else if (c?.type === 'deleteLegendItem' && LEGEND_SECTIONS.includes(c.section)) {
          const items = next.legend[c.section] ?? [];
          const at = legendAt(c.section, c.index);
          if (at < 0) { result.skipped++; continue; }
          next.legend[c.section] = items.filter((_, i) => i !== at);
        }
        if (JSON.stringify(next) === before) result.skipped++;
        else result.applied++;
      }
      return next;
    });
    return result;
  },

  updateTask(projectId, taskId, patch) {
    _updateAndSave(projectId, p => ({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, ..._weekdayDate(patch) } : t),
    }));
  },

  addTask(projectId, task, insertAfterId = null) {
    _updateAndSave(projectId, p => {
      const tasks = [...p.tasks];
      task = _weekdayDate(task);
      // Never two tasks with the same id (older schedules' nextTaskId can lag behind their tasks).
      const used = new Set(tasks.map(t => t.id));
      if (used.has(task.id)) task = { ...task, id: Math.max(0, ...used) + 1 };
      const idx = insertAfterId != null ? tasks.findIndex(t => t.id === insertAfterId) : -1;
      if (idx !== -1) tasks.splice(idx + 1, 0, task);
      else tasks.push(task);
      return { ...p, tasks, nextTaskId: Math.max((p.nextTaskId || 1) + 1, ...tasks.map(t => t.id + 1)) };
    });
  },

  deleteTask(projectId, taskId) {
    _updateAndSave(projectId, p => ({
      ...p,
      tasks: p.tasks.filter(t => t.id !== taskId),
    }));
  },

  reorderTasks(projectId, fromIdx, toIdx) {
    _updateAndSave(projectId, p => {
      const tasks = [...p.tasks];
      const [task] = tasks.splice(fromIdx, 1);
      tasks.splice(toIdx, 0, task);
      return { ...p, tasks };
    });
  },

  updateLegendItem(projectId, section, idx, patch) {
    _updateAndSave(projectId, p => {
      const items = (p.legend[section] ?? []).map((item, i) =>
        i === idx ? { ...item, ..._weekdayDate(patch) } : item
      );
      return { ...p, legend: { ...p.legend, [section]: _byDate(items) } };
    });
  },

  undo(projectId) {
    const snapshot = _popHistory(projectId);
    if (!snapshot) return;
    update(ps => ps.map(p => p.id === projectId ? snapshot : p));
    _saveProject(snapshot);
  },

  updateLegendSection(projectId, section, items) {
    items = _byDate(items.map(it => ({ uid: newUid(), ..._weekdayDate(it) })));
    _updateAndSave(projectId, p => {
      let tasks = p.tasks;
      if (section === 'milestones') {
        tasks = p.tasks.map(t => {
          if (!t.msRef) return t;
          const m = items.find(m => m.code === t.msRef.code);
          return m ? { ...t, msRef: { code: m.code, color: m.color } } : t;
        });
      }
      return { ...p, legend: { ...p.legend, [section]: items }, tasks };
    });
  },
};
