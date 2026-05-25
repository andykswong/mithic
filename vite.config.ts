import { readdirSync, statSync } from 'fs';
import { resolve } from 'path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

function findEntries(dir: string, base = ''): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const file of readdirSync(dir)) {
    const fullPath = resolve(dir, file);
    if (statSync(fullPath).isDirectory()) {
      Object.assign(entries, findEntries(fullPath, `${base}${file}/`));
    } else if (file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.d.ts')) {
      const name = `${base}${file.replace(/\.ts$/, '')}`;
      entries[name] = fullPath;
    }
  }
  return entries;
}

export default defineConfig({
  plugins: [
    dts({
      tsconfigPath: './tsconfig.json',
      exclude: ['**/*.test.ts']
    }),
  ],
  build: {
    lib: {
      entry: findEntries(resolve(process.cwd(), 'src')),
      formats: ['es'],
    },
    outDir: 'dist',
    sourcemap: true,
    minify: true,
    rollupOptions: {
      external: (id) => !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0'),
      output: {
        preserveModules: true,
        preserveModulesRoot: 'src',
        entryFileNames: '[name].js',
      },
    },
  },
});
