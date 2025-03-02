import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { delay, dispose } from '@mithic/commons';
import { WebReadStream, WebWriteStream } from './index.ts';

describe('WebReadStream', () => {
  let stream: WebReadStream;
  let readableStream: ReadableStream;
  let inputChunks: Uint8Array[];
  let controller: ReadableStreamDefaultController;

  beforeEach(() => {
    inputChunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6, 7])];
    readableStream = new ReadableStream({
      start(_controller) {
        controller = _controller;
        for (const chunk of inputChunks) {
          controller.enqueue(chunk);
        }
      }
    });
    stream = new WebReadStream(readableStream);
  });

  afterEach(() => {
    dispose(stream);
  });

  describe('dispose', () => {
    it('should unlock stream', () => {
      dispose(stream);
      assert.strictEqual(readableStream.locked, false);
    });
  });

  describe('read', () => {
    it('should trigger a poll and return, if buffer is empty', () => {
      assert.strictEqual(stream.read(5), undefined);
      assert.ok(stream['pendingRead'] !== undefined);
    });

    it('should return buffered data', async () => {
      await stream.poll();
      assert.deepStrictEqual(stream.read(5), inputChunks[0]);
    });

    it('should throw on closed stream', async () => {
      readableStream.cancel();
      try {
        await stream.poll();
      } catch {
        // ignore
      }
      assert.throws(() => stream.read(7), /StreamError: closed/);
    });

    it('should throw if last operation failed', async () => {
      controller.error('failed');
      await stream.poll();
      assert.throws(() => stream.read(7), /StreamError: last-operation-failed/);
    });
  });

  describe('checkRead', () => {
    it('should return read buffer content size', async () => {
      await stream.poll();
      assert.strictEqual(stream.checkRead(), inputChunks[0].byteLength);
    });

    it('should throw on closed stream', async () => {
      readableStream.cancel();
      try {
        await stream.poll();
      } catch {
        // ignore
      }
      assert.throws(() => stream.checkRead(), /StreamError: closed/);
    });

    it('should throw if last operation failed', async () => {
      controller.error('failed');
      await stream.poll();
      assert.throws(() => stream.checkRead(), /StreamError: last-operation-failed/);
    });
  });

  describe('poll', () => {
    it('should fill read buffer with data chunks', async () => {
      await stream.poll();
      assert.deepStrictEqual(stream['buffer'], inputChunks[0]);
      assert.strictEqual(stream['pendingRead'], undefined);
    });

    it('should return immediately if there is existing data', () => {
      stream['buffer'] = new Uint8Array([1, 2, 3]);
      assert.strictEqual(stream.poll(), true);
    });

    it('should trigger read and return false immediately if timeoutMs = 0', () => {
      assert.strictEqual(stream.poll(0), false);
      assert.ok(stream['pendingRead']);
    });

    it('should return false on timeout', async () => {
      const stream = new WebReadStream(new ReadableStream({})); // no data, pending forever
      assert.strictEqual(await stream.poll(1), false);
      assert.ok(stream['pendingRead']);
    });
  });
});

describe('WebWriteStream', () => {
  let stream: WebWriteStream;
  let writableStream: WritableStream;
  let outputChunks: Uint8Array[];
  let controller: WritableStreamDefaultController;

  beforeEach(() => {
    outputChunks = [];
    writableStream = new WritableStream({
      start(_controller) {
        controller = _controller;
      },
      write(chunk) { outputChunks.push(new Uint8Array(chunk)); }
    });
    stream = new WebWriteStream(writableStream);
  });

  afterEach(() => {
    dispose(stream);
  });

  describe('dispose', () => {
    it('should unlock stream', () => {
      const stream = new WebWriteStream(new WritableStream());
      dispose(stream);
      assert.strictEqual(writableStream.locked, false);
    });
  });

  describe('write', () => {
    it('should handle write request', async () => {
      const data = new Uint8Array([1, 2, 3]);
      stream.write(data);
      await stream.flush();
      assert.deepStrictEqual(outputChunks, [data]);
    });

    it('should handle multiple write requests', async () => {
      const data = new Uint8Array([1, 2, 3]), data2 = new Uint8Array([4, 5, 6, 7]);
      stream.write(data);
      stream.write(data2);
      await stream.flush();
      assert.deepStrictEqual(outputChunks, [data, data2]);
    });

    it('should throw on closed stream', async () => {
      const stream = new WebWriteStream(new WritableStream());
      dispose(stream);
      await delay(100);
      assert.throws(() => stream.write(new Uint8Array()), /StreamError: closed/);
    });

    it('should throw if last operation failed', () => {
      controller.error('failed');
      assert.throws(() => stream.write(new Uint8Array([1, 2])), /StreamError: last-operation-failed/);
    });
  });

  describe('flush', () => {
    it('should flush pending write request', async () => {
      const data = new Uint8Array([1, 2, 3]);
      stream.write(data);
      assert.strictEqual(await stream.flush(), true);
      assert.deepStrictEqual(outputChunks, [data]);
    });

    it('should return false on timeout', async () => {
      const stream = new WebWriteStream(new WritableStream({
        async write() { await delay(100); }
      }));
      stream.write(new Uint8Array([1, 2, 3]));
      assert.strictEqual(await stream.flush(1), false);
      assert.ok(stream['pendingWrite']);
      dispose(stream);
    });
  });
});
