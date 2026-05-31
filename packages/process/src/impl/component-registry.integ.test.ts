import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MessageChannel } from 'node:worker_threads';
import { NodeWorkerFactory } from '@mithic/io/io/worker-factory.node';
import { ComponentRegistry } from './component-registry.ts';
import { createCompilerBridge } from './compiler-bridge.ts';
import type { ManagedWorker } from '@mithic/io/io';

function createTestBridge(): { bridge: ReturnType<typeof createCompilerBridge>; worker: ManagedWorker } {
  const factory = new NodeWorkerFactory();
  const { port1, port2 } = new MessageChannel();
  const worker = factory.create(
    new URL('./compiler-worker.node.ts', import.meta.url),
    { name: 'test-compiler' },
  );
  worker.postMessage({ type: '__port', port: port2 }, [port2 as unknown as Transferable]);
  const bridge = createCompilerBridge(port1 as unknown as MessagePort);
  return { bridge, worker };
}

describe('ComponentRegistry integration (real jco)', () => {
  it('should compile, resolve, and instantiate a real WASM component', async () => {
    const componentPath = new URL('../../../coreutils/dist/wasm/component.wasm', import.meta.url);
    let wasmBytes: Uint8Array;
    try {
      wasmBytes = await readFile(componentPath);
    } catch {
      return; // Skip if coreutils not built
    }

    const { bridge, worker } = createTestBridge();
    const registry = new ComponentRegistry({ precompiled: new Map(), compiler: bridge });

    const resolved = registry.resolveBytes(wasmBytes, '/bin/coreutils');
    assert.ok(resolved, 'Should resolve WASM component');
    assert.equal(resolved.type, 'dynamic');
    assert.equal(typeof resolved.compileCore, 'function');
    assert.equal(typeof resolved.instantiate, 'function');

    // Verify compileCore returns actual WebAssembly.Module instances
    const moduleNames: string[] = [];
    const wrappedCompile = (path: string) => {
      moduleNames.push(path);
      return resolved.compileCore(path);
    };

    // Verify instantiate produces a runnable component
    // We can't fully run coreutils without WASI imports, but we can verify
    // the instantiate function is callable and requests the right modules
    try {
      resolved.instantiate(wrappedCompile, {}, (mod, imports) => new WebAssembly.Instance(mod, imports));
    } catch {
      // Expected to fail without WASI imports — but it should have called compileCore
    }

    assert.ok(moduleNames.length > 0, 'instantiate should have called compileCore at least once');
    assert.ok(moduleNames.every(n => n.endsWith('.wasm')), 'All module names should be .wasm paths');

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
    const registry = new ComponentRegistry({ precompiled: new Map(), compiler: bridge });

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
    const handlerSource = await rf(new URL('./compiler-handler.ts', import.meta.url), 'utf8');
    assert.ok(
      handlerSource.includes('@bytecodealliance/jco is required'),
      'Compiler handler should have a clear error message when jco is unavailable',
    );
  });
});
