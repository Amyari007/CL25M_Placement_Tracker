// HTTP helpers shared by the edge functions (also imported by Node tests).

// deno-lint-ignore no-explicit-any
const denoEnv = (globalThis as any).Deno?.env as { get(k: string): string | undefined } | undefined;
export const getEnv = (k: string): string | undefined => denoEnv?.get(k);

const allowed = (getEnv('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  // In production set ALLOWED_ORIGINS to your site's URL(s).
  const allow = allowed.length === 0 ? '*' : allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Expose-Headers': 'content-disposition, retry-after',
    Vary: 'Origin',
  };
}

export function json(req: Request, body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, private',
      'Pragma': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });
}

export function preflight(req: Request): Response | null {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, { error: 'method_not_allowed' }, 405);
  return null;
}

export function env(name: string): string {
  const v = getEnv(name);
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export function clientIp(req: Request): string {
  return (
    req.headers.get('cf-connecting-ip') ??
    req.headers.get('x-real-ip') ??
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

export function userAgent(req: Request): string {
  return (req.headers.get('user-agent') ?? '').slice(0, 300);
}

/** Random request id for correlating a response with its audit events. */
export function requestId(): string {
  const b = crypto.getRandomValues(new Uint8Array(9));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
