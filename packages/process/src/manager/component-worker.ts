import type { ProcessWorker, RunOptions } from '../types.ts';
import type { CompileResult } from '../component/compiler.ts';

export class ComponentProcessWorker implements ProcessWorker {
  readonly #worker: Worker;
  readonly #compileResult: CompileResult;

  constructor(worker: Worker, compileResult: CompileResult) {
    this.#worker = worker;
    this.#compileResult = compileResult;
  }

  run(options: RunOptions, transfer: Transferable[]) {
    this.#worker.postMessage({ type: 'run', compileResult: this.#compileResult, ...options }, transfer);
  }

  terminate() { this.#worker.terminate(); }

  addEventListener(type: 'error' | 'close', handler: () => void) {
    if (type === 'close') {
      this.#worker.addEventListener('message', ((e: MessageEvent) => {
        if (e.data?.type === 'close') handler();
      }) as EventListener);
    }
    this.#worker.addEventListener(type, handler as EventListener);
  }
}
