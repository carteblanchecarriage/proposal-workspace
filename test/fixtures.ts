// Building blocks for fee tests: a valid fee with sensible defaults, and fast-check generators for random fees
// (including the messy values a real worksheet can hold: blank cells, nulls, zero rates, unnamed phases).

import fc from "fast-check";
import type { FeeConsultant, FeePhase, FeeRole, SavedFee } from "../src/store";

export function makeFee(over: Partial<SavedFee> = {}): SavedFee {
  return {
    id: "fee-1",
    savedAt: 0,
    title: "Test fee",
    template: "",
    budget: { by: "amount", amount: null, area: null, costPerSf: null },
    targetPercent: null,
    roles: [],
    phases: [],
    consultants: [],
    markupPercent: 0,
    expenses: null,
    ...over,
  };
}

/**
 * The worked example the totals are checked against by hand:
 *   Principal $200/h, Architect $120/h.
 *   SD (typical 30%): Massing PR 10 + PA 40 = $6,800; Meetings PA 20 = $2,400. SD = 70 h, $9,200.
 *   DD (typical 70%): Plans PR 5 + PA 60 = $8,200. DD = 65 h, $8,200.
 *   Labor $17,400 (135 h). MEP $10,000 SD + $15,000 DD; Structural $5,000 DD: consultants $30,000.
 *   Markup 10% = $3,000. Total fee $50,400. Expenses $2,500 (listed, not in the fee).
 *   Budget $1,000,000: fee is 5.04%; a 6% target is $60,000.
 */
export function workedExample(): SavedFee {
  return makeFee({
    budget: { by: "amount", amount: 1_000_000, area: null, costPerSf: null },
    targetPercent: 6,
    roles: [
      { id: "pr", name: "Principal", rate: 200 },
      { id: "pa", name: "Architect", rate: 120 },
    ],
    phases: [
      {
        id: "sd",
        name: "Schematic Design",
        targetShare: 30,
        tasks: [
          { id: "t1", name: "Massing", hours: { pr: 10, pa: 40 } },
          { id: "t2", name: "Meetings", hours: { pa: 20 } },
        ],
      },
      { id: "dd", name: "Design Development", targetShare: 70, tasks: [{ id: "t3", name: "Plans", hours: { pr: 5, pa: 60 } }] },
    ],
    consultants: [
      { id: "c1", discipline: "MEP", firm: "Acme", byPhase: { sd: 10_000, dd: 15_000 } },
      { id: "c2", discipline: "Structural", firm: "Beam", byPhase: { dd: 5_000 } },
    ],
    markupPercent: 10,
    expenses: 2_500,
  });
}

// ---------- Generators ----------

/** Whole or half hours, sometimes blank; the worksheet never stores anything else. */
const hours = fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 400 }).map((h) => h / 2));
/** Dollar amounts with cents, as typed. */
const dollars = fc.integer({ min: 0, max: 50_000_000 }).map((c) => c / 100);

export const roleArb: fc.Arbitrary<FeeRole> = fc.record({
  id: fc.constantFrom("pr", "pm", "pa", "id"),
  name: fc.string({ maxLength: 12 }),
  rate: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 400 })),
});

export const feeArb: fc.Arbitrary<SavedFee> = fc
  .record({
    roles: fc.uniqueArray(roleArb, { selector: (r) => r.id, maxLength: 4 }),
    phaseCount: fc.integer({ min: 0, max: 6 }),
    consultantCount: fc.integer({ min: 0, max: 4 }),
    markupPercent: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 30 }), fc.double({ min: 0, max: 30, noNaN: true })),
    expenses: fc.oneof(fc.constant(null), dollars),
    budget: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 200_000_000 })),
    seed: fc.array(fc.tuple(hours, hours, hours, hours, dollars, fc.boolean(), fc.integer({ min: 0, max: 60 })), { minLength: 30, maxLength: 30 }),
    names: fc.array(fc.oneof(fc.constant(""), fc.constant("  "), fc.string({ minLength: 1, maxLength: 20 })), { minLength: 6, maxLength: 6 }),
  })
  .map(({ roles, phaseCount, consultantCount, markupPercent, expenses, budget, seed, names }) => {
    const roleIds = ["pr", "pm", "pa", "id"];
    const phases: FeePhase[] = Array.from({ length: phaseCount }, (_, i) => ({
      id: `p${i}`,
      name: names[i],
      targetShare: seed[i][6],
      tasks: Array.from({ length: (i % 3) + 1 }, (_, j) => {
        const [h0, h1, h2, h3] = seed[(i * 3 + j) % seed.length];
        // Hours can also be on roles no longer on the fee; they never count.
        const hours: Record<string, number> = { [roleIds[0]]: h0, [roleIds[1]]: h1, [roleIds[2]]: h2, [roleIds[3]]: h3 };
        return { id: `p${i}t${j}`, name: `Task ${j}`, hours };
      }),
    }));
    const consultants: FeeConsultant[] = Array.from({ length: consultantCount }, (_, c) => ({
      id: `c${c}`,
      discipline: `D${c}`,
      firm: `Firm ${c}`,
      byPhase: Object.fromEntries([
        ...phases.filter((_, i) => seed[(i + c) % seed.length][5]).map((p, i) => [p.id, seed[(i + c * 5) % seed.length][4]] as const),
        // An amount for a phase that was removed from the fee: it must never count.
        ["removed-phase", 99_999],
      ]),
    }));
    return makeFee({ roles, phases, consultants, markupPercent, expenses, budget: { by: "amount", amount: budget, area: null, costPerSf: null } });
  });

/** A whole number of cents (for checking that amounts sit on a rounding increment). */
export const cents = (n: number) => Math.round(n * 100);

/**
 * Two amounts of money are the same: within a hundredth of a cent. Adding the same dollars in a different order can
 * differ in the last binary digits, so rounding each side to the cent can land them a cent apart. Never compare that way.
 */
export const sameMoney = (a: number, b: number) => Math.abs(a - b) < 1e-4;
