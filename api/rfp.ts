import { assertOwnFiles, route } from "../lib/auth.js";
import { applyAddendum, checkOwnProposal, cleanupOldFiles, draftWorldViewFromSite, errorResponse, firmSiteUrl, fitCheck, reviewRfp, suggestWorldView, UserFacingError } from "../lib/claude.js";
import { firmContext, sectionsText } from "../lib/worldview.js";
import { z } from "zod";

// RFP reviews and the World view's checks, in one function (the Hobby plan allows 12 per deployment).
// The x-action header picks the job:
//  - none: review uploaded PDFs (uploaded first, one request each, via /api/upload, to stay under Vercel's body limit);
//  - "addendum": updates a saved review for a new addendum PDF, and lists what changed;
//  - "fit-check": the pursue / consider / pass verdict for a saved review's JSON;
//  - "suggest": suggested world view edits from how verdicts compared with outcomes;
//  - "qaqc": a final check of the firm's own finished proposal (uploaded first), against the RFP review if any.
// The firm's world view and past pursuits come from the browser as text, and are added after the built-in
// instructions exactly as the World view page shows them.
const Context = {
  worldView: z.string().max(20_000).default(""),
  pursuits: z.array(z.string().max(3_000)).max(20).default([]),
};
const Review = z.object({
  files: z.array(z.object({ file_id: z.string(), filename: z.string() })).min(1).max(10),
  ...Context,
  // The firm's standard proposal sections, for the review's proposal outline.
  sections: z.array(z.string().max(200)).max(30).default([]),
});
const Addendum = z.object({
  files: z.array(z.object({ file_id: z.string(), filename: z.string() })).min(1).max(5),
  rfp: z.object({}).passthrough(),
  number: z.number().int().min(1).max(99),
  ...Context,
  sections: z.array(z.string().max(200)).max(30).default([]),
});
const FitCheck = z.object({ rfp: z.object({}).passthrough(), ...Context });
const Qaqc = z.object({
  files: z.array(z.object({ file_id: z.string(), filename: z.string() })).min(1).max(3),
  rfp: z.object({}).passthrough().nullable().default(null),
});
const Suggest = z.object({ worldView: z.string().max(20_000), results: z.array(z.object({}).passthrough()).min(1).max(60) });

async function handle(request: Request): Promise<Response> {
  try {
    const action = request.headers.get("x-action");
    const body = await request.json().catch(() => null);

    if (action === "addendum") {
      const p = Addendum.safeParse(body);
      if (!p.success) throw new UserFacingError("Invalid addendum request.");
      const context = [firmContext(p.data.worldView, p.data.pursuits), sectionsText(p.data.sections)].filter(Boolean).join("\n\n");
      await assertOwnFiles(p.data.files.map((f) => f.file_id));
      return Response.json(await applyAddendum(p.data.files, p.data.rfp, p.data.number, context));
    }
    if (action === "fit-check") {
      const p = FitCheck.safeParse(body);
      if (!p.success) throw new UserFacingError("Invalid check request.");
      return Response.json(await fitCheck(p.data.rfp, firmContext(p.data.worldView, p.data.pursuits)));
    }
    if (action === "from-site") {
      // Drafts "Who we are" and "What makes a good pursuit" from the firm's website (World view page).
      const site = typeof (body as { url?: unknown })?.url === "string" ? (body as { url: string }).url : "";
      if (!site || site.length > 300) throw new UserFacingError("Enter your firm's website.");
      return Response.json(await draftWorldViewFromSite(firmSiteUrl(site)));
    }
    if (action === "qaqc") {
      const p = Qaqc.safeParse(body);
      if (!p.success) throw new UserFacingError("Invalid check request.");
      await assertOwnFiles(p.data.files.map((f) => f.file_id));
      return Response.json(await checkOwnProposal(p.data.files, p.data.rfp));
    }
    if (action === "suggest") {
      const p = Suggest.safeParse(body);
      if (!p.success) throw new UserFacingError("Invalid request.");
      return Response.json(await suggestWorldView(p.data.worldView, p.data.results));
    }

    const p = Review.safeParse(body);
    if (!p.success) throw new UserFacingError("Invalid RFP request.");
    await assertOwnFiles(p.data.files.map((f) => f.file_id));
    const [result] = await Promise.all([reviewRfp(p.data.files, [firmContext(p.data.worldView, p.data.pursuits), sectionsText(p.data.sections)].filter(Boolean).join("\n\n")), cleanupOldFiles()]);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}

export const POST = route(handle, { ai: true });
