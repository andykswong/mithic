const DATA_ADDR = 16;
const DATA_START = DATA_ADDR + 8;

const AsyncifyState = {
  None: 0,
  Unwinding: 1,
  Rewinding: 2,
} as const;

interface AsyncifyExports {
  asyncify_memory: WebAssembly.Memory;
  asyncify_start_unwind: (addr: number) => void;
  asyncify_stop_unwind: () => void;
  asyncify_start_rewind: (addr: number) => void;
  asyncify_stop_rewind: () => void;
  asyncify_get_state: () => number;
}

export class Asyncify {
  #value: unknown;
  #exports: AsyncifyExports | undefined;

  init(instance: WebAssembly.Instance): void {
    this.#exports = instance.exports as unknown as AsyncifyExports;
    const memory = this.#exports.asyncify_memory;
    const end = memory.buffer.byteLength;
    new Int32Array(memory.buffer, DATA_ADDR).set([DATA_START, end]);
  }

  getState(): number {
    return this.#exports!.asyncify_get_state();
  }

  wrapImportFn(fn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown {
    return (...args: unknown[]) => {
      if (this.getState() === AsyncifyState.Rewinding) {
        this.#exports!.asyncify_stop_rewind();
        return this.#value;
      }
      const result = fn(...args);
      if (isPromise(result)) {
        this.#exports!.asyncify_start_unwind(DATA_ADDR);
        this.#value = result;
      }
      return result;
    };
  }

  wrapExportFn(fn: (...args: unknown[]) => unknown): (...args: unknown[]) => Promise<unknown> {
    return async (...args: unknown[]) => {
      let result = fn(...args);
      while (this.getState() === AsyncifyState.Unwinding) {
        this.#exports!.asyncify_stop_unwind();
        this.#value = await (this.#value as Promise<unknown>);
        this.#exports!.asyncify_start_rewind(DATA_ADDR);
        result = fn(...args);
      }
      return result;
    };
  }
}

function isPromise(value: unknown): value is Promise<unknown> {
  return !!value && typeof (value as { then?: unknown }).then === 'function';
}
