import Anthropic from "@anthropic-ai/sdk";

// What happens when an AI call fails. The SDK already retries each call twice (overload, rate limits, server errors,
// dropped connections). If the model still fails, the request is tried once more on a fallback model, so an outage
// or overload of one model doesn't stop the app. Never for a request the API rejected (bad request, refusal), and
// never for a timeout: a second slow attempt couldn't finish before Vercel stops the request (5 minutes).

/** Each model the app calls, and the model it falls back to. Both must be priced (lib/cost.ts); a test checks. */
export const FALLBACK_MODEL: Record<string, string> = {
  // The main features: the previous Opus, which takes the same requests (effort, structured outputs, web fetch).
  "claude-opus-5-5": "claude-opus-5",
  // The project and schedule assistants: the current Sonnet.
  "claude-sonnet-4-6": "claude-sonnet-5-5",
};

/** How long Vercel lets an AI request run (vercel.json maxDuration), and the margin kept to answer in time. */
export const REQUEST_BUDGET_MS = 300_000;
const MARGIN_MS = 15_000;
/** Each AI attempt's own limit, under the request's budget, so a slow answer ends with a clear message. */
export const ATTEMPT_TIMEOUT_MS = 240_000;
/** A fallback is only worth starting with at least this long left. */
const MIN_FALLBACK_MS = 60_000;

/** Failures another model might not have: overload, server errors, rate limits, dropped connections. */
export function worthFallingBack(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return false; // too slow: no time for another attempt
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) return true;
  return err instanceof Anthropic.APIError && typeof err.status === "number" && err.status >= 500;
}

export type Attempt<T> = (model: string, options: { timeout: number; maxRetries?: number }) => Promise<T>;

type Log = { warn: (message: string) => void; error: (message: string) => void };

/**
 * Runs an AI call on its model; when that fails in a way another model might not, runs it once on the fallback, with
 * whatever time is left (and no retries of its own). If the fallback fails too, the original error is what's reported.
 * started: when the request began (for the time budget); now: a clock, for tests.
 */

export async function withFallback<T>(
  model: string,
  attempt: Attempt<T>,
  { started = Date.now(), now = Date.now, log = console as Log }: { started?: number; now?: () => number; log?: Log } = {},
): Promise<T> {
  try {
    return await attempt(model, { timeout: ATTEMPT_TIMEOUT_MS });
  } catch (err) {
    const fallback = FALLBACK_MODEL[model];
    const left = REQUEST_BUDGET_MS - MARGIN_MS - (now() - started);
    if (!fallback || !worthFallingBack(err) || left < MIN_FALLBACK_MS) throw err;
    log.warn(`[ai] ${model} failed (${describe(err)}); trying ${fallback} with ${Math.round(left / 1000)}s left`);
    try {
      return await attempt(fallback, { timeout: Math.min(ATTEMPT_TIMEOUT_MS, left), maxRetries: 0 });
    } catch (second) {
      log.error(`[ai] fallback ${fallback} failed too (${describe(second)})`);
      throw err;
    }
  }
}

const describe = (err: unknown) => (err instanceof Anthropic.APIError ? `${err.status ?? "connection"}` : (err as Error)?.name ?? "error");
