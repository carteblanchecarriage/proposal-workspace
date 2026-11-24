import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { getClient, UserFacingError, usageOf } from "./claude.js";
import { withFallback } from "./ai-fallback.js";
import { SCHEDULE_PROMPT } from "./schedule-prompt.js";
import { US_ENGLISH } from "./prompts.js";
import type { Usage } from "./cost.js";

// The Schedule Assistant, moved from the schedule maker. Same model as before so its answers don't change.
export const SCHEDULE_MODEL = "claude-sonnet-4-6";
// Room for an edit that touches every task (only what's written is billed).
const MAX_TOKENS = 8_000;

/** Sends the conversation plus the current schedule; returns the assistant's raw text (the editor parses it). */
export async function askScheduleAssistant(
  project: unknown,
  messages: { role: "user" | "assistant"; content: unknown }[],
  firm = "",
  /** the rest of the project, from the assistant (src/project-digest.ts) */
  digest = "",
  /** the organization's schedule colors and conventions (lib/schedule-style.ts) */
  style = "",
): Promise<{ text: string; usage: Usage }> {
  const system = `${[SCHEDULE_PROMPT, style, US_ENGLISH, firm].filter((x) => x.trim()).join("\n\n")}${digest ? `\n\n## The Rest of the Project (digest, read only)\n${digest}` : ""}

## Current Project
${JSON.stringify(project ?? null, null, 2)}`;
  // Content is passed through as the editor built it (text, or a file block plus text).
  const turns = messages.map(({ role, content }) => ({ role, content })) as MessageParam[];
  const msg = await withFallback(SCHEDULE_MODEL, (model, options) =>
    getClient().messages.create(
      // The fallback thinks before it answers: room for that, at low effort (as lib/assist.ts).
      { model, system, messages: turns, ...(model === SCHEDULE_MODEL ? { max_tokens: MAX_TOKENS } : { max_tokens: 8_000, output_config: { effort: "low" as const } }) },
      options,
    ),
  );
  if (msg.stop_reason === "refusal") throw new UserFacingError("The AI declined to answer that. Try asking another way.", 422);
  const text = msg.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("");
  return { text, usage: usageOf(msg) };
}
