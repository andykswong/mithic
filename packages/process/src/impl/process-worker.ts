import type { CompileResult } from './compiler-bridge.ts';

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
}

export async function handleRunMessage(msg: RunMessage): Promise<void> {
  const { exitSlotFromBuffer, signalSlotFromBuffer } = await import('./slots.ts');
  const { inputFromSharedBuffer, outputFromSharedBuffer } = await import('../utils.ts');

  const exitSlot = exitSlotFromBuffer(msg.exitSlotBuf);
  signalSlotFromBuffer(msg.signalSlotBuf);

  const stdin = inputFromSharedBuffer(msg.stdinBuf, msg.stdinBufSize);
  const stdout = outputFromSharedBuffer(msg.stdoutBuf, msg.stdoutBufSize);
  const stderr = outputFromSharedBuffer(msg.stderrBuf, msg.stderrBufSize);

  try {
    const { WASIShim } = await import('@mithic/wasip2');
    const { WASIProcess } = await import('@mithic/process/instantiation');
    const { SimpleProcessManager } = await import('./simple.ts');

    const jsSource = msg.compileResult.jsFiles?.['component.js'];
    if (!jsSource) {
      exitSlot.setExitCode(126);
      return;
    }

    // Create blob URL from jco JS source and dynamically import it
    const blob = new Blob([jsSource], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    let instantiate: (
      compileCore: (path: string) => Promise<WebAssembly.Module>,
      imports: Record<string, object>,
    ) => Promise<{ run: { run: () => number } }>;

    try {
      const mod = await import(/* webpackIgnore: true */ blobUrl);
      instantiate = mod.instantiate;
    } finally {
      URL.revokeObjectURL(blobUrl);
    }

    const compileCore = async (path: string): Promise<WebAssembly.Module> => {
      const bytes = msg.compileResult.modules[path];
      if (!bytes) throw new Error(`Module not found: ${path}`);
      return WebAssembly.compile(bytes.slice().buffer);
    };

    const shim = new WASIShim({
      sandbox: {
        args: msg.args,
        env: msg.env,
        cwd: msg.cwd,
        stdin,
        stdout,
        stderr,
      },
    });

    const processManager = new SimpleProcessManager();
    const wasiProcess = new WASIProcess({ manager: processManager });
    const imports = { ...shim.getImportObject(), ...wasiProcess.getImportObject() };

    const { run } = await instantiate(compileCore, imports);
    const code = run.run() ?? 0;
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
