import { MemoryFsProvider } from '@mithic/io/vfs';
import { SimpleProcessManager } from '@mithic/process/impl/simple';
import type { CommandHandler } from '@mithic/process/impl/simple';
import { MithicShell } from '@mithic/shell';
import { ComponentExit } from '@mithic/wasip2/cli/exit';
import { Descriptor } from '@mithic/wasip2/filesystem/types';
import { SyncFsDescriptorHandler } from '@mithic/wasip2/filesystem/sync-fs-handler';
import type { SyncInputStreamHandler } from '@mithic/io/io';
import type { Signal } from '@mithic/process/types';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const initPromise = new Promise<{ signal: SharedArrayBuffer; data: SharedArrayBuffer }>((resolve) => {
  globalThis.onmessage = (e: MessageEvent) => {
    if (e.data?.type === 'init') {
      resolve({ signal: e.data.signal, data: e.data.data });
    }
  };
});

const { signal, data } = await initPromise;
const signalView = new Int32Array(signal);
const dataView = new Uint8Array(data);

function sigFromNum(num: number): Signal | null {
  switch (num) {
    case 2: return 'sigint';
    case 9: return 'sigkill';
    case 15: return 'sigterm';
    case 18: return 'sigcont';
    case 20: return 'sigtstp';
    default: return null;
  }
}

let stdinRemainder = new Uint8Array(0);
let shell: MithicShell;

const sabStdinHandler: SyncInputStreamHandler = {
  blockingRead(len: number): Uint8Array {
    if (stdinRemainder.byteLength > 0) {
      const chunk = stdinRemainder.subarray(0, Math.min(len, stdinRemainder.byteLength));
      stdinRemainder = stdinRemainder.subarray(chunk.byteLength);
      return chunk;
    }

    while (Atomics.load(signalView, 0) === 0) {
      Atomics.wait(signalView, 0, 0);
    }

    const pendingSig = Atomics.load(signalView, 2);
    if (pendingSig !== 0) {
      Atomics.store(signalView, 2, 0);
      const sig = sigFromNum(pendingSig);
      if (sig && shell.hasForeground) {
        shell.signal(sig);
      }
      Atomics.store(signalView, 0, 0);
      Atomics.store(signalView, 1, 0);
      return encoder.encode('\n');
    }

    if (Atomics.load(signalView, 0) === 2) {
      throw { tag: 'closed' };
    }

    const byteLen = Atomics.load(signalView, 1);
    const bytes = new Uint8Array(byteLen);
    bytes.set(dataView.subarray(0, byteLen));
    Atomics.store(signalView, 0, 0);
    Atomics.store(signalView, 1, 0);

    if (bytes.byteLength <= len) {
      return bytes;
    }
    stdinRemainder = bytes.subarray(len);
    return bytes.subarray(0, len);
  },
};

const memFs = new MemoryFsProvider();
memFs.mkdir('/home');
memFs.mkdir('/tmp');
memFs.mkdir('/bin');

const manager = new SimpleProcessManager({
  commandResolver: (file: string) => {
    if (file === 'example') return createExampleCommand();
    return undefined;
  },
});

function createExampleCommand(): CommandHandler {
  return async (args, ctx) => {
    const { WASIShim } = await import('@mithic/wasip2');
    const shim = new WASIShim({
      sandbox: {
        args: ['example', ...args],
        env: ctx.env,
        stdin: ctx.stdin,
        stdout: ctx.stdout,
        stderr: ctx.stderr,
      }
    });
    try {
      const { instantiate, modules } = await import('@mithic/example-rust-cli/component');
      const { run } = await instantiate(
        async (path: keyof typeof modules) => modules[path] && WebAssembly.compile(await (await fetch(modules[path])).arrayBuffer()),
        shim.getImportObject()
      );
      run.run();
      return 0;
    } catch (e: unknown) {
      if (e instanceof ComponentExit) return e.code;
      ctx.stderr.write(encoder.encode(`example: ${String(e)}\n`));
      return 1;
    } finally {
      shim[Symbol.dispose]();
    }
  };
}

const rootDescriptor = new Descriptor(new SyncFsDescriptorHandler(memFs, '/'));

shell = new MithicShell({
  wasi: {
    sandbox: {
      preopens: { '/': rootDescriptor },
      args: ['msh'],
      env: { HOME: '/home', PATH: '/bin', USER: 'user', TERM: 'xterm-256color', PWD: '/home' },
      cwd: '/home',
      stdin: {
        handler: sabStdinHandler,
        isatty: true,
      },
      stdout: {
        handler: {
          write(data: Uint8Array): void {
            globalThis.postMessage({ type: 'stdout', value: decoder.decode(data) });
          },
        },
        isatty: true,
      },
      stderr: {
        handler: {
          write(data: Uint8Array): void {
            globalThis.postMessage({ type: 'stderr', value: decoder.decode(data) });
          },
        },
        isatty: false,
      },
    },
  },
  process: { manager },
  component: () => import('@mithic/shell/component'),
});

try {
  const exitCode = await shell.run();
  globalThis.postMessage({ type: 'exit', code: exitCode });
} catch (e: unknown) {
  if (e instanceof ComponentExit) {
    globalThis.postMessage({ type: 'exit', code: e.code });
  } else {
    globalThis.postMessage({ type: 'stderr', value: `worker error: ${String(e)}\n` });
    globalThis.postMessage({ type: 'exit', code: 1 });
  }
}
