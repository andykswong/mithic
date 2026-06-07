import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  transpileComponent,
  generateIndexJs,
  generateIndexDts,
  ASYNC_WASI_IMPORTS,
  ASYNC_WASI_EXPORTS,
} from './transpile.ts';

const RUST_CLI_COMPONENT = join(import.meta.dirname, '../../examples/rust-cli/dist/component.wasm');

describe('transpileComponent', () => {
  it('produces files including component.js and at least one .core.wasm', async () => {
    const component = new Uint8Array(await readFile(RUST_CLI_COMPONENT));
    const result = await transpileComponent(component, { name: 'component' });

    assert.ok(result.files.has('component.js'), 'should produce component.js');

    const wasmFiles = [...result.files.keys()].filter(f => f.endsWith('.core.wasm'));
    assert.ok(wasmFiles.length >= 1, `should produce at least one .core.wasm, got: ${wasmFiles}`);
  });

  it('returns imports and exports arrays', async () => {
    const component = new Uint8Array(await readFile(RUST_CLI_COMPONENT));
    const result = await transpileComponent(component, { name: 'component' });

    assert.ok(Array.isArray(result.imports), 'imports should be an array');
    assert.ok(Array.isArray(result.exports), 'exports should be an array');
  });

  it('with asyncMode asyncify produces asyncified core modules', async () => {
    const component = new Uint8Array(await readFile(RUST_CLI_COMPONENT));
    const result = await transpileComponent(component, {
      name: 'component',
      asyncMode: 'asyncify',
      asyncImports: ASYNC_WASI_IMPORTS,
      asyncExports: ASYNC_WASI_EXPORTS,
      asyncifyPages: 2,
    });

    const coreWasm = result.files.get('component.core.wasm')!;
    assert.ok(coreWasm, 'should produce component.core.wasm');

    const mod = new WebAssembly.Module(coreWasm as BufferSource);
    const exports = WebAssembly.Module.exports(mod);
    assert.ok(
      exports.some((e: WebAssembly.ModuleExportDescriptor) => e.name === 'asyncify_get_state'),
      'core module should have asyncify_get_state export',
    );
  });

  it('with asyncMode jspi does not asyncify core modules', async () => {
    const component = new Uint8Array(await readFile(RUST_CLI_COMPONENT));
    const result = await transpileComponent(component, {
      name: 'component',
      asyncMode: 'jspi',
      asyncImports: ASYNC_WASI_IMPORTS,
      asyncExports: ASYNC_WASI_EXPORTS,
    });

    const coreWasm = result.files.get('component.core.wasm')!;
    assert.ok(coreWasm, 'should produce component.core.wasm');

    const mod = new WebAssembly.Module(coreWasm as BufferSource);
    const exports = WebAssembly.Module.exports(mod);
    assert.ok(
      !exports.some((e: WebAssembly.ModuleExportDescriptor) => e.name === 'asyncify_get_state'),
      'core module should NOT have asyncify exports in jspi mode',
    );
  });

  it('respects custom name option', async () => {
    const component = new Uint8Array(await readFile(RUST_CLI_COMPONENT));
    const result = await transpileComponent(component, { name: 'mymod' });

    assert.ok(result.files.has('mymod.js'), 'should produce mymod.js');
  });
});

describe('generateIndexJs', () => {
  it('produces re-export and modules map', () => {
    const modules = { 'component.core.wasm': 'data:content/type;base64,AAAA' };
    const output = generateIndexJs('component', modules);

    assert.ok(output.includes('export * from \'./component.js\''), 'should re-export component.js');
    assert.ok(output.includes('export const modules ='), 'should export modules');
    assert.ok(output.includes('"component.core.wasm"'), 'should contain module key');
    assert.ok(output.includes('data:content/type;base64,AAAA'), 'should contain base64 data URI');
  });

  it('handles multiple wasm modules', () => {
    const modules = {
      'component.core.wasm': 'data:a',
      'component.core2.wasm': 'data:b',
    };
    const output = generateIndexJs('component', modules);

    assert.ok(output.includes('"component.core.wasm"'));
    assert.ok(output.includes('"component.core2.wasm"'));
  });

  it('handles empty modules map', () => {
    const output = generateIndexJs('component', {});
    assert.ok(output.includes('export * from \'./component.js\''));
    assert.ok(output.includes('export const modules = {}'));
  });
});

describe('generateIndexDts', () => {
  it('re-exports from component module and declares modules map', () => {
    const output = generateIndexDts('component');

    assert.ok(output.includes('export * from \'./component.js\''), 'should re-export from component');
    assert.ok(output.includes('export declare const modules'), 'should declare modules');
  });

  it('uses the provided component name', () => {
    const output = generateIndexDts('my-app');

    assert.ok(output.includes('export * from \'./my-app.js\''), 'should reference correct module');
  });
});
