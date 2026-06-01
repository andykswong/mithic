import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CommandRegistry } from './registry.ts';
import type { ComponentCompiler, CompileResult } from './compiler.ts';

function mockBridge(result: CompileResult): ComponentCompiler {
  return {
    compile: () => result,
    [Symbol.dispose]() {},
  };
}

describe('CommandRegistry', () => {
  describe('isWasmComponent', () => {
    it('should detect WASM magic bytes', () => {
      const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
      assert.equal(CommandRegistry.isWasmComponent(wasm), true);
    });

    it('should reject non-WASM bytes', () => {
      const text = new Uint8Array([0x23, 0x21, 0x2f, 0x62]); // #!/b
      assert.equal(CommandRegistry.isWasmComponent(text), false);
    });

    it('should reject too-short bytes', () => {
      assert.equal(CommandRegistry.isWasmComponent(new Uint8Array(0)), false);
      assert.equal(CommandRegistry.isWasmComponent(new Uint8Array(3)), false);
    });
  });

  describe('resolvePrecompiled', () => {
    it('should resolve a command from precompiled builtins', () => {
      const mockCompileCore = () => ({} as WebAssembly.Module);
      const mockInstantiate = () => ({ run: { run: () => 0 } });

      const registry = new CommandRegistry({
        precompiled: new Map([
          ['coreutils', {
            commands: new Set(['cat', 'ls', 'grep', 'head']),
            compileCore: mockCompileCore,
            instantiate: mockInstantiate as never,
          }],
        ]),
      });

      const result = registry.resolvePrecompiled('cat');
      assert.ok(result);
      assert.equal(result.compileCore, mockCompileCore);
    });

    it('should return undefined for unknown command', () => {
      const registry = new CommandRegistry({ precompiled: new Map() });
      assert.equal(registry.resolvePrecompiled('unknown'), undefined);
    });

    it('should match across multiple precompiled registrations', () => {
      const shellCompile = () => ({} as WebAssembly.Module);
      const coreutilsCompile = () => ({} as WebAssembly.Module);

      const registry = new CommandRegistry({
        precompiled: new Map([
          ['shell', { commands: new Set(['sh', 'bash']), compileCore: shellCompile, instantiate: (() => ({ run: { run: () => 0 } })) as never }],
          ['coreutils', { commands: new Set(['cat', 'ls']), compileCore: coreutilsCompile, instantiate: (() => ({ run: { run: () => 0 } })) as never }],
        ]),
      });

      assert.equal(registry.resolvePrecompiled('bash')?.compileCore, shellCompile);
      assert.equal(registry.resolvePrecompiled('cat')?.compileCore, coreutilsCompile);
    });
  });

  describe('resolveBytes', () => {
    it('should return undefined if no compiler configured', () => {
      const registry = new CommandRegistry({ precompiled: new Map() });
      const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
      assert.equal(registry.resolveBytes(wasm), undefined);
    });

    it('should return undefined for non-WASM bytes', () => {
      const bridge = mockBridge({ modules: {}, jsFiles: {}, cached: false });
      const registry = new CommandRegistry({ precompiled: new Map(), compiler: bridge });
      const text = new TextEncoder().encode('#!/bin/sh\necho hi');
      assert.equal(registry.resolveBytes(text), undefined);
    });

    it('should return CompileResult directly', () => {
      const compileResult: CompileResult = {
        modules: { 'core.wasm': new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]) },
        jsFiles: { 'component.js': 'function instantiate(c, i, ic) { return { run: { run: () => 0 } }; }' },
        cached: false,
      };
      const bridge = mockBridge(compileResult);
      const registry = new CommandRegistry({ precompiled: new Map(), compiler: bridge });
      const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

      const result = registry.resolveBytes(wasm);
      assert.ok(result);
      assert.equal(result, compileResult);
      assert.ok('modules' in result);
      assert.ok('jsFiles' in result);
    });

    it('should cache resolved components by key', () => {
      let compileCalls = 0;
      const bridge: ComponentCompiler = {
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

      const registry = new CommandRegistry({ precompiled: new Map(), compiler: bridge });
      const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

      registry.resolveBytes(wasm, '/bin/app');
      registry.resolveBytes(wasm, '/bin/app'); // should hit cache
      assert.equal(compileCalls, 1);
    });

    it('should throw if compiler fails', () => {
      const bridge: ComponentCompiler = {
        compile() { throw new Error('jco failed'); },
        [Symbol.dispose]() {},
      };
      const registry = new CommandRegistry({ precompiled: new Map(), compiler: bridge });
      const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
      assert.throws(() => registry.resolveBytes(wasm), /jco failed/);
    });
  });

  describe('dispose', () => {
    it('should dispose compiler on Symbol.dispose', () => {
      let disposed = false;
      const bridge: ComponentCompiler = {
        compile: () => ({ modules: {}, jsFiles: {}, cached: false }),
        [Symbol.dispose]() { disposed = true; },
      };
      const registry = new CommandRegistry({ precompiled: new Map(), compiler: bridge });
      registry[Symbol.dispose]();
      assert.equal(disposed, true);
    });

    it('should not throw if no compiler', () => {
      const registry = new CommandRegistry({ precompiled: new Map() });
      assert.doesNotThrow(() => registry[Symbol.dispose]());
    });
  });
});
