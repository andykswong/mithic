#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { transpileToFiles } from './transpile.ts';
import { ASYNC_WASI_EXPORTS, ASYNC_WASI_IMPORTS } from './async-imports.ts';
import type { TranspileToFilesOptions } from './transpile.ts';

function printUsage(): void {
  console.log(`Usage: wasm-transpile <component.wasm> [options]

Transpile a WASM component into JS + core WASM modules.

Options:
  -o, --out-dir <dir>       Output directory (default: ./dist)
  -n, --name <name>         Module name (default: derived from filename)
  --minify                  Minify generated JS (default: true)
  --no-minify               Disable minification
  --variants <list>         Comma-separated variants: sync,jspi,asyncify (default: sync)
  --asyncify-pages <n>      Secondary memory pages for asyncify (default: 1, 64KB each)
  -q, --quiet               Suppress progress output
  -h, --help                Show this help

Examples:
  wasm-transpile component.wasm -o ./out
  wasm-transpile component.wasm -o ./out --variants sync,jspi,asyncify --asyncify-pages 4
  wasm-transpile component.wasm -o ./out --variants jspi`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'out-dir': { type: 'string', short: 'o' },
      'name': { type: 'string', short: 'n' },
      'no-minify': { type: 'boolean', default: false },
      'variants': { type: 'string' },
      'asyncify-pages': { type: 'string' },
      'quiet': { type: 'boolean', short: 'q', default: false },
      'help': { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    printUsage();
    process.exit(values.help ? 0 : 1);
  }

  const input = resolve(positionals[0]);
  const quiet = values.quiet as boolean;
  const log = quiet ? () => {} : console.log;

  log(`Reading component: ${input}`);
  const component = new Uint8Array(await readFile(input));

  const variantStr = (values.variants as string) || 'sync';
  const variants = variantStr.split(',').map(v => v.trim()) as Array<'sync' | 'jspi' | 'asyncify'>;

  const valid = new Set(['sync', 'jspi', 'asyncify']);
  for (const v of variants) {
    if (!valid.has(v)) {
      console.error(`Invalid variant: ${v}. Must be one of: sync, jspi, asyncify`);
      process.exit(1);
    }
  }

  const opts: TranspileToFilesOptions = {
    name: (values.name as string) ?? basename(input, '.wasm'),
    outputDir: resolve((values['out-dir'] as string) ?? './dist'),
    minify: !values['no-minify'],
    variants,
    asyncImports: ASYNC_WASI_IMPORTS,
    asyncExports: ASYNC_WASI_EXPORTS,
  };

  if (variants.includes('asyncify')) {
    opts.asyncifyPages = parseInt(values['asyncify-pages'] as string, 10) || 1;
  }

  log(`Transpiling variants: ${variants.join(', ')}...`);
  await transpileToFiles(component, opts);
  log(`Done. Output: ${opts.outputDir}`);
}

main().catch((err: Error) => {
  console.error(err.message ?? err);
  process.exit(1);
});
