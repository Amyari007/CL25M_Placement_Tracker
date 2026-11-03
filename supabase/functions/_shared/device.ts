/**
 * Registered-device signatures (shared by the browser and the server).
 *
 * The browser creates an ECDSA P-256 key pair with WebCrypto and marks the
 * private key NON-EXTRACTABLE: page scripts can ask the browser to sign
 * with it, but cannot read or copy the key out. Only the public key is
 * sent to the server, at enrollment.
 *
 * Every protected request is signed over:
 *   cl25m-v1 | action | timestamp | nonce | session id | SHA-256(payload text)
 * so a signature works only once (nonce), only briefly (timestamp), only
 * with the same sign-in session (session id) and only for the exact payload.
 */

export const SIGNATURE_VERSION = 'cl25m-v1';
export const MAX_CLOCK_SKEW_MS = 120_000;

export interface SignedEnvelope {
  ts: number;
  nonce: string;
  sig: string;
}

export interface PublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

const te = new TextEncoder();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string) {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256b64url(text: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', te.encode(text)));
}

export async function canonical(action: string, ts: number, nonce: string, sessionId: string, payloadText: string): Promise<string> {
  return [SIGNATURE_VERSION, action, String(ts), nonce, sessionId, await sha256b64url(payloadText)].join('|');
}

/** RFC 7638 JWK thumbprint (SHA-256) of an EC public key. */
export async function jwkThumbprint(jwk: PublicJwk): Promise<string> {
  return sha256b64url(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }));
}

export function isPublicJwk(v: unknown): v is PublicJwk {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    o.kty === 'EC' &&
    o.crv === 'P-256' &&
    typeof o.x === 'string' &&
    typeof o.y === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(o.x) &&
    /^[A-Za-z0-9_-]{43}$/.test(o.y) &&
    !('d' in o)
  );
}

export function newNonce(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(18)));
}

export function envelopeShapeOk(e: unknown): e is SignedEnvelope {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.ts === 'number' &&
    Number.isFinite(o.ts) &&
    typeof o.nonce === 'string' &&
    /^[A-Za-z0-9_-]{16,64}$/.test(o.nonce) &&
    typeof o.sig === 'string' &&
    /^[A-Za-z0-9_-]{40,200}$/.test(o.sig)
  );
}

/** Verifies an ECDSA P-256 / SHA-256 signature (IEEE P1363 r||s, base64url). */
export async function verifySignature(jwk: PublicJwk, message: string, sigB64: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const sig = fromB64url(sigB64);
    if (sig.length !== 64) return false;
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, te.encode(message));
  } catch {
    return false;
  }
}

/** Signs with a (non-extractable) private key. Browser side. */
export async function signMessage(privateKey: CryptoKey, message: string): Promise<string> {
  return b64url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, te.encode(message)));
}

/** Decodes a JWT payload WITHOUT verifying it (only after the token was verified). */
export function jwtClaims(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1];
    return JSON.parse(new TextDecoder().decode(fromB64url(part)));
  } catch {
    return null;
  }
}
