import { getClient, usageOf } from "./claude.js";
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
  const msg = await getClient().messages.create({
    model: ASSIST_MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages: [
      { role: "user", content: [{ type: "text", text: context, cache_control: { type: "ephemeral" } }, { type: "text", text: first.content }] },
      ...rest.map((t) => ({ role: t.role, content: t.content })),
    ],
  });
  const reply = msg.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("")
    .trim();
  return { reply: reply || "I couldn't put an answer together. Try asking another way.", usage: usageOf(msg) };
}
