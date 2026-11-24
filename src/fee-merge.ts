// Combines two people's (or tabs') changes to the same fee, the way schedules do (schedule/lib/utils/merge.js): what
// only one side changed is kept, what both changed differently is asked about. Everything on a fee has its own id.
import { type Ask, type Conflict, mergeFields, mergeList, same } from "./schedule/lib/utils/merge.js";
import type { SavedFee } from "./store";

type Any = Record<string, any>;

// Kept by saving itself, or merged on their own below.
const OWN = new Set(["id", "createdAt", "savedAt", "savedBy", "_v", "workspaceProjectId", "status", "finalAt", "roles", "phases", "consultants", "belowLine"]);
// Parts that only make sense together: a target with whether it follows the curve, a draft summary as one list.
const GROUPS = [["targetPercent", "targetFromCurve"]];
const NAMES: Record<string, string> = {
  title: "Title",
  budget: "Construction budget",
  targetPercent: "Target fee percent",
  markupPercent: "Management markup",
  expenses: "Reimbursable expenses",
  durationMonths: "Project duration",
  draft: "Summary",
};

/** What a fee says, apart from how it's saved and whether it's final. */
export const feeContent = (f: SavedFee) => {
  const { savedAt: _a, savedBy: _b, _v, status: _s, finalAt: _f, ...rest } = f as SavedFee & { savedBy?: string };
  return rest;
};

export function mergeFees(base: SavedFee, mine: SavedFee, theirs: SavedFee, choices: Record<string, "mine" | "theirs"> = {}): { merged: SavedFee; conflicts: Conflict[] } {
  const conflicts: Conflict[] = [];
  const ask: Ask = (key, label, m, t) => {
    conflicts.push({ key, label, mine: m, theirs: t });
    return choices[key] ?? "mine";
  };
  /** Amounts keyed by role or phase (hours, consultant fees): each is its own value. */
  const amounts = (k: string, label: string, nameOf: (id: string) => string, b: Any, m: Any, t: Any) =>
    mergeFields(b ?? {}, m ?? {}, t ?? {}, [], (field, mv, tv) => ask(`${k}:${field}`, `${label}, ${nameOf(field)}`, mv, tv));
  const plain = (k: string, label: string, b: Any, m: Any, t: Any, skip: string[]) =>
    mergeFields(b, m, t, [], (field, mv, tv) => ask(`${k}:${field}`, `${label}: ${field}`, mv, tv), new Set(skip));
  const list = (kind: string, b: Any[] | undefined, m: Any[] | undefined, t: Any[] | undefined, label: (x: Any) => string, combine: (k: string, b: Any, m: Any, t: Any) => Any) =>
    mergeList({ base: b, mine: m, theirs: t, id: "id", groups: [], ask, kind, label, combine: (id, bb, mm, tt) => combine(`${kind}:${id}`, bb ?? {}, mm, tt) });

  const roleName = (id: string) => [...mine.roles, ...theirs.roles].find((r) => r.id === id)?.name ?? "role";
  const phaseName = (id: string) => [...mine.phases, ...theirs.phases].find((p) => p.id === id)?.name || "phase";
  const named = (x: Any) => `“${x.name || x.label || [x.discipline, x.firm].filter(Boolean).join(" ") || "unnamed"}”`;

  const merged = {
    ...theirs,
    ...mergeFields(base, mine, theirs, GROUPS, (f, m, t) => ask(`top:${f}`, NAMES[f] ?? f, m, t), OWN),
  } as SavedFee;
  for (const f of Object.keys(theirs) as (keyof SavedFee)[]) if (!OWN.has(f) && same(theirs[f], base[f]) && mine[f] === undefined) delete merged[f];
  merged.workspaceProjectId = same(mine.workspaceProjectId, base.workspaceProjectId) ? theirs.workspaceProjectId : mine.workspaceProjectId;
  // A role one side removed takes its hours with it. If the other side changed those hours meanwhile, that's asked about;
  // so for merging, a role carries its hours, and the tasks leave out the roles only one side still has.
  const hoursOf = (f: SavedFee, role: string) => Object.fromEntries(f.phases.flatMap((p) => p.tasks.filter((t) => t.hours[role]).map((t) => [t.id, t.hours[role]])));
  const withHours = (f: SavedFee) => f.roles.map((r) => ({ ...r, _hours: hoursOf(f, r.id) }));
  const has = (f: SavedFee, id: string) => f.roles.some((r) => r.id === id);
  const removed = base.roles.map((r) => r.id).filter((id) => has(mine, id) !== has(theirs, id));
  const without = (hours: Record<string, number> | undefined) => Object.fromEntries(Object.entries(hours ?? {}).filter(([id]) => !removed.includes(id)));
  merged.roles = list("role", withHours(base), withHours(mine), withHours(theirs), named, (k, b, m, t) => plain(k, named(m), b, m, t, ["_hours"])).map(({ _hours, ...r }) => r) as SavedFee["roles"];
  merged.phases = list("phase", base.phases, mine.phases, theirs.phases, named, (k, b, m, t) => ({
    ...plain(k, named(m), b, m, t, ["tasks"]),
    tasks: list(`${k}:task`, b.tasks, m.tasks, t.tasks, named, (tk, tb, tm, tt) => ({
      ...plain(tk, named(tm), tb, tm, tt, ["hours"]),
      hours: amounts(`${tk}:hours`, `${named(tm)} hours`, roleName, without(tb.hours), without(tm.hours), without(tt.hours)),
    })),
  })) as SavedFee["phases"];
  for (const p of merged.phases)
    p.tasks = p.tasks.map((task) => {
      const hours: Record<string, number> = without(task.hours);
      // A role that stays has its hours from the side that kept it.
      for (const id of removed.filter((id) => has(merged, id))) {
        const h = hoursOf(has(mine, id) ? mine : theirs, id)[task.id];
        if (h) hours[id] = h;
      }
      return { ...task, hours };
    });
  merged.consultants = list("consultant", base.consultants, mine.consultants, theirs.consultants, named, (k, b, m, t) => ({
    ...plain(k, named(m), b, m, t, ["byPhase"]),
    byPhase: amounts(`${k}:fee`, `${named(m)} fee`, phaseName, b.byPhase, m.byPhase, t.byPhase),
  })) as SavedFee["consultants"];
  if (mine.belowLine || theirs.belowLine) merged.belowLine = list("scope", base.belowLine, mine.belowLine, theirs.belowLine, named, (k, b, m, t) => plain(k, named(m), b, m, t, [])) as SavedFee["belowLine"];

  // Final means these exact numbers were marked final: a combination nobody marked is a draft.
  const marked = [mine, theirs].filter((f) => f.status === "final" && same(feeContent(f), feeContent(merged)));
  const reopened = base.status === "final" && [mine, theirs].some((f) => f.status !== "final" && same(feeContent(f), feeContent(base)));
  if (marked.length && !reopened) Object.assign(merged, { status: "final", finalAt: marked[0].finalAt });
  else {
    if (merged.status || [mine, theirs, base].some((f) => f.status)) merged.status = "draft";
    delete merged.finalAt;
  }
  return { merged, conflicts };
}
