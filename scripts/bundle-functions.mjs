/**
 * Bundles each Edge Function (index.ts + _shared imports) into ONE file
 * that can be pasted into the Supabase dashboard editor.
 *   node scripts/bundle-functions.mjs   ->  deploy/functions/<name>.ts
 * (deploy/ is git-ignored.)
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const functions = ['student-login', 'staff-login', 'admin-export', 'admin-credentials', 'admin-team', 'coordinator-api'];

for (const fn of functions) {
  await build({
    entryPoints: [`${root}/supabase/functions/${fn}/index.ts`],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    outfile: `${root}/deploy/functions/${fn}.ts`,
    plugins: [{ name: 'npm-external', setup(b) { b.onResolve({ filter: /^npm:/ }, (a) => ({ path: a.path, external: true })); } }],
    banner: { js: `// ${fn}: bundled single file for the Supabase dashboard editor` },
    legalComments: 'none',
  });
}
console.log(`bundled ${functions.length} functions into deploy/functions/`);
