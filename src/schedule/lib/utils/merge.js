// Combines two people's (or tabs') changes to the same schedule. Each side is compared with the version both started
// from: what only one side changed is kept; what both changed, differently, is a conflict to ask about.

const SECTIONS = ['deliverables', 'milestones', 'estimates', 'approvals'];
const SECTION_NAME = { deliverables: 'Deliverable', milestones: 'Milestone', estimates: 'Estimate', approvals: 'Approval' };
// Fields that only make sense together are kept or replaced together (one side's start with the other's end could
// make a bar that ends before it starts).
const TASK_GROUPS = [['type', 'start', 'end', 'date', 'extraDates']];
const TOP_GROUPS = [['viewStart', 'viewEnd']];
const GROUP_NAME = { type: 'dates', viewStart: 'dates shown', name: 'name', text: 'name', color: 'color', date: 'date', code: 'code', title: 'Title', number: 'Project number', client: 'Client', notes: 'Notes' };
// Kept by the store itself, never something a person changed.
const OWN = new Set(['id', 'savedAt', 'savedBy', 'createdAt', 'colorVersion', 'nextTaskId', '_v', 'tasks', 'legend']);

/** The same data written the same way, whatever order its fields are in; absent and undefined are the same. */
const key = (v) =>
  JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x)) ?? '';
export const same = (a, b) => key(a) === key(b);
const pick = (o, fields) => Object.fromEntries(fields.filter((f) => o?.[f] !== undefined).map((f) => [f, o[f]]));

/** Merges the fields of one thing (a task, a legend item, the schedule itself). ask(field, mine, theirs) picks a side. */
export function mergeFields(base, mine, theirs, groups, ask, skip = new Set()) {
  const grouped = new Set(groups.flat());
  const names = new Set([base, mine, theirs].flatMap((o) => Object.keys(o ?? {})).filter((f) => !skip.has(f) && !grouped.has(f)));
  const out = {};
  for (const fields of [...groups, ...[...names].map((f) => [f])]) {
    const [b, m, t] = [base, mine, theirs].map((o) => pick(o, fields));
    const side = same(m, t) || same(m, b) ? t : same(t, b) ? m : ask(fields[0], m, t) === 'mine' ? m : t;
    Object.assign(out, side);
  }
  return out;
}

/** Merges two lists of things with ids. combine(id, base, mine, theirs) merges one thing (by its fields when not given). */
export function mergeList({ base, mine, theirs, id, groups, ask, label, kind, newId, combine }) {
  const map = (list) => new Map((list ?? []).map((x) => [x[id], x]));
  const B = map(base), T = map(theirs);
  // Each side may have given a new item the same id: mine takes another, so both stay.
  const renamed = (mine ?? []).map((x) => (!B.has(x[id]) && T.has(x[id]) && !same(x, T.get(x[id])) && newId ? { ...x, [id]: newId(x[id]) } : x));
  const M = map(renamed);
  const result = new Map();
  for (const k of new Set([...T.keys(), ...M.keys()])) {
    const b = B.get(k), m = M.get(k), t = T.get(k);
    if (m && t) {
      result.set(k, combine ? combine(k, b, m, t) : mergeFields(b ?? {}, m, t, groups, (field, mv, tv) => ask(`${kind}:${k}:${field}`, `${label(b ?? t)}: ${GROUP_NAME[field] ?? field}`, mv, tv)));
    } else {
      const kept = m ?? t;
      if (!b) result.set(k, kept); // added by one side
      else if (!same(kept, b)) {
        // Changed by one side, deleted by the other.
        const choice = ask(`${kind}:${k}:deleted`, label(b), m ? 'changed' : 'deleted', m ? 'deleted' : 'changed');
        if ((choice === 'mine') === !!m) result.set(k, kept);
      }
    }
  }
  // The order: whoever reordered decides (mine when both did); the other side's additions go after the item they followed.
  const ids = (list) => (list ?? []).map((x) => x[id]);
  const common = (list) => ids(list).filter((k) => B.has(k) && M.has(k) && T.has(k));
  const mineMoved = !same(common(renamed), common(base));
  const [lead, other] = mineMoved ? [renamed, theirs] : [theirs, renamed];
  const order = ids(lead).filter((k) => result.has(k));
  const otherIds = ids(other);
  otherIds.forEach((k, i) => {
    if (!result.has(k) || order.includes(k)) return;
    let at = -1;
    for (let j = i - 1; j >= 0 && at === -1; j--) at = order.indexOf(otherIds[j]);
    order.splice(at + 1, 0, k);
  });
  return order.map((k) => result.get(k));
}

/**
 * Merges `mine` and `theirs`, both edited from `base`. choices: conflict key → 'mine' | 'theirs' (mine when not given).
 * ids remembers the new ids given to tasks and legend items, so merging again (or the undo steps) gives the same ones.
 * Returns the merged schedule and what both sides changed: { key, label, mine, theirs }.
 */
export function mergeSchedules(base, mine, theirs, choices = {}, ids = new Map()) {
  const conflicts = [];
  const ask = (k, label, m, t) => {
    conflicts.push({ key: k, label, mine: m, theirs: t });
    return choices[k] ?? 'mine';
  };
  const merged = {
    ...theirs,
    ...mergeFields(base, mine, theirs, TOP_GROUPS, (f, m, t) => (f === 'workspaceProjectId' ? 'theirs' : ask(`top:${f}`, GROUP_NAME[f] === 'dates shown' ? 'Dates shown' : GROUP_NAME[f] ?? f, m, t)), OWN),
  };
  // A field one side removed isn't brought back by the spread above.
  for (const f of Object.keys(theirs)) if (!OWN.has(f) && same(theirs[f], base[f]) && mine[f] === undefined) delete merged[f];

  const used = new Set([base, mine, theirs].flatMap((p) => (p.tasks ?? []).map((t) => t.id)));
  const newTaskId = (old) => {
    const k = `task:${old}`;
    if (!ids.has(k)) {
      const n = Math.max(0, ...used, ...[...ids.values()].filter((x) => typeof x === 'number')) + 1;
      ids.set(k, n);
    }
    return ids.get(k);
  };
  merged.tasks = mergeList({ base: base.tasks, mine: mine.tasks, theirs: theirs.tasks, id: 'id', groups: TASK_GROUPS, ask, kind: 'task', label: (t) => `“${t.name}”`, newId: newTaskId });
  merged.nextTaskId = Math.max(mine.nextTaskId ?? 1, theirs.nextTaskId ?? 1, ...merged.tasks.map((t) => t.id + 1));
  if (mine.legend || theirs.legend) {
    merged.legend = { ...theirs.legend };
    for (const s of SECTIONS) {
      merged.legend[s] = mergeList({ base: base.legend?.[s], mine: mine.legend?.[s], theirs: theirs.legend?.[s], id: 'uid', groups: [], ask, kind: s, label: (x) => `${SECTION_NAME[s]} “${x.text}”` });
    }
  }
  return { merged, conflicts };
}

/** Gives legend items without one a uid, the same one wherever the same saved schedule is loaded. */
export function withUids(legend) {
  if (!legend) return legend;
  const out = { ...legend };
  for (const s of SECTIONS) {
    if (!out[s]) continue;
    const seen = new Set(out[s].map((x) => x.uid).filter(Boolean));
    const taken = new Set();
    out[s] = out[s].map((x, i) => {
      if (x.uid && !taken.has(x.uid)) { taken.add(x.uid); return x; }
      let uid = `${s[0]}${i}`;
      while (seen.has(uid) || taken.has(uid)) uid += '_';
      taken.add(uid);
      return { ...x, uid };
    });
  }
  return out;
}
/** For an item added now: unlike any another tab might add. */
export const newUid = () => Math.random().toString(36).slice(2, 12);
