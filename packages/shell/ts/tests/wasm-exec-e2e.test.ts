import '@mithic/worker';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MessageChannel } from 'node:worker_threads';
import { createComponentCompiler, type CompileResult } from '@mithic/process/component/compiler';
import { WASIShim } from '@mithic/wasip2';
import { ComponentExit } from '@mithic/wasip2/cli/exit';

function createTestBridge(): { bridge: ReturnType<typeof createComponentCompiler>; worker: Worker } {
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(
    new URL(import.meta.resolve('@mithic/process/worker/compiler')),
    { type: 'module', name: 'test-compiler' },
  );
  worker.postMessage({ type: '__port', port: port2 }, [port2 as unknown as Transferable]);
  const bridge = createComponentCompiler(port1 as unknown as MessagePort);
  return { bridge, worker };
}

async function instantiateFromCompileResult(result: CompileResult, wasiImports: object): Promise<{ run: { run: () => number } }> {
  const jsSource = result.jsFiles['component.js'];
  if (!jsSource) throw new Error('No component.js in CompileResult');

  const encoded = Buffer.from(jsSource).toString('base64');
  const dataUrl = `data:text/javascript;base64,${encoded}`;
  const mod = await import(dataUrl);

  const compiled = new Map<string, WebAssembly.Module>();
  for (const [path, wasmBytes] of Object.entries(result.modules)) {
    compiled.set(path, new WebAssembly.Module(wasmBytes.slice().buffer));
  }
  const compileCore = (path: string) => {
    const mod = compiled.get(path);
    if (!mod) throw new Error(`Module not found: ${path}`);
    return mod;
  };
  return mod.instantiate(compileCore, wasiImports, (m: WebAssembly.Module, i: WebAssembly.Imports) => new WebAssembly.Instance(m, i));
}

/**
 * Temporarily suppress unhandled rejections during fn() and one microtask tick after.
 *
 * When WASM calls proc-exit() with a non-zero code, JCO's async task model throws
 * ComponentExit synchronously (caught by our try/catch) AND also rejects any pending
 * async Promise tasks with the same error. These secondary rejections are benign but
 * must be suppressed to avoid failing the Node.js test runner.
 *
 * This only affects proc-exit(non-zero) — proc-exit(0) / natural returns do not
 * generate unhandled rejections.
 */
async function suppressRejectionsDuring(fn: () => void | Promise<void>): Promise<void> {
  const existing = process.rawListeners('unhandledRejection') as ((...args: unknown[]) => void)[];
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', () => { /* suppress JCO secondary ComponentExit rejections */ });
  try {
    await fn();
  } finally {
    // Restore after microtasks (JCO async rejections) have had a chance to fire
    await new Promise<void>(resolve => setImmediate(resolve));
    process.removeAllListeners('unhandledRejection');
    for (const listener of existing) {
      process.on('unhandledRejection', listener);
    }
  }
}

describe('Dynamic WASM E2E (compile → instantiate → run)', () => {
  it('should compile coreutils and run basename command', async () => {
    const componentPath = new URL('../../../coreutils/dist/wasm/component.wasm', import.meta.url);
    let wasmBytes: Uint8Array;
    try {
      wasmBytes = await readFile(componentPath);
    } catch {
      return; // Skip if not built
    }

    const { bridge, worker } = createTestBridge();

    try {
      // 1. Compile via sync-bridge → jco transpile
      const result = bridge.compile(wasmBytes);
      assert.ok(result.modules, 'Should have modules');
      assert.ok(result.jsFiles['component.js'], 'Should have component.js');

      // 2. Capture stdout
      const chunks: Uint8Array[] = [];

      // 3. Create WASI shim — basename /hello/world exits 0 naturally (no proc-exit call)
      const shim = new WASIShim({
        sandbox: {
          args: ['basename', '/hello/world'],
          env: {},
          stdin: { handler: { read() { return undefined; }, blockingRead() { throw { tag: 'closed' }; } } },
          stdout: { handler: { write(data: Uint8Array) { chunks.push(new Uint8Array(data)); }, checkWrite() { return 65536; } } },
          stderr: { handler: { write() {}, checkWrite() { return 65536; } } },
        },
      });

      // 4. Instantiate and run
      let exitCode: number;
      try {
        const { run } = await instantiateFromCompileResult(result, shim.getImportObject());
        exitCode = run.run() ?? 0;
      } catch (e: unknown) {
        if (e instanceof ComponentExit) {
          exitCode = e.code;
        } else {
          throw e;
        }
      } finally {
        shim[Symbol.dispose]();
      }

      // 5. Verify output
      assert.equal(exitCode, 0, 'basename should exit with 0');
      const output = new TextDecoder().decode(Buffer.concat(chunks));
      assert.equal(output.trim(), 'world', 'basename /hello/world should output "world"');
    } finally {
      bridge[Symbol.dispose]();
      await worker.terminate();
    }
  });

  it('should handle component that exits with non-zero code', async () => {
    const componentPath = new URL('../../../coreutils/dist/wasm/component.wasm', import.meta.url);
    let wasmBytes: Uint8Array;
    try {
      wasmBytes = await readFile(componentPath);
    } catch {
      return;
    }

    const { bridge, worker } = createTestBridge();

    try {
      const result = bridge.compile(wasmBytes);

      // grep with no match exits 1 via proc-exit.
      // JCO's async model produces secondary unhandled rejections for non-zero proc-exit —
      // suppress them for the duration of the call.
      const stdinData = new TextEncoder().encode('hello\n');
      let stdinPos = 0;
      const shim = new WASIShim({
        sandbox: {
          args: ['grep', 'nomatch'],
          env: {},
          stdin: { handler: { read() { return undefined; }, blockingRead(len: number) {
            if (stdinPos >= stdinData.length) throw { tag: 'closed' };
            const slice = stdinData.slice(stdinPos, stdinPos + len);
            stdinPos += slice.length;
            return slice;
          } } },
          stdout: { handler: { write() {}, checkWrite() { return 65536; } } },
          stderr: { handler: { write() {}, checkWrite() { return 65536; } } },
        },
      });

      let exitCode = -1;
      await suppressRejectionsDuring(async () => {
        try {
          const { run } = await instantiateFromCompileResult(result, shim.getImportObject());
          exitCode = run.run() ?? 0;
        } catch (e: unknown) {
          if (e instanceof ComponentExit) exitCode = e.code;
          else throw e;
        } finally {
          shim[Symbol.dispose]();
        }
      });

      assert.equal(exitCode, 1, 'grep with no match should exit with 1');
    } finally {
      bridge[Symbol.dispose]();
      await worker.terminate();
    }
  });

  it('should work on cache hit (second compile same bytes)', async () => {
    const componentPath = new URL('../../../coreutils/dist/wasm/component.wasm', import.meta.url);
    let wasmBytes: Uint8Array;
    try {
      wasmBytes = await readFile(componentPath);
    } catch {
      return;
    }

    const { bridge, worker } = createTestBridge();

    try {
      // First compile (cache miss)
      bridge.compile(wasmBytes);

      // Second compile (cache hit) — should still have jsFiles and work
      const result = bridge.compile(wasmBytes);
      assert.equal(result.cached, true);

      const chunks: Uint8Array[] = [];
      const shim = new WASIShim({
        sandbox: {
          args: ['basename', '/cached/path'],
          env: {},
          stdin: { handler: { read() { return undefined; }, blockingRead() { throw { tag: 'closed' }; } } },
          stdout: { handler: { write(data: Uint8Array) { chunks.push(new Uint8Array(data)); }, checkWrite() { return 65536; } } },
          stderr: { handler: { write() {}, checkWrite() { return 65536; } } },
        },
      });

      let exitCode: number;
      try {
        const { run } = await instantiateFromCompileResult(result, shim.getImportObject());
        exitCode = run.run() ?? 0;
      } catch (e: unknown) {
        if (e instanceof ComponentExit) exitCode = e.code;
        else throw e;
      } finally {
        shim[Symbol.dispose]();
      }

      assert.equal(exitCode, 0);
      const output = new TextDecoder().decode(Buffer.concat(chunks));
      assert.equal(output.trim(), 'path', 'basename /cached/path should output "path"');
    } finally {
      bridge[Symbol.dispose]();
      await worker.terminate();
    }
  });
});
