import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Supabase Auth in the browser. The server tells the page whether login is on and gives it the project's public
// URL and publishable key (GET /api/auth), so there's one place to configure it. The session lives in localStorage
// and refreshes itself; every API call sends its access token.

let client: SupabaseClient | null = null;
/** The current access token, kept in step with the session (read synchronously for saves sent as the page closes). */
let token = "";

export const authEnabled = () => !!client;

/** Fetches the login settings and restores any saved session. Returns false when login is off. */
export async function initAuth(): Promise<boolean> {
  const res = await fetch("/api/auth");
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  const { auth } = (await res.json()) as { auth: { url: string; publishableKey: string } | null };
  if (!auth) return false;
  client = createClient(auth.url, auth.publishableKey, {
    // PKCE: sign-in links come back as ?code=… (not a #fragment), so they don't collide with the app's #tab routes.
    auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  client.auth.onAuthStateChange((_event, session) => {
    token = session?.access_token ?? "";
  });
  const { data } = await client.auth.getSession();
  token = data.session?.access_token ?? "";
  // A sign-in link leaves ?code=… in the address; tidy it once the session is in.
  if (token && new URLSearchParams(location.search).has("code")) history.replaceState(null, "", location.pathname + location.hash);
  return true;
}

/** Headers for an API call: a fresh token (refreshed first if it has expired). */
export async function authHeaders(): Promise<Record<string, string>> {
  if (!client) return {};
  const { data } = await client.auth.getSession();
  token = data.session?.access_token ?? "";
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * Renews the session after the server said the token was no good (e.g. a laptop woke from sleep before the
 * background refresh ran). True when there's a fresh token to retry with; false means a real sign-in is needed.
 */
export async function refreshAuth(): Promise<boolean> {
  if (!client) return false;
  const { data, error } = await client.auth.refreshSession();
  token = data.session?.access_token ?? "";
  return !error && !!token;
}

/** Like authHeaders, without waiting: for requests sent while the page is closing. */
export function authHeadersNow(): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

export const hasSession = () => !!token;

export async function currentEmail(): Promise<string | null> {
  return (await client?.auth.getUser())?.data.user?.email ?? null;
}

export async function signInWithPassword(email: string, password: string): Promise<string | null> {
  const { error } = await client!.auth.signInWithPassword({ email, password });
  return error ? error.message : null;
}

/** Emails a one-time sign-in link. Only people who already have an account (invited or added) can use it. */
export async function sendSignInLink(email: string): Promise<string | null> {
  const { error } = await client!.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname },
  });
  return error ? error.message : null;
}

export async function signOut(): Promise<void> {
  await client?.auth.signOut();
  token = "";
}
