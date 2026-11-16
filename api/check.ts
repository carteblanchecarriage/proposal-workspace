import { route } from "../lib/auth.js";
import { checkProject, errorResponse, ProposalSchema, UserFacingError, type Proposal, type Rfp } from "../lib/claude.js";
import { worldViewContext } from "../lib/worldview-server.js";
import { z } from "zod";

// Reviews and proposals saved before newer fields existed may lack them (or carry older ones), so both are taken
// as they were saved; they only go into the prompt as JSON.
const Body = z.object({ rfp: z.object({}).passthrough(), proposals: z.array(ProposalSchema.partial()).min(1).max(30) });

async function handle(request: Request): Promise<Response> {
  try {
    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new UserFacingError("Invalid project check request.");
    return Response.json(await checkProject(parsed.data.rfp as Rfp, parsed.data.proposals as Proposal[], await worldViewContext()));
  } catch (err) {
    return errorResponse(err);
  }
}

export const POST = route(handle, { ai: true });
