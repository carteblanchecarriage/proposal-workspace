// The fee worksheet's side of the AI assistant (the panel is assistant.ts, wired up in fee.ts): the team asks about
// the fee or asks for changes to its tasks and hours. Claude gets a compact copy of the worksheet with short ids (P1,
// P1-T2) and returns a list of edits; they're checked here against the worksheet before anything changes, applied as
// one step (one Undo reverses them), and saved like any other edit.
import type { FeeChat } from "../lib/claude";
import { budgetOf, taskCost, taskHours, totals } from "./fee-calc";
import type { SavedFee } from "./store";

type Change = FeeChat["changes"][number];

const round = (n: number) => Math.round(n * 100) / 100;

/** The worksheet as Claude sees it: short ids, every total worked out, nothing it doesn't need. */
export function worksheetFor(f: SavedFee) {
  const t = totals(f);
  const phases = f.phases.map((p, i) => {
    const pt = t.phases[i];
    return {
      id: `P${i + 1}`,
      name: p.name,
      typical_share_percent: pt.typical,
      share_percent: pt.share == null ? null : round(pt.share),
      hours: round(pt.hours),
      cost: round(pt.cost),
      tasks: p.tasks.map((task, j) => ({
        id: `P${i + 1}-T${j + 1}`,
        name: task.name,
        hours: Object.fromEntries(Object.entries(task.hours).filter(([, h]) => h > 0)),
        total_hours: round(taskHours(task)),
        cost: round(taskCost(task, f.roles)),
      })),
    };
  });
  return {
    title: f.title,
    construction_budget: budgetOf(f),
    target_percent: f.targetPercent,
    markup_percent: f.markupPercent,
    expenses: f.expenses,
    duration_months: f.durationMonths ?? null,
    summary: { budget_basis: f.draft?.basis ?? "", assumptions: (f.draft?.assumptions ?? []).filter((a) => a.trim()) },
    roles: f.roles.map((r) => ({ id: r.id, name: r.name, short: r.short ?? "", rate: r.rate, hours: round(t.roleHours[r.id] ?? 0) })),
    phases,
    consultants: f.consultants.map((c) => ({ discipline: c.discipline, firm: c.firm, fee: round(f.phases.reduce((s, p) => s + (c.byPhase?.[p.id] ?? 0), 0)) })),
    totals: {
      labor_hours: round(t.laborHours),
      labor: round(t.labor),
      consultants: round(t.consultants),
      markup: round(t.markup),
      expenses: round(t.expenses),
      total_fee: round(t.total),
      percent_of_construction: t.percentOfBudget == null ? null : round(t.percentOfBudget),
      target_fee: t.target == null ? null : round(t.target),
    },
  };
}

const cleanHours = (h: number) => Math.min(10_000, Math.max(0, Math.round(h * 2) / 2));

/**
 * Applies Claude's edits to the fee, checking each against it first: ids must exist, hours are whole or half hours
 * for roles on the fee, and values stay in range. Returns the phases it touched and how many edits were skipped.
 */
export function applyFeeChanges(f: SavedFee, changes: Change[]): { applied: number; skipped: number; phases: Set<string> } {
  const touched = new Set<string>();
  const roles = new Set(f.roles.map((r) => r.id));
  const phaseOf = (id: string) => {
    const m = /^P(\d+)$/.exec(id.trim());
    return m ? f.phases[Number(m[1]) - 1] : undefined;
  };
  // Task ids refer to the worksheet as sent, so they're resolved before anything moves.
  const taskIds = new Map<string, { phase: SavedFee["phases"][number]; task: SavedFee["phases"][number]["tasks"][number] }>();
  f.phases.forEach((phase, i) => phase.tasks.forEach((task, j) => taskIds.set(`P${i + 1}-T${j + 1}`, { phase, task })));
  const setHours = (hours: Record<string, number>, list: Change["hours"]) => {
    for (const h of list) {
      if (!roles.has(h.role_id) || !Number.isFinite(h.hours)) continue;
      const v = cleanHours(h.hours);
      if (v > 0) hours[h.role_id] = v;
      else delete hours[h.role_id];
    }
  };
  let applied = 0;
  let skipped = 0;
  for (const c of changes) {
    const found = taskIds.get(c.task_id.trim());
    if (c.op === "add_task") {
      const phase = phaseOf(c.phase_id);
      const name = c.name.trim().slice(0, 200);
      if (!phase || !name) {
        skipped++;
        continue;
      }
      const task = { id: crypto.randomUUID(), name, hours: {} as Record<string, number> };
      setHours(task.hours, c.hours);
      const at = found && found.phase === phase ? phase.tasks.indexOf(found.task) + 1 : phase.tasks.length;
      phase.tasks.splice(at, 0, task);
      touched.add(phase.id);
    } else if (c.op === "update_task" || c.op === "delete_task") {
      if (!found || !found.phase.tasks.includes(found.task)) {
        skipped++;
        continue;
      }
      if (c.op === "delete_task") found.phase.tasks.splice(found.phase.tasks.indexOf(found.task), 1);
      else {
        if (c.name.trim()) found.task.name = c.name.trim().slice(0, 200);
        setHours(found.task.hours, c.hours);
      }
      touched.add(found.phase.id);
    } else if (c.op === "scale_hours") {
      // Every task's hours in one phase ("" = all), times a factor within reason.
      const phases = c.phase_id.trim() ? [phaseOf(c.phase_id)].filter((x) => !!x) : f.phases;
      if (!phases.length || !Number.isFinite(c.number) || c.number <= 0 || c.number > 5) {
        skipped++;
        continue;
      }
      for (const phase of phases) {
        for (const task of phase.tasks)
          for (const [role, h] of Object.entries(task.hours)) {
            const v = cleanHours(h * c.number);
            if (v > 0) task.hours[role] = v;
            else delete task.hours[role];
          }
        touched.add(phase.id);
      }
    } else if (c.op === "set_value") {
      const n = c.number;
      if (!Number.isFinite(n) || n < 0) {
        skipped++;
        continue;
      }
      if (c.name === "target_percent" && n <= 100) {
        f.targetPercent = round(n);
        f.targetFromCurve = false;
      } else if (c.name === "markup_percent" && n <= 100) f.markupPercent = round(n);
      else if (c.name === "expenses") f.expenses = Math.round(n);
      else if (c.name === "duration_months" && n > 0 && n <= 240) f.durationMonths = round(n);
      else {
        skipped++;
        continue;
      }
    } else {
      skipped++;
      continue;
    }
    applied++;
  }
  return { applied, skipped, phases: touched };
}
