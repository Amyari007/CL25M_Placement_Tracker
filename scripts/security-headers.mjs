/**
 * Writes Netlify's _headers file for the single-file web build, with a
 * Content-Security-Policy that allows exactly the inline app script (by
 * hash), the Supabase project, and nothing else.
 *
 *   node scripts/security-headers.mjs dist-web https://<project>.supabase.co
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function cspFor(html, supabaseUrl) {
  const hashes = [];
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    if (m[1].length) hashes.push(`'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  }
  const api = new URL(supabaseUrl);
  const ws = `wss://${api.host}`;
  return [
    "default-src 'none'",
    `script-src ${hashes.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${api.origin} ${api.protocol === 'https:' ? ws : `ws://${api.host}`}`,
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

export function headersFile(html, supabaseUrl) {
  return `/*
  Content-Security-Policy: ${cspFor(html, supabaseUrl)}
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
  Cross-Origin-Opener-Policy: same-origin
  Strict-Transport-Security: max-age=31536000
  Cache-Control: no-cache
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, url] = process.argv.slice(2);
  if (!dir || !url) {
    console.error('usage: node scripts/security-headers.mjs <dist dir> <supabase url>');
    process.exit(1);
  }
  const html = readFileSync(path.join(dir, 'index.html'), 'utf8');
  writeFileSync(path.join(dir, '_headers'), headersFile(html, url));
  console.log(`wrote ${path.join(dir, '_headers')}`);
}
