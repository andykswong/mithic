import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, throws } from 'node:assert';

import { InputStream, OutputStream, isStreamClosed, type InputStreamHandler, type OutputStreamHandler } from './streams.ts';
import { Pollable, poll } from './poll.ts';

describe('InputStream', () => {
  it('read returns data from handler', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const stream = new InputStream({
      read(len: number) {
        return data.slice(0, len);
      },
      blockingRead(len: number) {
        return data.slice(0, len);
      },
    });

    const result = stream.read(3n);
    deepStrictEqual(result, new Uint8Array([1, 2, 3]));
  });

  it('read with len=0 returns empty array (not closed)', () => {
    const stream = new InputStream({
      read(len: number) {
        return new Uint8Array(len);
      },
      blockingRead(len: number) {
        return new Uint8Array(len);
      },
    });

    const result = stream.read(0n);
    deepStrictEqual(result, new Uint8Array(0));
  });

  it('read returns empty Uint8Array when handler.read returns undefined', () => {
    const stream = new InputStream({
      read(_len: number) {
        return undefined;
      },
      blockingRead(_len: number) {
        return new Uint8Array(0);
      },
    });

    const result = stream.read(10n);
    deepStrictEqual(result, new Uint8Array(0));
  });

  it('read returns empty when handler.read returns undefined (non-blocking has no data)', () => {
    const data = new Uint8Array([7, 8, 9]);
    const stream = new InputStream({
      read() { return undefined; },
      blockingRead(len: number) {
        return data.slice(0, len);
      },
    });

    const result = stream.read(2n);
    deepStrictEqual(result, new Uint8Array(0));
  });

  it('blockingRead throws closed when stream is done', () => {
    const stream = new InputStream({
      read() { return undefined; },
      blockingRead(_len: number): Uint8Array {
        throw { tag: 'closed' };
      },
    });

    throws(() => stream.blockingRead(10n), (err: unknown) => {
      return (err as { tag: string }).tag === 'closed';
    });
  });

  it('skip delegates to skip handler when present', () => {
    let skipCalled = false;
    let skipArg = 0;
    const stream = new InputStream({
      read() { return undefined; },
      skip(len: number) {
        skipCalled = true;
        skipArg = len;
        return len;
      },
      blockingRead(_len: number) {
        return new Uint8Array(0);
      },
    });

    const skipped = stream.skip(7n);
    strictEqual(skipCalled, true);
    strictEqual(skipArg, 7);
    strictEqual(skipped, 7n);
  });

  it('skip falls back to read handler when no skip handler', () => {
    const data = new Uint8Array([10, 20, 30, 40, 50]);
    let offset = 0;
    const stream = new InputStream({
      read(len: number) {
        const result = data.slice(offset, offset + len);
        offset += result.byteLength;
        return result;
      },
      blockingRead(len: number) {
        const result = data.slice(offset, offset + len);
        offset += result.byteLength;
        return result;
      },
    });

    const skipped = stream.skip(3n);
    strictEqual(skipped, 3n);
  });

  it('skip falls back to read when no skip handler', () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const stream = new InputStream({
      read(len: number) {
        return data.slice(0, len);
      },
      blockingRead(len: number) {
        return data.slice(0, len);
      },
    });

    const skipped = stream.skip(4n);
    strictEqual(skipped, 4n);
  });

  it('blockingSkip delegates to skip handler when present', () => {
    let skipCalled = false;
    const stream = new InputStream({
      read() { return undefined; },
      skip(len: number) {
        skipCalled = true;
        return len;
      },
      blockingRead(_len: number) {
        return new Uint8Array(0);
      },
    });

    const skipped = stream.blockingSkip(5n);
    strictEqual(skipCalled, true);
    strictEqual(skipped, 5n);
  });

  it('blockingSkip falls back to blockingRead when no skip handler', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const stream = new InputStream({
      read() { return undefined; },
      blockingRead(len: number) {
        return data.slice(0, len);
      },
    });

    const skipped = stream.blockingSkip(3n);
    strictEqual(skipped, 3n);
  });

  it('subscribe returns handler pollable when provided', () => {
    const customPollable = new Pollable(() => false);
    const stream = new InputStream({
      read() { return undefined; },
      blockingRead(_len: number) {
        return new Uint8Array(0);
      },
    }, () => customPollable);

    const p = stream.subscribe();
    strictEqual(p, customPollable);
  });

  it('subscribe returns default pollable that checks handler.read for readiness', () => {
    let hasData = false;
    const stream = new InputStream({
      read() { return hasData ? new Uint8Array([1]) : undefined; },
      blockingRead(_len: number) {
        return new Uint8Array(0);
      },
    });

    const p = stream.subscribe();
    strictEqual(p.ready(), false);
    hasData = true;
    strictEqual(p.ready(), true);
  });

  it('[Symbol.dispose] calls handler drop', () => {
    let dropped = false;
    const stream = new InputStream({
      read() { return undefined; },
      blockingRead(_len: number) {
        return new Uint8Array(0);
      },
      drop() {
        dropped = true;
      },
    });

    stream[Symbol.dispose]();
    strictEqual(dropped, true);
  });
});

describe('OutputStream', () => {
  it('write delegates to handler', () => {
    const written: Uint8Array[] = [];
    const stream = new OutputStream({
      write(data: Uint8Array) {
        written.push(data);
      },
    });

    const data = new Uint8Array([1, 2, 3]);
    stream.write(data);
    strictEqual(written.length, 1);
    deepStrictEqual(written[0], data);
  });

  it('write throws {tag:"closed"} when stream is closed', () => {
    const stream = new OutputStream({
      write(_data: Uint8Array) {},
    });

    stream[Symbol.dispose]();

    throws(() => stream.write(new Uint8Array([1])), (err: unknown) => {
      return (err as { tag: string }).tag === 'closed';
    });
  });

  it('blockingWriteAndFlush writes and flushes', () => {
    const written: Uint8Array[] = [];
    let flushed = false;
    const stream = new OutputStream({
      write(data: Uint8Array) {
        written.push(data);
      },
      flush() {
        flushed = true;
      },
    });

    const data = new Uint8Array([4, 5, 6]);
    stream.blockingWriteAndFlush(data);
    strictEqual(written.length, 1);
    deepStrictEqual(written[0], data);
    strictEqual(flushed, true);
  });

  it('blockingWriteAndFlush throws {tag:"closed"} when stream is closed', () => {
    const stream = new OutputStream({
      write(_data: Uint8Array) {},
    });
    stream[Symbol.dispose]();

    throws(() => stream.blockingWriteAndFlush(new Uint8Array([1])), (err: unknown) => {
      return (err as { tag: string }).tag === 'closed';
    });
  });

  it('flush delegates to handler', () => {
    let flushed = false;
    const stream = new OutputStream({
      write(_data: Uint8Array) {},
      flush() {
        flushed = true;
      },
    });

    stream.flush();
    strictEqual(flushed, true);
  });

  it('flush does nothing when handler has no flush method', () => {
    const stream = new OutputStream({
      write(_data: Uint8Array) {},
    });

    // Should not throw
    stream.flush();
  });

  it('blockingFlush delegates to handler', () => {
    let flushed = false;
    const stream = new OutputStream({
      write(_data: Uint8Array) {},
      flush() {
        flushed = true;
      },
    });

    stream.blockingFlush();
    strictEqual(flushed, true);
  });

  it('blockingFlush does nothing when handler has no flush method', () => {
    const stream = new OutputStream({
      write(_data: Uint8Array) {},
    });

    // Should not throw
    stream.blockingFlush();
  });

  it('writeZeroes writes correct number of zeros', () => {
    const written: Uint8Array[] = [];
    const stream = new OutputStream({
      write(data: Uint8Array) {
        written.push(new Uint8Array(data));
      },
    });

    stream.writeZeroes(5n);
    strictEqual(written.length, 1);
    strictEqual(written[0].length, 5);
    deepStrictEqual(written[0], new Uint8Array([0, 0, 0, 0, 0]));
  });

  it('writeZeroes with 0n writes empty array', () => {
    const written: Uint8Array[] = [];
    const stream = new OutputStream({
      write(data: Uint8Array) {
        written.push(new Uint8Array(data));
      },
    });

    stream.writeZeroes(0n);
    strictEqual(written.length, 1);
    strictEqual(written[0].length, 0);
  });

  it('splice reads from input and writes to output', () => {
    const inputData = new Uint8Array([10, 20, 30, 40, 50]);
    const inputStream = new InputStream({
      read(len: number) {
        return inputData.slice(0, len);
      },
      blockingRead(len: number) {
        return inputData.slice(0, len);
      },
    });

    const written: Uint8Array[] = [];
    const outputStream = new OutputStream({
      write(data: Uint8Array) {
        written.push(new Uint8Array(data));
      },
    });

    const spliced = outputStream.splice(inputStream, 3n);
    strictEqual(spliced, 3n);
    strictEqual(written.length, 1);
    deepStrictEqual(written[0], new Uint8Array([10, 20, 30]));
  });

  it('splice respects checkWrite capacity', () => {
    const inputData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const inputStream = new InputStream({
      read(len: number) {
        return inputData.slice(0, len);
      },
      blockingRead(len: number) {
        return inputData.slice(0, len);
      },
    });

    const written: Uint8Array[] = [];
    const outputStream = new OutputStream({
      checkWrite() {
        return 3; // Only 3 bytes available
      },
      write(data: Uint8Array) {
        written.push(new Uint8Array(data));
      },
    });

    const spliced = outputStream.splice(inputStream, 10n);
    // Should be limited by checkWrite capacity of 3
    strictEqual(spliced, 3n);
  });

  it('blockingSplice reads and writes with blocking', () => {
    const inputData = new Uint8Array([100, 200, 150]);
    const inputStream = new InputStream({
      read() { return undefined; },
      blockingRead(len: number) {
        return inputData.slice(0, len);
      },
    });

    const written: Uint8Array[] = [];
    let flushed = false;
    const outputStream = new OutputStream({
      write(data: Uint8Array) {
        written.push(new Uint8Array(data));
      },
      flush() {
        flushed = true;
      },
    });

    const spliced = outputStream.blockingSplice(inputStream, 3n);
    strictEqual(spliced, 3n);
    strictEqual(written.length, 1);
    deepStrictEqual(written[0], new Uint8Array([100, 200, 150]));
    strictEqual(flushed, true);
  });

  it('blockingSplice does not write when input returns empty', () => {
    const inputStream = new InputStream({
      read() { return undefined; },
      blockingRead(_len: number) {
        return new Uint8Array(0);
      },
    });

    const written: Uint8Array[] = [];
    const outputStream = new OutputStream({
      write(data: Uint8Array) {
        written.push(new Uint8Array(data));
      },
    });

    const spliced = outputStream.blockingSplice(inputStream, 5n);
    strictEqual(spliced, 0n);
    strictEqual(written.length, 0);
  });

  it('checkWrite returns capacity from handler', () => {
    const stream = new OutputStream({
      checkWrite() {
        return 4096;
      },
      write(_data: Uint8Array) {},
    });

    strictEqual(stream.checkWrite(), 4096n);
  });

  it('checkWrite returns default 1_000_000n when no handler', () => {
    const stream = new OutputStream({
      write(_data: Uint8Array) {},
    });

    strictEqual(stream.checkWrite(), 1_000_000n);
  });

  it('checkWrite returns 0n when stream is closed', () => {
    const stream = new OutputStream({
      write(_data: Uint8Array) {},
    });
    stream[Symbol.dispose]();
    strictEqual(stream.checkWrite(), 0n);
  });

  it('subscribe returns handler pollable when provided', () => {
    const customPollable = new Pollable(() => false);
    const stream = new OutputStream({
      write(_data: Uint8Array) {},
    }, () => customPollable);

    const p = stream.subscribe();
    strictEqual(p, customPollable);
  });

  it('subscribe returns default always-ready pollable when no handler', () => {
    const stream = new OutputStream({
      write(_data: Uint8Array) {},
    });

    const p = stream.subscribe();
    strictEqual(p.ready(), true);
  });

  it('[Symbol.dispose] calls handler drop', () => {
    let dropped = false;
    const stream = new OutputStream({
      write(_data: Uint8Array) {},
      drop() {
        dropped = true;
      },
    });

    stream[Symbol.dispose]();
    strictEqual(dropped, true);
  });
});

describe('Pollable', () => {
  it('ready returns handler result', () => {
    const alwaysReady = new Pollable(() => true);
    strictEqual(alwaysReady.ready(), true);

    const neverReady = new Pollable(() => false);
    strictEqual(neverReady.ready(), false);
  });

  it('default pollable is always ready', () => {
    const p = new Pollable();
    strictEqual(p.ready(), true);
  });
});

describe('isStreamClosed', () => {
  it('returns true for {tag:"closed"}', () => {
    strictEqual(isStreamClosed({ tag: 'closed' }), true);
  });

  it('returns false for {tag:"last-operation-failed"}', () => {
    strictEqual(isStreamClosed({ tag: 'last-operation-failed', val: {} }), false);
  });

  it('returns false for null', () => {
    strictEqual(isStreamClosed(null), false);
  });

  it('returns false for undefined', () => {
    strictEqual(isStreamClosed(undefined), false);
  });

  it('returns false for a plain Error', () => {
    strictEqual(isStreamClosed(new Error('closed')), false);
  });

  it('returns false for a string', () => {
    strictEqual(isStreamClosed('closed'), false);
  });

  it('returns false for object with no tag', () => {
    strictEqual(isStreamClosed({ message: 'closed' }), false);
  });
});

describe('InputStream.dup()', () => {
  it('dup delegates read to the same handler', () => {
    const data = new Uint8Array([1, 2, 3]);
    const stream = new InputStream({
      read() { return undefined; },
      blockingRead(len) { return data.slice(0, len); },
    });
    const duped = stream.dup();
    deepStrictEqual(duped.blockingRead(2n), new Uint8Array([1, 2]));
  });

  it('dup inherits isatty from owner', () => {
    const stream = new InputStream({ read() { return undefined; }, blockingRead() { return new Uint8Array(0); } }, undefined, true);
    strictEqual(stream.dup().isatty, true);
  });

  it('disposing a dup when original is still alive does NOT call handler drop', () => {
    let dropped = false;
    const stream = new InputStream({
      read() { return undefined; },
      blockingRead() { return new Uint8Array(0); },
      drop() { dropped = true; },
    });
    const duped = stream.dup();
    duped[Symbol.dispose]();
    strictEqual(dropped, false);
  });

  it('disposing the original when dup is still alive does NOT call handler drop', () => {
    let dropped = false;
    const stream = new InputStream({
      read() { return undefined; },
      blockingRead() { return new Uint8Array(0); },
      drop() { dropped = true; },
    });
    const duped = stream.dup();
    stream[Symbol.dispose]();
    strictEqual(dropped, false);
    duped[Symbol.dispose]();
    strictEqual(dropped, true);
  });

  it('disposing the last handle calls handler drop', () => {
    let dropped = false;
    const stream = new InputStream({
      read() { return undefined; },
      blockingRead() { return new Uint8Array(0); },
      drop() { dropped = true; },
    });
    stream[Symbol.dispose]();
    strictEqual(dropped, true);
  });
});

describe('OutputStream.dup()', () => {
  it('dup delegates write to the same handler', () => {
    const written: Uint8Array[] = [];
    const stream = new OutputStream({ write(d) { written.push(new Uint8Array(d)); } });
    const duped = stream.dup();
    duped.write(new Uint8Array([42]));
    strictEqual(written.length, 1);
    deepStrictEqual(written[0], new Uint8Array([42]));
  });

  it('dup inherits isatty from owner', () => {
    const stream = new OutputStream({ write() {} }, undefined, true);
    strictEqual(stream.dup().isatty, true);
  });

  it('disposing a dup closes that dup but does NOT call handler drop', () => {
    let dropped = false;
    const stream = new OutputStream({
      write() {},
      drop() { dropped = true; },
    });
    const duped = stream.dup();
    duped[Symbol.dispose]();
    strictEqual(dropped, false);
    // The dup is closed — writes throw
    throws(() => duped.write(new Uint8Array([1])), (e: unknown) => (e as { tag: string }).tag === 'closed');
  });

  it('disposing a dup does not close the owner', () => {
    const written: Uint8Array[] = [];
    const stream = new OutputStream({ write(d) { written.push(new Uint8Array(d)); } });
    const duped = stream.dup();
    duped[Symbol.dispose]();
    // Owner can still write
    stream.write(new Uint8Array([99]));
    strictEqual(written.length, 1);
  });

  it('disposing the original when dup is still alive does NOT call handler drop; dup can still write', () => {
    let dropped = false;
    const written: Uint8Array[] = [];
    const stream = new OutputStream({
      write(d) { written.push(new Uint8Array(d)); },
      drop() { dropped = true; },
    });
    const duped = stream.dup();
    stream[Symbol.dispose]();
    strictEqual(dropped, false);
    // dup still works
    duped.write(new Uint8Array([55]));
    strictEqual(written.length, 1);
    deepStrictEqual(written[0], new Uint8Array([55]));
    // only after dup is disposed does handler.drop() fire
    duped[Symbol.dispose]();
    strictEqual(dropped, true);
  });

  it('disposing the last handle calls handler drop', () => {
    let dropped = false;
    const stream = new OutputStream({
      write() {},
      drop() { dropped = true; },
    });
    stream[Symbol.dispose]();
    strictEqual(dropped, true);
  });

  it('multiple dups are independent — disposing one does not affect others', () => {
    const written: Uint8Array[] = [];
    const stream = new OutputStream({ write(d) { written.push(new Uint8Array(d)); } });
    const d1 = stream.dup();
    const d2 = stream.dup();
    d1[Symbol.dispose]();
    // d2 still works
    d2.write(new Uint8Array([7]));
    strictEqual(written.length, 1);
    deepStrictEqual(written[0], new Uint8Array([7]));
  });
});

describe('poll', () => {
  it('returns indices of ready pollables', () => {
    const p1 = new Pollable(() => true);
    const p2 = new Pollable(() => false);
    const p3 = new Pollable(() => true);

    const result = poll([p1, p2, p3]) as Uint32Array;
    deepStrictEqual(Array.from(result), [0, 2]);
  });

  it('throws on empty list', () => {
    throws(() => poll([]), /poll list must not be empty/);
  });
});

describe('InputStream async blockingRead', () => {
  it('blockingRead returns Promise when handler returns Promise', async () => {
    const handler: InputStreamHandler = {
      read() { return undefined; },
      blockingRead(len: number) {
        return new Promise<Uint8Array>(resolve =>
          setTimeout(() => resolve(new Uint8Array(len).fill(42)), 10)
        );
      },
    };
    const stream = new InputStream(handler);
    const result = stream.blockingRead(5n);
    strictEqual(result instanceof Promise, true);
    const data = await result;
    strictEqual(data.byteLength, 5);
    strictEqual(data[0], 42);
  });

  it('blockingRead returns Uint8Array directly for sync handler', () => {
    const handler: InputStreamHandler<true> = {
      read() { return undefined; },
      blockingRead(len: number) { return new Uint8Array(len).fill(7); },
    };
    const stream = new InputStream<true>(handler);
    const result = stream.blockingRead(3n);
    strictEqual(result.byteLength, 3);
    strictEqual(result[0], 7);
  });

  it('blockingRead rejects when handler Promise rejects', async () => {
    const handler: InputStreamHandler = {
      read() { return undefined; },
      blockingRead() { return Promise.reject({ tag: 'closed' }); },
    };
    const stream = new InputStream(handler);
    const result = stream.blockingRead(10n);
    strictEqual(result instanceof Promise, true);
    try {
      await result;
      throw new Error('should have rejected');
    } catch (err: unknown) {
      strictEqual((err as { tag: string }).tag, 'closed');
    }
  });

  it('blockingSkip with async handler returns Promise<bigint>', async () => {
    const handler: InputStreamHandler = {
      read() { return undefined; },
      blockingRead(len: number) {
        return new Promise<Uint8Array>(resolve =>
          setTimeout(() => resolve(new Uint8Array(len)), 5)
        );
      },
    };
    const stream = new InputStream(handler);
    const result = stream.blockingSkip(10n);
    strictEqual(result instanceof Promise, true);
    const skipped = await result;
    strictEqual(skipped, 10n);
  });
});

describe('OutputStream.write precondition', () => {
  it('write with data smaller than checkWrite capacity succeeds', () => {
    const written: Uint8Array[] = [];
    const stream = new OutputStream({
      checkWrite() { return 10; },
      write(data: Uint8Array) { written.push(new Uint8Array(data)); },
    });
    stream.write(new Uint8Array(5));
    strictEqual(written.length, 1);
  });
});

describe('InputStream edge cases', () => {
  it('read after dispose does not crash', () => {
    const stream = new InputStream({
      read() { return new Uint8Array([1]); },
      blockingRead() { return new Uint8Array([1]); },
    });
    stream[Symbol.dispose]();
    // After dispose, handler.drop() was called. Behavior is implementation-defined.
    // Verify it doesn't crash at minimum (handler still works, just ref-counted).
    const result = stream.read(1n);
    deepStrictEqual(result, new Uint8Array([1]));
  });

  it('skip returns 0 when no data available', () => {
    const stream = new InputStream({
      read() { return undefined; },
      blockingRead() { throw { tag: 'closed' }; },
    });
    strictEqual(stream.skip(10n), 0n);
  });

  it('blockingSkip uses skip handler when available', () => {
    let skipped = 0;
    const stream = new InputStream({
      read() { return undefined; },
      blockingRead() { return new Uint8Array(10); },
      skip(len: number) { skipped = len; return len; },
    });
    const result = stream.blockingSkip(5n);
    strictEqual(result, 5n);
    strictEqual(skipped, 5);
  });
});

describe('OutputStream.blockingWriteAndFlush chunking', () => {
  it('writes in chunks based on checkWrite capacity', () => {
    const written: Uint8Array[] = [];
    const stream = new OutputStream({
      checkWrite() { return 3; },
      write(data: Uint8Array) { written.push(new Uint8Array(data)); },
    });
    stream.blockingWriteAndFlush(new Uint8Array([1, 2, 3, 4, 5, 6, 7]));
    // Should be written in chunks of 3, 3, 1
    strictEqual(written.length, 3);
    deepStrictEqual(written[0], new Uint8Array([1, 2, 3]));
    deepStrictEqual(written[1], new Uint8Array([4, 5, 6]));
    deepStrictEqual(written[2], new Uint8Array([7]));
  });
});

describe('OutputStream.writeZeroes edge cases', () => {
  it('writes zero-filled buffer of specified length', () => {
    const written: Uint8Array[] = [];
    const stream = new OutputStream({
      write(data: Uint8Array) { written.push(new Uint8Array(data)); },
    });
    stream.writeZeroes(4n);
    deepStrictEqual(written[0], new Uint8Array([0, 0, 0, 0]));
  });

  it('writeZeroes on closed stream throws', () => {
    const stream = new OutputStream({
      write() {},
    });
    stream[Symbol.dispose]();
    throws(() => stream.writeZeroes(1n), (err: unknown) => {
      return (err as { tag: string }).tag === 'closed';
    });
  });
});

describe('OutputStream async flush', () => {
  it('flush returns Promise when handler flush returns Promise', async () => {
    let flushed = false;
    const handler: OutputStreamHandler = {
      write() {},
      flush() { return new Promise<void>(resolve => setTimeout(() => { flushed = true; resolve(); }, 10)); },
    };
    const stream = new OutputStream(handler);
    const result = stream.flush();
    strictEqual(result instanceof Promise, true);
    strictEqual(flushed, false);
    await result;
    strictEqual(flushed, true);
  });

  it('flush returns void for sync handler', () => {
    let flushed = false;
    const handler: OutputStreamHandler<true> = {
      write() {},
      flush() { flushed = true; },
    };
    const stream = new OutputStream<true>(handler);
    stream.flush();
    strictEqual(flushed, true);
  });
});

describe('close() idempotency (no double-drop)', () => {
  it('InputStream.close() does not double-drop handler', () => {
    let dropCount = 0;
    const stream = new InputStream<true>({
      read() { return undefined; },
      blockingRead() { return new Uint8Array(0); },
      drop() { dropCount++; },
    });
    stream.close();
    stream.close();
    stream[Symbol.dispose]();
    strictEqual(dropCount, 1);
  });

  it('OutputStream.close() does not double-drop handler', () => {
    let dropCount = 0;
    const stream = new OutputStream<true>({
      write() {},
      drop() { dropCount++; },
    });
    stream.close();
    stream.close();
    stream[Symbol.dispose]();
    strictEqual(dropCount, 1);
  });

  it('close() then dispose() does not drop again', () => {
    let dropCount = 0;
    const stream = new OutputStream<true>({
      write() {},
      drop() { dropCount++; },
    });
    stream.close();
    stream[Symbol.dispose]();
    strictEqual(dropCount, 1);
  });

  it('dispose() then close() does not drop again', () => {
    let dropCount = 0;
    const stream = new InputStream<true>({
      read() { return undefined; },
      blockingRead() { return new Uint8Array(0); },
      drop() { dropCount++; },
    });
    stream[Symbol.dispose]();
    stream.close();
    strictEqual(dropCount, 1);
  });

  it('close() on dup zeros refs — other dup dispose does not double-drop', () => {
    let dropCount = 0;
    const stream = new OutputStream<true>({
      write() {},
      drop() { dropCount++; },
    });
    const duped = stream.dup();
    duped.close();
    strictEqual(dropCount, 1, 'close() should drop immediately');
    stream[Symbol.dispose]();
    strictEqual(dropCount, 1, 'dispose() on original should not drop again (refs zeroed)');
  });

  it('dispose() on dup decrements — close() on original still drops', () => {
    let dropCount = 0;
    const stream = new InputStream<true>({
      read() { return undefined; },
      blockingRead() { return new Uint8Array(0); },
      drop() { dropCount++; },
    });
    const duped = stream.dup();
    duped[Symbol.dispose]();
    strictEqual(dropCount, 0, 'dispose() on dup should not drop (ref count still > 0)');
    stream.close();
    strictEqual(dropCount, 1, 'close() on original should drop');
  });

  it('two dups — dispose both ref-counted, drop on last', () => {
    let dropCount = 0;
    const stream = new OutputStream<true>({
      write() {},
      drop() { dropCount++; },
    });
    const dup1 = stream.dup();
    const dup2 = stream.dup();
    stream[Symbol.dispose]();
    strictEqual(dropCount, 0);
    dup1[Symbol.dispose]();
    strictEqual(dropCount, 0);
    dup2[Symbol.dispose]();
    strictEqual(dropCount, 1, 'handler dropped on last dispose');
  });
});
