// The browser's requests (src/api.ts): what people see when the server, the platform or the connection fails.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/auth", () => ({ authHeaders: async () => ({}), refreshAuth: async () => false }));
vi.mock("../src/store", () => ({ isDemo: () => false }));
const { OFFLINE, PLATFORM_ERRORS, postJson } = await import("../src/api");

const reply = (status: number, body: string, type = "application/json") => new Response(body, { status, headers: { "content-type": type } });

describe("postJson", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("returns the answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(200, '{"ok":true}')));
    await expect(postJson("/api/x", {})).resolves.toEqual({ ok: true });
  });

  it("shows the app's own error message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(429, '{"error":"The AI service is busy. Wait a minute and try again."}')));
    await expect(postJson("/api/x", {})).rejects.toMatchObject({ message: "The AI service is busy. Wait a minute and try again.", status: 429 });
  });

  it.each([413, 502, 503, 504])("explains the platform's own %s page in plain words", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(status, "<html>An error occurred</html>", "text/html")));
    await expect(postJson("/api/x", {})).rejects.toMatchObject({ message: PLATFORM_ERRORS[status], status });
  });

  it("a lost connection says so, and isn't retried (an AI request may already be running)", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetch);
    await expect(postJson("/api/x", {})).rejects.toMatchObject({ message: OFFLINE, status: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
