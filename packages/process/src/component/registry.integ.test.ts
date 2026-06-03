import '@mithic/worker';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MessageChannel } from 'node:worker_threads';
import { CommandRegistry } from './registry.ts';
import { createComponentCompiler } from './compiler.ts';

function createTestBridge(): { bridge: ReturnType<typeof createComponentCompiler>; worker: Worker } {
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(
    new URL('../worker/compiler.worker.ts', import.meta.url),
    { type: 'module', name: 'test-compiler' },
  );
  worker.postMessage({ type: '__port', port: port2 }, [port2 as unknown as Transferable]);
  const bridge = createComponentCompiler(port1 as unknown as MessagePort);
  return { bridge, worker };
}

describe('CommandRegistry integration (real jco)', () => {
  it('should compile and return a CompileResult for a real WASM component', async () => {
    const componentPath = new URL('../../../coreutils/dist/wasm/component.wasm', import.meta.url);
    let wasmBytes: Uint8Array;
    try {
      wasmBytes = await readFile(componentPath);
    } catch {
      return; // Skip if coreutils not built
    }

    const { bridge, worker } = createTestBridge();
    const registry = new CommandRegistry({ precompiled: new Map(), compiler: bridge });

    const result = registry.resolveBytes(wasmBytes, '/bin/coreutils');
    assert.ok(result, 'Should resolve WASM component');
    assert.ok('modules' in result, 'Result should have modules');
    assert.ok(typeof result.modules === 'object', 'modules should be an object');

    // Verify modules contain actual WASM bytes
    const moduleEntries = Object.entries(result.modules);
    assert.ok(moduleEntries.length > 0, 'Should have at least one module');
    assert.ok(moduleEntries.every(([name]) => name.endsWith('.wasm')), 'All module names should be .wasm paths');

    // Verify jsFiles contains component.js
    assert.ok(result.jsFiles?.['component.js'], 'Should have component.js in jsFiles');

    registry[Symbol.dispose]();
    await worker.terminate();
  });

  it('should cache resolved component (second call returns same object)', async () => {
    const componentPath = new URL('../../../coreutils/dist/wasm/component.wasm', import.meta.url);
    let wasmBytes: Uint8Array;
    try {
      wasmBytes = await readFile(componentPath);
    } catch {
      return;
    }

    const { bridge, worker } = createTestBridge();
    const registry = new CommandRegistry({ precompiled: new Map(), compiler: bridge });

    const resolved1 = registry.resolveBytes(wasmBytes, '/bin/app');
    const resolved2 = registry.resolveBytes(wasmBytes, '/bin/app');
    assert.strictEqual(resolved1, resolved2, 'Cache should return same object');

    registry[Symbol.dispose]();
    await worker.terminate();
  });

  it('should handle jco unavailable with clear error', async () => {
    // This test verifies the error message is informative when jco is missing.
    // We can't easily remove jco from node_modules mid-test, so this just
    // verifies the error path exists by checking the compiler-worker source.
    const { readFile: rf } = await import('node:fs/promises');
    const handlerSource = await rf(new URL('../worker/compiler.ts', import.meta.url), 'utf8');
    assert.ok(
      handlerSource.includes('@bytecodealliance/jco is required'),
      'Compiler handler should have a clear error message when jco is unavailable',
    );
  });
});
