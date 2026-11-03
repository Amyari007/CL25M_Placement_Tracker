import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'node:path';

/**
 * `vite build --mode offline` produces ONE self-contained HTML file that runs
 * offline: the Supabase data layer is swapped for a browser-storage one.
 */
function offlineBackend(): Plugin {
  const lib = path.resolve(__dirname, 'src/lib');
  const swap = ['supabase', 'auth', 'studentApi', 'adminApi'];
  return {
    name: 'offline-backend',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || importer.includes(`${path.sep}local${path.sep}`)) return null;
      const r = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!r) return null;
      for (const name of swap) {
        for (const ext of ['.ts', '.tsx']) {
          if (r.id === path.join(lib, name + ext)) return path.join(lib, 'local', name + ext);
        }
      }
      return null;
    },
  };
}

export default defineConfig(({ mode }) => {
  const local = mode === 'offline';
  const web = mode === 'web'; // online app as a single index.html for static hosting
  return {
    plugins: [react(), ...(local ? [offlineBackend(), viteSingleFile()] : web ? [viteSingleFile()] : [])],
    build: local || web
      ? { outDir: local ? 'dist-offline' : 'dist-web', assetsInlineLimit: 100_000_000, chunkSizeWarningLimit: 5000, cssCodeSplit: false }
      : {
          chunkSizeWarningLimit: 700,
          sourcemap: false,
          rollupOptions: { output: { manualChunks: { supabase: ['@supabase/supabase-js'] } } },
        },
  };
});
