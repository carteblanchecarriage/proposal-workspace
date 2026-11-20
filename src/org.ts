// The signed-in person's organization name, for text that names the firm (the printed mark).
// Set once sign-in is confirmed; "" when login is off or the name isn't known.
let name = "";
export const setOrgName = (n: string | null | undefined) => (name = (n ?? "").trim());
export const orgName = () => name;

// The notes every new schedule starts with: only the ones the organization wrote in its schedule settings (none
// until it does). Set wherever the schedule style is loaded.
let scheduleNotes = "";
/** Keeps the organization's default schedule notes, one per line, blank lines dropped. */
export const setScheduleNotes = (text: string | null | undefined) =>
  (scheduleNotes = (text ?? "").split("\n").map((l) => l.trim()).filter(Boolean).join("\n"));
/** The organization's default schedule notes, one per line; "" when it has none. */
export const defaultScheduleNotes = () => scheduleNotes;
