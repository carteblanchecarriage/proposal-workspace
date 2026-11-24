// The schedule assistant's reply: an edit comes as JSON ({ message, changes }), anything else is a plain answer.

export type ScheduleReply = { message: string; changes: unknown[] | null };

export function readReply(raw: string): ScheduleReply {
  const json = raw.match(/\{[\s\S]*\}/)?.[0];
  if (json) {
    try {
      const p = JSON.parse(json) as { message?: unknown; changes?: unknown } | null;
      if (p && typeof p === "object") return { message: typeof p.message === "string" ? p.message : "Done.", changes: Array.isArray(p.changes) ? p.changes : [] };
    } catch {
      // Not whole JSON: below.
    }
  }
  // An edit that was cut off or came back garbled is never shown as code, or half applied.
  if (/^\s*(?:```\w*\s*)?\{/.test(raw) || /"changes"\s*:/.test(raw))
    return { message: "That change was too long to come back whole, so nothing was changed. Try asking for it in smaller parts.", changes: null };
  return { message: raw, changes: null };
}
