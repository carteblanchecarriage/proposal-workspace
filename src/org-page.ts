import { post } from "./api";
import { confirmTyped, noticeModal } from "./modal";
import { setOrgName } from "./org";
import { signOut } from "./auth";
import { isDemo } from "./store";
import { esc } from "./table";

// The organization page: name, who's signed in to it, this month's AI use, export, and delete. Kept simple on
// purpose: no roles to manage or invites (a firm may well share one login). The owner renames and deletes.

type Info = {
  name: string;
  joinDomain: string | null;
  plan: string;
  createdAt: string;
  aiLimitUsd: number | null;
  aiSpentUsd: number;
  you: string | null;
  people: { email: string | null; role: string; you: boolean }[];
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const orgAction = <T>(action: string, body: object = {}) => post<T>("/api/auth", JSON.stringify(body), { "content-type": "application/json", "x-action": action });

let info: Info | null = null;

export async function showOrg() {
  const page = $("org-page");
  if (isDemo()) {
    page.innerHTML = `
      <h1 class="headline">Demo Architects</h1>
      <p class="wv-intro">In your own account, this page is where you rename your organization, see who's in it and this month's AI use, download all your data, or delete the organization.</p>`;
    return;
  }
  page.innerHTML = `<h1 class="headline">Organization</h1><span class="status">Loading…</span>`;
  try {
    info = await orgAction<Info>("org-info");
  } catch (err) {
    page.innerHTML = `<h1 class="headline">Organization</h1><span class="status error">${esc((err as Error).message)}</span>`;
    return;
  }
  render();
}

function render() {
  if (!info) return;
  const owner = info.you === "owner";
  const limit = info.aiLimitUsd;
  const usage =
    limit == null
      ? `${usd(info.aiSpentUsd)} this month (no limit)`
      : limit === 0
        ? "AI features aren't turned on for this organization yet."
        : `${usd(info.aiSpentUsd)} of ${usd(limit)} this month`;
  $("org-page").innerHTML = `
    <h1 class="headline">${esc(info.name)}</h1>
    <p class="wv-intro">Your organization: everything saved in the app belongs to it.</p>

    <div class="block">
      <h2 class="label">Name</h2>
      ${
        owner
          ? `<form id="org-rename" class="org-row"><input id="org-name-input" type="text" maxlength="120" value="${esc(info.name)}" aria-label="Organization name" /><button class="btn" type="submit">Save</button><span class="status" id="org-rename-status"></span></form>`
          : `<p>${esc(info.name)} <span class="org-muted">(the owner can change it)</span></p>`
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

  $("org-rename")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = $("org-rename-status");
    const name = $<HTMLInputElement>("org-name-input").value.trim();
    if (!name || name === info!.name) return;
    status.textContent = "Saving…";
    try {
      await orgAction("org-rename", { name });
      info!.name = name;
      setOrgName(name);
      $("org-name").textContent = name;
      render();
    } catch (err) {
      status.textContent = (err as Error).message;
      status.classList.add("error");
    }
  });

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
