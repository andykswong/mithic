import type { CompileResult } from '../component/compiler.ts';
import { exitSlotFromBuffer, signalSlotFromBuffer } from '../io/slots.ts';
import { inputFromSharedBuffer, outputFromSharedBuffer } from '../io/pipes.ts';
import { wrapInputWithSignalCheck, wrapOutputWithSignalCheck } from '../io/signal-stream.ts';
import { WASIShim } from '@mithic/wasip2';
import { WASIProcess } from '@mithic/process/instantiation';
import { ComponentExit } from '@mithic/wasip2/cli/exit';
import { Descriptor } from '@mithic/wasip2/filesystem/types';
import { SyncFsDescriptorHandler } from '@mithic/wasip2/filesystem/sync-fs-handler';
import { WorkerIo, createBlockingCall } from '@mithic/io/io';
import { InputStream, OutputStream } from '@mithic/wasip2/io/streams';
import { SyncBridgeFsProvider } from '@mithic/io/io/providers/sync-bridge';
import { SyncFileSystemRouter } from '@mithic/io/vfs';
import { ProxyProcessManager } from '../manager/proxy.ts';
import { SimpleProcessManager } from '../manager/simple.ts';
import type { ProcessManager } from '../types.ts';

export interface RunMessage {
  type: 'run';
  compileResult: CompileResult;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  exitSlotBuf: SharedArrayBuffer;
  signalSlotBuf: SharedArrayBuffer;
  stdinBuf: SharedArrayBuffer;
  stdinBufSize: number;
  stdoutBuf: SharedArrayBuffer;
  stdoutBufSize: number;
  stderrBuf: SharedArrayBuffer;
  stderrBufSize: number;
  inheritStdin?: boolean;
  inheritStdout?: boolean;
  inheritStderr?: boolean;
  isattyStdin?: boolean;
  isattyStdout?: boolean;
  isattyStderr?: boolean;
  ioPort?: MessagePort;
  spawnPort?: MessagePort;
}

export async function handleRunMessage(msg: RunMessage): Promise<void> {
  const exitSlot = exitSlotFromBuffer(msg.exitSlotBuf);
  const signalSlot = signalSlotFromBuffer(msg.signalSlotBuf);

  // Create IoLoop connection (shared for VFS + inherited stdio)
  const workerIo = msg.ioPort ? new WorkerIo(msg.ioPort) : undefined;

  // Use IoLoop sync-bridge for inherited stdio, SharedPipe SABs for piped stdio
  let rawStdin: InstanceType<typeof InputStream>;
  let rawStdout: InstanceType<typeof OutputStream>;
  let rawStderr: InstanceType<typeof OutputStream>;

  if (workerIo && (msg.inheritStdin || msg.inheritStdout || msg.inheritStderr)) {
    const { createStdinHandler, createStdoutHandler, createStderrHandler } = await import('@mithic/io/io/providers/sync-bridge');
    rawStdin = msg.inheritStdin
      ? new InputStream(createStdinHandler(workerIo), undefined, msg.isattyStdin)
      : inputFromSharedBuffer(msg.stdinBuf, msg.stdinBufSize);
    rawStdout = msg.inheritStdout
      ? new OutputStream(createStdoutHandler(workerIo), undefined, msg.isattyStdout)
      : outputFromSharedBuffer(msg.stdoutBuf, msg.stdoutBufSize);
    rawStderr = msg.inheritStderr
      ? new OutputStream(createStderrHandler(workerIo), undefined, msg.isattyStderr)
      : outputFromSharedBuffer(msg.stderrBuf, msg.stderrBufSize);
  } else {
    rawStdin = inputFromSharedBuffer(msg.stdinBuf, msg.stdinBufSize);
    rawStdout = outputFromSharedBuffer(msg.stdoutBuf, msg.stdoutBufSize);
    rawStderr = outputFromSharedBuffer(msg.stderrBuf, msg.stderrBufSize);
  }

  const stdin = wrapInputWithSignalCheck(rawStdin, signalSlot);
  const stdout = wrapOutputWithSignalCheck(rawStdout, signalSlot);
  const stderr = wrapOutputWithSignalCheck(rawStderr, signalSlot);

  try {
    const jsSource = msg.compileResult.jsFiles?.['component.js'];
    if (!jsSource) {
      rawStdout[Symbol.dispose]();
      rawStderr[Symbol.dispose]();
      rawStdin[Symbol.dispose]();
      exitSlot.setExitCode(126);
      return;
    }

    // Use native ESM import via data URL
    const encoded = typeof Buffer !== 'undefined'
      ? Buffer.from(jsSource).toString('base64')
      : btoa(jsSource);
    const dataUrl = `data:text/javascript;base64,${encoded}`;
    const mod = await import(/* webpackIgnore: true */ dataUrl);
    const instantiate = mod.instantiate as (
      compileCore: (path: string) => Promise<WebAssembly.Module>,
      imports: Record<string, object>,
    ) => Promise<{ run: { run: () => number } }>;

    const compileCore = async (path: string): Promise<WebAssembly.Module> => {
      const bytes = msg.compileResult.modules[path];
      if (!bytes) throw new Error(`Module not found: ${path}`);
      return WebAssembly.compile(bytes.slice().buffer);
    };

    // VFS via IoLoop sync-bridge (when available)
    let preopens: Record<string, Descriptor> | undefined;
    if (workerIo) {
      const syncFs = new SyncBridgeFsProvider(workerIo);
      const vfs = new SyncFileSystemRouter();
      vfs.mount('/', syncFs);
      preopens = { '/': new Descriptor(new SyncFsDescriptorHandler(vfs, '/')) };
    }

    // Process management: ProxyProcessManager when spawn port available, else graceful fallback
    let processManager: ProcessManager;
    if (msg.spawnPort) {
      const blockingCall = createBlockingCall(msg.spawnPort);
      processManager = new ProxyProcessManager(blockingCall);
    } else {
      processManager = new SimpleProcessManager();
    }

    const shim = new WASIShim({
      sandbox: {
        args: msg.args,
        env: msg.env,
        cwd: msg.cwd,
        stdin,
        stdout,
        stderr,
        preopens,
      },
    });

    const wasiProcess = new WASIProcess({ manager: processManager });
    const imports = { ...shim.getImportObject(), ...wasiProcess.getImportObject() };

    const { run } = await instantiate(compileCore, imports);
    const code = run.run() ?? 0;
    shim[Symbol.dispose]();
    // Dispose raw streams directly to ensure WRITER_CLOSED/READER_CLOSED is set
    // on the SharedPipe SABs. The signal wrappers and jco's dup may hold extra
    // refcounts that prevent the handler.drop() from firing via OutputStream.dispose().
    rawStdout[Symbol.dispose]();
    rawStderr[Symbol.dispose]();
    rawStdin[Symbol.dispose]();
    exitSlot.setExitCode(code);
  } catch (e: unknown) {
    rawStdout[Symbol.dispose]();
    rawStderr[Symbol.dispose]();
    rawStdin[Symbol.dispose]();
    if (e instanceof ComponentExit) {
      exitSlot.setExitCode(e.code);
    } else if (e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'number') {
      exitSlot.setExitCode((e as { code: number }).code);
    } else {
      exitSlot.setExitCode(1);
    }
  }
}
