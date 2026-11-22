// The activity page's usage arithmetic, shared by the server (lib/admin.ts) and the page (src/admin-page.ts). No
// server imports, so nothing from the database or encryption code reaches the browser.

import type { AdminOverview } from "./admin.js";

/** Most used first; ties by cost, then name, so the order never depends on how the rows arrived. */
export function sortFeatures<T extends { endpoint: string; calls: number; costUsd: number }>(list: T[]): T[] {
  return list.sort((a, b) => b.calls - a.calls || b.costUsd - a.costUsd || a.endpoint.localeCompare(b.endpoint));
}

/** The usage of some organizations only (e.g. all but the owner's): per day, per feature, and this month's totals. */
export function usageFor(o: AdminOverview, include: (orgId: string) => boolean) {
  const ids = Object.keys(o.byOrg).filter(include);
  const days = o.days.map((d, i) => ({
    date: d.date,
    calls: ids.reduce((s, id) => s + o.byOrg[id].days[i].calls, 0),
    costUsd: ids.reduce((s, id) => s + o.byOrg[id].days[i].costUsd, 0),
  }));
  const feats = new Map<string, { calls: number; costUsd: number }>();
  for (const id of ids)
    for (const [endpoint, f] of Object.entries(o.byOrg[id].features)) {
      const t = feats.get(endpoint) ?? { calls: 0, costUsd: 0 };
      feats.set(endpoint, { calls: t.calls + f.calls, costUsd: t.costUsd + f.costUsd });
    }
  const features = sortFeatures([...feats.entries()].map(([endpoint, f]) => ({ endpoint, ...f })));
  return { days, features, callsMonth: features.reduce((s, f) => s + f.calls, 0), costMonth: features.reduce((s, f) => s + f.costUsd, 0) };
}
