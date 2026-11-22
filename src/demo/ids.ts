// The demo's sample project and RFP review, by id. In their own small module so the app and the tour can name them
// without loading the demo's sample data (demo/data.ts, loaded only when the demo starts).

export const DEMO_PROJECT_ID = "demo-project-library";
export const DEMO_RFP_ID = "demo-rfp-library";

/** Parts of the sample project the visitor has filled in (one click each, from the dashboard; see project.ts). */
export type DemoPart = "schedule" | "fee" | "proposals";
const REVEALED = "demo_revealed";
export function demoRevealed(): DemoPart[] {
  try {
    return JSON.parse(sessionStorage.getItem(REVEALED) ?? "[]") as DemoPart[];
  } catch {
    return [];
  }
}
export function markRevealed(part: DemoPart) {
  try {
    sessionStorage.setItem(REVEALED, JSON.stringify([...new Set([...demoRevealed(), part])]));
  } catch {}
}
/** Every part filled in: the tour is over, so the sample project is complete. */
export function revealAll() {
  for (const part of ["schedule", "fee", "proposals"] as DemoPart[]) markRevealed(part);
}
export function clearRevealed() {
  try {
    sessionStorage.removeItem(REVEALED);
  } catch {}
}
