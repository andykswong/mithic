import '@mithic/worker';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MessageChannel } from 'node:worker_threads';
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

describe('ComponentCompiler', () => {
  it('should compile a WASM component and return module bytes', async () => {
    const { bridge, worker } = createTestBridge();

    const componentPath = new URL('../../../coreutils/dist/wasm/component.wasm', import.meta.url);
    let wasmBytes: Uint8Array;
    try {
      wasmBytes = await readFile(componentPath);
    } catch {
      bridge[Symbol.dispose]();
      await worker.terminate();
      return;
    }

    const result = bridge.compile(wasmBytes);
    assert.ok(result.modules);
    assert.ok(Object.keys(result.modules).length > 0, 'Should have at least one core WASM module');

    for (const [path, bytes] of Object.entries(result.modules)) {
      assert.ok(path.endsWith('.wasm'), `Expected .wasm path, got: ${path}`);
      assert.ok(bytes instanceof Uint8Array, `Expected Uint8Array for ${path}`);
      assert.equal(bytes[0], 0x00, 'WASM magic byte 0');
      assert.equal(bytes[1], 0x61, 'WASM magic byte 1');
      assert.equal(bytes[2], 0x73, 'WASM magic byte 2');
      assert.equal(bytes[3], 0x6d, 'WASM magic byte 3');
    }

    assert.equal(result.cached, false, 'First call should not be cached');

    bridge[Symbol.dispose]();
    await worker.terminate();
  });

  it('should return cached result on second compile of same bytes', async () => {
    const { bridge, worker } = createTestBridge();

    const componentPath = new URL('../../../coreutils/dist/wasm/component.wasm', import.meta.url);
    let wasmBytes: Uint8Array;
    try {
      wasmBytes = await readFile(componentPath);
    } catch {
      bridge[Symbol.dispose]();
      await worker.terminate();
      return;
    }

    const result1 = bridge.compile(wasmBytes);
    assert.equal(result1.cached, false);

    const result2 = bridge.compile(wasmBytes);
    assert.equal(result2.cached, true);
    assert.deepEqual(Object.keys(result1.modules), Object.keys(result2.modules));
    assert.ok(result2.jsFiles, 'Cache hit should include jsFiles');
    assert.ok(Object.keys(result2.jsFiles).length > 0, 'Cached jsFiles should not be empty');

    bridge[Symbol.dispose]();
    await worker.terminate();
  });

  it('should include jsFiles in result', async () => {
    const { bridge, worker } = createTestBridge();

    const componentPath = new URL('../../../coreutils/dist/wasm/component.wasm', import.meta.url);
    let wasmBytes: Uint8Array;
    try {
      wasmBytes = await readFile(componentPath);
    } catch {
      bridge[Symbol.dispose]();
      await worker.terminate();
      return;
    }

    const result = bridge.compile(wasmBytes);
    assert.ok(result.jsFiles, 'Should include JS files from jco transpile');
    assert.ok(Object.keys(result.jsFiles).length > 0, 'Should have at least one JS file');

    bridge[Symbol.dispose]();
    await worker.terminate();
  });
});
