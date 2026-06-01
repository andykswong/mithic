import { createBlockingCall, type BlockingCallFn } from '@mithic/io/io';
import { CALL_COMPILE } from './compiler-handler.ts';

export interface CompileResult {
  modules: Record<string, Uint8Array>;
  jsFiles: Record<string, string>;
  cached: boolean;
}

export interface CompilerBridge extends Disposable {
  compile(bytes: Uint8Array): CompileResult;
}

export function createCompilerBridge(port: MessagePort): CompilerBridge {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blockingCall: BlockingCallFn = createBlockingCall(port as any);

  return {
    compile(bytes: Uint8Array): CompileResult {
      return blockingCall(CALL_COMPILE, null, { bytes }) as CompileResult;
    },
    [Symbol.dispose]() {
      port.close();
    },
  };
}
