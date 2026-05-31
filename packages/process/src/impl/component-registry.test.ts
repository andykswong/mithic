import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ComponentRegistry } from './component-registry.ts';
import type { CompilerBridge, CompileResult } from './compiler-bridge.ts';

function mockBridge(result: CompileResult): CompilerBridge {
  return {
    compile: () => result,
    [Symbol.dispose]() {},
  };
}

describe('ComponentRegistry', () => {
  describe('isWasmComponent', () => {
    it('should detect WASM magic bytes', () => {
      const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
      assert.equal(ComponentRegistry.isWasmComponent(wasm), true);
    });

    it('should reject non-WASM bytes', () => {
      const text = new Uint8Array([0x23, 0x21, 0x2f, 0x62]); // #!/b
      assert.equal(ComponentRegistry.isWasmComponent(text), false);
    });

    it('should reject too-short bytes', () => {
      assert.equal(ComponentRegistry.isWasmComponent(new Uint8Array(0)), false);
      assert.equal(ComponentRegistry.isWasmComponent(new Uint8Array(3)), false);
    });
  });

  describe('resolve (precompiled)', () => {
    it('should resolve a command from precompiled builtins', () => {
      const mockCompileCore = () => ({} as WebAssembly.Module);
      const mockInstantiate = () => ({ run: { run: () => 0 } });

      const registry = new ComponentRegistry({
        precompiled: new Map([
          ['coreutils', {
            commands: new Set(['cat', 'ls', 'grep', 'head']),
            compileCore: mockCompileCore,
            instantiate: mockInstantiate as never,
          }],
        ]),
      });

      const result = registry.resolve('cat');
      assert.ok(result);
      assert.equal(result.type, 'precompiled');
      assert.equal(result.compileCore, mockCompileCore);
    });

    it('should return undefined for unknown command', () => {
      const registry = new ComponentRegistry({ precompiled: new Map() });
      assert.equal(registry.resolve('unknown'), undefined);
    });

    it('should match across multiple precompiled registrations', () => {
      const shellCompile = () => ({} as WebAssembly.Module);
      const coreutilsCompile = () => ({} as WebAssembly.Module);

      const registry = new ComponentRegistry({
        precompiled: new Map([
          ['shell', { commands: new Set(['sh', 'bash']), compileCore: shellCompile, instantiate: (() => ({ run: { run: () => 0 } })) as never }],
          ['coreutils', { commands: new Set(['cat', 'ls']), compileCore: coreutilsCompile, instantiate: (() => ({ run: { run: () => 0 } })) as never }],
        ]),
      });

      assert.equal(registry.resolve('bash')?.compileCore, shellCompile);
      assert.equal(registry.resolve('cat')?.compileCore, coreutilsCompile);
    });
  });

  describe('resolveBytes', () => {
    it('should return undefined if no compiler configured', () => {
      const registry = new ComponentRegistry({ precompiled: new Map() });
      const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
      assert.equal(registry.resolveBytes(wasm), undefined);
    });

    it('should return undefined for non-WASM bytes', () => {
      const bridge = mockBridge({ modules: {}, cached: false });
      const registry = new ComponentRegistry({ precompiled: new Map(), compiler: bridge });
      const text = new TextEncoder().encode('#!/bin/sh\necho hi');
      assert.equal(registry.resolveBytes(text), undefined);
    });

    it('should cache resolved components by key', () => {
      let compileCalls = 0;
      const bridge: CompilerBridge = {
        compile() {
          compileCalls++;
          return {
            modules: { 'core.wasm': new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]) },
            jsFiles: { 'component.js': 'function instantiate(c, i, ic) { return { run: { run: () => 0 } }; }' },
            cached: false,
          };
        },
        [Symbol.dispose]() {},
      };

      const registry = new ComponentRegistry({ precompiled: new Map(), compiler: bridge });
      const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

      registry.resolveBytes(wasm, '/bin/app');
      registry.resolveBytes(wasm, '/bin/app'); // should hit cache
      assert.equal(compileCalls, 1);
    });

    it('should throw if compiler fails', () => {
      const bridge: CompilerBridge = {
        compile() { throw new Error('jco failed'); },
        [Symbol.dispose]() {},
      };
      const registry = new ComponentRegistry({ precompiled: new Map(), compiler: bridge });
      const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
      assert.throws(() => registry.resolveBytes(wasm), /jco failed/);
    });

    it('should throw if no component.js in result', () => {
      const bridge = mockBridge({
        modules: { 'core.wasm': new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]) },
        cached: false,
      });
      const registry = new ComponentRegistry({ precompiled: new Map(), compiler: bridge });
      const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
      assert.throws(() => registry.resolveBytes(wasm), /component\.js/);
    });
  });

  describe('dispose', () => {
    it('should dispose compiler on Symbol.dispose', () => {
      let disposed = false;
      const bridge: CompilerBridge = {
        compile: () => ({ modules: {}, cached: false }),
        [Symbol.dispose]() { disposed = true; },
      };
      const registry = new ComponentRegistry({ precompiled: new Map(), compiler: bridge });
      registry[Symbol.dispose]();
      assert.equal(disposed, true);
    });

    it('should not throw if no compiler', () => {
      const registry = new ComponentRegistry({ precompiled: new Map() });
      assert.doesNotThrow(() => registry[Symbol.dispose]());
    });
  });
});
