import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, throws } from 'node:assert';

import { InputStream, OutputStream, isStreamClosed } from './streams.ts';
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

  it('read falls back to blockingRead when no read handler', () => {
    const data = new Uint8Array([7, 8, 9]);
    const stream = new InputStream({
      blockingRead(len: number) {
        return data.slice(0, len);
      },
    });

    const result = stream.read(2n);
    deepStrictEqual(result, new Uint8Array([7, 8]));
  });

  it('blockingRead throws closed when stream is done', () => {
    const stream = new InputStream({
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

  it('skip falls back to blockingRead when no skip or read handler', () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const stream = new InputStream({
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
      blockingRead(_len: number) {
        return new Uint8Array(0);
      },
    }, () => customPollable);

    const p = stream.subscribe();
    strictEqual(p, customPollable);
  });

  it('subscribe returns default always-ready pollable when no handler', () => {
    const stream = new InputStream({
      blockingRead(_len: number) {
        return new Uint8Array(0);
      },
    });

    const p = stream.subscribe();
    strictEqual(p.ready(), true);
  });

  it('[Symbol.dispose] calls handler drop', () => {
    let dropped = false;
    const stream = new InputStream({
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

describe('poll', () => {
  it('returns indices of ready pollables', () => {
    const p1 = new Pollable(() => true);
    const p2 = new Pollable(() => false);
    const p3 = new Pollable(() => true);

    const result = poll([p1, p2, p3]);
    deepStrictEqual(Array.from(result), [0, 2]);
  });

  it('throws on empty list', () => {
    throws(() => poll([]), /poll list must not be empty/);
  });
});
