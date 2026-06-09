import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAsyncQueuePipe } from './pipes.ts';
import type { StreamError } from '@mithic/wasip2/io/streams';

describe('createAsyncQueuePipe', () => {
  describe('blockingRead with data available', () => {
    it('returns Uint8Array directly (not a Promise)', () => {
      const { input, output } = createAsyncQueuePipe(1024);
      output.write(new Uint8Array([1, 2, 3]));
      const result = input.blockingRead(3n);
      assert.ok(!(result instanceof Promise), 'should not be a Promise when data is available');
      assert.deepEqual(result, new Uint8Array([1, 2, 3]));
    });

    it('returns partial data when less available than requested', () => {
      const { input, output } = createAsyncQueuePipe(1024);
      output.write(new Uint8Array([10, 20]));
      const result = input.blockingRead(5n);
      assert.ok(!(result instanceof Promise));
      assert.deepEqual(result, new Uint8Array([10, 20]));
    });
  });

  describe('blockingRead with empty queue', () => {
    it('returns a Promise that resolves when write() is called', async () => {
      const { input, output } = createAsyncQueuePipe(1024);
      const result = input.blockingRead(3n);
      assert.ok(result instanceof Promise, 'should return a Promise when queue is empty');

      // Write data to fulfill the pending reader
      output.write(new Uint8Array([4, 5, 6]));
      const data = await result;
      assert.deepEqual(data, new Uint8Array([4, 5, 6]));
    });

    it('resolves with only the requested amount', async () => {
      const { input, output } = createAsyncQueuePipe(1024);
      const result = input.blockingRead(2n);
      assert.ok(result instanceof Promise);

      output.write(new Uint8Array([10, 20, 30, 40]));
      const data = await result;
      assert.deepEqual(data, new Uint8Array([10, 20]));

      // Remaining data should be in the queue
      const remaining = input.read(5n);
      assert.deepEqual(remaining, new Uint8Array([30, 40]));
    });
  });

  describe('multiple pending readers', () => {
    it('resolved in FIFO order', async () => {
      const { input, output } = createAsyncQueuePipe(1024);

      const r1 = input.blockingRead(2n);
      const r2 = input.blockingRead(3n);
      assert.ok(r1 instanceof Promise);
      assert.ok(r2 instanceof Promise);

      // Write enough to satisfy both
      output.write(new Uint8Array([1, 2, 3, 4, 5]));

      const data1 = await r1;
      const data2 = await r2;
      assert.deepEqual(data1, new Uint8Array([1, 2]));
      assert.deepEqual(data2, new Uint8Array([3, 4, 5]));
    });

    it('partially satisfies readers based on available data', async () => {
      const { input, output } = createAsyncQueuePipe(1024);

      const r1 = input.blockingRead(3n);
      const r2 = input.blockingRead(3n);

      // Only write enough for the first reader
      output.write(new Uint8Array([10, 20, 30]));
      const data1 = await r1;
      assert.deepEqual(data1, new Uint8Array([10, 20, 30]));

      // Second reader is still pending, write more
      output.write(new Uint8Array([40, 50, 60]));
      const data2 = await r2;
      assert.deepEqual(data2, new Uint8Array([40, 50, 60]));
    });
  });

  describe('writer closes with pending readers', () => {
    it('readers get closed error (reject)', async () => {
      const { input, output } = createAsyncQueuePipe(1024);
      const result = input.blockingRead(5n);
      assert.ok(result instanceof Promise);

      output[Symbol.dispose]();

      await assert.rejects(result, (err: StreamError) => {
        assert.equal(err.tag, 'closed');
        return true;
      });
    });

    it('multiple pending readers all reject', async () => {
      const { input, output } = createAsyncQueuePipe(1024);
      const r1 = input.blockingRead(2n) as unknown as Promise<Uint8Array>;
      const r2 = input.blockingRead(3n) as unknown as Promise<Uint8Array>;

      output[Symbol.dispose]();

      await assert.rejects(r1, (err: StreamError) => err.tag === 'closed');
      await assert.rejects(r2, (err: StreamError) => err.tag === 'closed');
    });
  });

  describe('reader closes', () => {
    it('writer gets broken-pipe on next write', () => {
      const { input, output } = createAsyncQueuePipe(1024);
      input[Symbol.dispose]();
      assert.throws(
        () => output.write(new Uint8Array([1])),
        (err: StreamError) => err.tag === 'last-operation-failed',
      );
    });

    it('checkWrite returns 0 when reader is closed', () => {
      const { input, output } = createAsyncQueuePipe(1024);
      input[Symbol.dispose]();
      assert.equal(Number(output.checkWrite()), 0);
    });
  });

  describe('write resolves pending reader directly', () => {
    it('data goes straight to reader without queuing', async () => {
      const { input, output } = createAsyncQueuePipe(1024);
      const readerPromise = input.blockingRead(3n);
      assert.ok(readerPromise instanceof Promise);

      // Write data — it should go directly to the pending reader
      output.write(new Uint8Array([7, 8, 9]));

      // Queue should be empty — read() returns empty
      const queueCheck = input.read(10n);
      assert.equal(queueCheck.byteLength, 0);

      // The original reader should resolve
      const data = await readerPromise;
      assert.deepEqual(data, new Uint8Array([7, 8, 9]));
    });
  });

  describe('backpressure', () => {
    it('checkWrite returns 0 when buffer full', () => {
      const { output } = createAsyncQueuePipe(10);
      output.write(new Uint8Array(10));
      assert.equal(Number(output.checkWrite()), 0);
    });

    it('checkWrite returns available space', () => {
      const { output } = createAsyncQueuePipe(100);
      output.write(new Uint8Array(60));
      assert.equal(Number(output.checkWrite()), 40);
    });

    it('reading frees space', () => {
      const { input, output } = createAsyncQueuePipe(10);
      output.write(new Uint8Array(10));
      assert.equal(Number(output.checkWrite()), 0);
      input.read(5n);
      assert.equal(Number(output.checkWrite()), 5);
    });

    it('write exceeding buffer throws buffer-overflow', () => {
      const { output } = createAsyncQueuePipe(10);
      output.write(new Uint8Array(10));
      assert.throws(
        () => output.write(new Uint8Array(1)),
        (err: StreamError) => err.tag === 'last-operation-failed',
      );
    });
  });

  describe('Pollable.block() returns Promise when empty', () => {
    it('subscribe().block() returns Promise when no data available', () => {
      const { input } = createAsyncQueuePipe(1024);
      const pollable = input.subscribe();
      assert.equal(pollable.ready(), false);
      const result = pollable.block();
      assert.ok(result instanceof Promise, 'block() should return a Promise when no data');
    });

    it('subscribe().ready() returns true after data written', () => {
      const { input, output } = createAsyncQueuePipe(1024);
      const pollable = input.subscribe();
      assert.equal(pollable.ready(), false);
      output.write(new Uint8Array([1]));
      assert.equal(pollable.ready(), true);
    });

    it('subscribe().block() resolves when data becomes available', async () => {
      const { input, output } = createAsyncQueuePipe(1024);
      const pollable = input.subscribe();
      const blockPromise = pollable.block();
      assert.ok(blockPromise instanceof Promise);

      output.write(new Uint8Array([42]));
      await blockPromise;
      assert.equal(pollable.ready(), true);
    });

    it('subscribe().ready() becomes true when writer closes', () => {
      const { input, output } = createAsyncQueuePipe(1024);
      const pollable = input.subscribe();
      assert.equal(pollable.ready(), false);
      output[Symbol.dispose]();
      assert.equal(pollable.ready(), true);
    });
  });
});

describe('async pipe error paths', () => {
  it('pending readers get rejected when writer closes', async () => {
    const { input, output } = createAsyncQueuePipe(1024);
    const readPromise = input.blockingRead(10n);
    assert.ok(readPromise instanceof Promise);

    output[Symbol.dispose]();

    await assert.rejects(readPromise, (err: StreamError) => {
      assert.equal(err.tag, 'closed');
      return true;
    });
  });

  it('pending readers get rejected when reader is disposed', async () => {
    const { input, output: _output } = createAsyncQueuePipe(1024);
    const readPromise = input.blockingRead(10n);
    assert.ok(readPromise instanceof Promise);

    input[Symbol.dispose]();

    await assert.rejects(readPromise, (err: StreamError) => {
      assert.equal(err.tag, 'closed');
      return true;
    });
  });

  it('multiple pending readers resolved in order', async () => {
    const { input, output } = createAsyncQueuePipe(1024);
    const r1 = input.blockingRead(2n) as Promise<Uint8Array>;
    const r2 = input.blockingRead(2n) as Promise<Uint8Array>;

    output.write(new Uint8Array([1, 2, 3, 4]));

    const d1 = await r1;
    const d2 = await r2;
    assert.deepEqual(d1, new Uint8Array([1, 2]));
    assert.deepEqual(d2, new Uint8Array([3, 4]));
  });
});
