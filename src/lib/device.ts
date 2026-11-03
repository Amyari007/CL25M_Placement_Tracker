/**
 * This browser's device key for coordinator access.
 *
 * The private key is created NON-EXTRACTABLE and kept in IndexedDB as a
 * CryptoKey object: scripts can ask the browser to sign with it but cannot
 * read the key material. Clearing site data deletes it, after which this
 * browser is no longer the registered device (the administrator must
 * approve a replacement).
 */
import { canonical, newNonce, signMessage, type PublicJwk, type SignedEnvelope } from '../../supabase/functions/_shared/device.ts';

const DB = 'cl25m-device';
const STORE = 'keys';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

interface StoredKey {
  priv: CryptoKey;
  pub: PublicJwk;
}

const slot = (userId: string) => `coordinator:${userId}`;

export async function loadDeviceKey(userId: string): Promise<StoredKey | null> {
  try {
    return (await idb<StoredKey | undefined>('readonly', (s) => s.get(slot(userId)))) ?? null;
  } catch {
    return null;
  }
}

/** Creates (or replaces) this browser's key for the account. */
export async function createDeviceKey(userId: string): Promise<StoredKey> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const stored: StoredKey = { priv: kp.privateKey, pub: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! } };
  await idb('readwrite', (s) => s.put(stored, slot(userId)));
  return stored;
}

export async function sign(key: CryptoKey, action: string, sessionId: string, payloadText: string): Promise<SignedEnvelope> {
  const ts = Date.now();
  const nonce = newNonce();
  const sig = await signMessage(key, await canonical(action, ts, nonce, sessionId, payloadText));
  return { ts, nonce, sig };
}

export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return [browser, os].filter(Boolean).join(' on ');
}
