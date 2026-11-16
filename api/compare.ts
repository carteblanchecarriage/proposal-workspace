import { route } from "../lib/auth.js";
import { cleanupOldFiles, compareProposals, errorResponse, ProposalSchema, UserFacingError } from "../lib/claude.js";
import { worldViewContext } from "../lib/worldview-server.js";
import { z } from "zod";

const Body = z.object({ projectName: z.string().nullable(), proposals: z.array(ProposalSchema).min(1) });

async function handle(request: Request): Promise<Response> {
  try {
    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new UserFacingError("Invalid comparison request.");
    // Each run also clears out PDFs uploaded more than a day ago.
    const [result] = await Promise.all([
      compareProposals(parsed.data.proposals, parsed.data.projectName, await worldViewContext()),
      cleanupOldFiles(),
    ]);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}

export const POST = route(handle, { ai: true });
