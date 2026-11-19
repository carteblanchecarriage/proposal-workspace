import { route } from "../lib/auth.js";
import { draftSchedule, errorResponse, UserFacingError } from "../lib/claude.js";
import { askScheduleAssistant } from "../lib/schedule-ai.js";
import { scheduleConventionsContext, scheduleStyleContext, worldViewContext } from "../lib/worldview-server.js";

// The schedule editor's assistant, and (x-action "draft") a preliminary schedule drafted from a project's RFP
// review. Behind the access code like every other endpoint; both read the firm's world view.
const MAX_TURNS = 40;
const MAX_BODY = 4.4 * 1024 * 1024; // just under Vercel's 4.5 MB request limit

async function handle(request: Request): Promise<Response> {
  try {
    if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY)
      throw new UserFacingError("Request too large — attach a smaller file or a screenshot.", 413);
    const body = (await request.json().catch(() => null)) as { project?: unknown; rfp?: unknown; digest?: unknown; messages?: { role: string; content: unknown }[] } | null;
    if (request.headers.get("x-action") === "draft") {
      if (!body?.rfp || typeof body.rfp !== "object") throw new UserFacingError("Invalid schedule draft request.");
      return Response.json(await draftSchedule(body.rfp, [await worldViewContext(), scheduleConventionsContext()].filter(Boolean).join("\n\n")));
    }
    const messages = body?.messages;
    const valid =
      Array.isArray(messages) &&
      messages.length > 0 &&
      messages.length <= MAX_TURNS &&
      messages.every((m) => (m?.role === "user" || m?.role === "assistant") && m.content);
    if (!valid) throw new UserFacingError("Invalid conversation.");
    // The rest of the project, from the assistant (src/project-digest.ts).
    const digest = typeof body!.digest === "string" ? body!.digest.slice(0, 12_000) : "";
    return Response.json(await askScheduleAssistant(body!.project, messages as { role: "user" | "assistant"; content: unknown }[], await worldViewContext(), digest, scheduleStyleContext()));
  } catch (err) {
    return errorResponse(err);
  }
}

export const POST = route(handle, { ai: true });
