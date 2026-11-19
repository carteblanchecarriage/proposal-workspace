import { requestContext } from "./context.js";
import { scheduleConventionsText, scheduleStyleText } from "./schedule-style.js";
import { emptyWorldView, firmContext, worldViewText, type WorldView } from "./worldview.js";

/**
 * The organization's world view, as context to add after a tool's built-in instructions. Read on the server for the
 * tools that don't send it themselves, so every advice-giving tool sees it. An organization that hasn't saved one yet
 * gets the starting world view (lib/worldview.ts), the same one its World view page shows. Loaded once per request by
 * route() (lib/auth.ts); "" outside a signed-in request.
 */
export async function worldViewContext(): Promise<string> {
  const settings = requestContext()?.settings;
  if (!settings) return "";
  const saved = settings.worldView as Partial<WorldView> | null;
  return firmContext(worldViewText({ ...emptyWorldView(), ...saved }), []);
}

/** The organization's schedule colors and conventions (its schedule style), for the schedule assistant and draft. */
export function scheduleStyleContext(): string {
  const style = requestContext()?.settings?.scheduleStyle;
  const colors = style?.colors && typeof style.colors === "object" ? (style.colors as Record<string, string>) : {};
  return scheduleStyleText(colors, typeof style?.conventions === "string" ? style.conventions : undefined);
}

/** Only the organization's schedule conventions (the schedule draft picks categories, not colors). */
export function scheduleConventionsContext(): string {
  const style = requestContext()?.settings?.scheduleStyle;
  return scheduleConventionsText(typeof style?.conventions === "string" ? style.conventions : undefined);
}
