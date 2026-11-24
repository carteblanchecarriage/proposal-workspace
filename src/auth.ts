// Only Supabase's sign-in part: records go through this app's own server, so the rest of its library isn't needed.
import { AuthClient } from "@supabase/auth-js";

// Supabase Auth in the browser. The server tells the page whether login is on and gives it the project's public
// URL and publishable key (GET /api/auth), so there's one place to configure it. The session lives in localStorage
// and refreshes itself; every API call sends its access token.

let client: { auth: InstanceType<typeof AuthClient> } | null = null;
/** The current access token, kept in step with the session (read synchronously for saves sent as the page closes). */
let token = "";
/** Set when the page was opened from a password-reset email: the person should choose a new password. */
let recovering = false;
/** Set when the page was opened from an emailed link that didn't work (expired, used, or opened in another browser). */
let linkProblem: string | null = null;
export const emailLinkProblem = () => linkProblem;

export const authEnabled = () => !!client;

let inviteOnlyFlag = false;
/** Sign-ups are invite-only (the server's setting): the page offers no "Create an account". */
export const isInviteOnly = () => inviteOnlyFlag;

/** Fetches the login settings and restores any saved session. Returns false when login is off. */
export async function initAuth(): Promise<boolean> {
  const res = await fetch("/api/auth");
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  const { auth, inviteOnly } = (await res.json()) as { auth: { url: string; publishableKey: string } | null; inviteOnly?: boolean };
  inviteOnlyFlag = !!inviteOnly && !!auth;
  if (!auth) return false;
  // Invite emails sent from the Supabase dashboard come back with the session in the #fragment
  // (#access_token=…&refresh_token=…&type=invite), not the ?code=… this app's own links use. Taken out of the address
  // before anything reads it as a page name.
  const fragment = new URLSearchParams(location.hash.slice(1));
  // An emailed link (sign-in, password reset) comes back as ?code=…, or as ?error=… when Supabase refused it.
  const query = new URLSearchParams(location.search);
  const cameWithCode = query.has("code");
  const linkError = query.get("error_description") ?? fragment.get("error_description");
  if (query.has("error") || query.has("error_description")) history.replaceState(null, "", location.pathname + location.hash);
  const linked = fragment.get("access_token") && fragment.get("refresh_token")
    ? { access_token: fragment.get("access_token")!, refresh_token: fragment.get("refresh_token")!, type: fragment.get("type") }
    : null;
  if (linked || fragment.get("error_description")) history.replaceState(null, "", location.pathname + location.search);
  client = {
    auth: new AuthClient({
      url: `${auth.url}/auth/v1`,
      headers: { apikey: auth.publishableKey, Authorization: `Bearer ${auth.publishableKey}` },
      // Where Supabase's full library keeps the sign-in, so people stay signed in.
      storageKey: `sb-${new URL(auth.url).hostname.split(".")[0]}-auth-token`,
      // PKCE: sign-in links come back as ?code=… (not a #fragment), so they don't collide with the app's #tab routes.
      flowType: "pkce",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    }),
  };
  client.auth.onAuthStateChange((event, session) => {
    token = session?.access_token ?? "";
    if (event === "PASSWORD_RECOVERY") recovering = true;
  });
  if (linked) {
    const { data: set } = await client.auth.setSession({ access_token: linked.access_token, refresh_token: linked.refresh_token });
    // An invited person (or a password reset) chooses their password first.
    if (set.session && (linked.type === "invite" || linked.type === "recovery")) recovering = true;
  }
  const { data } = await client.auth.getSession();
  token = data.session?.access_token ?? "";
  // Supabase announces a password-reset link a moment after the session is in (on a timer), so wait for that turn;
  // otherwise the page goes straight in and never asks for the new password.
  if (cameWithCode) await new Promise((r) => setTimeout(r, 0));
  if (linkError) linkProblem = linkError;
  else if (cameWithCode && !token) {
    linkProblem = "That link didn't work. It may have expired or been used already, or been opened in a different browser from the one you asked for it in. Ask for a new one here.";
    history.replaceState(null, "", location.pathname + location.hash); // a reload doesn't try it again
  }
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
    options: { shouldCreateUser: false, emailRedirectTo: returnTo() },
  });
  return error ? error.message : null;
}

export const isRecovering = () => recovering;
/** After a link problem has been shown once. */
export const clearEmailLinkProblem = () => (linkProblem = null);

/** Back to this page after an emailed link (sign-up confirmation, sign-in, password reset). */
const returnTo = () => location.origin + location.pathname;

/** Creates an account. Returns an error, or whether the person must confirm their email before signing in. */
export async function signUp(email: string, password: string): Promise<{ error: string | null; confirm: boolean }> {
  const { data, error } = await client!.auth.signUp({ email, password, options: { emailRedirectTo: returnTo() } });
  if (error) return { error: error.message, confirm: false };
  return { error: null, confirm: !data.session };
}

export async function sendPasswordReset(email: string): Promise<string | null> {
  const { error } = await client!.auth.resetPasswordForEmail(email, { redirectTo: returnTo() });
  return error ? error.message : null;
}

export async function setNewPassword(password: string): Promise<string | null> {
  const { error } = await client!.auth.updateUser({ password });
  if (!error) recovering = false;
  return error ? error.message : null;
}

export async function signOut(): Promise<void> {
  await client?.auth.signOut();
  token = "";
}
