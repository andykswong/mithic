import type { CompileResult } from '../component/compiler.ts';
import type { Descriptor } from '@mithic/wasip2/filesystem/types';

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
  ioPort?: MessagePort;
}

export async function handleRunMessage(msg: RunMessage): Promise<void> {
  const { exitSlotFromBuffer, signalSlotFromBuffer } = await import('../io/slots.ts');
  const { inputFromSharedBuffer, outputFromSharedBuffer } = await import('../io/pipes.ts');
  const { InputStream, OutputStream } = await import('@mithic/wasip2/io/streams');

  const exitSlot = exitSlotFromBuffer(msg.exitSlotBuf);
  const signalSlot = signalSlotFromBuffer(msg.signalSlotBuf);

  const { wrapInputWithSignalCheck, wrapOutputWithSignalCheck } = await import('../io/signal-stream.ts');

  let rawStdin: InstanceType<typeof InputStream>;
  let rawStdout: InstanceType<typeof OutputStream>;
  let rawStderr: InstanceType<typeof OutputStream>;

  if (msg.inheritStdin || msg.inheritStdout || msg.inheritStderr) {
    const { NodeStdinHandler, NodeStdoutHandler, NodeStderrHandler } = await import('@mithic/io/io/providers/node-stdio');
    rawStdin = msg.inheritStdin
      ? new InputStream(new NodeStdinHandler())
      : inputFromSharedBuffer(msg.stdinBuf, msg.stdinBufSize);
    rawStdout = msg.inheritStdout
      ? new OutputStream(new NodeStdoutHandler())
      : outputFromSharedBuffer(msg.stdoutBuf, msg.stdoutBufSize);
    rawStderr = msg.inheritStderr
      ? new OutputStream(new NodeStderrHandler())
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
    const { WASIShim } = await import('@mithic/wasip2');
    const { WASIProcess } = await import('@mithic/process/instantiation');
    const { SimpleProcessManager } = await import('../manager/simple.ts');

    const jsSource = msg.compileResult.jsFiles?.['component.js'];
    if (!jsSource) {
      exitSlot.setExitCode(126);
      return;
    }

    // Import jco JS source via data URL (works in both Node.js workers and browsers)
    const encoded = typeof Buffer !== 'undefined'
      ? Buffer.from(jsSource).toString('base64')
      : btoa(jsSource);
    const dataUrl = `data:text/javascript;base64,${encoded}`;

    const mod = await import(/* webpackIgnore: true */ dataUrl);
    const instantiate: (
      compileCore: (path: string) => Promise<WebAssembly.Module>,
      imports: Record<string, object>,
    ) => Promise<{ run: { run: () => number } }> = mod.instantiate;

    const compileCore = async (path: string): Promise<WebAssembly.Module> => {
      const bytes = msg.compileResult.modules[path];
      if (!bytes) throw new Error(`Module not found: ${path}`);
      return WebAssembly.compile(bytes.slice().buffer);
    };

    let preopens: Record<string, Descriptor> | undefined;
    if (msg.ioPort) {
      const { WorkerIo } = await import('@mithic/io/io');
      const { SyncBridgeFsProvider } = await import('@mithic/io/io/providers/sync-bridge');
      const { SyncFileSystemRouter } = await import('@mithic/io/vfs');
      const { Descriptor } = await import('@mithic/wasip2/filesystem/types');
      const { SyncFsDescriptorHandler } = await import('@mithic/wasip2/filesystem/sync-fs-handler');

      const workerIo = new WorkerIo(msg.ioPort);
      const syncFs = new SyncBridgeFsProvider(workerIo);
      const vfs = new SyncFileSystemRouter();
      vfs.mount('/', syncFs);
      preopens = { '/': new Descriptor(new SyncFsDescriptorHandler(vfs, '/')) };
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

    // TODO: SimpleProcessManager suffices for leaf commands (cat, echo, etc.) that never spawn
    // children. A nested shell (running scripts with pipelines) would need ProxyProcessManager
    // delegating back to the orchestrating thread via sync-bridge.
    const processManager = new SimpleProcessManager();
    const wasiProcess = new WASIProcess({ manager: processManager });
    const imports = { ...shim.getImportObject(), ...wasiProcess.getImportObject() };

    const { run } = await instantiate(compileCore, imports);
    const code = run.run() ?? 0;
    shim[Symbol.dispose]();
    exitSlot.setExitCode(code);
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'number') {
      exitSlot.setExitCode((e as { code: number }).code);
    } else {
      exitSlot.setExitCode(1);
    }
  } finally {
    stdout[Symbol.dispose]();
    stderr[Symbol.dispose]();
    stdin[Symbol.dispose]();
  }
}
