import { mount, unmount } from "svelte";
import ScheduleStyle from "./pages/ScheduleStyle.svelte";

// The schedule style editor (colors, font, Today line), shown on the Organization page outside the schedule screens.

let current: Record<string, unknown> | null = null;

/** The standard schedule font (Barlow), for the font sample; the schedule screens load it the same way. */
function loadBarlow() {
  if (document.getElementById("schedule-fonts")) return;
  const link = Object.assign(document.createElement("link"), {
    id: "schedule-fonts",
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&family=Barlow+Condensed:wght@300;400;500;600;700;800&display=swap",
  });
  document.head.appendChild(link);
}

export function mountScheduleStyle(target: HTMLElement) {
  unmountScheduleStyle();
  loadBarlow();
  current = mount(ScheduleStyle, { target });
}

export function unmountScheduleStyle() {
  if (current) unmount(current);
  current = null;
}
