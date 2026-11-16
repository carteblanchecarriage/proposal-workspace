import type { Usage } from "./cost.js";

// Where each Claude response's usage goes. No imports beyond types: lib/claude.ts is also loaded by the browser,
// so the server-only part (lib/context.ts) plugs itself in here instead of being imported by it.
let hook: ((usage: Usage) => void) | null = null;
export const setUsageHook = (fn: (usage: Usage) => void) => (hook = fn);
export const recordUsage = (usage: Usage) => hook?.(usage);
