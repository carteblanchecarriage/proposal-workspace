// The site owner's activity page (#admin): who's using the site and how much AI each organization uses. Only for the
// emails in ADMIN_EMAILS; the server checks every request (lib/admin.ts). Account and usage data only.

import { postJson } from "./api";
import type { AdminOverview } from "../lib/admin";
import { usageFor } from "../lib/admin-usage";
import { esc } from "./table";

const $ = (id: string) => document.getElementById(id)!;

/** What each AI endpoint is, in plain words (usage is recorded by endpoint). */
const FEATURES: Record<string, string> = {
  "/api/rfp": "RFP reviews, fit checks, world view",
  "/api/extract": "Reading consultant proposals",
  "/api/compare": "Comparing proposals",
  "/api/chat": "Proposal chat and project assistant",
  "/api/fee-draft": "Fee drafts and fee assistant",
  "/api/schedule-ai": "Schedule drafts and assistant",
  "/api/upload": "Uploads",
};

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "Never");
function ago(iso: string | null): string {
  if (!iso) return "Never";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 30 ? `${days} days ago` : day(iso);
}

/** "Fri, Nov 20: 12 AI calls, $1.23" (with "Today" for today). */
function dayText(d: { date: string; calls: number; costUsd: number }, today = false): string {
  const when = new Date(d.date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return `${today ? "Today, " : ""}${when}: ${d.calls.toLocaleString("en-US")} AI call${d.calls === 1 ? "" : "s"}, ${usd(d.costUsd)}`;
}

/** Whose usage the summary, chart and features show: everyone, everyone but the owner's own testing, or one org. */
type Scope = "all" | "others" | `org:${string}`;
const SCOPE_KEY = "admin_usage_scope";
const readScope = (): Scope | null => {
  try {
    return localStorage.getItem(SCOPE_KEY) as Scope | null;
  } catch {
    return null;
  }
};
const writeScope = (s: Scope) => {
  try {
    localStorage.setItem(SCOPE_KEY, s);
  } catch {}
};

export async function showAdmin() {
  const page = $("admin-page");
  page.innerHTML = `<h1 class="headline">Activity</h1><span class="status">Loading…</span>`;
  let data: AdminOverview;
  try {
    data = await postJson<AdminOverview>("/api/auth", {}, "admin-overview");
  } catch (err) {
    const status = (err as { status?: number }).status;
    page.innerHTML = `<h1 class="headline">Activity</h1><p class="status ${status === 403 ? "" : "error"}">${
      status === 403 ? "This page isn't available." : esc((err as Error).message)
    }</p>`;
    return;
  }
  render(data);
}

function render(data: AdminOverview) {
  const page = $("admin-page");
  const s = data.summary;
  const you = data.yourOrgId && data.byOrg[data.yourOrgId] ? data.yourOrgId : null;
  // Leaving out the owner's own organization is the default, so testing never mixes with real use.
  let scope: Scope = readScope() ?? (you ? "others" : "all");
  if ((scope === "others" && !you) || (scope.startsWith("org:") && !data.byOrg[scope.slice(4)])) scope = you ? "others" : "all";
  const include = (id: string) => (scope === "all" ? true : scope === "others" ? id !== you : id === scope.slice(4));
  const usage = usageFor(data, include);
  const maxCalls = Math.max(1, ...usage.days.map((d) => d.calls));
  const scopeName =
    scope === "all" ? "all organizations" : scope === "others" ? "all organizations except yours" : (data.orgs.find((o) => o.id === scope.slice(4))?.name ?? "one organization");
  page.innerHTML = `
    <h1 class="headline">Activity</h1>
    <p class="wv-intro">Every organization's plan and AI use. Account and usage data only, never what's inside anyone's projects. Updated ${esc(
      new Date(data.generatedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
    )}. <button class="link" type="button" data-admin-refresh>Refresh</button></p>

    <div class="block admin-summary">
      ${[
        ["Organizations", String(s.orgs)],
        ["People", String(s.people)],
        ["Active in the last 7 days", String(s.active7)],
      ]
        .map(([label, value]) => `<div><span class="admin-num">${esc(value)}</span><span class="admin-cap">${esc(label)}</span></div>`)
        .join("")}
    </div>

    <div class="block">
      <h2 class="label">Organizations</h2>
      <div class="scroll"><table class="grid admin-orgs">
        <thead><tr><th>Organization</th><th>Plan</th><th class="num">People</th><th>Created</th><th>Last active</th><th class="num">AI calls</th><th class="num">AI cost</th><th>Allowance used</th><th>Flags</th></tr></thead>
        <tbody>${data.orgs
          .map(
            (o) => `<tr>
              <td><b>${esc(o.name)}</b>${o.id === you ? ' <span class="admin-cap">(you)</span>' : ""}</td>
              <td>${esc(o.plan)}${o.status ? ` <span class="admin-cap">${esc(o.status)}</span>` : ""}</td>
              <td class="num">${o.members}</td>
              <td>${esc(day(o.createdAt))}</td>
              <td>${esc(ago(o.lastActive))}</td>
              <td class="num">${o.calls.toLocaleString("en-US")}</td>
              <td class="num">${usd(o.costUsd)}</td>
              <td>${
                o.limitUsd == null
                  ? "No limit"
                  : o.limitUsd === 0
                    ? "No allowance"
                    : `<span class="admin-meter" title="${esc(usd(o.costUsd))} of ${esc(usd(o.limitUsd))}"><span style="width:${Math.min(100, o.percent ?? 0).toFixed(1)}%"></span></span> ${Math.round(o.percent ?? 0)}% of ${esc(usd(o.limitUsd))}`
              }</td>
              <td>${o.flags.map((f) => `<span class="admin-flag ${f === "at limit" || f === "past due" ? "bad" : ""}">${esc(f)}</span>`).join(" ")}</td>
            </tr>`,
          )
          .join("")}</tbody>
      </table></div>
      <p class="admin-cap">AI calls and cost are for each organization's current period: its billing period when it's subscribed, else this calendar month.</p>
    </div>

    <div class="block admin-usage">
      <div class="admin-scope">
        <label for="admin-scope"><b>Show usage for</b></label>
        <select id="admin-scope" aria-label="Whose usage to show">
          <option value="all" ${scope === "all" ? "selected" : ""}>All organizations</option>
          ${you ? `<option value="others" ${scope === "others" ? "selected" : ""}>All except yours (leaves out your own testing)</option>` : ""}
          ${data.orgs.map((o) => `<option value="org:${esc(o.id)}" ${scope === `org:${o.id}` ? "selected" : ""}>${esc(o.name)}${o.id === you ? " (you)" : ""}</option>`).join("")}
        </select>
      </div>
      <div class="admin-summary">
        ${[
          ["AI calls this month", usage.callsMonth.toLocaleString("en-US")],
          ["AI cost this month", usd(usage.costMonth)],
        ]
          .map(([label, value]) => `<div><span class="admin-num">${esc(value)}</span><span class="admin-cap">${esc(label)}</span></div>`)
          .join("")}
      </div>
      <p class="admin-cap">Showing ${esc(scopeName)}.</p>
    </div>

    <div class="block">
      <h2 class="label">AI calls, last 30 days</h2>
      <p class="admin-day-readout" id="admin-day-readout">${esc(dayText(usage.days[usage.days.length - 1], true))}</p>
      <div class="admin-days" role="img" aria-label="AI calls per day over the last 30 days">${usage.days
        .map(
          (d, i) =>
            `<span class="admin-day" data-day="${i}" title="${esc(dayText(d))}"><span style="height:${((d.calls / maxCalls) * 100).toFixed(1)}%"></span></span>`,
        )
        .join("")}</div>
      <div class="admin-days-axis"><span>${esc(day(usage.days[0].date + "T12:00:00Z"))}</span><span>Today</span></div>
    </div>

    <div class="block">
      <h2 class="label">Features used this month</h2>
      ${
        usage.features.length
          ? `<table class="grid admin-features"><thead><tr><th>Feature</th><th class="num">AI calls</th><th class="num">AI cost</th></tr></thead><tbody>${usage.features
              .map((f) => `<tr><td>${esc(FEATURES[f.endpoint] ?? f.endpoint)}</td><td class="num">${f.calls.toLocaleString("en-US")}</td><td class="num">${usd(f.costUsd)}</td></tr>`)
              .join("")}</tbody></table>`
          : `<p class="none">No AI use this month for ${esc(scopeName)}.</p>`
      }
    </div>`;
  page.querySelector<HTMLSelectElement>("#admin-scope")?.addEventListener("change", (e) => {
    writeScope((e.target as HTMLSelectElement).value as Scope);
    render(data);
  });
  page.querySelector("[data-admin-refresh]")?.addEventListener("click", () => void showAdmin());
  // Hovering (or tapping) a day shows its date, calls and cost above the chart; leaving the chart goes back to today.
  const chart = page.querySelector<HTMLElement>(".admin-days");
  const readout = page.querySelector<HTMLElement>("#admin-day-readout");
  const showDay = (i: number | null) => {
    chart?.querySelectorAll(".admin-day.on").forEach((el) => el.classList.remove("on"));
    const d = usage.days[i ?? usage.days.length - 1];
    if (i != null) chart?.querySelector(`[data-day="${i}"]`)?.classList.add("on");
    if (readout) readout.textContent = dayText(d, i == null);
  };
  chart?.addEventListener("pointerover", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-day]");
    if (el) showDay(Number(el.dataset.day));
  });
  chart?.addEventListener("pointerleave", () => showDay(null));
}
