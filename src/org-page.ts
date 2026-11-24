import { postJson } from "./api";
import { confirmTyped, noticeModal } from "./modal";
import { setOrgName } from "./org";
import { signOut } from "./auth";
import { isDemo } from "./store";
import { esc } from "./table";
import { renderQualifications } from "./qualifications";
import { renderStyleSettings } from "./style-settings";

// The organization page: name, who's signed in to it, this month's AI use, export, and delete. Kept simple on
// purpose: no roles to manage or invites (a firm may well share one login). The owner renames and deletes.

type Info = {
  name: string;
  joinDomain: string | null;
  plan: string;
  createdAt: string;
  /** AI use as a share of the allowance (lib/org.ts); never dollars */
  ai: { state: "off" } | { state: "limited"; percent: number };
  subscriptionStatus: string | null;
  renewsAt: string | null;
  /** null when billing isn't set up on the server */
  billing: { price: string | null } | null;
  you: string | null;
  people: { email: string | null; role: string; you: boolean }[];
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
/** "37%", "less than 1%" for a little use, "0%" for none. */
const pct = (n: number) => (n > 0 && n < 1 ? "less than 1%" : `${Math.round(n)}%`);
const orgAction = <T>(action: string, body: object = {}) => postJson<T>("/api/auth", body, action);

let info: Info | null = null;
/** The name's edit box is open. */
let editingName = false;

export async function showOrg() {
  const page = $("org-page");
  editingName = false;
  if (isDemo()) {
    page.innerHTML = `
      <h1 class="headline">Demo Architects</h1>
      <p class="wv-intro">In your own account, this page is where you rename your organization, see who's in it and this month's AI use, download all your data, or delete the organization.</p>
      <div class="block" id="org-style"></div>
      <div class="block settings-group" id="org-qualifications"></div>`;
    void renderStyleSettings($("org-style"));
    void renderQualifications($("org-qualifications"));
    return;
  }
  page.innerHTML = `<h1 class="headline">Organization</h1><span class="status">Loading…</span>`;
  try {
    info = await orgAction<Info>("org-info");
    // Back from Stripe Checkout: the subscription switches on when Stripe's webhook arrives, usually within seconds.
    if (location.hash === "#org/subscribed") {
      history.replaceState(null, "", "#org");
      for (let i = 0; i < 8 && info.plan !== "pro"; i++) {
        page.innerHTML = `<h1 class="headline">${esc(info.name)}</h1><span class="status">Thanks! Turning on your subscription…</span>`;
        await new Promise((r) => setTimeout(r, 1500));
        info = await orgAction<Info>("org-info");
      }
    }
  } catch (err) {
    page.innerHTML = `<h1 class="headline">Organization</h1><span class="status error">${esc((err as Error).message)}</span>`;
    return;
  }
  render();
}

function render() {
  if (!info) return;
  const owner = info.you === "owner";
  const period = info.plan === "pro" ? "this billing period" : "this month";
  const ai = info.ai;
  const usage = ai.state === "off" ? "AI features aren't turned on for this organization yet." : `${pct(ai.percent)} of ${period}'s AI allowance used.`;
  const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "");
  const b = info.billing;
  const price = b?.price ? ` · ${esc(b.price)}` : "";
  const plan =
    info.plan === "owner"
      ? `<p>Internal plan: no subscription. AI has a monthly allowance, which resets on the 1st.</p>`
      : info.plan === "pro"
        ? `<p><b>Pro</b>${price}${info.renewsAt ? `. Renews ${esc(day(info.renewsAt))}.` : ""}</p>
           ${info.subscriptionStatus === "past_due" ? `<p class="status error">The last payment didn't go through. Update the card under Manage billing; AI stays on while Stripe retries.</p>` : ""}
           ${owner ? `<button class="btn" type="button" id="org-portal">Manage billing</button>` : ""}`
        : b
          ? `<p>Free: AI features are off.${b.price ? ` Subscribe for <b>${esc(b.price)}</b>, which includes an AI allowance each billing period.` : ""}</p>
             ${owner ? `<button class="btn primary" type="button" id="org-subscribe">Subscribe</button>` : `<p class="org-muted">Ask your organization's owner to subscribe.</p>`}`
          : `<p>Free.</p>`;
  $("org-page").innerHTML = `
    <h1 class="headline">${esc(info.name)}</h1>
    <p class="wv-intro">Your organization: everything saved in the app belongs to it.</p>

    <div class="block">
      <h2 class="label">Name</h2>
      ${
        !owner
          ? `<p>${esc(info.name)} <span class="org-muted">(the owner can change it)</span></p>`
          : editingName
            ? `<form id="org-rename" class="org-row"><input id="org-name-input" type="text" maxlength="120" value="${esc(info.name)}" aria-label="Organization name" /><button class="btn primary" type="submit">Save</button><button class="btn" type="button" id="org-rename-cancel">Cancel</button><span class="status" id="org-rename-status"></span></form>`
            : `<p>${esc(info.name)} <button class="link edit-link" type="button" id="org-rename-edit">Edit</button></p>`
      }
    </div>

    <div class="block">
      <h2 class="label">People</h2>
      <ul class="org-people">
        ${info.people.map((p) => `<li>${esc(p.email ?? "(unknown)")}${p.role === "owner" ? " · owner" : ""}${p.you ? " · you" : ""}</li>`).join("")}
      </ul>
      ${info.joinDomain ? `<p class="org-muted">Anyone who signs up with an @${esc(info.joinDomain)} email joins automatically.</p>` : ""}
    </div>

    <div class="block">
      <h2 class="label">Plan</h2>
      ${plan}
      <span class="status" id="org-billing-status"></span>
    </div>

    <div class="block" id="org-style"></div>

    <div class="block settings-group" id="org-qualifications"></div>

    <div class="block">
      <h2 class="label">AI use</h2>
      <p>${usage}</p>
    </div>

    <div class="block">
      <h2 class="label">Your data</h2>
      <p>Download everything your organization has saved (RFP reviews, comparisons, projects, consultants, schedules, fees, World view) as one file.</p>
      <button class="btn" type="button" id="org-export">Download all data</button>
      <span class="status" id="org-export-status"></span>
    </div>

    ${
      owner
        ? `<div class="block org-danger">
      <h2 class="label">Delete organization</h2>
      <p>Permanently deletes ${esc(info.name)} and everything in it, including stored PDFs. This can't be undone; download your data first. Everyone's sign-in still works, but they'll start with an empty organization.</p>
      <button class="btn primary danger" type="button" id="org-delete">Delete organization…</button>
    </div>`
        : ""
    }`;

  void renderStyleSettings($("org-style"));
  void renderQualifications($("org-qualifications"));

  // The name reads as text; Edit opens a box with Save and Cancel (Escape cancels too), so nothing changes by accident.
  $("org-rename-edit")?.addEventListener("click", () => {
    editingName = true;
    render();
    const box = $<HTMLInputElement>("org-name-input");
    box.focus();
    box.select();
  });
  const stopEditing = () => {
    editingName = false;
    render();
  };
  $("org-rename-cancel")?.addEventListener("click", stopEditing);
  $("org-name-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") stopEditing();
  });
  $("org-rename")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = $("org-rename-status");
    const name = $<HTMLInputElement>("org-name-input").value.trim();
    if (!name) return;
    if (name === info!.name) return stopEditing();
    status.classList.remove("error");
    status.textContent = "Saving…";
    try {
      await orgAction("org-rename", { name });
      info!.name = name;
      setOrgName(name);
      $("org-name").textContent = name;
      editingName = false;
      render();
    } catch (err) {
      status.textContent = (err as Error).message;
      status.classList.add("error");
    }
  });

  // Subscribe / Manage billing: Stripe's own pages.
  for (const [id, action] of [["org-subscribe", "billing-checkout"], ["org-portal", "billing-portal"]] as const) {
    $(id)?.addEventListener("click", async () => {
      const status = $("org-billing-status");
      status.classList.remove("error");
      status.textContent = "Opening Stripe…";
      try {
        location.href = (await orgAction<{ url: string }>(action)).url;
      } catch (err) {
        status.textContent = (err as Error).message;
        status.classList.add("error");
      }
    });
  }

  $("org-export").addEventListener("click", async () => {
    const status = $("org-export-status");
    status.textContent = "Preparing…";
    try {
      const data = await orgAction<object>("org-export");
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const day = new Date().toISOString().slice(0, 10);
      const a = Object.assign(document.createElement("a"), { href: url, download: `${info!.name.replace(/[^\w .-]+/g, "_")} export ${day}.json` });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      status.textContent = "";
    } catch (err) {
      status.textContent = (err as Error).message;
      status.classList.add("error");
    }
  });

  $("org-delete")?.addEventListener("click", async () => {
    const ok = await confirmTyped({
      title: "Delete organization",
      body: `This permanently deletes ${info!.name}: every RFP review, comparison, project, consultant, schedule, fee and stored PDF. It can't be undone.`,
      name: info!.name,
      confirm: "Delete everything",
    });
    if (!ok) return;
    try {
      await orgAction("org-delete", { name: info!.name });
    } catch (err) {
      return noticeModal("Couldn't delete", (err as Error).message);
    }
    await signOut();
    history.replaceState(null, "", location.pathname);
    location.reload();
  });
}
