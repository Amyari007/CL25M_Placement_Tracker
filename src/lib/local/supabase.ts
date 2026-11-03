// Offline build: there is no server. Kept so shared imports resolve.
import { ApiError } from '../errors';
export { ApiError, friendlyError } from '../errors';
export const SUPABASE_URL = undefined;
export const SUPABASE_ANON_KEY = undefined;
export const isConfigured = true;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const supabase: any = null;
export async function callFunction(): Promise<Response> {
  throw new ApiError('Not available in the offline version.', 400);
}
