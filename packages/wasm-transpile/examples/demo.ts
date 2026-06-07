/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { installPolyfill, createInstantiateCore } from '../src/index.ts';
import { WASIShim } from '@mithic/wasip2';
import { AsyncNodeStdinHandler, AsyncNodeStdoutHandler, AsyncNodeStderrHandler } from './handlers.ts';

const { values } = parseArgs({
  options: {
    asyncify: { type: 'boolean', default: true },
  },
});
const useAsyncify = values.asyncify as boolean;

const polyfill = installPolyfill({ overrideNative: useAsyncify });

if (polyfill.installed) {
  console.log(`[demo] Asyncify polyfill installed${polyfill.overrodeNative ? ' (overriding native JSPI)' : ''}`);
} else {
  console.log('[demo] Using native JSPI');
}

const shim = new WASIShim({
  sandbox: {
    env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => v != null)) as Record<string, string>,
    args: process.argv.slice(2),
    stdin: { handler: new AsyncNodeStdinHandler() as any },
    stdout: { handler: new AsyncNodeStdoutHandler() as any },
    stderr: { handler: new AsyncNodeStderrHandler() as any },
  },
});

const distDir = join(import.meta.dirname, '../dist/example');
const entryPoint = join(distDir, 'component.js');

const { instantiate } = await import(entryPoint);
const { run } = await instantiate(
  async (path: string) => WebAssembly.compile(await readFile(join(distDir, path))),
  shim.getImportObject(),
  createInstantiateCore(),
);

const exitCode = await run.run();
process.exit(exitCode ?? 0);
