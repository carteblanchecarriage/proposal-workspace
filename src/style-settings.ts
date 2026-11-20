// Schedule and fee settings on the Organization page. Each group is edited as one: its Edit opens every setting in it,
// and Save applies them together (Cancel or Escape drops them). Both are global, so they read as text until Edit.

import { DEFAULT_FEE_STYLE, FEE_FONTS, FEE_ROUNDINGS, cleanFeeStyle, type FeeFont, type FeeRounding, type FeeStyle } from "./fee-style";
import { proposalHtml } from "./fee";
import { confirmModal } from "./modal";
import { getFeeStyle, saveFeeStyle } from "./store";
import { esc } from "./table";

/** A small fee, to preview the table with. */
const SAMPLE = {
  columns: [
    { firm: "", discipline: "Architecture" },
    { firm: "Halvorsen Lake Engineering", discipline: "MEP" },
  ],
  rows: [
    { label: "Schematic Design", amounts: [86437.5, 14215], total: 100652.5 },
    { label: "Design Development", amounts: [112748.25, 21330], total: 134078.25 },
    { label: "Construction Documents", amounts: [198310.8, 35480], total: 233790.8 },
  ],
  totals: [397496.55, 71025],
  total: 468521.55,
};

const COLORS: [keyof FeeStyle, string, string][] = [
  ["head", "Header", "Column titles across the top"],
  ["totalColumn", "Total Fee column", "Each phase's total (its title a shade darker)"],
  ["totalRow", "Total row", "The bottom row of totals"],
];

let saved: FeeStyle = DEFAULT_FEE_STYLE;
let draft: FeeStyle | null = null;
let root: HTMLElement | null = null;
let status = "";
let statusError = false;
let escapeBound = false;
/** Couldn't read the saved style: editing stays off, so the standard look can't be saved over the real one. */
let loadFailed = false;

/** Fills the Style and formatting section: the schedule settings (loaded on demand) and the fee table settings. */
export async function renderStyleSettings(section: HTMLElement) {
  section.innerHTML = `
    <h2 class="label">Schedules and fees</h2>
    <p class="wv-intro">These apply to everyone in the organization.</p>
    <div class="style-part settings-group" id="org-schedule-style"><span class="status">Loading…</span></div>
    <div class="style-part settings-group" id="org-fee-style"><span class="status">Loading…</span></div>`;
  root = section.querySelector<HTMLElement>("#org-fee-style");
  draft = null;
  status = "";
  root!.addEventListener("click", onClick);
  // Escape leaves editing without saving, like Cancel (a dialog on top handles its own Escape first).
  if (!escapeBound) {
    escapeBound = true;
    addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !draft || !root?.isConnected || document.querySelector("dialog[open]")) return;
      draft = null;
      renderFee();
    });
  }
  root!.addEventListener("input", onInput);
  // A color picker closed: redraw the row too (its swatch and Use standard).
  root!.addEventListener("change", (e) => {
    if (draft && (e.target as HTMLElement).matches("[data-fee-color]")) renderFee();
  });
  // Each part loads on its own, so one failing never leaves the other on "Loading…".
  const schedTarget = section.querySelector<HTMLElement>("#org-schedule-style");
  void import("./schedule/style-mount")
    .then((m) => {
      if (!schedTarget?.isConnected) return;
      schedTarget.innerHTML = "";
      m.mountScheduleStyle(schedTarget);
    })
    .catch((err) => {
      // Usually the site was updated while this page was open, so its older code file is gone: a reload fixes it.
      console.error("[settings] schedule settings didn't load:", err);
      if (schedTarget?.isConnected)
        schedTarget.innerHTML = `<span class="status error">Couldn't load the schedule settings. The site may have just been updated: reload the page.</span>`;
    });
  saved = await getFeeStyle().catch(() => ((loadFailed = true), DEFAULT_FEE_STYLE));
  renderFee();
}

function renderFee() {
  if (!root?.isConnected) return;
  const s = draft ?? saved;
  const isStandard = (k: keyof FeeStyle) => s[k] === DEFAULT_FEE_STYLE[k];
  root.classList.toggle("editing", !!draft);
  root.innerHTML = `
    <div class="settings-head">
      <div>
        <h3 class="style-head">Fees</h3>
      </div>
      ${draft ? `<span class="settings-editing">Editing: saved together</span>` : loadFailed ? "" : '<button class="btn" data-fee-style-edit>Edit fee settings</button>'}
    </div>
    ${loadFailed ? `<p class="status error">Couldn't load your saved fee settings. Reload the page to edit them.</p>` : ""}
    <p class="style-intro">The Proposal table on every fee, and how it looks when copied into a proposal.</p>
    <h4 class="settings-sub">Table colors</h4>
    <ul class="style-colors">
      ${COLORS.map(
        ([k, label, hint]) => `<li>
          ${
            draft
              ? `<label class="swatch" title="Choose a color for ${esc(label)}"><input type="color" value="${esc(String(s[k]))}" data-fee-color="${k}" aria-label="${esc(label)} color" /></label>`
              : `<span class="swatch" style="background:${esc(String(s[k]))}"></span>`
          }
          <span class="name"><b>${esc(label)}</b> <span class="hint">${esc(hint)}</span></span>
          ${
            draft && !isStandard(k)
              ? `<button class="link" data-fee-standard="${k}">Use standard</button>`
              : `<span class="std">${isStandard(k) ? "Standard" : "Custom"}</span>`
          }
        </li>`,
      ).join("")}
    </ul>
    <h4 class="settings-sub">Text</h4>
    <dl class="style-opts">
      <dt>Font</dt>
      <dd>${
        draft
          ? `<select data-fee-font aria-label="Fee table font">${(Object.keys(FEE_FONTS) as FeeFont[])
              .map((f) => `<option value="${f}" ${f === s.font ? "selected" : ""}>${esc(FEE_FONTS[f].label)}</option>`)
              .join("")}</select>`
          : esc(FEE_FONTS[s.font].label)
      }</dd>
      <dt>Totals</dt>
      <dd>${
        draft
          ? `<label class="check"><input type="checkbox" data-fee-caps ${s.capitals ? "checked" : ""} /> “TOTAL FEE” and “TOTAL” in capitals</label>`
          : s.capitals ? "In capitals (TOTAL FEE)" : "As written (Total Fee)"
      }</dd>
      <dt>Rounding</dt>
      <dd>${
        draft
          ? `<select data-fee-rounding aria-label="Fee rounding">${FEE_ROUNDINGS.map(
              (r) => `<option value="${r.value}" ${r.value === s.rounding ? "selected" : ""}>${esc(r.label)}</option>`,
            ).join("")}</select>`
          : esc(FEE_ROUNDINGS.find((r) => r.value === s.rounding)!.label)
      }<span class="style-hint">Each amount is rounded, and the totals add the rounded amounts, so the table always adds up.</span></dd>
    </dl>
    <p class="style-preview-label">${draft ? "Preview" : "Sample"}</p>
    <div class="scroll style-preview">${proposalHtml(SAMPLE, s)}</div>
    ${
      draft
        ? `<div class="actions">
        <button class="btn primary" data-fee-style-save>Save fee settings</button>
        <button class="btn" data-fee-style-cancel>Cancel</button>
        <button class="link" data-fee-style-reset>Reset everything to standard</button>
      </div>`
        : ""
    }
    <span class="status ${statusError ? "error" : ""}">${esc(status)}</span>`;
}

async function onClick(e: Event) {
  const t = e.target as HTMLElement;
  if (t.closest("[data-fee-style-edit]")) {
    draft = { ...saved };
    status = "";
  } else if (t.closest("[data-fee-style-cancel]")) draft = null;
  else if (t.closest("[data-fee-style-reset]") && draft) draft = { ...DEFAULT_FEE_STYLE };
  else if (t.closest("[data-fee-standard]") && draft) {
    const k = t.closest("[data-fee-standard]")!.getAttribute("data-fee-standard") as keyof FeeStyle;
    draft = { ...draft, [k]: DEFAULT_FEE_STYLE[k] };
  } else if (t.closest("[data-fee-style-save]") && draft) {
    const ok = await confirmModal({
      title: "Save the fee table style?",
      body: "Every fee's Proposal table in your organization will use it, including tables copied from now on.",
      confirm: "Save",
    });
    if (!ok) return;
    const next = cleanFeeStyle(draft);
    try {
      await saveFeeStyle(next);
      saved = next;
      draft = null;
      statusError = false;
      status = "Saved. Every fee table now uses this style.";
    } catch (err) {
      statusError = true;
      status = (err as Error).message;
    }
  } else return;
  renderFee();
}

function onInput(e: Event) {
  if (!draft) return;
  const el = e.target as HTMLInputElement;
  const color = el.getAttribute("data-fee-color") as keyof FeeStyle | null;
  if (color) draft = { ...draft, [color]: el.value.toUpperCase() };
  else if (el.matches("[data-fee-font]")) draft = { ...draft, font: el.value as FeeFont };
  else if (el.matches("[data-fee-caps]")) draft = { ...draft, capitals: el.checked };
  else if (el.matches("[data-fee-rounding]")) draft = { ...draft, rounding: Number(el.value) as FeeRounding };
  else return;
  // Redraw only the preview while a color picker is open, so the picker isn't closed under the pointer.
  const preview = root?.querySelector(".style-preview");
  if (color && preview) return void (preview.innerHTML = proposalHtml(SAMPLE, draft));
  renderFee();
}
