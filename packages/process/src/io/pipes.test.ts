import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPipe, createSharedPipeRaw, inputFromSharedBuffer, outputFromSharedBuffer } from './pipes.ts';
import type { StreamError } from '@mithic/wasip2/io/streams';

describe('createPipe (QueuePipe)', () => {
  it('data written to output is readable from input', () => {
    const { input, output } = createPipe();
    output.write(new Uint8Array([1, 2, 3]));
    const data = input.read(3n);
    assert.deepEqual(data, new Uint8Array([1, 2, 3]));
  });

  it('read returns empty when no data available', () => {
    const { input } = createPipe();
    const data = input.read(10n);
    assert.equal(data.byteLength, 0);
  });

  it('multiple writes are read in order', () => {
    const { input, output } = createPipe();
    output.write(new Uint8Array([1, 2]));
    output.write(new Uint8Array([3, 4]));
    const chunk1 = input.read(2n);
    const chunk2 = input.read(2n);
    assert.deepEqual(chunk1, new Uint8Array([1, 2]));
    assert.deepEqual(chunk2, new Uint8Array([3, 4]));
  });

  it('partial read returns requested length from chunk', () => {
    const { input, output } = createPipe();
    output.write(new Uint8Array([10, 20, 30, 40, 50]));
    const first = input.read(2n);
    const rest = input.read(10n);
    assert.deepEqual(first, new Uint8Array([10, 20]));
    assert.deepEqual(rest, new Uint8Array([30, 40, 50]));
  });

  describe('EOF propagation', () => {
    it('writer close causes blockingRead to throw closed', () => {
      const { input, output } = createPipe();
      output[Symbol.dispose]();
      assert.throws(
        () => input.blockingRead(10n),
        (err: StreamError) => err.tag === 'closed',
      );
    });

    it('subscribe becomes ready when writer closes', () => {
      const { input, output } = createPipe();
      const pollable = input.subscribe();
      assert.equal(pollable.ready(), false);
      output[Symbol.dispose]();
      assert.equal(pollable.ready(), true);
    });
  });

  describe('broken-pipe', () => {
    it('reader close causes write to throw', () => {
      const { input, output } = createPipe();
      input[Symbol.dispose]();
      assert.throws(
        () => output.write(new Uint8Array([1])),
        (err: StreamError) => err.tag === 'closed' || err.tag === 'last-operation-failed',
      );
    });

    it('checkWrite returns 0 when reader is closed', () => {
      const { input, output } = createPipe();
      input[Symbol.dispose]();
      assert.equal(Number(output.checkWrite()), 0);
    });
  });

  describe('backpressure', () => {
    it('checkWrite returns available space', () => {
      const { output } = createPipe({ bufferSize: 100 });
      assert.equal(Number(output.checkWrite()), 100);
    });

    it('checkWrite decreases as data is written', () => {
      const { output } = createPipe({ bufferSize: 100 });
      output.write(new Uint8Array(60));
      assert.equal(Number(output.checkWrite()), 40);
    });

    it('checkWrite returns 0 when buffer is full', () => {
      const { output } = createPipe({ bufferSize: 10 });
      output.write(new Uint8Array(10));
      assert.equal(Number(output.checkWrite()), 0);
    });

    it('reading frees space', () => {
      const { input, output } = createPipe({ bufferSize: 10 });
      output.write(new Uint8Array(10));
      assert.equal(Number(output.checkWrite()), 0);
      input.read(5n);
      assert.equal(Number(output.checkWrite()), 5);
    });

    it('subscribe on output becomes ready when space available', () => {
      const { input, output } = createPipe({ bufferSize: 5 });
      output.write(new Uint8Array(5));
      const pollable = output.subscribe();
      assert.equal(pollable.ready(), false);
      input.read(1n);
      assert.equal(pollable.ready(), true);
    });

    it('write exceeding buffer throws last-operation-failed (buffer-overflow)', () => {
      const { output } = createPipe({ bufferSize: 10 });
      output.write(new Uint8Array(10));
      assert.throws(
        () => output.write(new Uint8Array(1)),
        (err: StreamError) => err.tag === 'last-operation-failed',
      );
    });
  });
});

describe('createPipe (SharedPipe)', () => {
  it('data written to output is readable from input', () => {
    const { input, output } = createPipe({ shared: true, bufferSize: 1024 });
    output.write(new Uint8Array([5, 6, 7]));
    const data = input.read(3n);
    assert.deepEqual(data, new Uint8Array([5, 6, 7]));
  });

  it('writer close causes blockingRead to throw closed', () => {
    const { input, output } = createPipe({ shared: true });
    output[Symbol.dispose]();
    assert.throws(
      () => input.blockingRead(10n),
      (err: StreamError) => err.tag === 'closed',
    );
  });

  it('reader close causes write to throw', () => {
    const { input, output } = createPipe({ shared: true });
    input[Symbol.dispose]();
    assert.throws(
      () => output.write(new Uint8Array([1])),
      (err: StreamError) => err.tag === 'closed' || err.tag === 'last-operation-failed',
    );
  });

  it('subscribe becomes ready when data available', () => {
    const { input, output } = createPipe({ shared: true, bufferSize: 1024 });
    const pollable = input.subscribe();
    assert.equal(pollable.ready(), false);
    output.write(new Uint8Array([1]));
    assert.equal(pollable.ready(), true);
  });

  it('write exceeding free space throws last-operation-failed', () => {
    const { output } = createPipe({ shared: true, bufferSize: 16 });
    // Fill the buffer (bufferSize - 1 = 15 usable bytes)
    output.write(new Uint8Array(15));
    // Attempt to write 1 more byte — should throw
    assert.throws(
      () => output.write(new Uint8Array([99])),
      (err: StreamError) => err.tag === 'last-operation-failed',
    );
  });

  it('checkWrite returns 0 when buffer is full', () => {
    const { output } = createPipe({ shared: true, bufferSize: 16 });
    output.write(new Uint8Array(15));
    assert.equal(output.checkWrite(), 0n);
  });
});

describe('createPipe (SharedPipe) bulk operations', () => {
  it('handles wrap-around writes correctly', () => {
    const { input, output } = createPipe({ shared: true, bufferSize: 16 });
    // Write 10 bytes, read 10 bytes (move read pointer to 10)
    output.write(new Uint8Array([1,2,3,4,5,6,7,8,9,10]));
    input.blockingRead(10n);
    // Write 10 bytes starting at position 10 — wraps around at 16
    output.write(new Uint8Array([11,12,13,14,15,16,17,18,19,20]));
    const result = input.blockingRead(10n);
    assert.deepEqual(result, new Uint8Array([11,12,13,14,15,16,17,18,19,20]));
  });

  it('large write fills entire buffer correctly', () => {
    const { input, output } = createPipe({ shared: true, bufferSize: 64 });
    const big = new Uint8Array(63); // max usable = bufferSize - 1
    for (let i = 0; i < 63; i++) big[i] = i;
    output.write(big);
    const result = input.blockingRead(63n);
    assert.deepEqual(result, big);
  });
});

describe('SharedPipe stress', () => {
  it('survives rapid alternating read/write cycles', () => {
    const { input, output } = createPipe({ shared: true, bufferSize: 256 });
    const written: number[] = [];
    const read: number[] = [];

    for (let i = 0; i < 1000; i++) {
      const chunk = new Uint8Array([i & 0xff]);
      output.write(chunk);
      written.push(i & 0xff);
      const result = input.read(1n);
      if (result.byteLength > 0) read.push(result[0]!);
    }
    // Drain remaining
    output[Symbol.dispose]();
    try {
      while (true) {
        const result = input.blockingRead(256n) as Uint8Array;
        for (const b of result) read.push(b);
      }
    } catch { /* closed */ }

    assert.deepEqual(read, written);
  });

  it('handles full buffer -> drain -> refill cycle', () => {
    const { input, output } = createPipe({ shared: true, bufferSize: 32 });
    for (let cycle = 0; cycle < 10; cycle++) {
      const data = new Uint8Array(31); // max fill
      data.fill(cycle);
      output.write(data);
      const result = input.blockingRead(31n);
      assert.deepEqual(result, data);
    }
  });
});

describe('SharedPipe SAB reconstruction', () => {
  it('inputFromSharedBuffer reads data written by outputFromSharedBuffer', () => {
    const pipe = createSharedPipeRaw(1024);
    const output = outputFromSharedBuffer(pipe.buffer, pipe.bufferSize);
    const input = inputFromSharedBuffer(pipe.buffer, pipe.bufferSize);
    output.write(new Uint8Array([1, 2, 3, 4]));
    const data = input.read(4n);
    assert.deepEqual(data, new Uint8Array([1, 2, 3, 4]));
  });

  it('writer close propagates across buffer reconstruction', () => {
    const pipe = createSharedPipeRaw(1024);
    const output = outputFromSharedBuffer(pipe.buffer, pipe.bufferSize);
    const input = inputFromSharedBuffer(pipe.buffer, pipe.bufferSize);
    output[Symbol.dispose]();
    assert.throws(
      () => input.blockingRead(1n),
      (err: StreamError) => err.tag === 'closed',
    );
  });

  it('reader close causes write to throw broken-pipe', () => {
    const pipe = createSharedPipeRaw(1024);
    const output = outputFromSharedBuffer(pipe.buffer, pipe.bufferSize);
    const input = inputFromSharedBuffer(pipe.buffer, pipe.bufferSize);
    input[Symbol.dispose]();
    assert.throws(
      () => output.write(new Uint8Array([1])),
      (err: StreamError) => err.tag === 'closed' || err.tag === 'last-operation-failed',
    );
  });

  it('wrap-around works with reconstructed streams', () => {
    const pipe = createSharedPipeRaw(16);
    const output = outputFromSharedBuffer(pipe.buffer, pipe.bufferSize);
    const input = inputFromSharedBuffer(pipe.buffer, pipe.bufferSize);
    // Write 10 bytes, read 10 (move read pointer to 10)
    output.write(new Uint8Array([1,2,3,4,5,6,7,8,9,10]));
    input.blockingRead(10n);
    // Write 10 more starting at position 10 — wraps around at 16
    output.write(new Uint8Array([11,12,13,14,15,16,17,18,19,20]));
    const result = input.blockingRead(10n);
    assert.deepEqual(result, new Uint8Array([11,12,13,14,15,16,17,18,19,20]));
  });

  it('createSharedPipeRaw creates correct size buffer', () => {
    const pipe = createSharedPipeRaw(256);
    assert.equal(pipe.buffer.byteLength, 16 + 256); // HEADER_SIZE + bufferSize
    assert.equal(pipe.bufferSize, 256);
  });
});
