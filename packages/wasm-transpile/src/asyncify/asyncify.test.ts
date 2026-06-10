/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  installPolyfill,
  createInstantiateCore,
  asyncifyTransform,
  transpileComponent,
  ASYNC_WASI_IMPORTS,
  ASYNC_WASI_EXPORTS,
} from '../index.ts';
import { WASIShim } from '@mithic/wasip2';

const RUST_CLI_COMPONENT = join(import.meta.dirname, '../../../examples/component-rust/dist/component.wasm');

describe('asyncifyTransform', () => {
  it('instruments WASM with asyncify exports and secondary memory', async () => {
    const component = new Uint8Array(await readFile(RUST_CLI_COMPONENT));
    const result = await transpileComponent(component, {
      name: 'component',
      asyncMode: 'jspi',
      asyncImports: ASYNC_WASI_IMPORTS,
      asyncExports: ASYNC_WASI_EXPORTS,
    });

    const coreWasm = result.files.get('component.core.wasm')!;
    assert.ok(coreWasm, 'should produce component.core.wasm');

    const asyncified = asyncifyTransform(coreWasm, { secondaryMemoryPages: 4 });
    assert.ok(asyncified.length > coreWasm.length, 'asyncified should be larger than original');

    const mod = new WebAssembly.Module(asyncified as BufferSource);
    const exports = WebAssembly.Module.exports(mod);
    const exportNames = exports.map((e: WebAssembly.ModuleExportDescriptor) => e.name);

    assert.ok(exportNames.includes('asyncify_get_state'));
    assert.ok(exportNames.includes('asyncify_start_unwind'));
    assert.ok(exportNames.includes('asyncify_stop_unwind'));
    assert.ok(exportNames.includes('asyncify_start_rewind'));
    assert.ok(exportNames.includes('asyncify_stop_rewind'));
    assert.ok(exportNames.includes('asyncify_memory'));

    const memExports = exports.filter((e: WebAssembly.ModuleExportDescriptor) => e.kind === 'memory');
    assert.equal(memExports.length, 2, 'should have primary + asyncify memory');
  });
});

describe('transpileComponent with asyncMode asyncify', () => {
  it('transpiles and asyncifies in one step', async () => {
    const component = new Uint8Array(await readFile(RUST_CLI_COMPONENT));
    const result = await transpileComponent(component, {
      name: 'component',
      asyncMode: 'asyncify',
      asyncImports: ASYNC_WASI_IMPORTS,
      asyncExports: ASYNC_WASI_EXPORTS,
      asyncifyPages: 2,
    });

    const coreWasm = result.files.get('component.core.wasm')!;
    const mod = new WebAssembly.Module(coreWasm as BufferSource);
    const exports = WebAssembly.Module.exports(mod);
    assert.ok(
      exports.some((e: WebAssembly.ModuleExportDescriptor) => e.name === 'asyncify_get_state'),
      'core module should be asyncified',
    );
  });
});

describe('asyncify JSPI polyfill (end-to-end)', () => {
  it('runs rust-component with async stdin via asyncify', async () => {
    const component = new Uint8Array(await readFile(RUST_CLI_COMPONENT));

    const result = await transpileComponent(component, {
      name: 'component',
      minify: false,
      asyncMode: 'asyncify',
      asyncImports: ASYNC_WASI_IMPORTS,
      asyncExports: ASYNC_WASI_EXPORTS,
      asyncifyPages: 4,
    });

    const outDir = join(tmpdir(), `mithic-asyncify-test-${Date.now()}`);
    await mkdir(outDir, { recursive: true });

    try {
      for (const [filename, content] of result.files) {
        const dir = join(outDir, filename.includes('/') ? filename.slice(0, filename.lastIndexOf('/')) : '');
        await mkdir(dir, { recursive: true });
        await writeFile(join(outDir, filename), content);
      }

      const polyfill = installPolyfill({ overrideNative: true });

      const output: string[] = [];
      const shim = new WASIShim({
        sandbox: {
          env: { TEST: 'asyncify' },
          args: [],
          stdin: {
            handler: {
              blockingRead(): Promise<Uint8Array> {
                return Promise.resolve(new TextEncoder().encode('TestUser\n'));
              },
            } as any,
          },
          stdout: {
            handler: {
              write(data: Uint8Array): number {
                output.push(new TextDecoder().decode(data));
                return data.length;
              },
              blockingFlush() {},
            } as any,
          },
          stderr: {
            handler: {
              write(data: Uint8Array): number { return data.length; },
              blockingFlush() {},
            } as any,
          },
        },
      });

      const { instantiate } = await import(join(outDir, 'component.js'));
      const { run } = await instantiate(
        async (path: string) => WebAssembly.compile(await readFile(join(outDir, path))),
        shim.getImportObject(),
        createInstantiateCore({ asyncify: true }),
      );

      await run.run();

      const fullOutput = output.join('');
      assert.ok(
        fullOutput.includes('Hello world, TestUser!'),
        `expected greeting, got: ${fullOutput.slice(0, 200)}`,
      );
      assert.ok(
        fullOutput.includes('ENV.TEST = "asyncify"'),
        `expected env var, got: ${fullOutput.slice(0, 200)}`,
      );

      assert.ok(polyfill.installed, 'should install asyncify polyfill');
      assert.ok(polyfill.overrodeNative, 'should override native JSPI');
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
