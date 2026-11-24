// Errors with a message meant for people. In its own module, without the AI library, so that the functions that only
// load and save records start quickly (lib/claude.ts is large).

export class UserFacingError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/** Any thrown error as a JSON response with a readable message. The AI library is loaded only to read one of its errors. */
export async function errorResponse(err: unknown): Promise<Response> {
  if (err instanceof UserFacingError) {
    console.error(`[api] ${err.status}: ${err.message}`);
    return Response.json({ error: err.message }, { status: err.status });
  }
  return (await import("./claude.js")).errorResponse(err);
}
