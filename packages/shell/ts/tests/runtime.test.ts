import '@mithic/worker';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Runtime } from '../runtime.ts';
import { MemoryFsProvider, DeviceFsProvider, SyncFileSystemRouter } from '@mithic/io/vfs';
import type { SyncOutputStreamHandler } from '@mithic/io/io';
import { ComponentProcessWorker } from '@mithic/process/manager/component-worker';
import { InlineProcessWorker } from '@mithic/process/manager/inline-worker';
import type { CompileResult } from '@mithic/process/component/compiler';
import type { ProcessWorker } from '@mithic/process/types';
import { COREUTILS_COMMANDS } from '@mithic/coreutils';
import { modules as shellModules } from '@mithic/shell/component';
import { modules as coreutilsModules } from '@mithic/coreutils/component';

// --- Load CompileResults (same pattern as cli.ts) ---

async function fetchModuleBytes(dataUris: Record<string, string>): Promise<Record<string, Uint8Array>> {
  const modules: Record<string, Uint8Array> = {};
  await Promise.all(
    Object.entries(dataUris).map(async ([name, uri]) => {
      const response = await fetch(uri);
      modules[name] = new Uint8Array(await response.arrayBuffer());
    }),
  );
  return modules;
}

const [shellRawModules, coreutilsRawModules] = await Promise.all([
  fetchModuleBytes(shellModules),
  fetchModuleBytes(coreutilsModules),
]);

const shellComponentDir = dirname(fileURLToPath(import.meta.resolve('@mithic/shell/component')));
const coreutilsComponentDir = dirname(fileURLToPath(import.meta.resolve('@mithic/coreutils/component')));
const shellJsSource = readFileSync(join(shellComponentDir, 'component.js'), 'utf-8');
const coreutilsJsSource = readFileSync(join(coreutilsComponentDir, 'component.js'), 'utf-8');

const shellCompileResult: CompileResult = {
  modules: shellRawModules,
  jsFiles: { 'component.js': shellJsSource },
  cached: true,
};
const coreutilsCompileResult: CompileResult = {
  modules: coreutilsRawModules,
  jsFiles: { 'component.js': coreutilsJsSource },
  cached: true,
};

const processWorkerUrl = new URL(import.meta.resolve('@mithic/process/worker/process'));

function createWorkerFactory(memFs: MemoryFsProvider) {
  return function createWorker(file: string, name?: string): ProcessWorker | undefined {
    const cmdName = file.includes('/') ? file.split('/').pop()! : file;
    if (cmdName === 'sh' || cmdName === 'bash') {
      const worker = new Worker(processWorkerUrl, { type: 'module', name });
      return new ComponentProcessWorker(worker, shellCompileResult);
    }
    if (COREUTILS_COMMANDS.has(cmdName)) {
      const worker = new Worker(processWorkerUrl, { type: 'module', name });
      return new ComponentProcessWorker(worker, coreutilsCompileResult);
    }
    return undefined;
  };
}

function createCaptureStdout(): { handler: SyncOutputStreamHandler; chunks: Uint8Array[] } {
  const chunks: Uint8Array[] = [];
  const handler: SyncOutputStreamHandler = {
    write(data: Uint8Array) { chunks.push(new Uint8Array(data)); },
    flush() {},
  };
  return { handler, chunks };
}

function createCaptureStderr(): { handler: SyncOutputStreamHandler; chunks: Uint8Array[] } {
  const chunks: Uint8Array[] = [];
  const handler: SyncOutputStreamHandler = {
    write(data: Uint8Array) { chunks.push(new Uint8Array(data)); },
    flush() {},
  };
  return { handler, chunks };
}

function createTestVfs(memFs: MemoryFsProvider, stdoutHandler: SyncOutputStreamHandler, stderrHandler: SyncOutputStreamHandler) {
  const vfs = new SyncFileSystemRouter();
  vfs.mount('/', memFs);
  vfs.mount('/dev', new DeviceFsProvider({ stdout: stdoutHandler, stderr: stderrHandler }));
  return vfs;
}

function getOutput(chunks: Uint8Array[]): string {
  return new TextDecoder().decode(Buffer.concat(chunks));
}

describe('Runtime', () => {
  it('exec returns Process with pid', () => {
    const memFs = new MemoryFsProvider();
    const { handler: stdoutHandler } = createCaptureStdout();
    const { handler: stderrHandler } = createCaptureStderr();

    const runtime = new Runtime({
      fs: createTestVfs(memFs, stdoutHandler, stderrHandler),
      stdio: { stdout: stdoutHandler, stderr: stderrHandler },
      createWorker: createWorkerFactory(memFs),
    });

    try {
      // Use basename which is in COREUTILS_COMMANDS
      const proc = runtime.exec('basename', { args: ['/hello/world'] });
      assert.equal(typeof proc.pid(), 'number');
      assert.ok(proc.pid() >= 0);
    } finally {
      runtime[Symbol.dispose]();
    }
  });

  it('runs coreutils command (basename)', async () => {
    const memFs = new MemoryFsProvider();
    const { handler: stdoutHandler, chunks } = createCaptureStdout();
    const { handler: stderrHandler } = createCaptureStderr();

    const runtime = new Runtime({
      fs: createTestVfs(memFs, stdoutHandler, stderrHandler),
      stdio: { stdout: stdoutHandler, stderr: stderrHandler },
      createWorker: createWorkerFactory(memFs),
    });

    try {
      const proc = runtime.exec('basename', { args: ['/hello/world'] });
      const code = await runtime.waitAsync(proc);
      assert.equal(code, 0);
      assert.equal(getOutput(chunks).trim(), 'world');
    } finally {
      runtime[Symbol.dispose]();
    }
  });

  it('runs shell script via bash -c', async () => {
    const memFs = new MemoryFsProvider();
    const { handler: stdoutHandler, chunks } = createCaptureStdout();
    const { handler: stderrHandler } = createCaptureStderr();

    const runtime = new Runtime({
      fs: createTestVfs(memFs, stdoutHandler, stderrHandler),
      stdio: { stdout: stdoutHandler, stderr: stderrHandler },
      createWorker: createWorkerFactory(memFs),
      env: { PATH: '/usr/bin:/bin' },
    });

    try {
      const proc = runtime.exec('bash', { args: ['-c', 'echo world'] });
      const code = await runtime.waitAsync(proc);
      assert.equal(code, 0);
      assert.equal(getOutput(chunks).trim(), 'world');
    } finally {
      runtime[Symbol.dispose]();
    }
  });

  it('exec with InlineProcessWorker returns correct exit code', async () => {
    const memFs = new MemoryFsProvider();
    const { handler: stdoutHandler } = createCaptureStdout();
    const { handler: stderrHandler } = createCaptureStderr();

    const runtime = new Runtime({
      fs: createTestVfs(memFs, stdoutHandler, stderrHandler),
      stdio: { stdout: stdoutHandler, stderr: stderrHandler },
      createWorker: (file: string) => {
        if (file === 'exit42') {
          return new InlineProcessWorker(() => 42);
        }
        return createWorkerFactory(memFs)(file);
      },
    });

    try {
      const proc = runtime.exec('exit42');
      const code = await runtime.waitAsync(proc);
      assert.equal(code, 42);
    } finally {
      runtime[Symbol.dispose]();
    }
  });

  it('unknown command throws ProcessError', () => {
    const memFs = new MemoryFsProvider();
    const { handler: stdoutHandler } = createCaptureStdout();
    const { handler: stderrHandler } = createCaptureStderr();

    const runtime = new Runtime({
      fs: createTestVfs(memFs, stdoutHandler, stderrHandler),
      stdio: { stdout: stdoutHandler, stderr: stderrHandler },
      createWorker: () => undefined,
    });

    try {
      assert.throws(() => runtime.exec('nonexistent_cmd'), (err: unknown) => {
        return err instanceof Error && err.name === 'ProcessError';
      });
    } finally {
      runtime[Symbol.dispose]();
    }
  });

  it('waitAsync resolves with exit code', async () => {
    const memFs = new MemoryFsProvider();
    const { handler: stdoutHandler, chunks } = createCaptureStdout();
    const { handler: stderrHandler } = createCaptureStderr();

    const runtime = new Runtime({
      fs: createTestVfs(memFs, stdoutHandler, stderrHandler),
      stdio: { stdout: stdoutHandler, stderr: stderrHandler },
      createWorker: createWorkerFactory(memFs),
    });

    try {
      // bash -c 'true' exits 0
      const proc = runtime.exec('bash', { args: ['-c', 'true'] });
      const code = await runtime.waitAsync(proc);
      assert.equal(code, 0);
    } finally {
      runtime[Symbol.dispose]();
    }
  });

  it('dispose cleans up', () => {
    const memFs = new MemoryFsProvider();
    const { handler: stdoutHandler } = createCaptureStdout();
    const { handler: stderrHandler } = createCaptureStderr();

    const runtime = new Runtime({
      fs: createTestVfs(memFs, stdoutHandler, stderrHandler),
      stdio: { stdout: stdoutHandler, stderr: stderrHandler },
      createWorker: createWorkerFactory(memFs),
    });

    // Should not throw
    runtime[Symbol.dispose]();
    // Calling dispose again should not throw
    runtime[Symbol.dispose]();
  });

  it('multiple concurrent exec calls', async () => {
    const memFs = new MemoryFsProvider();
    const { handler: stdoutHandler, chunks } = createCaptureStdout();
    const { handler: stderrHandler } = createCaptureStderr();

    const runtime = new Runtime({
      fs: createTestVfs(memFs, stdoutHandler, stderrHandler),
      stdio: { stdout: stdoutHandler, stderr: stderrHandler },
      createWorker: createWorkerFactory(memFs),
    });

    try {
      const proc1 = runtime.exec('basename', { args: ['/a/one'] });
      const proc2 = runtime.exec('basename', { args: ['/b/two'] });
      const proc3 = runtime.exec('basename', { args: ['/c/three'] });

      const [code1, code2, code3] = await Promise.all([
        runtime.waitAsync(proc1),
        runtime.waitAsync(proc2),
        runtime.waitAsync(proc3),
      ]);

      assert.equal(code1, 0);
      assert.equal(code2, 0);
      assert.equal(code3, 0);

      const output = getOutput(chunks);
      assert.ok(output.includes('one'), 'output should contain "one"');
      assert.ok(output.includes('two'), 'output should contain "two"');
      assert.ok(output.includes('three'), 'output should contain "three"');
    } finally {
      runtime[Symbol.dispose]();
    }
  });
});
