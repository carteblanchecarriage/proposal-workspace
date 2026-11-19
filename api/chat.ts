import { assertOwnFiles, route } from "../lib/auth.js";
import { askAssistant } from "../lib/assist.js";
import { chat, ComparisonSchema, errorResponse, ProposalSchema, UserFacingError } from "../lib/claude.js";
import { worldViewContext } from "../lib/worldview-server.js";
import { z } from "zod";

// The proposal comparison's chat, and (x-action "assist") the project assistant on pages without an assistant of
// their own. One endpoint for both keeps the deployment within its function limit.

const Turns = z
  .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(20000) }))
  .min(1)
  .refine((t) => t[0].role === "user" && t[t.length - 1].role === "user", "Conversation must start and end with a user turn.");

const Body = z.object({
  projectName: z.string().nullable(),
  proposals: z
    .array(ProposalSchema.extend({ file_id: z.string().regex(/^file_[A-Za-z0-9_-]+$/), source_file: z.string() }))
    .min(1),
  comparison: ComparisonSchema,
  turns: Turns,
  // The PDFs are read only when asked for; otherwise the chat answers from the extracted data and analysis.
  withPdfs: z.boolean().default(false),
  digest: z.string().max(12_000).default(""),
});

const AssistBody = z.object({
  page: z.enum(["project", "consultants", "rfp"]),
  pageContext: z.unknown(),
  digest: z.string().max(12_000).default(""),
  turns: Turns.refine((t) => t.length <= 40),
});
const MAX_ASSIST_BYTES = 1_000_000;

async function handle(request: Request): Promise<Response> {
  try {
    if (request.headers.get("x-action") === "assist") {
      if (Number(request.headers.get("content-length") ?? 0) > MAX_ASSIST_BYTES) throw new UserFacingError("This page is too large to send.", 413);
      const a = AssistBody.safeParse(await request.json().catch(() => null));
      if (!a.success) throw new UserFacingError("Invalid assistant request.");
      return Response.json(await askAssistant(a.data.page, a.data.pageContext, a.data.digest, a.data.turns, await worldViewContext()));
    }
    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new UserFacingError("Invalid chat request.");
    const { proposals, comparison, projectName, turns, withPdfs, digest } = parsed.data;
    // Only PDFs this organization uploaded (410, like an expired file, offers "Re-attach PDFs").
    if (withPdfs) await assertOwnFiles(proposals.map((p) => p.file_id));
    return Response.json(await chat(proposals, comparison, projectName, turns, await worldViewContext(), withPdfs, digest));
  } catch (err) {
    return errorResponse(err);
  }
}

export const POST = route(handle, { ai: true });
