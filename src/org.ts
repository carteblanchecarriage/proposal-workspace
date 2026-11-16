// The signed-in person's organization name, for text that names the firm (schedule notes, the printed mark).
// Set once sign-in is confirmed; "" when login is off or the name isn't known.
let name = "";
export const setOrgName = (n: string | null | undefined) => (name = (n ?? "").trim());
export const orgName = () => name;

/** The standard schedule notes, naming the organization (or "We" when its name isn't known). */
export function defaultScheduleNotes(): string {
  return [
    "Project schedules are reliant on timely Owner input and approvals.",
    `${name ? `${name} does` : "We do"} not provide accurate projections for construction duration or timelines beyond the Construction Documentation phase.`,
  ].join("\n");
}
