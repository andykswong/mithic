import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import { dispose, MaybePromise } from '@mithic/commons';
import { StreamErrorTag, streams, type ReadStream, type WriteStream } from './index.ts';

describe('InputStream', () => {
  let stream: streams.InputStream;
  let readStream: ReturnType<typeof createMockReadStream>;

  beforeEach(() => {
    readStream = createMockReadStream();
    stream = new streams.InputStream({ stream: readStream });
  });

  describe('dispose', () => {
    it('should close the underlying stream', () => {
      dispose(stream);
      assert.strictEqual(readStream[Symbol.dispose].mock.callCount(), 1);
    });
  });

  describe('read', () => {
    it('should return empty byte array if read nothing', () => {
      const result = stream.read(4n);
      assert.deepStrictEqual(result, new Uint8Array());
      assert.strictEqual(readStream.read.mock.callCount(), 1);
      assert.deepStrictEqual(readStream.read.mock.calls[0].arguments, [4]);
    });

    it('should read chunk from underlying stream', () => {
      const chunk = new Uint8Array([1, 2, 3]);
      readStream.read.mock.mockImplementationOnce(() => chunk);
      const result = stream.read(4n);
      assert.deepStrictEqual(result, chunk);
      assert.deepStrictEqual(readStream.read.mock.calls[0].arguments, [4]);
    });
  });

  describe('blockingRead', () => {
    it('should return immediately available chunk from underlying stream', () => {
      const chunk = new Uint8Array([1, 2, 3]);
      readStream.read.mock.mockImplementationOnce(() => chunk);
      const result = stream.blockingRead(5n);
      assert.deepStrictEqual(result, chunk);
      assert.deepStrictEqual(readStream.read.mock.calls[0].arguments, [5]);
    });

    it('should wait for chunk to be read from underlying stream', async () => {
      let callCount = 0;
      const chunk = new Uint8Array([1, 2, 3]);
      readStream.poll.mock.mockImplementationOnce(async () => true);
      readStream.read.mock.mockImplementation(() => callCount++ === 1 ? chunk : undefined);

      const result = await stream.blockingRead(5n);
      assert.deepStrictEqual(result, chunk);
      assert.deepStrictEqual(readStream.poll.mock.callCount(), 1);
      assert.deepStrictEqual(readStream.read.mock.callCount(), 2);
      assert.deepStrictEqual(readStream.read.mock.calls[0].arguments, [5]);
      assert.deepStrictEqual(readStream.read.mock.calls[1].arguments, [5]);
    });
  });

  describe('skip', () => {
    it('should return 0 if skipped nothing', () => {
      const result = stream.skip(4n);
      assert.deepStrictEqual(result, 0n);
      assert.strictEqual(readStream.read.mock.callCount(), 1);
      assert.deepStrictEqual(readStream.read.mock.calls[0].arguments, [4]);
    });

    it('should return actual bytes skipped', () => {
      const chunk = new Uint8Array([1, 2, 3]);
      readStream.read.mock.mockImplementationOnce(() => chunk);
      const result = stream.skip(4n);
      assert.deepStrictEqual(result, 3n);
      assert.deepStrictEqual(readStream.read.mock.calls[0].arguments, [4]);
    });
  });

  describe('blockingSkip', () => {
    it('should return immediately available chunk length from underlying stream', () => {
      const chunk = new Uint8Array([1, 2, 3]);
      readStream.read.mock.mockImplementationOnce(() => chunk);
      const result = stream.blockingSkip(5n);
      assert.deepStrictEqual(result, 3n);
      assert.deepStrictEqual(readStream.read.mock.calls[0].arguments, [5]);
    });

    it('should wait for chunk to be skipped from underlying stream', async () => {
      let callCount = 0;
      const chunk = new Uint8Array([1, 2, 3]);
      readStream.poll.mock.mockImplementationOnce(async () => true);
      readStream.read.mock.mockImplementation(() => callCount++ === 1 ? chunk : undefined);

      const result = await stream.blockingSkip(5n);
      assert.deepStrictEqual(result, 3n);
      assert.deepStrictEqual(readStream.poll.mock.callCount(), 1);
      assert.deepStrictEqual(readStream.read.mock.callCount(), 2);
      assert.deepStrictEqual(readStream.read.mock.calls[0].arguments, [5]);
      assert.deepStrictEqual(readStream.read.mock.calls[1].arguments, [5]);
    });
  });

  describe('subscribe', () => {
    it('should return pollable that indicates if stream is ready to be read', async () => {
      let callCount = 0;
      readStream.checkRead.mock.mockImplementation(() => callCount++ === 1 ? 2 : 0);

      const pollable = stream.subscribe();

      // Only the 2nd checkRead call returns non-zero and hence ready
      assert.strictEqual(pollable.ready(), false);
      assert.deepStrictEqual(readStream.checkRead.mock.callCount(), 1);
      assert.strictEqual(pollable.ready(), true);
      assert.deepStrictEqual(readStream.checkRead.mock.callCount(), 2);
      assert.strictEqual(pollable.ready(), false);
      assert.deepStrictEqual(readStream.checkRead.mock.callCount(), 3);

      dispose(pollable);
    });
  });
});

describe('OutputStream', () => {
  let stream: streams.OutputStream;
  let writeStream: ReturnType<typeof createMockWriteStream>;

  beforeEach(() => {
    writeStream = createMockWriteStream();
    stream = new streams.OutputStream({ stream: writeStream });
  });

  describe('dispose', () => {
    it('should close the underlying stream', () => {
      dispose(stream);
      assert.strictEqual(writeStream[Symbol.dispose].mock.callCount(), 1);
    });
  });

  describe('write', () => {
    it('should write data to the stream', () => {
      const data = new Uint8Array([1, 2, 3]);
      stream.write(data);
      assert.strictEqual(writeStream.write.mock.callCount(), 1);
      assert.deepStrictEqual(writeStream.write.mock.calls[0].arguments, [data]);
    });
  });

  describe('blockingWriteAndFlush', async () => {
    it('should write in chunks and blocking flush', async () => {
      const chunks = [new Uint8Array(Array(4096).fill(1)), new Uint8Array(Array(12).fill(2))];
      writeStream.checkWrite.mock.mockImplementation(() => 8192);
      writeStream.flush.mock.mockImplementationOnce(async () => true);

      const result = stream.blockingWriteAndFlush(new Uint8Array([...chunks[0], ...chunks[1]]));
      assert.ok(MaybePromise.isThenable(result));
      await result;

      assert.strictEqual(writeStream.write.mock.callCount(), 2);
      assert.deepStrictEqual(writeStream.write.mock.calls[0].arguments, [chunks[0]]);
      assert.deepStrictEqual(writeStream.write.mock.calls[1].arguments, [chunks[1]]);
      assert.strictEqual(writeStream.flush.mock.callCount(), 1);
    });
  });

  describe('writeZeroes', () => {
    it('should write 0s to the stream', () => {
      stream.writeZeroes(3n);
      assert.strictEqual(writeStream.write.mock.callCount(), 1);
      assert.deepStrictEqual(writeStream.write.mock.calls[0].arguments, [new Uint8Array(3)]);
    });
  });

  describe('blockingWriteZeroesAndFlush', () => {
    it('should write 0s in chunks and blocking flush', async () => {
      writeStream.checkWrite.mock.mockImplementation(() => 8192);
      writeStream.flush.mock.mockImplementationOnce(async () => true);

      stream.blockingWriteZeroesAndFlush(4200n);
      assert.strictEqual(writeStream.write.mock.callCount(), 2);
      assert.deepStrictEqual(writeStream.write.mock.calls[0].arguments, [new Uint8Array(4096)]);
      assert.deepStrictEqual(writeStream.write.mock.calls[1].arguments, [new Uint8Array(104)]);
      assert.strictEqual(writeStream.flush.mock.callCount(), 1);
    });
  });

  describe('blockingFlush', () => {
    it('should wait for underlying stream to be flushed', async () => {
      writeStream.flush.mock.mockImplementationOnce(async () => true);
      const result = stream.blockingFlush();
      assert.ok(MaybePromise.isThenable(result));
      await result;
      assert.strictEqual(writeStream.flush.mock.callCount(), 1);
      assert.deepStrictEqual(writeStream.flush.mock.calls[0].arguments, []);
    });

    it('should throw if timeout', async () => {
      writeStream.flush.mock.mockImplementationOnce(async () => false);
      await assert.rejects(async () => stream.blockingFlush(), `StreamError: ${StreamErrorTag.LastOperationFailed}`);
      assert.strictEqual(writeStream.flush.mock.callCount(), 1);
      assert.deepStrictEqual(writeStream.flush.mock.calls[0].arguments, []);
    });
  });

  describe('subscribe', () => {
    it('should return pollable that indicates if stream is writable', async () => {
      let callCount = 0;
      writeStream.checkWrite.mock.mockImplementation(() => callCount++ === 1 ? 2 : 0);

      const pollable = stream.subscribe();

      // Only the 2nd checkWrite call returns non-zero and hence ready
      assert.strictEqual(pollable.ready(), false);
      assert.deepStrictEqual(writeStream.checkWrite.mock.callCount(), 1);
      assert.strictEqual(pollable.ready(), true);
      assert.deepStrictEqual(writeStream.checkWrite.mock.callCount(), 2);
      assert.strictEqual(pollable.ready(), false);
      assert.deepStrictEqual(writeStream.checkWrite.mock.callCount(), 3);

      dispose(pollable);
    });
  });

  describe('splice', () => {
    let inputStream: streams.InputStream;
    let readStream: ReturnType<typeof createMockReadStream>;

    beforeEach(() => {
      readStream = createMockReadStream();
      inputStream = new streams.InputStream({ stream: readStream });
    });

    describe('splice', () => {
      it('should write chunk from input stream', async () => {
        const chunk = new Uint8Array([1, 2, 3]);
        readStream.read.mock.mockImplementationOnce(() => chunk);
        writeStream.checkWrite.mock.mockImplementation(() => 4);

        const result = stream.splice(inputStream, 5n);
        assert.strictEqual(result, 3n);
        assert.strictEqual(readStream.read.mock.callCount(), 1);
        assert.deepStrictEqual(readStream.read.mock.calls[0].arguments, [4]);
        assert.strictEqual(writeStream.write.mock.callCount(), 1);
        assert.deepStrictEqual(writeStream.write.mock.calls[0].arguments, [chunk]);
      });
    });

    describe('blockingSplice', () => {
      it('should write chunk from input stream and block', async () => {
        let checkWriteCallCount = 0;
        const chunk = new Uint8Array([1, 2, 3]);
        readStream.read.mock.mockImplementationOnce(() => chunk);
        writeStream.checkWrite.mock.mockImplementation(() => checkWriteCallCount++ >= 1 ? 4096 : 0);
        writeStream.flush.mock.mockImplementation(async () => true);

        const result = await stream.blockingSplice(inputStream, 4n);
        assert.strictEqual(result, 3n);
        assert.strictEqual(readStream.read.mock.callCount(), 1);
        assert.deepStrictEqual(readStream.read.mock.calls[0].arguments, [4]);
        assert.strictEqual(writeStream.write.mock.callCount(), 1);
        assert.deepStrictEqual(writeStream.write.mock.calls[0].arguments, [chunk]);
        assert.strictEqual(writeStream.flush.mock.callCount(), 2);
        assert.strictEqual(writeStream.checkWrite.mock.callCount(), 3);
      });
    });
  });
});

function createMockReadStream() {
  return {
    [Symbol.dispose]: mock.fn<() => void>(),
    read: mock.fn(),
    checkRead: mock.fn(),
    poll: mock.fn(),
  } satisfies ReadStream;
}

function createMockWriteStream() {
  return {
    [Symbol.dispose]: mock.fn<() => void>(),
    write: mock.fn(),
    checkWrite: mock.fn(),
    flush: mock.fn(),
  } satisfies WriteStream;
}
