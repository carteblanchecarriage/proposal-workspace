// Shared by every tab: POSTs to /api/* with the signed-in user's token, and throws the server's readable error message.
import { authHeaders, refreshAuth } from "./auth";
import { isDemo } from "./store";

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);
/** Shows the sign-in form again; for callers that make their own requests. */
export const unauthorized = () => onUnauthorized();

// In the demo nothing reaches the server (no AI, no uploads): the page offers an account instead.
let onDemoBlocked = () => {};
export const setDemoBlockedHandler = (fn: () => void) => (onDemoBlocked = fn);
/** True (after offering an account) when the demo is on, so the caller should stop. */
export function blockedInDemo(): boolean {
  if (!isDemo()) return false;
  onDemoBlocked();
  return true;
}

/**
 * What to say when a response has no message of its own: the hosting platform's own error pages (a request cut off
 * at its time limit, a crashed function, a file too large to send) aren't the app's JSON.
 */
export const PLATFORM_ERRORS: Record<number, string> = {
  413: "That file is too large to send. Try a smaller file, or leave out pages you don't need.",
  502: "The server had a problem. Try again in a minute.",
  503: "The server is busy or restarting. Try again in a minute.",
  504: "This took longer than the server allows (5 minutes). Try again; for a long document, leave out pages you don't need.",
};
export const OFFLINE = "Couldn't reach the server. Check your connection and try again.";

export async function post<T>(url: string, body: BodyInit, headers: Record<string, string>): Promise<T> {
  if (blockedInDemo()) throw Object.assign(new Error("That works once you create an account."), { status: 0, demo: true });
  const send = async () => {
    try {
      return await fetch(url, { method: "POST", body, headers: { ...headers, ...(await authHeaders()) } });
    } catch {
      // No response at all: offline, or the connection dropped. Never retried here: an AI request may already be
      // running (and charged), so the person decides whether to try again.
      throw Object.assign(new Error(OFFLINE), { status: 0 });
    }
  };
  let res = await send();
  // A stale token: renew it quietly and try once more before asking the person to sign in.
  if (res.status === 401 && (await refreshAuth())) res = await send();
  if (res.status === 401) onUnauthorized();
  const fallback = PLATFORM_ERRORS[res.status] ?? `Server returned ${res.status}`;
  const data = await res.json().catch(() => ({ error: fallback }));
  if (!res.ok) throw Object.assign(new Error(data.error ?? fallback), { status: res.status });
  return data as T;
}

/** POSTs a JSON body; action picks the job on endpoints that do several (the x-action header). */
export const postJson = <T>(url: string, body: unknown, action?: string) =>
  post<T>(url, JSON.stringify(body), { "content-type": "application/json", ...(action ? { "x-action": action } : {}) });

/** Sends a PDF's raw bytes. */
export const postPdf = <T>(url: string, file: File) =>
  post<T>(url, file, { "content-type": "application/pdf", "x-filename": encodeURIComponent(file.name) });
