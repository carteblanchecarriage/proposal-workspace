import { z } from "zod";
import { UserFacingError } from "./errors.js";
import { insertRow, query } from "./db.js";

// "Request access" from the public landing page, while sign-ups are invite-only. Anyone can send one, so it's kept
// small and limited: a few per visitor (by IP) per hour on this server, one per email a day (repeats are accepted
// quietly but not saved again), and a ceiling on requests per hour overall.

const Body = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(200),
  firm: z.string().trim().max(160).default(""),
  note: z.string().trim().max(1000).default(""),
});

const PER_IP = 3;
const IP_WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_HOUR = 100;
const recent = new Map<string, number[]>();

function ipOf(request: Request): string {
  return (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || request.headers.get("x-real-ip") || "unknown";
}

export async function requestAccess(request: Request): Promise<void> {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) throw new UserFacingError("Please add your name and a valid email.");
  const { name, email, firm, note } = parsed.data;

  const now = Date.now();
  const ip = ipOf(request);
  const times = (recent.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS);
  if (times.length >= PER_IP) throw new UserFacingError("Thanks, we've got your request. Please don't send more than a few.", 429);
  if (recent.size > 5000) recent.clear();
  recent.set(ip, [...times, now]);

  const hourAgo = new Date(now - IP_WINDOW_MS).toISOString();
  const dayAgo = new Date(now - 24 * IP_WINDOW_MS).toISOString();
  const [sameEmail, lastHour] = await Promise.all([
    query<unknown[]>(`access_requests?select=id&email=eq.${encodeURIComponent(email)}&created_at=gte.${encodeURIComponent(dayAgo)}&limit=1`),
    query<unknown[]>(`access_requests?select=id&created_at=gte.${encodeURIComponent(hourAgo)}&limit=${MAX_PER_HOUR}`),
  ]);
  if (sameEmail.length) return; // already asked today
  if (lastHour.length >= MAX_PER_HOUR) throw new UserFacingError("We're getting a lot of requests right now. Please try again later.", 429);

  await insertRow("access_requests", { name, email, firm: firm || null, note: note || null });
}
