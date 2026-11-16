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

export async function post<T>(url: string, body: BodyInit, headers: Record<string, string>): Promise<T> {
  if (blockedInDemo()) throw Object.assign(new Error("That works once you create an account."), { status: 0, demo: true });
  const send = async () => fetch(url, { method: "POST", body, headers: { ...headers, ...(await authHeaders()) } });
  let res = await send();
  // A stale token: renew it quietly and try once more before asking the person to sign in.
  if (res.status === 401 && (await refreshAuth())) res = await send();
  if (res.status === 401) onUnauthorized();
  const data = await res.json().catch(() => ({ error: `Server returned ${res.status}` }));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Server returned ${res.status}`), { status: res.status });
  return data as T;
}

/** Sends a PDF's raw bytes. */
export const postPdf = <T>(url: string, file: File) =>
  post<T>(url, file, { "content-type": "application/pdf", "x-filename": encodeURIComponent(file.name) });
