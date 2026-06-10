import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  transpileComponent,
  transpileToFiles,
  ASYNC_WASI_IMPORTS,
  ASYNC_WASI_EXPORTS,
} from './transpile.ts';

const RUST_CLI_COMPONENT = join(import.meta.dirname, '../../examples/component-rust/dist/component.wasm');

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

describe('transpileToFiles', () => {
  async function exists(path: string): Promise<boolean> {
    try { await stat(path); return true; } catch { return false; }
  }

  it('produces all variant files with all variants', async () => {
    const component = new Uint8Array(await readFile(RUST_CLI_COMPONENT));
    const outputDir = join(tmpdir(), `wasm-transpile-test-${Date.now()}-all`);

    try {
      await transpileToFiles(component, {
        outputDir,
        variants: ['sync', 'jspi', 'asyncify'],
        asyncImports: ASYNC_WASI_IMPORTS,
        asyncExports: ASYNC_WASI_EXPORTS,
        asyncifyPages: 1,
      });

      assert.ok(await exists(join(outputDir, 'component.js')), 'should produce component.js');
      assert.ok(await exists(join(outputDir, 'component.async.js')), 'should produce component.async.js');
      assert.ok(await exists(join(outputDir, 'component.d.ts')), 'should produce component.d.ts');
      assert.ok(await exists(join(outputDir, 'component.async.d.ts')), 'should produce component.async.d.ts');
      assert.ok(await exists(join(outputDir, 'index.js')), 'should produce index.js');
      assert.ok(await exists(join(outputDir, 'index.d.ts')), 'should produce index.d.ts');
      assert.ok(await exists(join(outputDir, 'jspi.js')), 'should produce jspi.js');
      assert.ok(await exists(join(outputDir, 'jspi.d.ts')), 'should produce jspi.d.ts');
      assert.ok(await exists(join(outputDir, 'asyncify.js')), 'should produce asyncify.js');
      assert.ok(await exists(join(outputDir, 'asyncify.d.ts')), 'should produce asyncify.d.ts');
      assert.ok(await exists(join(outputDir, 'core')), 'should produce core/ directory');
      assert.ok(await exists(join(outputDir, 'core-asyncify')), 'should produce core-asyncify/ directory');

      const indexJs = await readFile(join(outputDir, 'index.js'), 'utf8');
      assert.ok(indexJs.includes('from \'./component.js\''), 'index.js should reference component.js');
      assert.ok(indexJs.includes('data:content/type;base64,'), 'index.js should contain base64 modules');

      const jspiJs = await readFile(join(outputDir, 'jspi.js'), 'utf8');
      assert.ok(jspiJs.includes('from \'./component.async.js\''), 'jspi.js should reference component.async.js');

      const asyncifyJs = await readFile(join(outputDir, 'asyncify.js'), 'utf8');
      assert.ok(asyncifyJs.includes('from \'./component.async.js\''), 'asyncify.js should reference component.async.js');
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('produces only sync variant by default', async () => {
    const component = new Uint8Array(await readFile(RUST_CLI_COMPONENT));
    const outputDir = join(tmpdir(), `wasm-transpile-test-${Date.now()}-sync`);

    try {
      await transpileToFiles(component, { outputDir });

      assert.ok(await exists(join(outputDir, 'component.js')), 'should produce component.js');
      assert.ok(await exists(join(outputDir, 'index.js')), 'should produce index.js');
      assert.ok(await exists(join(outputDir, 'core')), 'should produce core/ directory');
      assert.ok(!(await exists(join(outputDir, 'component.async.js'))), 'should NOT produce component.async.js');
      assert.ok(!(await exists(join(outputDir, 'jspi.js'))), 'should NOT produce jspi.js');
      assert.ok(!(await exists(join(outputDir, 'asyncify.js'))), 'should NOT produce asyncify.js');
      assert.ok(!(await exists(join(outputDir, 'core-asyncify'))), 'should NOT produce core-asyncify/');
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('asyncify entry point has different module map than sync', async () => {
    const component = new Uint8Array(await readFile(RUST_CLI_COMPONENT));
    const outputDir = join(tmpdir(), `wasm-transpile-test-${Date.now()}-diff`);

    try {
      await transpileToFiles(component, {
        outputDir,
        variants: ['sync', 'asyncify'],
        asyncImports: ASYNC_WASI_IMPORTS,
        asyncExports: ASYNC_WASI_EXPORTS,
        asyncifyPages: 1,
      });

      const indexJs = await readFile(join(outputDir, 'index.js'), 'utf8');
      const asyncifyJs = await readFile(join(outputDir, 'asyncify.js'), 'utf8');

      const indexModules = JSON.parse(indexJs.split('export const modules = ')[1].trimEnd().replace(/;\s*$/, ''));
      const asyncifyModules = JSON.parse(asyncifyJs.split('export const modules = ')[1].trimEnd().replace(/;\s*$/, ''));

      assert.notEqual(
        indexModules['component.core.wasm'],
        asyncifyModules['component.core.wasm'],
        'asyncified core.wasm should differ from sync core.wasm',
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('core-asyncify/ contains all core wasm files', async () => {
    const component = new Uint8Array(await readFile(RUST_CLI_COMPONENT));
    const outputDir = join(tmpdir(), `wasm-transpile-test-${Date.now()}-cores`);

    try {
      await transpileToFiles(component, {
        outputDir,
        variants: ['sync', 'asyncify'],
        asyncImports: ASYNC_WASI_IMPORTS,
        asyncExports: ASYNC_WASI_EXPORTS,
        asyncifyPages: 1,
      });

      const { readdir } = await import('node:fs/promises');
      const coreFiles = (await readdir(join(outputDir, 'core'))).filter(f => f.endsWith('.wasm')).sort();
      const asyncifyCoreFiles = (await readdir(join(outputDir, 'core-asyncify'))).filter(f => f.endsWith('.wasm')).sort();

      assert.deepEqual(asyncifyCoreFiles, coreFiles, 'core-asyncify/ should contain the same set of files as core/');

      const coreSize = (await stat(join(outputDir, 'core', 'component.core.wasm'))).size;
      const asyncifyCoreSize = (await stat(join(outputDir, 'core-asyncify', 'component.core.wasm'))).size;
      assert.ok(asyncifyCoreSize > coreSize, 'asyncified core.wasm should be larger than original');
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
