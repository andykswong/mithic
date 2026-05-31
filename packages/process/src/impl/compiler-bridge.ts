import { MessageChannel } from 'node:worker_threads';
import { createBlockingCall, type BlockingCallFn } from '@mithic/io/io';
import type { WorkerFactory, ManagedWorker } from './worker-factory.ts';

const CALL_COMPILE = 1;

export interface CompileResult {
  modules: Record<string, Uint8Array>;
  jsFiles?: Record<string, string>;
  cached: boolean;
}

export interface CompilerBridge extends Disposable {
  compile(bytes: Uint8Array): CompileResult;
}

export function createCompilerBridge(factory: WorkerFactory): CompilerBridge {
  const { port1, port2 } = new MessageChannel();

  const worker: ManagedWorker = factory.create(
    new URL('./compiler-worker.ts', import.meta.url),
    { name: 'mithic-compiler' },
  );

  // Transfer port2 to the compiler Worker
  worker.postMessage({ type: '__compilerPort', port: port2 }, [port2 as unknown as Transferable]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blockingCall: BlockingCallFn = createBlockingCall(port1 as any);

  return {
    compile(bytes: Uint8Array): CompileResult {
      return blockingCall(CALL_COMPILE, null, { bytes }) as CompileResult;
    },
    [Symbol.dispose]() {
      port1.close();
      worker.terminate();
    },
  };
}
