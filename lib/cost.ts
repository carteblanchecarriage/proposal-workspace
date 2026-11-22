// Shared by server and browser: Claude API pricing and cost math. No SDK imports.

/** US$ per million tokens, Anthropic list prices (Oct 2026). Update here if pricing changes. */
const PRICES: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  // The Schedule Assistant (lib/schedule-ai.ts).
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  // Fallback models (lib/ai-fallback.ts): when the main model is down or overloaded, or declines a request.
  "claude-opus-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
};

export type Usage = {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  /** null when the serving model isn't in the price table */
  cost_usd: number | null;
};

/**
 * A model's price. The API may report a longer, dated name (claude-opus-5-5-20261001), so names match by their start,
 * and the longest match wins: "claude-opus-5-5" must never be priced as "claude-opus-5".
 */
const priceFor = (model: string) => {
  const key = Object.keys(PRICES)
    .filter((k) => model === k || model.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? PRICES[key] : undefined;
};

export function costOf(u: Omit<Usage, "cost_usd">): number | null {
  const p = priceFor(u.model);
  if (!p) return null;
  return (
    (u.input_tokens * p.input + u.output_tokens * p.output + u.cache_write_tokens * p.cacheWrite + u.cache_read_tokens * p.cacheRead) /
    1e6
  );
}
