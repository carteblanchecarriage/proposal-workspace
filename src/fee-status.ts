// A fee is a draft until the team marks it final. Shown as a banner on the fee workspace and on the project page's
// Fee card; editing a final fee makes it a draft again, so "Final" always means the numbers haven't changed since.

import { confirmModal } from "./modal";
import type { SavedFee } from "./store";
import { dateText } from "../lib/format";

export const isFinal = (f: SavedFee) => f.status === "final";

/** The banner: Draft with "Mark as final", or Final (and when) with "Back to draft". compact for the project card. */
export function feeStatusHtml(f: SavedFee, compact = false): string {
  return isFinal(f)
    ? `<div class="fee-state final${compact ? " compact" : ""}" role="status">
        <span><b>Final</b>${f.finalAt ? ` · marked final ${dateText(f.finalAt)}` : ""}</span>
        <button class="link" data-fee-draft="${f.id}">Back to draft</button>
      </div>`
    : `<div class="fee-state draft${compact ? " compact" : ""}" role="status">
        <span><b>Draft</b>${compact ? "" : " · the numbers may still change"}</span>
        <button class="btn" data-fee-final="${f.id}">Mark as final</button>
      </div>`;
}

/** Marks a fee final or back to draft, asking first either way; resolves the changed fee, or null if cancelled. */
export async function setFeeStatus(f: SavedFee, status: "draft" | "final"): Promise<SavedFee | null> {
  if (status === "final") {
    const ok = await confirmModal({
      title: "Mark this fee final?",
      body: "It shows as Final on the project and in the fee workspace. Editing it later makes it a draft again.",
      confirm: "Mark as final",
    });
    if (!ok) return null;
    return { ...f, status: "final", finalAt: Date.now() };
  }
  // Going back to draft is a deliberate step too, so a stray click can't undo "Final".
  const ok = await confirmModal({
    title: "Make this fee a draft again?",
    body: "It will show as Draft on the project and in the fee workspace until someone marks it final again.",
    confirm: "Back to draft",
  });
  if (!ok) return null;
  const { finalAt: _, ...rest } = f;
  return { ...rest, status: "draft" };
}
