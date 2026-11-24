// The safeguard on AI spending: no organization can use more than $100 of AI in a month (its billing period when it
// subscribes, else the calendar month), whatever its own allowance says: no limit, a plan's cap set too high, or a
// typo. Shared by the check before every AI request (lib/auth.ts), the organization's page (lib/org.ts) and the
// owner's activity page (lib/admin.ts). No imports, so the browser can use it too.

/** The most any organization can spend on AI in a month, in US$. */
export const AI_SAFEGUARD_USD = 100;

/** The allowance that actually applies: the organization's own, never above the safeguard. null (no limit) is the safeguard. */
export function effectiveLimit(limitUsd: number | null): number {
  if (limitUsd == null || !Number.isFinite(limitUsd)) return AI_SAFEGUARD_USD;
  return Math.min(Math.max(0, limitUsd), AI_SAFEGUARD_USD);
}

/**
 * Whether an organization's AI is paused, and why: "no allowance" (0: not turned on, e.g. no subscription), or
 * "used up" (this month's spending has reached its allowance, or the safeguard). Checked before each request, so a
 * request already running can finish and take spending slightly past the limit, by at most one request.
 */
export function aiBlocked(limitUsd: number | null, spentUsd: number): "no allowance" | "used up" | null {
  const limit = effectiveLimit(limitUsd);
  if (limit <= 0) return "no allowance";
  return spentUsd >= limit ? "used up" : null;
}
