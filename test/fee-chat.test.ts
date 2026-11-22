// The fee assistant's edits: Claude's answer is untrusted input, so every edit is checked against the worksheet before
// it changes anything. These tests feed it good edits, and the malformed ones a model can produce.
import { describe, expect, it } from "vitest";
import type { FeeChat } from "../lib/claude";
import { applyFeeChanges, worksheetFor } from "../src/fee-chat";
import { totals } from "../src/fee-calc";
import { workedExample } from "./fixtures";

type Change = FeeChat["changes"][number];
const edit = (c: Partial<Change>): Change => ({
  op: "set_value",
  phase_id: "",
  task_id: "",
  name: "",
  number: 0,
  hours: [],
  consultant_id: "",
  discipline: "",
  firm: "",
  fees: [],
  ...c,
});

describe("worksheetFor: what Claude sees", () => {
  const w = worksheetFor(workedExample());
  it("short ids for phases, tasks and consultants", () => {
    expect(w.phases.map((p) => p.id)).toEqual(["P1", "P2"]);
    expect(w.phases[0].tasks.map((t) => t.id)).toEqual(["P1-T1", "P1-T2"]);
    expect(w.consultants.map((c) => c.id)).toEqual(["C1", "C2"]);
  });
  it("the totals it's told match the worksheet's", () => {
    expect(w.totals.total_fee).toBe(50_400);
    expect(w.consultants[0]).toMatchObject({ fee: 25_000, by_phase: [{ phase_id: "P1", amount: 10_000 }, { phase_id: "P2", amount: 15_000 }] });
  });
});

describe("applyFeeChanges: tasks and hours", () => {
  it("adds a task after the one named, with hours rounded to half hours", () => {
    const f = workedExample();
    const r = applyFeeChanges(f, [edit({ op: "add_task", phase_id: "P1", task_id: "P1-T1", name: "Code review", hours: [{ role_id: "pa", hours: 7.3 }] })]);
    expect(r).toMatchObject({ applied: 1, skipped: 0 });
    expect(f.phases[0].tasks.map((t) => t.name)).toEqual(["Massing", "Code review", "Meetings"]);
    expect(f.phases[0].tasks[1].hours).toEqual({ pa: 7.5 });
  });

  it("ids refer to the worksheet as sent, even after an earlier edit in the same reply moves tasks", () => {
    const f = workedExample();
    applyFeeChanges(f, [edit({ op: "delete_task", task_id: "P1-T1" }), edit({ op: "update_task", task_id: "P1-T2", name: "Weekly meetings" })]);
    expect(f.phases[0].tasks.map((t) => t.name)).toEqual(["Weekly meetings"]);
  });

  it("hours of 0 take a role off a task; unknown roles are ignored", () => {
    const f = workedExample();
    applyFeeChanges(f, [edit({ op: "update_task", task_id: "P1-T1", hours: [{ role_id: "pr", hours: 0 }, { role_id: "ghost", hours: 50 }] })]);
    expect(f.phases[0].tasks[0].hours).toEqual({ pa: 40 });
  });

  it("caps absurd hours", () => {
    const f = workedExample();
    applyFeeChanges(f, [edit({ op: "update_task", task_id: "P1-T1", hours: [{ role_id: "pa", hours: 1e9 }] })]);
    expect(f.phases[0].tasks[0].hours.pa).toBe(10_000);
  });

  it("scales one phase, or all of them", () => {
    const f = workedExample();
    applyFeeChanges(f, [edit({ op: "scale_hours", phase_id: "P2", number: 0.5 })]);
    expect(f.phases[1].tasks[0].hours).toEqual({ pr: 2.5, pa: 30 });
    const g = workedExample();
    applyFeeChanges(g, [edit({ op: "scale_hours", phase_id: "", number: 2 })]);
    expect(totals(g).labor).toBe(2 * 17_400);
  });

  it("refuses a scale of 0, negative, or more than 5×", () => {
    for (const number of [0, -1, 6, NaN]) expect(applyFeeChanges(workedExample(), [edit({ op: "scale_hours", number })]).skipped).toBe(1);
  });
});

describe("applyFeeChanges: settings", () => {
  it("sets the target, markup, expenses and duration within range", () => {
    const f = workedExample();
    const r = applyFeeChanges(f, [
      edit({ name: "target_percent", number: 7.25 }),
      edit({ name: "markup_percent", number: 12 }),
      edit({ name: "expenses", number: 3200.4 }),
      edit({ name: "duration_months", number: 18 }),
    ]);
    expect(r.applied).toBe(4);
    expect([f.targetPercent, f.markupPercent, f.expenses, f.durationMonths]).toEqual([7.25, 12, 3200, 18]);
    expect(f.targetFromCurve).toBe(false);
  });

  it("never changes rates, the budget, or anything it doesn't know", () => {
    const f = workedExample();
    const r = applyFeeChanges(f, [edit({ name: "rate", number: 999 }), edit({ name: "budget", number: 1 }), edit({ name: "markup_percent", number: 150 }), edit({ name: "expenses", number: -5 })]);
    expect(r).toMatchObject({ applied: 0, skipped: 4 });
    expect(f).toEqual(workedExample());
  });

  it("skips unknown ops and unknown ids without touching anything else", () => {
    const f = workedExample();
    const r = applyFeeChanges(f, [edit({ op: "delete_everything" as never }), edit({ op: "delete_task", task_id: "P9-T9" }), edit({ op: "add_task", phase_id: "P9", name: "x" })]);
    expect(r).toMatchObject({ applied: 0, skipped: 3 });
    expect(f).toEqual(workedExample());
  });
});

describe("applyFeeChanges: consultants", () => {
  it("fills an existing row: firm name and fees by phase, rounded to dollars", () => {
    const f = workedExample();
    applyFeeChanges(f, [edit({ op: "update_consultant", consultant_id: "C1", firm: "Acme Engineering", fees: [{ phase_id: "P1", amount: 12_000.6 }] })]);
    expect(f.consultants[0]).toMatchObject({ firm: "Acme Engineering", discipline: "MEP", byPhase: { sd: 12_001, dd: 15_000 } });
  });

  it("an amount of 0 takes the consultant off that phase", () => {
    const f = workedExample();
    applyFeeChanges(f, [edit({ op: "update_consultant", consultant_id: "C1", fees: [{ phase_id: "P2", amount: 0 }] })]);
    expect(f.consultants[0].byPhase).toEqual({ sd: 10_000 });
  });

  it("adds a consultant; refuses one with no name and no discipline, or only bad phases", () => {
    const f = workedExample();
    const r = applyFeeChanges(f, [
      edit({ op: "add_consultant", discipline: "Civil", firm: "Grade Co", fees: [{ phase_id: "P2", amount: 4_000 }] }),
      edit({ op: "add_consultant", fees: [{ phase_id: "P1", amount: 1 }] }),
      edit({ op: "add_consultant", discipline: "Lighting", fees: [{ phase_id: "P7", amount: 1 }] }),
    ]);
    expect(r).toMatchObject({ applied: 1, skipped: 2 });
    expect(f.consultants.at(-1)).toMatchObject({ discipline: "Civil", firm: "Grade Co", byPhase: { dd: 4_000 } });
  });

  it("removing a consultant unassigns the scope items it was to provide", () => {
    const f = workedExample();
    f.belowLine = [{ id: "b", label: "Survey", basis: "lump", amount: 1, note: "", by: "c2" }];
    applyFeeChanges(f, [edit({ op: "delete_consultant", consultant_id: "C2" })]);
    expect(f.consultants.map((c) => c.id)).toEqual(["c1"]);
    expect(f.belowLine[0].by).toBeUndefined();
  });

  it("caps an absurd fee", () => {
    const f = workedExample();
    applyFeeChanges(f, [edit({ op: "update_consultant", consultant_id: "C1", fees: [{ phase_id: "P1", amount: 1e15 }] })]);
    expect(f.consultants[0].byPhase.sd).toBe(100_000_000);
  });
});
