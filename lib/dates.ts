// Dates as the site stores them ("YYYY-MM-DD"), shared by the browser and the server. No dependencies.

const pad = (n: number, len = 2) => String(n).padStart(len, "0");

/**
 * A real calendar day, in a year a project could use. Not just the right shape: "2027-02-31" or a mistyped year ("0202",
 * "9999") would put things centuries away, and draw a timeline thousands of months long.
 */
export function isDay(s: unknown): s is string {
  const m = typeof s === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null;
  if (!m || +m[1] < 1990 || +m[1] > 2100) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` === s;
}

/** The longest timeline shown, in years. */
export const MAX_VIEW_YEARS = 30;
/** A timeline that can be drawn: it ends after it starts, within MAX_VIEW_YEARS. */
export const isView = (start: unknown, end: unknown): boolean =>
  isDay(start) && isDay(end) && end > start && Number(end.slice(0, 4)) - Number(start.slice(0, 4)) <= MAX_VIEW_YEARS;
