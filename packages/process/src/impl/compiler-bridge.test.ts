import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCompilerBridge } from './compiler-bridge.ts';
import { createDefaultWorkerFactory } from './worker-factory.ts';

describe('CompilerBridge', () => {
  it('should compile a WASM component and return module bytes', async () => {
    const factory = createDefaultWorkerFactory();
    const bridge = createCompilerBridge(factory);

    // Use coreutils component as test fixture (already built)
    const componentPath = new URL('../../../../coreutils/dist/wasm/component.wasm', import.meta.url);
    let wasmBytes: Uint8Array;
    try {
      wasmBytes = await readFile(componentPath);
    } catch {
      bridge[Symbol.dispose]();
      return; // Skip if coreutils not built
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
  });

  it('should return cached result on second compile of same bytes', async () => {
    const factory = createDefaultWorkerFactory();
    const bridge = createCompilerBridge(factory);

    const componentPath = new URL('../../../../coreutils/dist/wasm/component.wasm', import.meta.url);
    let wasmBytes: Uint8Array;
    try {
      wasmBytes = await readFile(componentPath);
    } catch {
      bridge[Symbol.dispose]();
      return;
    }

    const result1 = bridge.compile(wasmBytes);
    assert.equal(result1.cached, false);

    const result2 = bridge.compile(wasmBytes);
    assert.equal(result2.cached, true);
    assert.deepEqual(Object.keys(result1.modules), Object.keys(result2.modules));

    bridge[Symbol.dispose]();
  });

  it('should include jsFiles in result', async () => {
    const factory = createDefaultWorkerFactory();
    const bridge = createCompilerBridge(factory);

    const componentPath = new URL('../../../../coreutils/dist/wasm/component.wasm', import.meta.url);
    let wasmBytes: Uint8Array;
    try {
      wasmBytes = await readFile(componentPath);
    } catch {
      bridge[Symbol.dispose]();
      return;
    }

    const result = bridge.compile(wasmBytes);
    assert.ok(result.jsFiles, 'Should include JS files from jco transpile');
    assert.ok(Object.keys(result.jsFiles).length > 0, 'Should have at least one JS file');

    bridge[Symbol.dispose]();
  });
});
