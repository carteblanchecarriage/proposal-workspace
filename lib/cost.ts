// Shared by server and browser: Claude API pricing and cost math. No SDK imports.

/** US$ per million tokens, Anthropic list prices (Oct 2026). Update here if pricing changes. */
const PRICES: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  // The Schedule Assistant (lib/schedule-ai.ts).
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  // Possible server-side fallback model if a request is declined.
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

const priceFor = (model: string) => PRICES[Object.keys(PRICES).find((k) => model.startsWith(k)) ?? ""];

export function costOf(u: Omit<Usage, "cost_usd">): number | null {
  const p = priceFor(u.model);
  if (!p) return null;
  return (
    (u.input_tokens * p.input + u.output_tokens * p.output + u.cache_write_tokens * p.cacheWrite + u.cache_read_tokens * p.cacheRead) /
    1e6
  );
}

/** An AI cost for people: "$0.07", or "<$0.01" for a fraction of a cent. */
export function usd(n: number): string {
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}
