import { it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { sha256Hex } from '../src/lib/local/sha256';
it('matches node sha256', () => {
  for (const s of ['', 'abc', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(1000), 'salt:3732 ✓']) expect(sha256Hex(s)).toBe(createHash('sha256').update(s).digest('hex'));
});
