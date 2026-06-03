import { exitSlotFromBuffer } from '../io/slots.ts';
import type { ProcessWorker, RunOptions } from '../types.ts';

export class InlineProcessWorker implements ProcessWorker {
  readonly #handler: (options: RunOptions) => number | Promise<number>;
  readonly #closeHandlers: Array<() => void> = [];

  constructor(handler: (options: RunOptions) => number | Promise<number>) {
    this.#handler = handler;
  }

  run(options: RunOptions, _transfer: Transferable[]) {
    const exitSlot = exitSlotFromBuffer(options.exitSlotBuf);
    Promise.resolve().then(() => this.#handler(options)).then(
      (code) => {
        exitSlot.setExitCode(code);
        for (const fn of this.#closeHandlers) fn();
      },
      () => {
        exitSlot.setExitCode(1);
        for (const fn of this.#closeHandlers) fn();
      },
    );
  }

  terminate() {}

  addEventListener(type: 'error' | 'close', handler: () => void) {
    if (type === 'close') this.#closeHandlers.push(handler);
  }
}
