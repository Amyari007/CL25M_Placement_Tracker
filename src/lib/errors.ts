export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

/** Turns database/network errors into short, non-revealing messages. */
export function friendlyError(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  const msg = (e as { message?: string })?.message ?? '';
  if (/fetch|network|Failed to fetch/i.test(msg)) return 'Could not reach the server. Check your connection and try again.';
  if (/JWT|expired|session/i.test(msg)) return 'Your session has expired. Please sign in again.';
  if (/limit reached|maximum 300/i.test(msg)) return 'You have reached the maximum number of applications.';
  // Validation messages written by the database for students are safe to show as-is.
  if (/look like the same company|at least one company|company name|120 characters|not a valid company name|Submit your applications/i.test(msg)) return msg;
  return 'Something went wrong while saving. Please try again.';
}
