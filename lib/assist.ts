import { getClient, UserFacingError, usageOf } from "./claude.js";
import { withFallback } from "./ai-fallback.js";
import { ASSIST_SYSTEM, US_ENGLISH } from "./prompts.js";
import type { Usage } from "./cost.js";

// The project assistant on pages without an assistant of their own (project, Consultants, RFP review): questions and
// answers only, no edits. Sonnet with a short reply limit keeps each turn cheap; the page and the project digest go
// first and are cached, so follow-up questions read them at the cache rate.
export const ASSIST_MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 2048;

export type AssistPage = "project" | "consultants" | "rfp";
const PAGE_NAME: Record<AssistPage, string> = { project: "Project dashboard", consultants: "Consultant proposals page", rfp: "RFP review" };

export async function askAssistant(
  page: AssistPage,
  pageContext: unknown,
  digest: string,
  turns: { role: "user" | "assistant"; content: string }[],
  firm = "",
): Promise<{ reply: string; usage: Usage }> {
  const system = [ASSIST_SYSTEM, US_ENGLISH, firm.trim()].filter(Boolean).join("\n\n");
  const context = `${digest ? `The project (digest):\n${digest}\n\n` : ""}Open page: ${PAGE_NAME[page]} (JSON):\n${JSON.stringify(pageContext)}`;
  const [first, ...rest] = turns;
  const messages = [
    { role: "user" as const, content: [{ type: "text" as const, text: context, cache_control: { type: "ephemeral" as const } }, { type: "text" as const, text: first.content }] },
    ...rest.map((t) => ({ role: t.role, content: t.content })),
  ];
  const msg = await withFallback(ASSIST_MODEL, (model, options) =>
    getClient().messages.create({ model, system, messages, ...replyLimits(model) }, options),
  );
  checkReply(msg.stop_reason);
  const reply = msg.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("")
    .trim();
  return { reply: (reply || "I couldn't put an answer together. Try asking another way.") + cutOffNote(msg.stop_reason), usage: usageOf(msg) };
}

/**
 * Reply limits for a model. The main model answers directly; the fallback (a newer model that thinks before it answers)
 * gets room for that, at low effort, so its thinking never uses up the reply.
 */
export function replyLimits(model: string): { max_tokens: number; output_config?: { effort: "low" } } {
  return model === ASSIST_MODEL ? { max_tokens: MAX_TOKENS } : { max_tokens: 8_000, output_config: { effort: "low" } };
}

/** A declined request is said plainly (not shown as an empty answer). */
export function checkReply(stop: string | null) {
  if (stop === "refusal") throw new UserFacingError("The AI declined to answer that. Try asking another way.", 422);
}

/** A reply cut off at its length limit says so, rather than just stopping mid-sentence. */
export const cutOffNote = (stop: string | null) => (stop === "max_tokens" ? "\n\n(The answer was cut off. Ask for a shorter answer, or ask it to continue.)" : "");
