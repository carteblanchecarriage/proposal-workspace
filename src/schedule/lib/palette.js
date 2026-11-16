import { derived, writable } from 'svelte/store';

// The organization's schedule style: colors by category, milestone and estimate badge colors, the font, and whether
// the Today line shows by default. Schedules keep storing the standard color codes (the templates, the color picker,
// the AI assistant and "draft from RFP" all use them); each organization chooses how they look, and every schedule —
// existing ones too, and their prints and PDFs — is drawn that way.

/** The categories, with the standard code each one stores, and its 50% halftone (the lighter swatch) where it has one. */
export const CATEGORIES = [
  { key: 'design',       label: 'Design phases',          hint: 'Programming, SD, DD and CDs',            base: '#00914D', half: '#80C8A6' },
  { key: 'review',       label: 'Reviews',                hint: 'Client, owner and design reviews',       base: '#949494' },
  { key: 'hold',         label: 'Holds and waiting',      hint: 'Waiting periods',                        base: '#20ABE2', half: '#90D5F1' },
  { key: 'construction', label: 'Construction and CA',    hint: 'Construction and construction administration', base: '#6D245D', half: '#B692AE' },
  { key: 'permit',       label: 'Permits and approvals',  hint: 'Permit submission and AHJ reviews',      base: '#D83968', half: '#EC9CB4' },
  { key: 'other',        label: 'Bidding and closeout',   hint: 'Bidding, procurement and closeout',      base: '#282829' },
];

/**
 * The legend's items: one color for every deliverable, milestone, estimate and approval marker (unset = the standard
 * look: deliverables orange, milestones black, estimates each their own color, approvals blue).
 */
export const BADGES = [
  { key: 'deliverable', label: 'Deliverables',  hint: 'Numbered deliverable badges',                  base: '#D4804A' },
  { key: 'milestone',   label: 'Milestones',    hint: 'Lettered milestone markers',                   base: '#282829' },
  { key: 'estimate',    label: 'Estimates',     hint: 'SD, DD and other estimate badges',             base: '#00914D' },
  { key: 'approval',    label: 'Approvals',     hint: 'Approval diamonds, such as permit approval',   base: '#20ABE2' },
];

/** Fonts the server's PDF browser can load too (Google Fonts, or the site's own Inter). */
export const FONTS = [
  { key: 'barlow', label: 'Barlow (standard)', stack: "'Barlow', Arial, sans-serif" },
  { key: 'inter',  label: 'Inter',             stack: "'Inter Variable', Arial, sans-serif" },
  { key: 'roboto', label: 'Roboto',            stack: "'Roboto', Arial, sans-serif", google: 'Roboto:wght@400;500;700;800' },
  { key: 'lora',   label: 'Lora (serif)',      stack: "'Lora', Georgia, serif",       google: 'Lora:wght@400;500;600;700' },
];

export const DEFAULT_OPTIONS = { font: 'barlow', showToday: true };

const HEX = /^#[0-9a-f]{6}$/i;
/** Where the style travels with a schedule to the print page (see handOver, below). */
const HANDOFF = 'schedule_palette';
const HANDOFF_OPTIONS = 'schedule_options';
const COLOR_KEYS = [...CATEGORIES, ...BADGES].map((c) => c.key);

/** A color mixed 50/50 with white: the lighter version of a custom color. */
function halftone(hex) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c) => Math.round((c + 255) / 2).toString(16).padStart(2, '0');
  return `#${mix(n >> 16)}${mix((n >> 8) & 255)}${mix(n & 255)}`.toUpperCase();
}

/** Only well-formed colors for known keys: what's saved, and what the PDF server accepts. */
export function cleanPalette(value) {
  const out = {};
  for (const k of COLOR_KEYS) if (typeof value?.[k] === 'string' && HEX.test(value[k])) out[k] = value[k].toUpperCase();
  return out;
}
export function cleanOptions(value) {
  return {
    font: FONTS.some((f) => f.key === value?.font) ? value.font : DEFAULT_OPTIONS.font,
    showToday: typeof value?.showToday === 'boolean' ? value.showToday : DEFAULT_OPTIONS.showToday,
  };
}

/** Chosen colors by key; keys left out keep the standard look. */
export const palette = writable(readHandedOver(HANDOFF, cleanPalette));
/** The font, and whether the Today line shows by default. */
export const options = writable(readHandedOver(HANDOFF_OPTIONS, cleanOptions));

/** standard code (lowercase) → the color to draw it in, for an organization's chosen colors */
export function buildColorMap(p) {
  const m = new Map();
  for (const c of CATEGORIES) {
    const chosen = p?.[c.key];
    if (!chosen) continue;
    m.set(c.base.toLowerCase(), chosen);
    if (c.half) m.set(c.half.toLowerCase(), halftone(chosen));
  }
  return m;
}
export const colorMap = derived(palette, buildColorMap);

/** The CSS font stack for a font choice (the standard Barlow when unknown). */
export const fontStack = (key) => (FONTS.find((f) => f.key === key) ?? FONTS[0]).stack;

/** The color to draw a stored color in. */
export const paint = (hex, map) => (typeof hex === 'string' && map.get(hex.toLowerCase())) || hex;
/** A milestone's or estimate's color: the organization's badge color when it set one, else its own (painted). */
export const badge = (kind, hex, p, map) => p[kind] ?? paint(hex, map);

// The font: an attribute on the page that app.css styles the schedule screens by, and the font file when it's a
// Google font (the PDF browser is allowed to load those).
export function applyFont(font) {
  const f = FONTS.find((x) => x.key === font) ?? FONTS[0];
  document.documentElement.dataset.scheduleFont = f.key;
  loadFont(f.key);
}
/** Adds the font's file to the page when it's a Google font (e.g. for the project page's schedule snapshot). */
export function loadFont(font) {
  const f = FONTS.find((x) => x.key === font) ?? FONTS[0];
  if (f.google && !document.getElementById(`schedule-font-${f.key}`)) {
    const link = Object.assign(document.createElement('link'), {
      id: `schedule-font-${f.key}`,
      rel: 'stylesheet',
      href: `https://fonts.googleapis.com/css2?family=${f.google}&display=swap`,
    });
    document.head.appendChild(link);
  }
}
options.subscribe((o) => { if (typeof document !== 'undefined') applyFont(o.font); });

// Deliverable and approval markers are drawn by CSS (var(--sched-deliverable), var(--sched-approval)), so their
// colors are set on the page; unset, the CSS falls back to the standard orange and blue.
palette.subscribe((p) => {
  if (typeof document === 'undefined') return;
  for (const k of ['deliverable', 'approval']) {
    if (p[k]) document.documentElement.style.setProperty(`--sched-${k}`, p[k]);
    else document.documentElement.style.removeProperty(`--sched-${k}`);
  }
});

// The print preview and the server's PDF browser aren't signed in, so the editor hands the style over with the
// schedule (session storage, like the schedule itself).
function readHandedOver(key, clean) {
  try {
    return clean(JSON.parse(sessionStorage.getItem(key) ?? '{}'));
  } catch {
    return clean({});
  }
}
export function handOver(p, o) {
  try {
    sessionStorage.setItem(HANDOFF, JSON.stringify(cleanPalette(p)));
    sessionStorage.setItem(HANDOFF_OPTIONS, JSON.stringify(cleanOptions(o)));
  } catch {}
}
