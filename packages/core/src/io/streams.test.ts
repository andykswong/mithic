import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Worker } from 'node:worker_threads';
import { delay, dispose } from '@mithic/commons';
import { runWorker } from '../test/io.worker.ts';
import { Io, streams } from './index.ts';

describe('InputStream', () => {
  let stream: streams.InputStream;
  let chunks: Uint8Array[];
  let worker: Worker;

  beforeEach(async () => {
    [worker, Io.provider] = runWorker();
    chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6, 7])];
    for (const chunk of chunks) {
      worker.stdin?.write(chunk);
    }
    await delay(100);

    stream = new streams.InputStream({ fd: 0 });
  });

  afterEach(async () => {
    await worker?.terminate();
  });

  describe('read', () => {
    it('should read nothing from first try', async () => {
      const result = stream.read(4n);
      assert.deepStrictEqual(result, new Uint8Array());
    });

    it('should read chunk from input stream', async () => {
      await stream.subscribe();
      const result = stream.read(4n);
      assert.deepStrictEqual(result, chunks[0]);
    });
  });

  describe('blockingRead', () => {
    it('should read chunk from input stream', () => {
      const result = stream.blockingRead(4n);
      assert.deepStrictEqual(result, chunks[0]);
    });
  });

  describe('subscribe', () => {
    it('should return pollable that indicates if stream is ready to be read', async () => {
      const pollable = stream.subscribe();

      // ready as there is existing data
      await pollable.waitAsync();
      assert.strictEqual(pollable.ready(), true);

      // no longer ready after all existing data is consumed
      assert.deepStrictEqual(stream.blockingRead(5n), chunks[0]);
      assert.deepStrictEqual(stream.blockingRead(5n), chunks[1]);
      assert.strictEqual(pollable.ready(), false);

      // ready again as there is new data
      const data = [8, 9];
      worker.stdin?.write(new Uint8Array(data));
      await pollable.waitAsync();
      assert.strictEqual(pollable.ready(), true);
      assert.deepStrictEqual(stream.read(2n), new Uint8Array(data));

      dispose(pollable);
    });
  });
});

describe('OutputStream', () => {
  let stream: streams.OutputStream;
  let chunks: Uint8Array[];
  let worker: Worker;

  beforeEach(async () => {
    [worker, Io.provider] = runWorker();
    chunks = [];
    worker.stdout?.on('data', (chunk) => {
      chunks.push(new Uint8Array(chunk));
    });
    await delay(100);

    stream = new streams.OutputStream({ fd: 1 });
  });

  afterEach(async () => {
    await worker?.terminate();
  });

  describe('write', () => {
    it('should write data to the stream', async () => {
      const data = new Uint8Array([1, 2, 3]);
      stream.write(data);
      await stream.subscribe();
      await delay(100); // for data to pump through 
      assert.deepStrictEqual(chunks, [data]);
      assert(stream.checkWrite() > 0n);
    });
  });

  describe('blockingWriteAndFlush', () => {
    it('should write in chunks and blocking flush', async () => {
      const actualChunks = [new Uint8Array(Array(4096).fill(1)), new Uint8Array(Array(12).fill(2))];
      stream.blockingWriteAndFlush(new Uint8Array([...actualChunks[0], ...actualChunks[1]]));
      assert(stream.checkWrite() > 0n);
      await delay(100); // for data to pump through
      assert.deepStrictEqual(chunks, actualChunks);
    });
  });

  describe('writeZeroes', () => {
    it('should write 0s to the stream', async () => {
      stream.writeZeroes(3n);
      await stream.subscribe();
      await delay(100); // for data to pump through
      assert.deepStrictEqual(chunks, [new Uint8Array(3)]);
    });
  });

  describe('blockingWriteZeroesAndFlush', () => {
    it('should write 0s in chunks and blocking flush', async () => {
      stream.blockingWriteZeroesAndFlush(4200n);
      assert(stream.checkWrite() > 0n);
      await delay(100); // for data to pump through
      assert.deepStrictEqual(chunks, [new Uint8Array(4096), new Uint8Array(104)]);
    });
  });

  describe('blockingFlush', () => {
    it('should wait for stream to be writable again', async () => {
      stream.write(new Uint8Array(Array(Number(stream.checkWrite()) + 100).fill(1)));
      assert.strictEqual(stream.checkWrite(), 0n);
      stream.blockingFlush();
      assert(stream.checkWrite() > 0n);
    });
  });

  describe('subscribe', () => {
    it('should return pollable that indicates if stream is writable', async () => {
      const pollable = stream.subscribe();
      await pollable.waitAsync();
      assert.strictEqual(pollable.ready(), true);

      // fill the write buffer
      stream.write(new Uint8Array(Array(Number(stream.checkWrite())).fill(1)));
      assert.strictEqual(pollable.ready(), false);

      await pollable.waitAsync();
      assert.strictEqual(pollable.ready(), true);
      assert(stream.checkWrite() > 0n);

      dispose(pollable);
    });
  });

  describe('splice', () => {
    let inputStream: streams.InputStream;
    let inputChunks: Uint8Array[];

    beforeEach(async () => {
      inputChunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
      for (const chunk of inputChunks) {
        worker.stdin?.write(chunk);
      }
      inputStream = new streams.InputStream({ fd: 0 });

      await delay();
    })

    describe('splice', () => {
      it('should write chunk from input stream', async () => {
        await inputStream.subscribe();

        const len = Number(stream.splice(inputStream, 4n));
        stream.blockingFlush();
  
        await delay(100);
        assert.strictEqual(len, inputChunks[0].length);
        assert.deepStrictEqual(chunks, [inputChunks[0]]);
      });
    });

    describe('blockingSplice', () => {
      it('should write chunk from input stream and block', async () => {
        await inputStream.subscribe();
        const len = Number(stream.blockingSplice(inputStream, 4n));
        assert.strictEqual(len, inputChunks[0].length);
        await delay(100);
        assert.deepStrictEqual(chunks, [inputChunks[0]]);
      });
    });
  });
});
