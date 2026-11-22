// A fee as an Excel workbook: the worksheet (rates, hours by role for every task, consultants by phase, the totals)
// and the Proposal table, in the organization's fee table style. Totals are live formulas, so the file keeps working
// when hours or rates change; each also carries its current value, for previews that don't calculate. ExcelJS is
// loaded only when a fee is exported.
import type { Cell, Worksheet } from "exceljs";
import { budgetOf, consultantPhase, proposalTable, roundedTable, taskCost, taskHours, totals } from "./fee-calc";
import { roundFee, textOn, type FeeFont, type FeeStyle } from "./fee-style";
import type { SavedFee } from "./store";

const MONEY = '"$"#,##0';
// Hours are whole or half hours. "General" shows 12 and 7.5 as they are; "#,##0.##" would show 12 as "12." (Excel
// keeps the decimal point when there are no decimals), and Excel has no format that drops it only for whole numbers.
const HOURS = "General";
const PERCENT = '0.0"%"';
const RATIO = "0.0%";
/**
 * The organization's fee table font, by the name Excel knows it, on every sheet. Where a computer lacks it (Helvetica
 * on Windows), Excel shows its closest match and keeps the name, so it prints in the right font wherever it's installed.
 */
const EXCEL_FONT: Record<FeeFont, string> = { helvetica: "Helvetica", arial: "Arial", calibri: "Calibri", georgia: "Georgia", garamond: "Garamond" };

/** Column letters: 1 → A, 27 → AA. */
function col(n: number): string {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
const argb = (hex: string) => `FF${hex.replace("#", "").toUpperCase()}`;
const fill = (hex: string) => ({ type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: argb(hex) } });
const SOFT = "#F2F2F0";

/** A formula with its current value (shown until Excel recalculates). */
const formula = (cell: Cell, f: string, result: number | null, format = MONEY) => {
  cell.value = { formula: f, result: result ?? 0 };
  cell.numFmt = format;
};
const number = (cell: Cell, n: number | null | undefined, format = MONEY) => {
  cell.value = n ?? null;
  cell.numFmt = format;
};

/** Downloads the fee as an .xlsx file. */
export async function exportFeeExcel(f: SavedFee, opts: { project: string; style: FeeStyle }) {
  const { Workbook } = await import("exceljs");
  const book = new Workbook();
  book.created = new Date();
  // Excel works every formula out when the file opens (the stored values are only for previews).
  book.calcProperties.fullCalcOnLoad = true;
  const font = EXCEL_FONT[opts.style.font] ?? "Arial";
  const sheet = book.addWorksheet("Fee worksheet", { views: [{ state: "frozen", xSplit: 1, ySplit: 0 }] });
  const t = totals(f);
  const roles = f.roles;
  const hoursCol = roles.length + 2;
  const costCol = roles.length + 3;
  const last = col(costCol);

  // ---------- Heading and inputs ----------
  sheet.getCell("A1").value = f.title || "Fee";
  sheet.getCell("A1").font = { name: font, size: 16, bold: true };
  sheet.getCell("A2").value = [opts.project, f.status === "final" ? "Final" : "Draft", `Exported ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`]
    .filter(Boolean)
    .join(" · ");
  const inputs: [string, number | null, string][] = [
    ["Construction budget", budgetOf(f), MONEY],
    ["Target fee (% of construction)", f.targetPercent, PERCENT],
    ["Management markup on consultants (%)", f.markupPercent, PERCENT],
    ["Reimbursable expenses (not in the fee)", f.expenses, MONEY],
  ];
  const at = (label: string) => `$B$${4 + inputs.findIndex(([l]) => l === label)}`;
  inputs.forEach(([label, value, format], i) => {
    sheet.getCell(`A${4 + i}`).value = label;
    number(sheet.getCell(`B${4 + i}`), value, format);
    sheet.getCell(`B${4 + i}`).fill = fill(SOFT);
  });
  const BUDGET = at("Construction budget");
  const TARGET = at("Target fee (% of construction)");
  const MARKUP = at("Management markup on consultants (%)");
  const EXPENSES = at("Reimbursable expenses (not in the fee)");

  // ---------- Labor: rates, then each phase's tasks with hours by role ----------
  let row = 4 + inputs.length + 2;
  const head = sheet.getRow(row);
  ["Phase / task", ...roles.map((r) => r.short || r.name), "Hours", "Cost"].forEach((v, i) => (head.getCell(i + 1).value = v));
  styleHeader(head, costCol, opts.style, font);
  const rateRow = ++row;
  sheet.getCell(`A${rateRow}`).value = "Rate ($/hour)";
  roles.forEach((r, i) => {
    number(sheet.getCell(rateRow, i + 2), r.rate);
    sheet.getCell(rateRow, i + 2).fill = fill(SOFT);
  });
  sheet.getRow(rateRow).font = { name: font, italic: true };
  const rates = `$B$${rateRow}:$${col(roles.length + 1)}$${rateRow}`;

  const phaseRows: number[] = [];
  f.phases.forEach((phase, pi) => {
    const pt = t.phases[pi];
    const phaseRow = ++row;
    phaseRows.push(phaseRow);
    const taskRows = phase.tasks.map((task) => {
      const r = ++row;
      sheet.getCell(`A${r}`).value = task.name;
      sheet.getCell(`A${r}`).alignment = { indent: 1 };
      roles.forEach((role, i) => number(sheet.getCell(r, i + 2), task.hours[role.id] || null, HOURS));
      formula(sheet.getCell(r, hoursCol), roles.length ? `SUM(B${r}:${col(roles.length + 1)}${r})` : "0", taskHours(task), HOURS);
      formula(sheet.getCell(r, costCol), roles.length ? `SUMPRODUCT(B${r}:${col(roles.length + 1)}${r},${rates})` : "0", taskCost(task, roles));
      return r;
    });
    // The phase's row: its tasks' totals.
    const sum = (c: number) => (taskRows.length ? `SUM(${col(c)}${taskRows[0]}:${col(c)}${taskRows[taskRows.length - 1]})` : "0");
    const p = sheet.getRow(phaseRow);
    p.getCell(1).value = phase.name;
    roles.forEach((role, i) => formula(p.getCell(i + 2), sum(i + 2), phase.tasks.reduce((s, x) => s + (x.hours[role.id] ?? 0), 0), HOURS));
    formula(p.getCell(hoursCol), sum(hoursCol), pt.hours, HOURS);
    formula(p.getCell(costCol), sum(costCol), pt.cost);
    p.font = { name: font, bold: true };
    for (let c = 1; c <= costCol; c++) p.getCell(c).fill = fill(SOFT);
  });
  const laborRow = ++row;
  const sumPhases = (c: number) => (phaseRows.length ? phaseRows.map((r) => `${col(c)}${r}`).join("+") : "0");
  const lr = sheet.getRow(laborRow);
  lr.getCell(1).value = "Labor total";
  roles.forEach((role, i) => formula(lr.getCell(i + 2), sumPhases(i + 2), t.roleHours[role.id] ?? 0, HOURS));
  formula(lr.getCell(hoursCol), sumPhases(hoursCol), t.laborHours, HOURS);
  formula(lr.getCell(costCol), sumPhases(costCol), t.labor);
  styleTotal(lr, costCol, opts.style, font);
  const LABOR = `$${last}$${laborRow}`;

  // ---------- Consultants: quoted fees by phase ----------
  row += 2;
  const consHead = sheet.getRow(row);
  ["Consultant", ...f.phases.map((p) => p.name), "Total"].forEach((v, i) => (consHead.getCell(i + 1).value = v));
  styleHeader(consHead, f.phases.length + 2, opts.style, font);
  const consRows = f.consultants.map((c) => {
    const r = ++row;
    sheet.getCell(`A${r}`).value = [c.discipline, c.firm].filter(Boolean).join(" · ");
    f.phases.forEach((p, i) => {
      number(sheet.getCell(r, i + 2), consultantPhase(c, p.id) || null);
      sheet.getCell(r, i + 2).fill = fill(SOFT);
    });
    formula(sheet.getCell(r, f.phases.length + 2), f.phases.length ? `SUM(B${r}:${col(f.phases.length + 1)}${r})` : "0", f.phases.reduce((s, p) => s + consultantPhase(c, p.id), 0));
    return r;
  });
  const consTotalRow = ++row;
  const ct = sheet.getRow(consTotalRow);
  ct.getCell(1).value = "Consultants total";
  const consSum = (c: number) => (consRows.length ? `SUM(${col(c)}${consRows[0]}:${col(c)}${consRows[consRows.length - 1]})` : "0");
  f.phases.forEach((p, i) => formula(ct.getCell(i + 2), consSum(i + 2), f.consultants.reduce((s, c) => s + consultantPhase(c, p.id), 0)));
  formula(ct.getCell(f.phases.length + 2), consSum(f.phases.length + 2), t.consultants);
  styleTotal(ct, f.phases.length + 2, opts.style, font);
  const CONSULTANTS = `$${col(f.phases.length + 2)}$${consTotalRow}`;

  // ---------- The fee ----------
  row += 2;
  const sumRow = (label: string, f_: string, result: number | null, format = MONEY, bold = false) => {
    const r = ++row;
    sheet.getCell(`A${r}`).value = label;
    formula(sheet.getCell(`B${r}`), f_, result, format);
    if (bold) sheet.getRow(r).font = { name: font, bold: true };
    return `$B$${r}`;
  };
  sheet.getCell(`A${row}`).value = "Fee";
  sheet.getCell(`A${row}`).font = { name: font, size: 13, bold: true };
  sumRow("Labor", LABOR, t.labor);
  sumRow("Consultants", CONSULTANTS, t.consultants);
  const MARKUP_AMT = sumRow("Management markup", `${CONSULTANTS}*${MARKUP}/100`, t.markup);
  const TOTAL = sumRow("Total fee", `${LABOR}+${CONSULTANTS}+${MARKUP_AMT}`, t.total, MONEY, true);
  sumRow("Percent of construction", `IF(${BUDGET}>0,${TOTAL}/${BUDGET},"")`, t.percentOfBudget == null ? null : t.percentOfBudget / 100, RATIO);
  sumRow("Target fee", `IF(AND(${BUDGET}>0,${TARGET}<>""),${BUDGET}*${TARGET}/100,"")`, t.target);
  sumRow("Reimbursable expenses (listed below the fee)", EXPENSES, t.expenses);

  sheet.getColumn(1).width = 44;
  for (let c = 2; c <= Math.max(costCol, f.phases.length + 2); c++) sheet.getColumn(c).width = 14;
  sheet.eachRow((r) => r.eachCell((c) => (c.font = { name: font, ...c.font })));

  addProposalSheet(book.addWorksheet("Proposal table"), f, opts.style, font, { laborRows: phaseRows, costCol: last, consRows, markup: MARKUP, expenses: EXPENSES });

  const blob = new Blob([await book.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: fileName(f, opts.project) });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/**
 * The Proposal table: a row per phase, Architecture (its labor plus the markup on that phase's consultant fees) and
 * each consultant, linked to the worksheet so it follows any change there.
 */
function addProposalSheet(
  sheet: Worksheet,
  f: SavedFee,
  style: FeeStyle,
  font: string,
  ref: { laborRows: number[]; costCol: string; consRows: number[]; markup: string; expenses: string },
) {
  // Rounded as the organization rounds its fee table: each amount's formula rounds, and the totals add rounded cells.
  const t = roundedTable(proposalTable(f), (x) => roundFee(x, style.rounding));
  const to = style.rounding;
  const R = (expr: string) => (to === 0.01 ? `ROUND(${expr},2)` : to === 1 ? `ROUND(${expr},0)` : `ROUND((${expr})/${to},0)*${to}`);
  const FMT = to === 0.01 ? '"$"#,##0.00' : MONEY;
  const W = "'Fee worksheet'!";
  // Only consultants with a fee are columns (as on the page); their worksheet rows, by the same order.
  const withFee = f.consultants.map((c, i) => ({ c, row: ref.consRows[i] })).filter(({ c }) => f.phases.some((p) => consultantPhase(c, p.id) > 0));
  const n = t.columns.length;
  const totalCol = n + 2;
  const caps = (s: string) => (style.capitals ? s.toUpperCase() : s);

  const head = sheet.getRow(1);
  head.getCell(1).value = "Phase";
  t.columns.forEach((c, i) => (head.getCell(i + 2).value = c.firm ? `${c.firm} (${c.discipline})` : c.discipline));
  head.getCell(totalCol).value = caps("Total fee");
  styleHeader(head, totalCol, style, font);
  head.getCell(totalCol).fill = fill(style.totalColumn);
  head.getCell(totalCol).font = { name: font, bold: true, color: { argb: argb(textOn(style.totalColumn)) } };

  let r = 1;
  const rows: number[] = [];
  // The same phases as the proposal table on the page (proposalTable decides which show), in the same order.
  t.rows.forEach((tr) => {
    const pi = f.phases.findIndex((x) => x.id === tr.phaseId);
    if (pi < 0) return;
    const row = sheet.getRow(++r);
    rows.push(r);
    row.getCell(1).value = tr.label;
    row.getCell(1).font = { name: font, bold: true };
    const phaseCol = col(pi + 2);
    const quoted = withFee.map(({ row: cr }) => `${W}${phaseCol}${cr}`);
    formula(row.getCell(2), R(`${W}${ref.costCol}${ref.laborRows[pi]}${quoted.length ? `+(${quoted.join("+")})*${W}${ref.markup}/100` : ""}`), tr?.amounts[0] ?? 0, FMT);
    withFee.forEach(({ row: cr }, i) => formula(row.getCell(i + 3), R(`${W}${phaseCol}${cr}`), tr?.amounts[i + 1] ?? 0, FMT));
    formula(row.getCell(totalCol), `SUM(B${r}:${col(n + 1)}${r})`, tr?.total ?? 0, FMT);
    row.getCell(totalCol).fill = fill(style.totalColumn);
    row.getCell(totalCol).font = { name: font, color: { argb: argb(textOn(style.totalColumn)) } };
  });
  const total = sheet.getRow(++r);
  total.getCell(1).value = caps("Total");
  for (let c = 2; c <= totalCol; c++)
    formula(total.getCell(c), rows.length ? `SUM(${col(c)}${rows[0]}:${col(c)}${rows[rows.length - 1]})` : "0", c === totalCol ? t.total : t.totals[c - 2], FMT);
  for (let c = 1; c <= totalCol; c++) {
    total.getCell(c).fill = fill(style.totalRow);
    total.getCell(c).font = { name: font, bold: true, color: { argb: argb(textOn(style.totalRow)) } };
  }
  if (t.expenses) {
    const e = sheet.getRow(r += 2);
    e.getCell(1).value = "Reimbursable expenses (not included in the fee)";
    formula(e.getCell(2), `${W}${ref.expenses}`, t.expenses);
  }
  if (t.belowLine?.length) {
    r += 2;
    sheet.getCell(`A${r}`).value = "Additional scope items (offered outside the fee)";
    sheet.getCell(`A${r}`).font = { name: font, bold: true };
    for (const b of t.belowLine) {
      const row = sheet.getRow(++r);
      row.getCell(1).value = [b.label, b.note].filter(Boolean).join(" — ");
      number(row.getCell(totalCol), b.amount);
      row.getCell(totalCol + 1).value = { lump: "Lump sum", hourly: "Hourly", nte: "Not to exceed", allowance: "Allowance", request: "Upon request" }[b.basis];
    }
  }
  sheet.getColumn(1).width = 32;
  for (let c = 2; c <= totalCol + 1; c++) sheet.getColumn(c).width = 18;
  sheet.eachRow((row) => row.eachCell((c) => (c.font = { name: font, ...c.font })));
}

function styleHeader(row: ReturnType<Worksheet["getRow"]>, cols: number, style: FeeStyle, font: string) {
  for (let c = 1; c <= cols; c++) {
    const cell = row.getCell(c);
    cell.fill = fill(style.head);
    cell.font = { name: font, bold: true, color: { argb: argb(textOn(style.head)) } };
    cell.alignment = { vertical: "bottom", wrapText: true, horizontal: c === 1 ? "left" : "right" };
  }
}

function styleTotal(row: ReturnType<Worksheet["getRow"]>, cols: number, style: FeeStyle, font: string) {
  for (let c = 1; c <= cols; c++) {
    row.getCell(c).fill = fill(style.totalRow);
    row.getCell(c).font = { name: font, bold: true, color: { argb: argb(textOn(style.totalRow)) } };
  }
}

/** "2611 Maple Hollow Library - Fee.xlsx", with the fee's own title when it says more than the project's: safe on every system. */
export function fileName(f: SavedFee, project: string, ext = "xlsx", suffix = ""): string {
  const title = (f.title || "").trim();
  const base = [project, !title || project.toLowerCase().includes(title.toLowerCase()) ? "Fee" : title].filter(Boolean).join(" - ") + suffix;
  return `${base.replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim().slice(0, 120) || "Fee"}.${ext}`;
}
