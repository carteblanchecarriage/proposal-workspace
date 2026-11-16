import { AsyncLocalStorage } from "node:async_hooks";
import type { Usage } from "./cost.js";
import { setFileHook, setUsageHook } from "./usage-hook.js";

/**
 * Who a request is for, available anywhere while it's handled (set by route() in lib/auth.ts). Lets deep code (the
 * Claude helpers, the world-view loader) know the organization without passing it through every call.
 */
export type RequestContext = {
  userId: string | null;
  email: string | null;
  /** null when login is off (local dev without Supabase Auth): nothing is saved to the database then. */
  orgId: string | null;
  endpoint: string;
  /** Usage records being written; route() waits for them before answering. */
  pending: Promise<unknown>[];
};

const store = new AsyncLocalStorage<RequestContext>();

export const runWithContext = <T>(ctx: RequestContext, fn: () => Promise<T>) => store.run(ctx, fn);
export const requestContext = () => store.getStore() ?? null;

type UsageSink = (ctx: RequestContext, usage: Usage) => Promise<unknown>;
let sink: UsageSink | null = null;
/** Set by lib/auth.ts, which knows where usage is stored (kept separate so lib/claude.ts needn't import the db). */
export const setUsageSink = (fn: UsageSink) => (sink = fn);

type FileSink = (ctx: RequestContext, fileId: string) => Promise<unknown>;
let fileSink: FileSink | null = null;
/** Set by lib/auth.ts: where an uploaded PDF's owner is recorded. */
export const setFileSink = (fn: FileSink) => (fileSink = fn);

// Every PDF uploaded to Anthropic (lib/claude.ts → uploadPdf) is recorded as the request's organization's.
setFileHook(async (fileId) => {
  const ctx = store.getStore();
  if (ctx?.orgId && fileSink) await fileSink(ctx, fileId);
});

// Every Claude response (lib/claude.ts → usageOf) charges its tokens to the request's organization.
setUsageHook((usage: Usage) => {
  const ctx = store.getStore();
  if (!ctx?.orgId || !sink) return;
  ctx.pending.push(sink(ctx, usage).catch((err) => console.error("[usage] couldn't record:", (err as Error).message)));
});
