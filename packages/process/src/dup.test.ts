import { describe, it } from 'node:test';
import { deepStrictEqual } from 'node:assert';
import { SimpleProcessManager } from './impl/simple.ts';

describe('dupOutputStream', () => {
  it('duplicate writes to the same pipe destination', () => {
    const manager = new SimpleProcessManager();
    const { input, output } = manager.createPipe();
    const dup = manager.dupOutputStream(output);

    output.blockingWriteAndFlush(new Uint8Array([1, 2, 3]));
    dup.blockingWriteAndFlush(new Uint8Array([4, 5, 6]));

    const chunk1 = input.blockingRead(3n);
    const chunk2 = input.blockingRead(3n);
    deepStrictEqual(chunk1, new Uint8Array([1, 2, 3]));
    deepStrictEqual(chunk2, new Uint8Array([4, 5, 6]));
  });

  it('disposing the dup does NOT close the original', () => {
    const manager = new SimpleProcessManager();
    const { input, output } = manager.createPipe();
    const dup = manager.dupOutputStream(output);

    dup[Symbol.dispose]();

    output.blockingWriteAndFlush(new Uint8Array([7, 8]));
    const chunk = input.blockingRead(2n);
    deepStrictEqual(chunk, new Uint8Array([7, 8]));
  });

  it('dup still works after original is disposed — ref-count keeps handler alive until last handle gone', () => {
    const manager = new SimpleProcessManager();
    const { input, output } = manager.createPipe();
    const dup = manager.dupOutputStream(output);

    output[Symbol.dispose]();

    dup.blockingWriteAndFlush(new Uint8Array([9]));
    const chunk = input.blockingRead(1n);
    deepStrictEqual(chunk, new Uint8Array([9]));
  });
});
