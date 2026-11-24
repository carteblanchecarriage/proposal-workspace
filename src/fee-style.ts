// The proposal fee table's look, set once per organization (Organization page → Style and formatting) and used by
// every fee's Proposal table, on screen and when copied into Word, Google Docs or InDesign.

export type FeeStyle = {
  /** header row background (column titles) */
  head: string;
  /** Total Fee column background (and its header a shade darker) */
  totalColumn: string;
  /** Total row background */
  totalRow: string;
  font: FeeFont;
  /** "TOTAL FEE" and "TOTAL" in capitals */
  capitals: boolean;
  /** what the Proposal table's fee amounts are rounded to, in dollars: cents (0.01) up to the nearest 1,000 */
  rounding: FeeRounding;
};

/** The rounding choices, smallest first, with how each shows $12,345.67. */
export const FEE_ROUNDINGS = [
  { value: 0.01, label: "Cents ($ 12,345.67)" },
  { value: 1, label: "Whole dollars ($ 12,346) (standard)" },
  { value: 10, label: "Nearest $10 ($ 12,350)" },
  { value: 100, label: "Nearest $100 ($ 12,300)" },
  { value: 1000, label: "Nearest $1,000 ($ 12,000)" },
] as const;
export type FeeRounding = (typeof FEE_ROUNDINGS)[number]["value"];

/** An amount rounded to the setting (cents are rounded as cents, so no float dust like 0.30000000000000004). */
export const roundFee = (n: number, to: FeeRounding) => {
  // Half rounds away from zero, as Excel does (so a credit rounds as the same charge would), and float dust is dropped
  // first (1.005 is stored as 1.00499…).
  const steps = Number(Math.abs(to === 0.01 ? n * 100 : n / to).toPrecision(12));
  const r = Math.round(steps);
  return (Math.sign(n) * (to === 0.01 ? r / 100 : r * to)) || 0;
};

export const FEE_FONTS = {
  helvetica: { label: "Helvetica (standard)", stack: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
  arial: { label: "Arial", stack: "Arial, Helvetica, sans-serif" },
  calibri: { label: "Calibri", stack: "Calibri, Carlito, Arial, sans-serif" },
  georgia: { label: "Georgia (serif)", stack: "Georgia, 'Times New Roman', serif" },
  garamond: { label: "Garamond (serif)", stack: "Garamond, 'EB Garamond', Georgia, serif" },
} as const;
export type FeeFont = keyof typeof FEE_FONTS;

export const DEFAULT_FEE_STYLE: FeeStyle = {
  head: "#20ABE2",
  totalColumn: "#6D6E71",
  totalRow: "#231F20",
  font: "helvetica",
  capitals: true,
  rounding: 1,
};

const HEX = /^#[0-9a-f]{6}$/i;
/** Only well-formed values; anything missing or odd falls back to the standard. */
export function cleanFeeStyle(v: Partial<FeeStyle> | null | undefined): FeeStyle {
  const color = (x: unknown, d: string) => (typeof x === "string" && HEX.test(x) ? x.toUpperCase() : d);
  return {
    head: color(v?.head, DEFAULT_FEE_STYLE.head),
    totalColumn: color(v?.totalColumn, DEFAULT_FEE_STYLE.totalColumn),
    totalRow: color(v?.totalRow, DEFAULT_FEE_STYLE.totalRow),
    font: v?.font && v.font in FEE_FONTS ? v.font : DEFAULT_FEE_STYLE.font,
    capitals: typeof v?.capitals === "boolean" ? v.capitals : DEFAULT_FEE_STYLE.capitals,
    rounding: FEE_ROUNDINGS.some((r) => r.value === v?.rounding) ? (v!.rounding as FeeRounding) : DEFAULT_FEE_STYLE.rounding,
  };
}

/** A color mixed toward black (amount 0–1), for the Total Fee header. */
function darker(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (c: number) => Math.round(c * (1 - amount)).toString(16).padStart(2, "0");
  return `#${ch(n >> 16)}${ch((n >> 8) & 255)}${ch(n & 255)}`;
}
/** A color mixed toward white (amount 0–1), for light section rows. */
function tint(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (c: number) => Math.round(c + (255 - c) * amount).toString(16).padStart(2, "0");
  return `#${ch(n >> 16)}${ch((n >> 8) & 255)}${ch(n & 255)}`;
}

/** White or near-black text, whichever reads better on the background. */
export function textOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? "#231f20" : "#ffffff";
}

/** Inline styles for each kind of cell (inline so the formatting survives being pasted). */
export function feeTableCss(s: FeeStyle) {
  const caps = s.capitals ? " text-transform: uppercase;" : "";
  const headTotal = darker(s.totalColumn, 0.18);
  return {
    font: `font-family: ${FEE_FONTS[s.font].stack}; font-size: 13px;`,
    border: "border: 1px solid #bcbec0;",
    head: `min-width: 120px; background: ${s.head}; color: ${textOn(s.head)}; font-weight: 400; text-align: center; vertical-align: bottom; padding: 10px 12px;`,
    headTotal: `min-width: 120px; background: ${headTotal}; color: ${textOn(headTotal)}; font-weight: 700; text-align: center; vertical-align: middle; padding: 10px 12px;${caps}`,
    phase: "background: #ffffff; color: #231f20; font-weight: 700; text-align: left; padding: 12px;",
    cell: "min-width: 120px; background: #ffffff; color: #231f20; text-align: center; padding: 12px; white-space: nowrap;",
    cellTotal: `min-width: 120px; background: ${s.totalColumn}; color: ${textOn(s.totalColumn)}; text-align: center; padding: 12px; white-space: nowrap;`,
    foot: `min-width: 120px; background: ${s.totalRow}; color: ${textOn(s.totalRow)}; text-align: center; padding: 12px; white-space: nowrap;`,
    footLabel: `background: ${s.totalRow}; color: ${textOn(s.totalRow)}; font-weight: 700; text-align: left; padding: 12px;${caps}`,
    // A section heading inside the table (e.g. Below the line): a light tint of the header color, across every column.
    section: `background: ${tint(s.head, 0.78)}; color: #231f20; font-weight: 700; text-align: left; padding: 8px 12px; font-size: 12px; letter-spacing: .04em; text-transform: uppercase;`,
    note: "display: block; font-weight: 400; font-size: 12px; margin-top: 2px;",
  };
}

/** "$ 241,020" (or "$ 241,020.50" when the setting is cents), rounded to the setting; nothing in it shows a dash. */
export function feeMoney(n: number, to: FeeRounding = 1): string {
  const v = roundFee(n, to);
  if (!v) return "-";
  const cents = to === 0.01;
  return `${v < 0 ? "-" : ""}$ ${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`;
}
