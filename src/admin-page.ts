// The site owner's activity page (#admin): who's using the site and how much AI each organization uses. Only for the
// emails in ADMIN_EMAILS; the server checks every request (lib/admin.ts). Account and usage data only.

import { postJson } from "./api";
import type { AccessRequest, AdminOrg, AdminOverview, FeedbackItem, PendingInvite } from "../lib/admin";
import { confirmModal, formModal, noticeModal } from "./modal";
import { usageFor } from "../lib/admin-usage";
import { AI_SAFEGUARD_USD, effectiveLimit } from "../lib/ai-limits";
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

// ---------- The inbox: access requests and feedback ----------

type Inbox = { requests: AccessRequest[]; feedback: FeedbackItem[]; invites: PendingInvite[] | null };
let inbox: Inbox | null = null;
let inboxError = "";
/** Whether every request shows, or only the ones still to decide on. */
let allRequests = false;
let lastOverview: AdminOverview | null = null;

async function loadInbox() {
  try {
    inbox = await postJson<Inbox>("/api/auth", {}, "admin-inbox");
    inboxError = "";
  } catch (err) {
    inbox = null;
    inboxError = (err as Error).message;
  }
}

const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

function inboxHtml(): string {
  if (!inbox) return `<div class="block"><h2 class="label">Inbox</h2><p class="status error">Couldn't load access requests and feedback: ${esc(inboxError)}</p></div>`;
  const open = inbox.requests.filter((r) => r.status === "new");
  const shown = allRequests ? inbox.requests : open;
  const requests = `<div class="block admin-inbox">
      <h2 class="label">Access requests <span class="admin-cap">${open.length} to decide on${inbox.requests.length > open.length ? ` · <button class="link" type="button" data-req-all>${allRequests ? "Show only new" : `Show all ${inbox.requests.length}`}</button>` : ""}</span></h2>
      ${
        shown.length
          ? `<div class="scroll"><table class="grid admin-requests">
        <thead><tr><th>Asked</th><th>Name</th><th>Email</th><th>Firm</th><th>Note</th><th>Status</th><th></th></tr></thead>
        <tbody>${shown
          .map(
            (r) => `<tr>
              <td>${esc(when(r.createdAt))}</td>
              <td><b>${esc(r.name)}</b></td>
              <td><a href="mailto:${esc(r.email)}">${esc(r.email)}</a></td>
              <td>${esc(r.firm)}</td>
              <td class="admin-note">${esc(r.note)}</td>
              <td><span class="admin-flag ${r.status === "new" ? "bad" : ""}">${esc(r.status)}</span></td>
              <td class="admin-actions">${
                r.status === "new"
                  ? `<button class="btn" type="button" data-req-invite="${esc(r.id)}">Invite</button><button class="link" type="button" data-req-status="${esc(r.id)}" data-to="declined">Decline</button>`
                  : `<button class="link" type="button" data-req-status="${esc(r.id)}" data-to="new">Reopen</button>`
              }</td>
            </tr>`,
          )
          .join("")}</tbody>
      </table></div>`
          : `<p class="none">${inbox.requests.length ? "Nothing new to decide on." : "No requests yet."}</p>`
      }
    </div>`;
  const feedback = `<div class="block admin-inbox">
      <h2 class="label">Feedback <span class="admin-cap">${inbox.feedback.length ? `${inbox.feedback.length} message${inbox.feedback.length === 1 ? "" : "s"}` : ""}</span></h2>
      ${
        inbox.feedback.length
          ? `<ul class="admin-feedback">${inbox.feedback
              .map(
                (f) => `<li>
              <p class="admin-cap">${esc(when(f.createdAt))}${f.email ? ` · <a href="mailto:${esc(f.email)}">${esc(f.email)}</a>` : ""}${f.orgName ? ` · ${esc(f.orgName)}` : ""}${f.page ? ` · on ${esc(f.page)}` : ""}</p>
              <p>${esc(f.message).replace(/\n/g, "<br />")}</p>
            </li>`,
              )
              .join("")}</ul>`
          : `<p class="none">No feedback yet.</p>`
      }
    </div>`;
  const waiting = (iso: string) => {
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
    return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  };
  const invites = `<div class="block admin-inbox">
      <h2 class="label">Invited, not signed in yet <span class="admin-cap">${inbox.invites ? `${inbox.invites.length}` : ""}</span></h2>
      ${
        inbox.invites === null
          ? `<p class="status error">Couldn't read who's been invited. Try Refresh.</p>`
          : inbox.invites.length
            ? `<div class="scroll"><table class="grid admin-requests admin-invites">
        <thead><tr><th>Email</th><th>Invited</th><th></th></tr></thead>
        <tbody>${inbox.invites
          .map(
            (i) => `<tr>
              <td><a href="mailto:${esc(i.email)}">${esc(i.email)}</a></td>
              <td>${esc(waiting(i.invitedAt))}</td>
              <td class="admin-actions"><button class="link" type="button" data-resend="${esc(i.email)}">Resend invite</button></td>
            </tr>`,
          )
          .join("")}</tbody>
      </table></div>`
            : `<p class="none">Everyone invited has signed in.</p>`
      }
    </div>`;
  return requests + invites + feedback;
}

/** Invite, decline and reopen, and showing all requests: changes are saved, then the inbox is read again. */
async function onInboxClick(e: Event) {
  const t = e.target as HTMLElement;
  if (t.closest("[data-req-all]")) {
    allRequests = !allRequests;
    return redraw();
  }
  const resend = t.closest<HTMLButtonElement>("[data-resend]");
  if (resend) {
    const email = resend.dataset.resend!;
    const ok = await confirmModal({ title: "Resend the invite?", body: `This emails ${email} a fresh link to set a password and sign in.`, confirm: "Resend" });
    if (!ok) return;
    resend.disabled = true;
    try {
      await postJson("/api/auth", { email }, "admin-resend-invite");
      await noticeModal("Invite sent", `${email} has a fresh invite.`);
    } catch (err) {
      await noticeModal("Couldn't resend the invite", (err as Error).message);
    }
    resend.disabled = false;
    return;
  }
  const invite = t.closest<HTMLButtonElement>("[data-req-invite]");
  const status = t.closest<HTMLButtonElement>("[data-req-status]");
  if (!invite && !status) return;
  const id = (invite ?? status)!.getAttribute(invite ? "data-req-invite" : "data-req-status")!;
  const req = inbox?.requests.find((r) => r.id === id);
  if (!req) return;
  try {
    if (invite) {
      const ok = await confirmModal({
        title: `Invite ${req.name}?`,
        body: `This emails ${req.email} an invite to set a password and sign in. They'll get their own organization on their first sign-in.`,
        confirm: "Send invite",
      });
      if (!ok) return;
      invite.disabled = true;
      const res = await postJson<{ alreadyHadAccount: boolean }>("/api/auth", { id }, "admin-invite");
      if (res.alreadyHadAccount) await noticeModal("Already has an account", `${req.email} already has an account, so no invite was sent. The request is marked invited.`);
    } else {
      status!.disabled = true;
      await postJson("/api/auth", { id, status: status!.dataset.to }, "admin-request-status");
    }
  } catch (err) {
    await noticeModal("Couldn't update the request", (err as Error).message);
  }
  await loadInbox();
  redraw();
}

/** What applies to an organization: its own allowance, never above the safeguard ("no limit" is the safeguard). */
function allowanceCell(o: AdminOrg): string {
  const applies = effectiveLimit(o.limitUsd);
  if (applies === 0) return "No allowance";
  const capped = o.limitUsd == null || o.limitUsd > AI_SAFEGUARD_USD;
  const meter = `<span class="admin-meter" title="${esc(usd(o.costUsd))} of ${esc(usd(applies))}"><span style="width:${Math.min(100, o.percent ?? 0).toFixed(1)}%"></span></span>`;
  return `${meter} ${Math.round(o.percent ?? 0)}% of ${esc(usd(applies))}${capped ? ' <span class="admin-cap">(safeguard)</span>' : ""}`;
}

/** "3 projects · 2 RFP reviews · 1 fee", or "Nothing yet". */
function madeText(o: AdminOrg): string {
  const parts: [number, string][] = [
    [o.made.projects, "project"],
    [o.made.reviews, "RFP review"],
    [o.made.fees, "fee"],
    [o.made.schedules, "schedule"],
    [o.made.comparisons, "comparison"],
  ];
  const text = parts.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}${n === 1 ? "" : "s"}`);
  return text.length ? text.join(" · ") : "Nothing yet";
}

/** Changes an organization's monthly AI allowance: dollars, 0 to turn AI off, or blank for no limit. */
async function changeAllowance(org: AdminOrg) {
  const current = org.limitUsd == null ? "" : String(org.limitUsd);
  const parse = (v: string) => (v.trim() === "" ? null : Number(v.replace(/[$,\s]/g, "")));
  const values = await formModal({
    title: `AI allowance for ${org.name}`,
    fields: [{ label: `Dollars of AI use a month, up to $${AI_SAFEGUARD_USD} (0 turns AI off; blank means the $${AI_SAFEGUARD_USD} safeguard)`, value: current, placeholder: `$${AI_SAFEGUARD_USD} safeguard` }],
    confirm: "Save",
    validate: ([v]) => {
      const n = parse(v);
      return n === null || (Number.isFinite(n) && n >= 0 && n <= AI_SAFEGUARD_USD);
    },
  });
  if (!values) return;
  try {
    await postJson("/api/auth", { id: org.id, usd: parse(values[0]) }, "admin-allowance");
  } catch (err) {
    return noticeModal("Couldn't change the allowance", (err as Error).message);
  }
  await showAdmin();
}

function redraw() {
  if (lastOverview) render(lastOverview);
}

export async function showAdmin() {
  const page = $("admin-page");
  page.innerHTML = `<h1 class="headline">Activity</h1><span class="status">Loading…</span>`;
  let data: AdminOverview;
  const inboxLoad = loadInbox();
  try {
    data = await postJson<AdminOverview>("/api/auth", {}, "admin-overview");
    await inboxLoad;
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
  lastOverview = data;
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
    <p class="wv-intro">Requests for access, feedback, and every organization's plan and AI use. Never what's inside anyone's projects. Updated ${esc(
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

    ${inboxHtml()}

    <div class="block">
      <h2 class="label">Organizations</h2>
      <div class="scroll"><table class="grid admin-orgs">
        <thead><tr><th>Organization</th><th>Plan</th><th class="num">People</th><th>Created</th><th>Last active</th><th>Made</th><th class="num">AI calls</th><th class="num">AI cost</th><th>Allowance used</th><th>Flags</th></tr></thead>
        <tbody>${data.orgs
          .map(
            (o) => `<tr>
              <td><b>${esc(o.name)}</b>${o.id === you ? ' <span class="admin-cap">(you)</span>' : ""}</td>
              <td>${esc(o.plan)}${o.status ? ` <span class="admin-cap">${esc(o.status)}</span>` : ""}</td>
              <td class="num">${o.members}</td>
              <td>${esc(day(o.createdAt))}</td>
              <td>${esc(ago(o.lastActive))}</td>
              <td class="admin-made">${esc(madeText(o))}</td>
              <td class="num">${o.calls.toLocaleString("en-US")}</td>
              <td class="num">${usd(o.costUsd)}</td>
              <td class="admin-allowance">${allowanceCell(o)} <button class="link" type="button" data-allowance="${esc(o.id)}">Change</button></td>
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
  page.querySelectorAll(".admin-inbox").forEach((el) => el.addEventListener("click", (e) => void onInboxClick(e)));
  page.querySelectorAll<HTMLButtonElement>("[data-allowance]").forEach((b) =>
    b.addEventListener("click", () => {
      const org = data.orgs.find((o) => o.id === b.dataset.allowance);
      if (org) void changeAllowance(org);
    }),
  );
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
