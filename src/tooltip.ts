/**
 * Tooltips for any element with a data-tip attribute: shown on hover or keyboard focus, placed below the element
 * (above when there's no room) and kept inside the window. One element for the whole page, fixed-positioned, so a
 * scrolling card doesn't clip it.
 */
let tip: HTMLDivElement | null = null;
let owner: HTMLElement | null = null;

function el(): HTMLDivElement {
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "tooltip";
    tip.id = "tooltip";
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    document.body.append(tip);
  }
  return tip;
}

function show(target: HTMLElement) {
  const text = target.dataset.tip;
  if (!text) return;
  const t = el();
  owner = target;
  t.textContent = text;
  t.hidden = false;
  target.setAttribute("aria-describedby", "tooltip");
  const r = target.getBoundingClientRect();
  const w = t.offsetWidth, h = t.offsetHeight, gap = 8, edge = 12;
  const left = Math.min(Math.max(edge, r.left + r.width / 2 - w / 2), innerWidth - w - edge);
  const below = r.bottom + gap + h <= innerHeight - edge;
  t.style.left = `${left}px`;
  t.style.top = `${below ? r.bottom + gap : Math.max(edge, r.top - gap - h)}px`;
}

function hide() {
  if (!owner) return;
  owner.removeAttribute("aria-describedby");
  owner = null;
  if (tip) tip.hidden = true;
}

const tipOf = (e: Event) => (e.target as HTMLElement | null)?.closest?.<HTMLElement>("[data-tip]") ?? null;

export function initTooltips() {
  document.addEventListener("mouseover", (e) => {
    const t = tipOf(e);
    if (t && t !== owner) show(t);
    else if (!t && owner && !owner.matches(":focus-visible")) hide();
  });
  document.addEventListener("focusin", (e) => {
    const t = tipOf(e);
    if (t) show(t);
  });
  document.addEventListener("focusout", hide);
  document.addEventListener("keydown", (e) => e.key === "Escape" && hide());
  addEventListener("scroll", hide, true);
  addEventListener("hashchange", hide);
}
