// The admin inbox (lib/admin.ts): access requests and feedback, and inviting or declining a request. The database and
// Supabase's invite endpoint are simulated: no email is ever sent.
import { beforeEach, describe, expect, it, vi } from "vitest";

const rows: Record<string, unknown[]> = {};
const query = vi.fn(async (path: string, init?: RequestInit) => {
  if (init?.method === "PATCH") return null;
  return rows[path.split("?")[0]] ?? [];
});
vi.mock("../lib/db.js", () => ({ query: (path: string, init?: RequestInit) => query(path, init) }));

const { adminInbox, inviteRequest, setRequestStatus } = await import("../lib/admin");

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

beforeEach(() => {
  query.mockClear();
  vi.unstubAllGlobals();
  vi.stubEnv("SUPABASE_URL", "https://project.supabase.co/rest/v1");
  vi.stubEnv("SUPABASE_SECRET_KEY", "test-key");
  vi.spyOn(console, "error").mockImplementation(() => {});
  rows.access_requests = [
    { id: ID, name: "Dana", email: "dana@example.com", firm: "Studio", note: "Saw a demo", status: "new", created_at: "2026-11-22T10:00:00Z" },
    { id: "a", name: "Lee", email: "lee@example.com", firm: null, note: null, status: "weird", created_at: "2026-11-20T10:00:00Z" },
  ];
  rows.feedback = [
    { id: "f1", message: "Love the fee table", tab: "fee", user_email: "pm@firm.com", org_id: "o1", created_at: "2026-11-22T09:00:00Z" },
    { id: "f2", message: "Bug?", tab: null, user_email: null, org_id: null, created_at: "2026-11-21T09:00:00Z" },
  ];
  rows.organizations = [{ id: "o1", name: "Firm" }];
});

describe("adminInbox", () => {
  it("lists requests and feedback, with blanks for missing fields and the sender's organization", async () => {
    const { requests, feedback } = await adminInbox();
    expect(requests[0]).toEqual({ id: ID, name: "Dana", email: "dana@example.com", firm: "Studio", note: "Saw a demo", status: "new", createdAt: "2026-11-22T10:00:00Z" });
    expect(requests[1]).toMatchObject({ firm: "", note: "", status: "new" }); // an unknown status reads as new
    expect(feedback).toEqual([
      { id: "f1", message: "Love the fee table", page: "fee", email: "pm@firm.com", orgName: "Firm", createdAt: "2026-11-22T09:00:00Z" },
      { id: "f2", message: "Bug?", page: "", email: "", orgName: "", createdAt: "2026-11-21T09:00:00Z" },
    ]);
  });
});

describe("setRequestStatus", () => {
  it("saves a valid status", async () => {
    await setRequestStatus(ID, "declined");
    expect(query).toHaveBeenCalledWith(`access_requests?id=eq.${ID}`, expect.objectContaining({ method: "PATCH", body: JSON.stringify({ status: "declined" }) }));
  });

  it.each([
    ["an unknown status", ID, "approved"],
    ["a malformed id (no query injection)", "x&status=eq.new", "invited"],
    ["no id", undefined, "invited"],
  ])("refuses %s", async (_, id, status) => {
    await expect(setRequestStatus(id, status)).rejects.toThrow("Unknown request or status.");
    expect(query).not.toHaveBeenCalled();
  });
});

describe("inviteRequest", () => {
  it("asks Supabase to invite the email, back to this site, then marks the request invited", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(inviteRequest(ID, "https://app.example.com")).resolves.toEqual({ alreadyHadAccount: false });
    expect(fetch).toHaveBeenCalledWith(
      "https://project.supabase.co/auth/v1/invite?redirect_to=https%3A%2F%2Fapp.example.com",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ email: "dana@example.com" }) }),
    );
    expect(query).toHaveBeenCalledWith(`access_requests?id=eq.${ID}`, expect.objectContaining({ body: JSON.stringify({ status: "invited" }) }));
  });

  it("someone who already has an account is marked invited, and the page is told", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"msg":"A user with this email address has already been registered"}', { status: 422 })));
    await expect(inviteRequest(ID, "https://app.example.com")).resolves.toEqual({ alreadyHadAccount: true });
  });

  it("a failed invite says so, and leaves the request as it was", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));
    await expect(inviteRequest(ID, "https://app.example.com")).rejects.toThrow(/Too many invites/);
    expect(query).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: "PATCH" }));
  });

  it("refuses a request that doesn't exist", async () => {
    rows.access_requests = [];
    vi.stubGlobal("fetch", vi.fn());
    await expect(inviteRequest(ID, "https://app.example.com")).rejects.toThrow(/no longer exists/);
  });
});

const { setOrgAllowance, pendingInvites, resendInvite, MAX_ALLOWANCE_USD } = await import("../lib/admin");

describe("setOrgAllowance", () => {
  it.each([
    [20, 20],
    [12.345, 12.35],
    [0, 0],
    [null, null],
  ])("saves %s as %s", async (usd, saved) => {
    await expect(setOrgAllowance(ID, usd)).resolves.toBe(saved);
    expect(query).toHaveBeenCalledWith(`organizations?id=eq.${ID}`, expect.objectContaining({ method: "PATCH", body: JSON.stringify({ ai_monthly_limit_usd: saved }) }));
  });

  it.each([
    ["a negative amount", -1],
    ["more than the cap (a typo guard)", MAX_ALLOWANCE_USD + 1],
    ["text", "20"],
    ["not a number", NaN],
  ])("refuses %s", async (_, usd) => {
    await expect(setOrgAllowance(ID, usd)).rejects.toThrow(/allowance is \$0/);
    expect(query).not.toHaveBeenCalled();
  });

  it("refuses an unknown organization", async () => {
    await expect(setOrgAllowance("not-an-id", 10)).rejects.toThrow("Unknown organization.");
  });
});

describe("pendingInvites", () => {
  const user = (id: string, over: object) => ({ id, email: `${id}@example.com`, invited_at: null, last_sign_in_at: null, ...over });

  it("lists people invited who haven't signed in, longest waiting first, across pages", async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => user(`u${i}`, { last_sign_in_at: "2026-11-01T00:00:00Z", invited_at: "2026-10-01T00:00:00Z" }));
    page1[5] = user("waiting-new", { invited_at: "2026-11-20T00:00:00Z" });
    const page2 = [user("waiting-old", { invited_at: "2026-11-02T00:00:00Z" }), user("self-signup", {})];
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify({ users: url.includes("page=1&") ? page1 : page2 })));
    vi.stubGlobal("fetch", fetch);
    expect((await pendingInvites()).map((i) => i.email)).toEqual(["waiting-old@example.com", "waiting-new@example.com"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("says so when Supabase can't be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    await expect(pendingInvites()).rejects.toThrow(/Couldn't read the invited people/);
  });
});

describe("resendInvite", () => {
  it("asks Supabase to send a fresh invite", async () => {
    const fetch = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    await resendInvite("dana@example.com", "https://app.example.com");
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/auth/v1/invite?redirect_to="), expect.objectContaining({ body: JSON.stringify({ email: "dana@example.com" }) }));
  });

  it("explains what to do when Supabase won't resend", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("exists", { status: 422 })));
    await expect(resendInvite("dana@example.com", "https://app.example.com")).rejects.toThrow(/delete this person under Authentication/);
  });

  it("refuses something that isn't an email", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(resendInvite("not an email", "https://app.example.com")).rejects.toThrow("Unknown email.");
  });
});
