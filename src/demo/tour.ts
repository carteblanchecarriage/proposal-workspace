// The demo's guided tour: a spotlight on one part of the page and a short note beside it, step by step, from the
// sample project through reviewing its RFP to the fee, schedule and consultants. Some steps wait for the visitor to
// do the thing (click Review the RFP); the rest have Next. Clicks inside the spotlight work as usual; a click
// anywhere else ends the tour (and does nothing else), as do Skip and Escape. Where it got to is kept for the browser tab, like the demo itself.

import { DEMO_PROJECT_ID } from "./ids";

type Step = {
  /** the page this step belongs to (the address); the note shows only there */
  on: (hash: string) => boolean;
  /** what to spotlight (the first match that's on screen); none: a note in the middle of the page */
  target?: string;
  title: string;
  body: string;
  /** moves on by itself when the address matches (the visitor did the thing); otherwise there's a Next button */
  doneWhen?: (hash: string) => boolean;
  /** moves on by itself once this shows up on the page (e.g. a card the visitor just filled in) */
  doneWhenShown?: string;
  /** the last step: account buttons instead of Next */
  last?: boolean;
};

const PROJECT = `#project/${DEMO_PROJECT_ID}`;
const onProject = (h: string) => h === PROJECT;
const onRfpStart = (h: string) => h === "#rfp";
const onReview = (h: string) => h.startsWith("#rfp/");
const onWorldView = (h: string) => h === "#worldview";

const STEPS: Step[] = [
  {
    on: onProject,
    target: ".proj-rfp",
    title: "Start with the owner's RFP",
    body: "Every pursuit starts here. Click Review the RFP.",
    doneWhen: (h) => h.startsWith("#rfp"),
  },
  {
    on: onRfpStart,
    target: "#rfp-sample-box",
    title: "Analyze the RFP",
    body: "In your account you'd drop in the RFP and its addenda. Here, review the sample: a library renovation and addition.",
    doneWhen: onReview,
  },
  {
    on: onReview,
    target: "#rfp-results .rfp-glance",
    title: "The RFP at a glance",
    body: "When proposals are due, when to send a printed copy to the printer, the next mandatory date, the budget and the page limit, pulled out of the RFP for you.",
  },
  {
    on: onReview,
    target: "#rfp-results ul.watch",
    title: "What could cost you",
    body: "Disqualifiers, risky contract terms and scope that's heavier than it looks, each with the page it's on.",
  },
  {
    on: onReview,
    target: "#rfp-results .rfp-top a.link",
    title: "Back to the project",
    body: "The review now feeds the rest of the project. Click to go back.",
    doneWhen: onProject,
  },
  {
    on: onProject,
    target: "#project-page .proj-grid",
    title: "The whole pursuit, in one place",
    body: "The RFP review you just ran is the start. The schedule, the fee and the consultants' proposals sit next to it, and each is a click away.",
  },
  {
    on: onProject,
    target: ".proj-schedule",
    title: "Draft the schedule",
    body: "Click Draft the schedule. It's laid out from the RFP you just reviewed.",
    doneWhenShown: ".proj-schedule .card-title-link",
  },
  {
    on: onProject,
    target: ".proj-schedule",
    title: "A schedule from the RFP's dates",
    body: "Design phases, owner reviews, permitting, bidding and construction. Click the Schedule title to open it full size, adjust it and print.",
  },
  {
    on: onProject,
    target: ".proj-fee",
    title: "Draft the fee",
    body: "Click Draft the fee. It starts from the RFP's budget and your fee curve.",
    doneWhenShown: ".proj-fee .card-title-link",
  },
  {
    on: onProject,
    target: ".proj-fee",
    title: "Your fee, in seconds",
    body: "Hours by phase and role, consultants with markup, and a fee table ready for the proposal. Click the Architecture fee title to open the full worksheet, adjust and review.",
  },
  {
    on: onProject,
    target: ".proj-team",
    title: "Add your consultants' proposals",
    body: "Click to add three sample MEP proposals, as if they'd just come in.",
    doneWhenShown: ".proj-team .received:not(.waiting)",
  },
  {
    on: onProject,
    target: ".proj-team",
    title: "Level your consultants' fees",
    body: "Each proposal is read and totaled. Click See detailed comparison to see their scope and fees side by side, with gaps and exclusions flagged.",
  },
  {
    on: onProject,
    target: "#project-page [data-assistant]",
    title: "Ask AI on any page",
    body: "It knows the whole project: the RFP, the fee, the schedule and the proposals.",
  },
  {
    on: onProject,
    target: "header.site a.worldview-link",
    title: "Your firm's world view",
    body: "Every AI tool in the app works from your firm's point of view. Click World view to see it.",
    doneWhen: (h) => h === "#worldview",
  },
  {
    on: onWorldView,
    target: "#worldview-page .wv-view",
    title: "Tell it who you are, once",
    body: "Who you are, what makes a good pursuit, your red flags and how you weigh things. The RFP review, the fee draft and the assistant all read it, so their answers fit your firm.",
  },
  {
    on: onWorldView,
    target: "#worldview-page #wv-chart",
    title: "Your fee curve",
    body: "The fee you expect at each construction budget. Fee drafts start from it, and your past pursuits show up against it.",
  },
  {
    on: onWorldView,
    target: "#worldview-page .block.saved",
    title: "It learns from your track record",
    body: "Add past pursuits and how they turned out. The world view check compares its verdicts with what really happened, so you can sharpen it over time.",
  },
  {
    on: () => true,
    title: "That's the tour",
    body: "Explore the sample project freely: nothing you change is saved. When you're ready, set up your own workspace.",
    last: true,
  },
];

const KEY = "demo_tour_step";
const read = () => {
  try {
    const v = sessionStorage.getItem(KEY);
    return v == null ? 0 : Number(v);
  } catch {
    return 0;
  }
};
const write = (n: number) => {
  try {
    sessionStorage.setItem(KEY, String(n));
  } catch {}
};

let step = -1; // -1: off
let spot: HTMLDivElement | null = null;
let tip: HTMLDivElement | null = null;
let shownFor = -1; // the step the page was last scrolled for
/** While the page scrolls to a new step's part: where it was last frame, and for how many frames it hasn't moved. */
let settling: { scrolled: boolean; until: number; last: string; still: number } | null = null;
/** Which side of its part the current note went on (below, above, right, left; -1: the least-covering fallback). */
let side: number | null = null;
let frame = 0;
let observer: MutationObserver | null = null;

/** Starts (or picks up) the tour. restart: from the first step. */
export function startTour(restart = false) {
  step = restart ? 0 : read();
  if (step >= STEPS.length) return; // finished or skipped earlier in this tab
  write(step);
  if (!spot) {
    spot = Object.assign(document.createElement("div"), { className: "tour-spot" });
    tip = Object.assign(document.createElement("div"), { className: "tour-tip" });
    tip.setAttribute("role", "dialog");
    tip.setAttribute("aria-live", "polite");
    document.body.append(spot, tip);
    tip.addEventListener("click", onTipClick);
    addEventListener("hashchange", onHash);
    addEventListener("resize", schedule);
    addEventListener("scroll", schedule, true);
    addEventListener("keydown", onKey);
    // Capture, so a click outside the spotlight is stopped before the page sees it.
    addEventListener("pointerdown", onOutside, true);
    addEventListener("click", onOutside, true);
    observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class"] });
  }
  shownFor = -1;
  onHash();
}

/** Ends the tour for this tab. */
export function endTour() {
  const wasOn = step >= 0;
  write(STEPS.length);
  step = -1;
  // The app fills in the rest of the sample project, so whoever leaves the tour can explore all of it (main.ts).
  if (wasOn) dispatchEvent(new Event("demo-tour-ended"));
  spot?.remove();
  tip?.remove();
  spot = tip = null;
  observer?.disconnect();
  removeEventListener("hashchange", onHash);
  removeEventListener("resize", schedule);
  removeEventListener("scroll", schedule, true);
  removeEventListener("keydown", onKey);
  // Ended by a press outside: its click is still on its way (after the button comes up), so keep catching it.
  if (swallowClick) setTimeout(stopCatching, 2000);
  else stopCatching();
}

function stopCatching() {
  if (step >= 0) return; // the tour was started again meanwhile: it needs these
  swallowClick = false;
  removeEventListener("pointerdown", onOutside, true);
  removeEventListener("click", onOutside, true);
}

/** Set by a press outside the spotlight: its click is swallowed too, after the tour has ended. */
let swallowClick = false;

/**
 * A press outside the spotlight and the note ends the tour, and neither it nor its click reaches the page. Inside
 * the spotlight, everything works as usual. While no note is showing (between pages), nothing is caught.
 */
function onOutside(e: Event) {
  if (e.type === "click" && swallowClick) {
    e.preventDefault();
    e.stopPropagation();
    if (step < 0) stopCatching();
    else swallowClick = false;
    return;
  }
  if (step < 0 || !spot || !tip || tip.hidden) return;
  const target = e.target as Node;
  if (tip.contains(target)) return;
  // The demo banner's Take the tour restarts it, so it isn't an outside click.
  if ((target as HTMLElement).closest?.("#demo-tour")) return;
  const { clientX: x, clientY: y } = e as PointerEvent;
  const r = spot.getBoundingClientRect();
  if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && r.width > 0) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.type === "pointerdown") {
    swallowClick = true;
    if (STEPS[step].last) finish();
    else endTour();
  }
}

function go(n: number) {
  step = n;
  write(n);
  if (n >= STEPS.length) return endTour();
  shownFor = -1;
  schedule();
}

function onHash() {
  if (step < 0) return;
  const h = location.hash;
  // The visitor did what the step asked (or skipped ahead by doing a later step's thing): move on.
  let s = step;
  while (s < STEPS.length && STEPS[s].doneWhen?.(h)) s++;
  if (s !== step) return go(s);
  schedule();
}

/** Whether the current note offers Next / Back (the same rules as its buttons). */
const waits = (s: Step) => !!(s.doneWhen || s.doneWhenShown);
const canNext = () => step >= 0 && !waits(STEPS[step]) && !STEPS[step].last;
const canBack = () => step > 0 && !waits(STEPS[step]) && !waits(STEPS[step - 1]);

function onKey(e: KeyboardEvent) {
  if (step < 0 || document.querySelector("dialog[open]")) return;
  if (e.key === "Escape") return STEPS[step].last ? finish() : endTour();
  // Left and right arrows step through the notes, like Back and Next; never while typing, or when no note is showing.
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
  const el = e.target as HTMLElement;
  if (el.closest?.("input, textarea, select, [contenteditable='true']") || !tip || tip.hidden || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === "ArrowRight" && canNext()) {
    e.preventDefault();
    go(step + 1);
  } else if (e.key === "ArrowLeft" && canBack()) {
    e.preventDefault();
    go(step - 1);
  }
}

function onTipClick(e: Event) {
  const action = (e.target as HTMLElement).closest<HTMLElement>("[data-tour]")?.dataset.tour;
  if (action === "next") go(step + 1);
  else if (action === "back") go(Math.max(0, step - 1));
  else if (action === "skip") endTour();
  else if (action === "close") finish();
}

/** Closing the last note: the tour ends where it started, on the sample project's dashboard. */
function finish() {
  endTour();
  if (location.hash !== PROJECT) location.hash = PROJECT;
}

function schedule() {
  if (step < 0 || frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    place();
  });
}

/** The first matching element that's actually on screen (not hidden, has a size). */
function find(selector: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && !el.closest("[hidden]")) return el;
  }
  return null;
}

/**
 * Brings a step's part into view: centered when it fits on screen with room for the note; otherwise its top just
 * inside the window (with space for the spotlight's edge), so a tall part is never cut off at the top.
 */
function scrollToTarget(target: HTMLElement): boolean {
  const r = target.getBoundingClientRect();
  // Where the page should end up: the part centered, or (a tall part) its top just inside the window.
  const wanted = r.height <= innerHeight * 0.6 ? scrollY + r.top + r.height / 2 - innerHeight / 2 : scrollY + r.top - 24;
  const top = Math.max(0, Math.min(wanted, document.documentElement.scrollHeight - innerHeight));
  if (Math.abs(top - scrollY) < 2) return false; // already there: nothing to wait for
  scrollTo({ top, behavior: "smooth" });
  return true;
}

// The browser says when a smooth scroll has finished ("scrollend"); the note waits for it (or for a safety timeout,
// for browsers without it), then for the page to hold still a few frames, and shows once, in its final place.
addEventListener("scrollend", () => {
  if (settling) (settling.scrolled = true), schedule();
}, true);

function place() {
  if (!spot || !tip || step < 0) return;
  const s = STEPS[step];
  const here = s.on(location.hash);
  const target = here && s.target ? find(s.target) : null;
  // Off its page, or its target isn't there yet (still loading): show nothing.
  if (!here || (s.target && !target)) {
    spot.hidden = tip.hidden = true;
    return;
  }
  // The visitor filled in what this step asked for: on to the next one.
  if (s.doneWhenShown && find(s.doneWhenShown)) return go(step + 1);
  if (shownFor !== step) {
    shownFor = step;
    tip.innerHTML = tipHtml(s);
    // The page scrolls smoothly to the next part, so it's clear where on the page it went. The spotlight stays on
    // its part all the way (no animation of its own, so nothing lags or wobbles); the note waits until it stops.
    side = null;
    settling = target ? { scrolled: !scrollToTarget(target), until: performance.now() + 1200, last: "", still: 0 } : null;
  }
  spot.hidden = false;
  if (settling && target) {
    // Settled: the part's position and size have held still for several frames (the scroll, and any re-layout the
    // page does as it arrives, are over), so the note shows once, in its final place.
    const b = target.getBoundingClientRect();
    const now = [b.top, b.left, b.width, b.height].map(Math.round).join();
    settling.still = now === settling.last ? settling.still + 1 : 0;
    settling.last = now;
    const scrollDone = settling.scrolled || performance.now() > settling.until;
    if (!scrollDone || settling.still < 3) {
      tip.hidden = true;
      requestAnimationFrame(place); // keep following until the scroll has stopped
    } else {
      settling = null;
      tip.hidden = false;
      tip.querySelector<HTMLElement>("[data-tour=next], [data-tour=close]")?.focus({ preventScroll: true });
    }
  } else {
    if (tip.hidden && !settling) tip.querySelector<HTMLElement>("[data-tour=next], [data-tour=close]")?.focus({ preventScroll: true });
    tip.hidden = false;
  }
  const vw = innerWidth;
  const vh = innerHeight;
  if (!target) {
    // A closing note in the middle of the page, with the page dimmed behind it.
    spot.style.cssText = `left:${vw / 2}px; top:${vh / 2}px; width:0; height:0;`;
    tip.style.cssText = `left:${Math.max(16, (vw - tip.offsetWidth) / 2)}px; top:${Math.max(16, (vh - tip.offsetHeight) / 2)}px;`;
    return;
  }
  const r = target.getBoundingClientRect();
  const pad = 6;
  spot.style.cssText = `left:${r.left - pad}px; top:${r.top - pad}px; width:${r.width + pad * 2}px; height:${r.height + pad * 2}px;`;
  // The note never covers the spotlight when there's room anywhere: below it, above it, to its right, to its left.
  // When none fits (a section nearly as big as the window, or a phone), it goes where it covers the least of it.
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  const gap = 12;
  const m = 8; // margin from the window's edge
  const clampX = (x: number) => Math.min(vw - tw - m, Math.max(m, x));
  const clampY = (y: number) => Math.min(vh - th - m, Math.max(m, y));
  const box = { left: r.left - pad, top: r.top - pad, right: r.right + pad, bottom: r.bottom + pad };
  const spots: [number, number, boolean][] = [
    [clampX(box.left), box.bottom + gap, box.bottom + gap + th <= vh - m], // below
    [clampX(box.left), box.top - gap - th, box.top - gap - th >= m], // above
    [box.right + gap, clampY(box.top), box.right + gap + tw <= vw - m], // right
    [box.left - gap - tw, clampY(box.top), box.left - gap - tw >= m], // left
  ];
  const covered = (x: number, y: number) =>
    Math.max(0, Math.min(x + tw, box.right) - Math.max(x, box.left)) * Math.max(0, Math.min(y + th, box.bottom) - Math.max(y, box.top));
  const corners: [number, number][] = [
    [vw - tw - m, vh - th - m],
    [m, vh - th - m],
    [vw - tw - m, m],
    [m, m],
  ];
  const fallback = [...spots.map(([x, y]) => [clampX(x), clampY(y)] as [number, number]), ...corners].reduce((best, p) =>
    covered(p[0], p[1]) < covered(best[0], best[1]) ? p : best,
  );
  // The side is chosen once per step and kept while it still fits, so a small shift on the page never makes the note
  // jump from below its part to beside it.
  if (side === null || (side >= 0 && !spots[side][2])) {
    const i = spots.findIndex(([, , fits]) => fits);
    if (!tip.hidden) side = i;
    const [left, top] = i >= 0 ? spots[i] : fallback;
    return void (tip.style.cssText = `left:${Math.round(left)}px; top:${Math.round(top)}px;`);
  }
  const [left, top] = side >= 0 ? spots[side] : fallback;
  tip.style.cssText = `left:${Math.round(left)}px; top:${Math.round(top)}px;`;
}

function tipHtml(s: Step): string {
  const n = STEPS.length - 1; // the closing note isn't counted
  const count = s.last ? "" : `<span class="tour-count">${step + 1} of ${n}</span>`;
  const buttons = s.last
    ? `<button class="btn primary" type="button" data-landing="signup" data-tour="close">Create an account</button><button class="btn primary request-access" type="button" data-landing="request" data-tour="close">Request access</button><button class="link" type="button" data-tour="close">Keep exploring</button>`
    : `${canNext() ? `<button class="btn primary" type="button" data-tour="next">Next</button>` : ""}${canBack() ? `<button class="link" type="button" data-tour="back">Back</button>` : ""}<button class="link" type="button" data-tour="skip">Skip tour</button>`;
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `${count}<h3>${esc(s.title)}</h3><p>${esc(s.body)}</p><div class="tour-actions">${buttons}</div>`;
}
