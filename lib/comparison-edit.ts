// Changing a saved comparison without redoing it: taking firms out (no AI needed), and merging in what the AI
// returns for firms added later (see extendComparison in lib/claude.ts). Shared by the server and the browser.

import type { Comparison } from "./claude.js";

type Status = Comparison["categories"][number]["items"][number]["statuses"][number];

/** What the AI returns when firms are added to an existing comparison: only what's new, plus a fresh briefing. */
export type ComparisonExtension = {
  briefing: Comparison["briefing"];
  /** each new firm's status for the existing scope items (matched by category and item text) */
  statuses: (Status & { category: string; item: string })[];
  /** scope items the new proposals raise, with a status for every firm */
  new_items: { category: string; item: string; statuses: Status[] }[];
  /** each new firm's fee lines, on existing fee rows (matched by section and label) or new ones */
  fee_cells: { section: string; label: string; firm_index: number; item_ids: number[]; note: string | null }[];
  /** new firms' pricing-scenario wording, mapped to the existing scenario names */
  scenario_labels: { name: string; firm_index: number; scenario: string }[];
};

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Takes firms out of a comparison (by firm_index) and renumbers the rest, keeping their order. */
export function removeFirms(cmp: Comparison, remove: number[]): Comparison {
  if (!remove.length) return cmp;
  const gone = new Set(remove);
  const map = new Map<number, number>();
  const count = Math.max(
    -1,
    ...cmp.categories.flatMap((c) => c.items.flatMap((i) => i.statuses.map((s) => s.firm_index))),
    ...cmp.fee_rows.flatMap((r) => r.cells.map((c) => c.firm_index)),
  ) + 1;
  for (let i = 0, n = 0; i < count; i++) if (!gone.has(i)) map.set(i, n++);
  const keep = (i: number) => map.has(i);
  const to = (i: number) => map.get(i)!;
  return {
    briefing: {
      ...cmp.briefing,
      flags: cmp.briefing.flags
        .map((f) => ({ ...f, firm_indexes: f.firm_indexes.filter(keep).map(to) }))
        .filter((f, k) => f.firm_indexes.length || !cmp.briefing.flags[k].firm_indexes.length),
      questions: cmp.briefing.questions.filter((q) => keep(q.firm_index)).map((q) => ({ ...q, firm_index: to(q.firm_index) })),
    },
    scenarios: cmp.scenarios.map((s) => ({ ...s, firm_labels: s.firm_labels.filter((l) => keep(l.firm_index)).map((l) => ({ ...l, firm_index: to(l.firm_index) })) })),
    fee_rows: cmp.fee_rows
      .map((r) => ({ ...r, cells: r.cells.filter((c) => keep(c.firm_index)).map((c) => ({ ...c, firm_index: to(c.firm_index) })) }))
      .filter((r) => r.cells.some((c) => c.item_ids.length)),
    categories: cmp.categories
      .map((c) => ({
        ...c,
        items: c.items.map((i) => ({ ...i, statuses: i.statuses.filter((s) => keep(s.firm_index)).map((s) => ({ ...s, firm_index: to(s.firm_index) })) })),
      }))
      .filter((c) => c.items.length),
  };
}

/** Merges what the AI returned for added firms into the comparison (existing content is kept as it was). */
export function mergeExtension(cmp: Comparison, ext: ComparisonExtension): Comparison {
  const categories = cmp.categories.map((c) => ({ ...c, items: c.items.map((i) => ({ ...i, statuses: [...i.statuses] })) }));
  const findItem = (category: string, item: string) => {
    const cat = categories.find((c) => same(c.name, category));
    return { cat, it: cat?.items.find((i) => same(i.item, item)) };
  };
  for (const s of ext.statuses) {
    const { category, item, ...status } = s;
    const { it } = findItem(category, item);
    if (it && !it.statuses.some((x) => x.firm_index === status.firm_index)) it.statuses.push(status);
  }
  for (const n of ext.new_items) {
    const { cat, it } = findItem(n.category, n.item);
    if (it) {
      for (const st of n.statuses) if (!it.statuses.some((x) => x.firm_index === st.firm_index)) it.statuses.push(st);
    } else if (cat) cat.items.push({ item: n.item, statuses: n.statuses });
    else categories.push({ name: n.category, items: [{ item: n.item, statuses: n.statuses }] });
  }
  const fee_rows = cmp.fee_rows.map((r) => ({ ...r, cells: [...r.cells] }));
  for (const f of ext.fee_cells) {
    let row = fee_rows.find((r) => same(r.section, f.section) && same(r.label, f.label));
    if (!row) fee_rows.push((row = { section: f.section, label: f.label, cells: [] }));
    const at = row.cells.findIndex((c) => c.firm_index === f.firm_index);
    const cell = { firm_index: f.firm_index, item_ids: f.item_ids, note: f.note };
    if (at >= 0) row.cells[at] = cell;
    else row.cells.push(cell);
  }
  const scenarios = cmp.scenarios.map((s) => ({ ...s, firm_labels: [...s.firm_labels] }));
  for (const l of ext.scenario_labels) {
    let s = scenarios.find((x) => same(x.name, l.name));
    if (!s) scenarios.push((s = { name: l.name, firm_labels: [] }));
    if (!s.firm_labels.some((x) => x.firm_index === l.firm_index)) s.firm_labels.push({ firm_index: l.firm_index, scenario: l.scenario });
  }
  return { briefing: ext.briefing, scenarios, fee_rows, categories };
}
