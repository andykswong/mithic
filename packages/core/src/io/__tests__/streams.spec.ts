import type { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { delay } from '@mithic/commons';
import { runWorker } from '#io/tests/worker';
import { InputStream, OutputStream } from '../streams.ts';
import { Io } from '../types.ts';

describe('InputStream', () => {
  let stream: InputStream;
  let chunks: Uint8Array[];
  let worker: Worker;

  beforeEach(async () => {
    [worker, Io.provider] = runWorker();
    chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6, 7])];
    for (const chunk of chunks) {
      worker.stdin?.write(chunk);
    }
    await delay(100);

    stream = new InputStream({ fd: 0 });
  });

  afterEach(async () => {
    await worker?.terminate();
  });

  describe('read', () => {
    it('should read nothing from first try', async () => {
      const result = stream.read(4n);
      expect(result).toStrictEqual(new Uint8Array());
    });

    it('should read chunk from input stream', async () => {
      await stream.subscribe().waitAsync();
      const result = stream.read(4n);
      expect(result).toStrictEqual(chunks[0]);
    });
  });

  describe('blockingRead', () => {
    it('should read chunk from input stream', () => {
      const result = stream.blockingRead(4n);
      expect(result).toStrictEqual(chunks[0]);
    });
  });

  describe('subscribe', () => {
    it('should return pollable that indicates if stream is ready to be read', async () => {
      expect(stream.blockingRead(5n)).toStrictEqual(chunks[0]);
      expect(stream.blockingRead(5n)).toStrictEqual(chunks[1]);

      using pollable = stream.subscribe();
      expect(pollable.ready()).toBe(false);

      const data = [8, 9];
      worker.stdin?.write(new Uint8Array(data));
      await pollable.waitAsync();

      expect(pollable.ready()).toBe(true);
      expect(stream.read(2n)).toStrictEqual(new Uint8Array(data));
    });
  });
});

describe('OutputStream', () => {
  let stream: OutputStream;
  let chunks: Uint8Array[];
  let worker: Worker;

  beforeEach(async () => {
    [worker, Io.provider] = runWorker();
    chunks = [];
    worker.stdout?.on('data', (chunk) => {
      chunks.push(new Uint8Array(chunk));
    });
    await delay(100);

    stream = new OutputStream({ fd: 1 });
  });

  afterEach(async () => {
    await worker?.terminate();
  });

  describe('write', () => {
    it('should write data to the stream', async () => {
      const data = new Uint8Array([1, 2, 3]);
      stream.write(data);
      await stream.subscribe().waitAsync();
      await delay(100); // for data to pump through 
      expect(chunks).toStrictEqual([data]);
      expect(Number(stream.checkWrite())).toBeGreaterThan(0);
    });
  });

  describe('blockingWriteAndFlush', () => {
    it('should write in chunks and blocking flush', async () => {
      const actualChunks = [new Uint8Array(Array(4096).fill(1)), new Uint8Array(Array(12).fill(2))];
      stream.blockingWriteAndFlush(new Uint8Array([...actualChunks[0], ...actualChunks[1]]));
      expect(Number(stream.checkWrite())).toBeGreaterThan(0);
      await delay(100); // for data to pump through
      expect(chunks).toStrictEqual(actualChunks);
    });
  });

  describe('writeZeroes', () => {
    it('should write 0s to the stream', async () => {
      stream.writeZeroes(3n);
      await stream.subscribe().waitAsync();
      await delay(100); // for data to pump through
      expect(chunks).toStrictEqual([new Uint8Array(3)]);
    });
  });

  describe('blockingWriteZeroesAndFlush', () => {
    it('should write 0s in chunks and blocking flush', async () => {
      stream.blockingWriteZeroesAndFlush(4200n);
      expect(Number(stream.checkWrite())).toBeGreaterThan(0);
      await delay(100); // for data to pump through
      expect(chunks).toStrictEqual([new Uint8Array(4096), new Uint8Array(104)]);
    });
  });

  describe('blockingFlush', () => {
    it('should wait for stream to be writable again', async () => {
      stream.write(new Uint8Array(Array(Number(stream.checkWrite())).fill(1)));
      expect(Number(stream.checkWrite())).toBe(0);
      stream.blockingFlush();
      expect(Number(stream.checkWrite())).toBeGreaterThan(0);
    });
  });

  describe('subscribe', () => {
    it('should return pollable that indicates if stream is writable', async () => {
      stream.write(new Uint8Array(Array(Number(stream.checkWrite())).fill(1)));
      using pollable = stream.subscribe();
      pollable.block();
      expect(pollable.ready()).toBe(true);
      expect(Number(stream.checkWrite())).toBeGreaterThan(0);
    });
  });

  describe('splice', () => {
    let inputStream: InputStream;
    let inputChunks: Uint8Array[];

    beforeEach(async () => {
      inputChunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
      for (const chunk of inputChunks) {
        worker.stdin?.write(chunk);
      }
      inputStream = new InputStream({ fd: 0 });

      await delay();
    })

    describe('splice', () => {
      it('should write chunk from input stream', async () => {
        await inputStream.subscribe().waitAsync();

        const len = Number(stream.splice(inputStream, 4n));
        stream.blockingFlush();
  
        await delay(100);
        expect(len).toBe(inputChunks[0].length);
        expect(chunks).toStrictEqual([inputChunks[0]]);
      });
    });

    describe('blockingSplice', () => {
      it('should write chunk from input stream and block', async () => {
        await inputStream.subscribe().waitAsync();
        const len = Number(stream.blockingSplice(inputStream, 4n));
        expect(len).toBe(inputChunks[0].length);
        await delay(100);
        expect(chunks).toStrictEqual([inputChunks[0]]);
      });
    });
  });
});
