import { route } from "../lib/auth.js";
import { requestContext } from "../lib/context.js";
import { errorResponse, UserFacingError } from "../lib/claude.js";
import { addFeedback, dbConfigured } from "../lib/db.js";
import { z } from "zod";

const Body = z.object({ message: z.string().trim().min(1).max(5000), tab: z.string().max(40).nullable() });

async function handle(request: Request): Promise<Response> {
  try {
    if (!dbConfigured()) throw new UserFacingError("Feedback isn't set up on this site yet.", 503);
    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new UserFacingError("Please write a message first.");
    const ctx = requestContext();
    await addFeedback(parsed.data.message, parsed.data.tab, ctx?.orgId ?? null, ctx?.email ?? null);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

export const POST = route(handle);
