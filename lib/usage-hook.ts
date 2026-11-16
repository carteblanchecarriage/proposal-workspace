import type { Usage } from "./cost.js";

// Where each Claude response's usage goes. No imports beyond types: lib/claude.ts is also loaded by the browser,
// so the server-only part (lib/context.ts) plugs itself in here instead of being imported by it.
let hook: ((usage: Usage) => void) | null = null;
export const setUsageHook = (fn: (usage: Usage) => void) => (hook = fn);
export const recordUsage = (usage: Usage) => hook?.(usage);

// Each PDF uploaded to Anthropic is recorded as its organization's (lib/context.ts plugs in where), so later requests
// can only use file ids their own organization uploaded.
let fileHook: ((fileId: string) => Promise<void>) | null = null;
export const setFileHook = (fn: (fileId: string) => Promise<void>) => (fileHook = fn);
export const recordFile = async (fileId: string) => fileHook?.(fileId);
