import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { budgetOf, consultantTotal, proposalTable, readAmount, readArea, roundedTable, summable, taskCost, taskHours, totals, wholePercents } from "../src/fee-calc";
import { cents, feeArb, makeFee, sameMoney, workedExample } from "./fixtures";

describe("totals: the worked example, checked by hand", () => {
  const t = totals(workedExample());

  it("adds labor from hours × rates, phase by phase", () => {
    expect(t.phases.map((p) => [p.hours, p.cost])).toEqual([
      [70, 9_200],
      [65, 8_200],
    ]);
    expect(t.labor).toBe(17_400);
    expect(t.laborHours).toBe(135);
    expect(t.roleHours).toEqual({ pr: 15, pa: 120 });
  });

  it("adds consultants, and marks up only consultants", () => {
    expect(t.consultants).toBe(30_000);
    expect(t.markup).toBe(3_000);
  });

  it("leaves reimbursable expenses out of the fee", () => {
    expect(t.expenses).toBe(2_500);
    expect(t.total).toBe(50_400);
  });

  it("works out the percent of construction and the target fee", () => {
    expect(t.budget).toBe(1_000_000);
    expect(t.percentOfBudget).toBeCloseTo(5.04, 10);
    expect(t.target).toBe(60_000);
  });

  it("gives each phase its share of labor and its typical share", () => {
    expect(t.phases[0].share).toBeCloseTo((9_200 / 17_400) * 100, 10);
    expect(t.phases.map((p) => p.typical)).toEqual([30, 70]);
  });
});

describe("proposalTable: the worked example", () => {
  const table = proposalTable(workedExample());

  it("puts architecture (labor + that phase's markup) beside each consultant", () => {
    expect(table.columns.map((c) => c.discipline)).toEqual(["Architecture", "MEP", "Structural"]);
    expect(table.rows).toEqual([
      { phaseId: "sd", label: "Schematic Design", amounts: [10_200, 10_000, 0], total: 20_200 },
      { phaseId: "dd", label: "Design Development", amounts: [10_200, 15_000, 5_000], total: 30_200 },
    ]);
    expect(table.totals).toEqual([20_400, 25_000, 5_000]);
  });

  it("totals exactly what the worksheet totals", () => {
    expect(table.total).toBe(totals(workedExample()).total);
  });

  it("lists expenses separately", () => {
    expect(table.expenses).toBe(2_500);
  });
});

describe("edge cases a real worksheet has", () => {
  it("an empty fee is all zeros, with no percent or target", () => {
    const t = totals(makeFee());
    expect([t.labor, t.consultants, t.markup, t.total, t.expenses]).toEqual([0, 0, 0, 0, 0]);
    expect(t.percentOfBudget).toBeNull();
    expect(t.target).toBeNull();
  });

  it("a blank rate or blank hours count as zero, never as NaN", () => {
    const fee = makeFee({
      roles: [{ id: "pa", name: "PA", rate: null }],
      phases: [{ id: "p", name: "SD", targetShare: 0, tasks: [{ id: "t", name: "x", hours: { pa: NaN, pr: 5 } }] }],
    });
    const t = totals(fee);
    expect(t.labor).toBe(0);
    expect(Number.isNaN(t.total)).toBe(false);
    expect(taskHours(fee.phases[0].tasks[0])).toBe(5); // hours on a role not on the fee still show as hours…
    expect(taskCost(fee.phases[0].tasks[0], fee.roles)).toBe(0); // …but cost nothing
  });

  it("a zero budget gives no percent (never Infinity)", () => {
    const t = totals(makeFee({ budget: { by: "amount", amount: 0, area: null, costPerSf: null }, targetPercent: 8 }));
    expect(t.percentOfBudget).toBeNull();
    expect(t.target).toBeNull();
  });

  it("a consultant's fee on a phase that was removed doesn't count", () => {
    const fee = makeFee({ phases: [{ id: "sd", name: "SD", targetShare: 100, tasks: [] }] });
    expect(consultantTotal({ id: "c", discipline: "", firm: "", byPhase: { sd: 100, gone: 5_000 } }, fee.phases)).toBe(100);
  });

  it("a phase not named yet still shows in the proposal table when it has amounts (found by the property test)", () => {
    const fee = makeFee({
      roles: [{ id: "pr", name: "PR", rate: 1 }],
      phases: [
        { id: "a", name: "", targetShare: 0, tasks: [{ id: "t", name: "x", hours: { pr: 0.5 } }] },
        { id: "b", name: "  ", targetShare: 0, tasks: [] },
      ],
    });
    const table = proposalTable(fee);
    expect(table.rows.map((r) => r.label)).toEqual(["Unnamed phase"]); // the empty unnamed phase stays hidden
    expect(table.total).toBe(totals(fee).total);
  });

  it("a consultant with no fee gets no column", () => {
    const fee = workedExample();
    fee.consultants.push({ id: "c3", discipline: "Civil", firm: "Nobody", byPhase: {} });
    expect(proposalTable(fee).columns).toHaveLength(3);
  });
});

describe("budgetOf", () => {
  it("by amount", () => expect(budgetOf(makeFee({ budget: { by: "amount", amount: 5e6, area: 100, costPerSf: 10 } }))).toBe(5e6));
  it("by area: area × cost per square foot", () => expect(budgetOf(makeFee({ budget: { by: "area", amount: 1, area: 12_000, costPerSf: 450 } }))).toBe(5_400_000));
  it("by area, half filled in: none", () => expect(budgetOf(makeFee({ budget: { by: "area", amount: null, area: 12_000, costPerSf: null } }))).toBeNull());
  it("older fees with only area and cost are read by area", () =>
    expect(budgetOf(makeFee({ budget: { amount: null, area: 1_000, costPerSf: 300 } as never }))).toBe(300_000));
});

describe("wholePercents", () => {
  it("splits evenly and gives the leftover point to the largest remainder", () => expect(wholePercents([1, 1, 1])).toEqual([34, 33, 33]));
  it("keeps shares that already add to 100", () => expect(wholePercents([5, 15, 20, 40, 5, 10, 5])).toEqual([5, 15, 20, 40, 5, 10, 5]));
  it("nothing to scale: nulls", () => expect(wholePercents([0, 0])).toEqual([null, null]));
  it("always whole numbers adding to exactly 100, each within 1 of its exact share", () =>
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 1_000 }), { minLength: 1, maxLength: 12 }).filter((w) => w.some((x) => x > 0)), (w) => {
        const out = wholePercents(w) as number[];
        const sum = w.reduce((s, x) => s + x, 0);
        expect(out.reduce((s, x) => s + x, 0)).toBe(100);
        out.forEach((p, i) => {
          expect(Number.isInteger(p)).toBe(true);
          expect(Math.abs(p - (w[i] / sum) * 100)).toBeLessThan(1);
        });
      }),
    ));
});

describe("readAmount and readArea (budgets and sizes typed or read from an RFP)", () => {
  it.each([
    ["$4.5 million", 4_500_000],
    ["$4,500,000", 4_500_000],
    ["4.5M", 4_500_000],
    ["$250k", 250_000],
    ["Construction budget: $7.8M", 7_800_000],
  ])("reads %s", (text, value) => expect(readAmount(text)).toBe(value));

  it.each([["$3M–$5M"], ["$500"], ["TBD"], [""]])("refuses %s (a range, too small, or nothing)", (text) => expect(readAmount(text)).toBeNull());

  it.each([
    ["12,000 SF", 12_000],
    ["12,000 sq ft", 12_000],
    ["8,500 GSF", 8_500],
    ["about 6,500 square feet", 6_500],
  ])("reads the area in %s", (text, value) => expect(readArea(text)).toBe(value));

  it("no area: null", () => expect(readArea("two floors")).toBeNull());
});

describe("additional scope items (below the line)", () => {
  it("never count in the fee, and only lump sums, allowances and not-to-exceed amounts add up", () => {
    const fee = workedExample();
    fee.belowLine = [
      { id: "b1", label: "Survey", basis: "lump", amount: 4_000, note: "", by: "architecture" },
      { id: "b2", label: "Extra visits", basis: "hourly", amount: 175, note: "", by: "c1" },
      { id: "b3", label: "Renderings", basis: "request", amount: null, note: "" },
      { id: "b4", label: "  ", basis: "lump", amount: 9_999, note: "" }, // blank label: not listed
    ];
    const table = proposalTable(fee);
    expect(table.total).toBe(50_400);
    expect(table.belowLine?.map((b) => [b.label, b.column])).toEqual([
      ["Survey", 0],
      ["Extra visits", 1],
      ["Renderings", null],
    ]);
    expect(table.belowLineTotal).toBe(4_000);
    expect(summable({ basis: "hourly", amount: 175 })).toBe(false);
  });
});

// ---------- Properties, over thousands of random worksheets ----------

describe("properties of every fee", () => {
  it("the total is labor + consultants + markup, and markup is exactly the markup percent of consultants", () =>
    fc.assert(
      fc.property(feeArb, (fee) => {
        const t = totals(fee);
        expect(t.total).toBeCloseTo(t.labor + t.consultants + t.markup, 6);
        expect(t.markup).toBeCloseTo((t.consultants * fee.markupPercent) / 100, 6);
        expect(t.phases.reduce((s, p) => s + p.hours, 0)).toBeCloseTo(t.laborHours, 6);
        for (const v of [t.total, t.labor, t.consultants, t.markup]) expect(Number.isFinite(v)).toBe(true);
      }),
      { numRuns: 2_000 },
    ));

  it("labor by phase adds up to labor by role (two different ways of adding the same hours)", () =>
    fc.assert(
      fc.property(feeArb, (fee) => {
        const t = totals(fee);
        const byRole = fee.roles.reduce((s, r) => s + (t.roleHours[r.id] ?? 0) * (r.rate ?? 0), 0);
        expect(sameMoney(byRole, t.labor)).toBe(true);
      }),
    ));

  it("the proposal table's total equals the worksheet's total, whatever the phases are called", () =>
    fc.assert(
      fc.property(feeArb, (fee) => {
        const table = proposalTable(fee);
        expect(sameMoney(table.total, totals(fee).total)).toBe(true);
        // And the table adds up across and down.
        for (const r of table.rows) expect(sameMoney(r.total, r.amounts.reduce((s, x) => s + x, 0))).toBe(true);
        expect(sameMoney(table.totals.reduce((s, x) => s + x, 0), table.total)).toBe(true);
      }),
      { numRuns: 2_000 },
    ));

  it("doubling every rate doubles labor; reordering phases changes no totals", () =>
    fc.assert(
      fc.property(feeArb, (fee) => {
        const t = totals(fee);
        const doubled = totals({ ...fee, roles: fee.roles.map((r) => ({ ...r, rate: r.rate == null ? null : r.rate * 2 })) });
        expect(sameMoney(doubled.labor, t.labor * 2)).toBe(true);
        const reversed = totals({ ...fee, phases: [...fee.phases].reverse() });
        expect(sameMoney(reversed.total, t.total)).toBe(true);
      }),
    ));

  it("rounded tables always add up as shown, for every rounding", () =>
    fc.assert(
      fc.property(feeArb, fc.constantFrom(0.01, 1, 10, 100, 1000), (fee, to) => {
        const round = (n: number) => (to === 0.01 ? Math.round(n * 100) / 100 : Math.round(n / to) * to);
        const t = roundedTable(proposalTable(fee), round);
        for (const r of t.rows) {
          for (const a of r.amounts) expect(cents(a) % cents(to)).toBe(0); // every amount is on the increment
          expect(sameMoney(r.total, r.amounts.reduce((s, x) => s + x, 0))).toBe(true);
        }
        t.totals.forEach((c, i) => expect(sameMoney(c, t.rows.reduce((s, r) => s + r.amounts[i], 0))).toBe(true));
        expect(sameMoney(t.total, t.totals.reduce((s, x) => s + x, 0))).toBe(true);
        // Rounding moves the total by at most half an increment per amount.
        const n = t.rows.reduce((s, r) => s + r.amounts.length, 0);
        expect(Math.abs(t.total - proposalTable(fee).total)).toBeLessThanOrEqual((n * to) / 2 + 0.01);
      }),
      { numRuns: 1_000 },
    ));
});
