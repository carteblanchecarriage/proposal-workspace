// Fee edge cases: what's typed or pasted into number boxes, credits, rounding, and the assistant's edits landing after
// the worksheet has changed.
import { describe, expect, it } from "vitest";
import type { FeeChat } from "../lib/claude";
import { cleanNumber, proposalTable, readArea, roundedTable, totals } from "../src/fee-calc";
import { applyFeeChanges } from "../src/fee-chat";
import { feeMoney, roundFee } from "../src/fee-style";
import { workedExample } from "./fixtures";

describe("cleanNumber", () => {
  it.each([
    ["4,000,000-5,000,000", "4000000"],
    ["$4,000,000 – $5,000,000", "4000000"],
    ["$4.5M", "4500000"],
    ["4.5 million", "4500000"],
    ["250k", "250000"],
    ["12,000 SF", "12000"],
    ["1.2.3", "1.2"],
    ["-5", "5"],
    ["007", "7"],
    ["12.", "12."],
    [".5", ".5"],
    ["", ""],
    ["abc", ""],
  ])("%s reads as %s", (typed, out) => expect(cleanNumber(typed, { units: true })).toBe(out));
  it("units only where they make sense", () => expect(cleanNumber("12m")).toBe("12"));
  it.each([["-500", "-500"], ["(500)", "-500"], ["-", "-"], ["$ -1,200", "-1200"]])("a credit: %s", (typed, out) => expect(cleanNumber(typed, { negative: true })).toBe(out));
  it("cleaning twice changes nothing", () => {
    for (const s of ["4.5M", "1.50", "12.", "1,234,567.89"]) {
      const once = cleanNumber(s, { units: true });
      expect(cleanNumber(once, { units: true })).toBe(once);
    }
  });
});

describe("credits", () => {
  it("a consultant whose fees cancel out, or are a credit, is in the proposal table: it totals the fee", () => {
    const f = workedExample();
    f.consultants[0].byPhase = { sd: 5_000, dd: -5_000 };
    f.consultants[1].byPhase = { dd: -2_000 };
    const t = proposalTable(f);
    expect(t.columns).toHaveLength(3);
    expect(t.total).toBeCloseTo(totals(f).total, 6);
  });
  it("show as -$ and round like the same charge", () => {
    expect(feeMoney(-1234.5)).toBe("-$ 1,235");
    expect(roundFee(-1500, 1000)).toBe(-roundFee(1500, 1000));
  });
});

describe("rounding", () => {
  it("half a cent rounds up as in Excel", () => expect(roundFee(1.005, 0.01)).toBe(1.01));
  it("never gives negative zero", () => expect(Object.is(roundFee(-0.2, 1), 0)).toBe(true));
  it("rounded totals still add up", () => {
    const t = roundedTable(proposalTable(workedExample()), (n) => roundFee(n, 1000));
    expect(t.rows.reduce((s, r) => s + r.total, 0)).toBe(t.total);
  });
});

describe("reading the RFP's area", () => {
  it.each(["10,000–12,000 SF", "10,000 to 12,000 sq ft", "10,000 SF - 12,000 SF"])("a range is not one area: %s", (s) => expect(readArea(s)).toBeNull());
  it("one area", () => expect(readArea("about 12,500 GSF")).toBe(12_500));
});

describe("the assistant answering about a worksheet that's changed since", () => {
  const edit = (c: Partial<FeeChat["changes"][number]>) => ({ op: "update_task", phase_id: "", task_id: "", name: "", number: 0, hours: [], consultant_id: "", discipline: "", firm: "", fees: [], ...c }) as FeeChat["changes"][number];
  it("edits the task it meant after phases are reordered and a task removed", () => {
    const sent = workedExample();
    const f = workedExample();
    f.phases.reverse();
    f.phases[1].tasks.shift();
    const r = applyFeeChanges(f, [edit({ task_id: "P1-T2", name: "Right one" }), edit({ task_id: "P1-T1", name: "Gone" })], sent);
    expect(r).toMatchObject({ applied: 1, skipped: 1 });
    expect(f.phases[1].tasks.map((t) => t.name)).toEqual(["Right one"]);
    expect(f.phases[0].tasks.map((t) => t.name)).toEqual(["Plans"]);
  });
  it("edits the consultant it meant after one is removed", () => {
    const f = workedExample();
    f.consultants.shift();
    applyFeeChanges(f, [edit({ op: "update_consultant", consultant_id: "C2", firm: "New" }), edit({ op: "delete_consultant", consultant_id: "C1" })], workedExample());
    expect(f.consultants).toMatchObject([{ id: "c2", firm: "New" }]);
  });
  it("an edit with nothing usable in it isn't counted as done", () => {
    expect(applyFeeChanges(workedExample(), [edit({ task_id: "P1-T1", hours: [{ role_id: "ghost", hours: 5 }] })])).toMatchObject({ applied: 0, skipped: 1 });
  });
});

describe("comparison notes", () => {
  it("keep words (a note with the letter d was dropped) and drop figures", async () => {
    const { feeTable } = await import("../src/table");
    const proposal = { firm: "A", additional_services: [], hourly_rates: [{ role: "PM", rate: 132.5 }], exclusions: [], assumptions: [], disciplines: [], reimbursables: "", payment_terms: "", fee_items: [{ id: "f1", label: "Fee", kind: "fee", amount: 100, percent: null, basis: "fixed", scenario: null, page: 0 }] };
    const html = (note: string) =>
      feeTable([proposal] as never, { scenarios: [], fee_rows: [{ section: "Fees", label: "Fee", cells: [{ firm_index: 0, item_ids: ["f1"], note }] }] } as never);
    expect(html("Includes design and bidding")).toContain("Includes design and bidding");
    expect(html("")).toContain("PM: $132.50/hr"); // as stated, not rounded
    expect(html("About 12 meetings")).not.toContain("About 12 meetings");
  });
});
