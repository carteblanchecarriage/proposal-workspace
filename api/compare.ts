import { route } from "../lib/auth.js";
import { cleanupOldFiles, compareProposals, ComparisonSchema, errorResponse, extendComparison, ProposalSchema, UserFacingError } from "../lib/claude.js";
import { worldViewContext } from "../lib/worldview-server.js";
import { z } from "zod";

const Body = z.object({
  projectName: z.string().nullable(),
  proposals: z.array(ProposalSchema).min(1),
  // A section of a project's Consultants page: compare only this discipline's scope and fees.
  focus: z.object({ label: z.string().max(100), disciplines: z.array(z.string().max(100)).max(10) }).optional(),
});

// x-action "extend": adds proposals to an existing comparison (or refreshes its briefing after one was taken out)
// without redoing the rest.
const Extend = z.object({
  projectName: z.string().nullable(),
  cmp: ComparisonSchema,
  existing: z.array(ProposalSchema).min(1),
  added: z.array(ProposalSchema),
  focus: Body.shape.focus,
});

async function handle(request: Request): Promise<Response> {
  try {
    const body = await request.json().catch(() => null);
    if (request.headers.get("x-action") === "extend") {
      const p = Extend.safeParse(body);
      if (!p.success) throw new UserFacingError("Invalid comparison request.");
      return Response.json(await extendComparison(p.data.cmp, p.data.existing, p.data.added, p.data.projectName, await worldViewContext(), p.data.focus));
    }
    const parsed = Body.safeParse(body);
    if (!parsed.success) throw new UserFacingError("Invalid comparison request.");
    // Each run also clears out PDFs uploaded more than a day ago.
    const [result] = await Promise.all([
      compareProposals(parsed.data.proposals, parsed.data.projectName, await worldViewContext(), parsed.data.focus),
      cleanupOldFiles(),
    ]);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}

export const POST = route(handle, { ai: true });
