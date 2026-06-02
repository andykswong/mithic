/**
 * Utility functions for @mithic/process.
 * Pipe implementation and convenience helpers.
 */

import { InputStream, OutputStream, type InputStreamHandler, type OutputStreamHandler, type StreamError } from '@mithic/wasip2/io/streams';
import { Pollable } from '@mithic/wasip2/io/poll';
import type { Process, PipeOptions, SpawnOptions, ProcessManager } from '../types.ts';

/**
 * Convenience helper: spawn a process with pipes pre-created for all three streams.
 * Returns the process plus the caller's ends of each pipe.
 */
export function spawnWithPipes(
  manager: ProcessManager,
  file: string,
  args: string[],
  options?: Omit<SpawnOptions, 'stdin' | 'stdout' | 'stderr'>,
): { process: Process; stdin: OutputStream; stdout: InputStream; stderr: InputStream } {
  const stdinPipe = manager.createPipe();
  const stdoutPipe = manager.createPipe();
  const stderrPipe = manager.createPipe();

  const proc = manager.spawn(file, args, {
    ...options,
    stdin: stdinPipe.input,
    stdout: stdoutPipe.output,
    stderr: stderrPipe.output,
  });

  return {
    process: proc,
    stdin: stdinPipe.output,
    stdout: stdoutPipe.input,
    stderr: stderrPipe.input,
  };
}

const DEFAULT_BUFFER_SIZE = 65536;

/**
 * Create an anonymous pipe — a linked (InputStream, OutputStream) pair.
 * Data written to the output is readable from the input.
 */
export function createPipe(options?: PipeOptions): { input: InputStream; output: OutputStream } {
  const bufferSize = options?.bufferSize ?? DEFAULT_BUFFER_SIZE;

  if (options?.shared) {
    return createSharedPipe(bufferSize);
  }
  return createQueuePipe(bufferSize);
}

// --- QueuePipe: Uint8Array[] queue for same-thread use ---

function createQueuePipe(bufferSize: number): { input: InputStream; output: OutputStream } {
  const queue: Uint8Array[] = [];
  let buffered = 0;
  let writerClosed = false;
  let readerClosed = false;

  const inputHandler: InputStreamHandler = {
    read(len: number): Uint8Array | undefined {
      if (queue.length === 0) {
        if (writerClosed) throw { tag: 'closed' } as StreamError;
        return undefined;
      }
      return dequeue(len);
    },

    blockingRead(len: number): Uint8Array {
      if (queue.length === 0) {
        throw { tag: 'closed' } as StreamError;
      }
      return dequeue(len);
    },

    drop(): void {
      readerClosed = true;
      queue.length = 0;
      buffered = 0;
    },
  };

  const outputHandler: OutputStreamHandler = {
    checkWrite(): number {
      if (readerClosed) return 0;
      return Math.max(0, bufferSize - buffered);
    },

    write(data: Uint8Array): void {
      if (readerClosed) {
        throw { tag: 'last-operation-failed', val: { toDebugString: () => 'broken-pipe' } } as StreamError;
      }
      if (data.byteLength === 0) return;
      if (buffered + data.byteLength > bufferSize) {
        throw { tag: 'last-operation-failed', val: { toDebugString: () => 'buffer-overflow' } } as StreamError;
      }
      queue.push(new Uint8Array(data));
      buffered += data.byteLength;
    },

    flush(): void {},

    drop(): void {
      writerClosed = true;
    },
  };

  function dequeue(len: number): Uint8Array {
    if (queue.length === 0) return new Uint8Array(0);
    const chunk = queue[0]!;
    if (chunk.byteLength <= len) {
      queue.shift();
      buffered -= chunk.byteLength;
      return chunk;
    }
    const result = chunk.slice(0, len);
    queue[0] = chunk.slice(len);
    buffered -= len;
    return result;
  }

  return {
    input: new InputStream(inputHandler, () => new Pollable(() => queue.length > 0 || writerClosed)),
    output: new OutputStream(outputHandler, () => new Pollable(() => readerClosed || buffered < bufferSize)),
  };
}

// --- SharedPipe: SharedArrayBuffer ring buffer for cross-thread use ---

const HEADER_SIZE = 16;
const READ_POS = 0;
const WRITE_POS = 1;
const WRITER_CLOSED = 2;
const READER_CLOSED = 3;

function createSharedPipe(bufferSize: number): { input: InputStream; output: OutputStream } {
  const sab = new SharedArrayBuffer(HEADER_SIZE + bufferSize);
  const control = new Int32Array(sab, 0, 4);
  const data = new Uint8Array(sab, HEADER_SIZE);

  function available(): number {
    const rp = Atomics.load(control, READ_POS);
    const wp = Atomics.load(control, WRITE_POS);
    return (wp - rp + bufferSize) % bufferSize;
  }

  function freeSpace(): number {
    return bufferSize - 1 - available();
  }

  const inputHandler: InputStreamHandler = {
    read(len: number): Uint8Array | undefined {
      const avail = available();
      if (avail === 0) {
        if (Atomics.load(control, WRITER_CLOSED)) throw { tag: 'closed' } as StreamError;
        return undefined;
      }
      const toRead = Math.min(len, avail);
      return readFromRing(toRead);
    },

    blockingRead(len: number): Uint8Array {
      let avail = available();
      if (avail === 0) {
        if (Atomics.load(control, WRITER_CLOSED)) throw { tag: 'closed' } as StreamError;
        Atomics.wait(control, WRITE_POS, Atomics.load(control, WRITE_POS));
        avail = available();
        if (avail === 0 && Atomics.load(control, WRITER_CLOSED)) {
          throw { tag: 'closed' } as StreamError;
        }
      }
      const toRead = Math.min(len, avail);
      return readFromRing(toRead);
    },

    drop(): void {
      Atomics.store(control, READER_CLOSED, 1);
      Atomics.notify(control, READER_CLOSED);
    },
  };

  const outputHandler: OutputStreamHandler = {
    checkWrite(): number {
      if (Atomics.load(control, READER_CLOSED)) return 0;
      return freeSpace();
    },

    write(buf: Uint8Array): void {
      if (Atomics.load(control, READER_CLOSED)) {
        throw { tag: 'last-operation-failed', val: { toDebugString: () => 'broken-pipe' } } as StreamError;
      }
      if (buf.byteLength === 0) return;
      if (buf.byteLength > freeSpace()) {
        throw { tag: 'last-operation-failed', val: { toDebugString: () => 'buffer-overflow' } } as StreamError;
      }
      writeToRing(buf);
    },

    flush(): void {},

    drop(): void {
      Atomics.store(control, WRITER_CLOSED, 1);
      Atomics.notify(control, WRITE_POS);
    },
  };

  function readFromRing(len: number): Uint8Array {
    const rp = Atomics.load(control, READ_POS);
    const result = new Uint8Array(len);
    const firstChunk = Math.min(len, bufferSize - rp);
    result.set(data.subarray(rp, rp + firstChunk));
    if (len > firstChunk) {
      result.set(data.subarray(0, len - firstChunk), firstChunk);
    }
    Atomics.store(control, READ_POS, (rp + len) % bufferSize);
    Atomics.notify(control, READ_POS);
    return result;
  }

  function writeToRing(bytes: Uint8Array): void {
    const wp = Atomics.load(control, WRITE_POS);
    const firstChunk = Math.min(bytes.byteLength, bufferSize - wp);
    data.set(bytes.subarray(0, firstChunk), wp);
    if (bytes.byteLength > firstChunk) {
      data.set(bytes.subarray(firstChunk), 0);
    }
    Atomics.store(control, WRITE_POS, (wp + bytes.byteLength) % bufferSize);
    Atomics.notify(control, WRITE_POS);
  }

  return {
    input: new InputStream(inputHandler, () => new Pollable(() => available() > 0 || Atomics.load(control, WRITER_CLOSED) !== 0)),
    output: new OutputStream(outputHandler, () => new Pollable(() => Atomics.load(control, READER_CLOSED) !== 0 || freeSpace() > 0)),
  };
}

// --- SharedPipe reconstruction from raw SAB handles ---

export interface SharedPipeHandle {
  buffer: SharedArrayBuffer;
  bufferSize: number;
}

export function createSharedPipeRaw(bufferSize: number): SharedPipeHandle {
  const buffer = new SharedArrayBuffer(HEADER_SIZE + bufferSize);
  return { buffer, bufferSize };
}

export function inputFromSharedBuffer(buffer: SharedArrayBuffer, bufferSize: number): InputStream {
  const control = new Int32Array(buffer, 0, 4);
  const data = new Uint8Array(buffer, HEADER_SIZE);

  function available(): number {
    const rp = Atomics.load(control, READ_POS);
    const wp = Atomics.load(control, WRITE_POS);
    return (wp - rp + bufferSize) % bufferSize;
  }

  function readFromRing(len: number): Uint8Array {
    const rp = Atomics.load(control, READ_POS);
    const result = new Uint8Array(len);
    const firstChunk = Math.min(len, bufferSize - rp);
    result.set(data.subarray(rp, rp + firstChunk));
    if (len > firstChunk) {
      result.set(data.subarray(0, len - firstChunk), firstChunk);
    }
    Atomics.store(control, READ_POS, (rp + len) % bufferSize);
    Atomics.notify(control, READ_POS);
    return result;
  }

  const inputHandler: InputStreamHandler = {
    read(len: number): Uint8Array | undefined {
      const avail = available();
      if (avail === 0) {
        if (Atomics.load(control, WRITER_CLOSED)) throw { tag: 'closed' } as StreamError;
        return undefined;
      }
      return readFromRing(Math.min(len, avail));
    },
    blockingRead(len: number): Uint8Array {
      let avail = available();
      if (avail === 0) {
        if (Atomics.load(control, WRITER_CLOSED)) throw { tag: 'closed' } as StreamError;
        Atomics.wait(control, WRITE_POS, Atomics.load(control, WRITE_POS));
        avail = available();
        if (avail === 0 && Atomics.load(control, WRITER_CLOSED)) {
          throw { tag: 'closed' } as StreamError;
        }
      }
      return readFromRing(Math.min(len, avail));
    },
    drop(): void {
      Atomics.store(control, READER_CLOSED, 1);
      Atomics.notify(control, READER_CLOSED);
      Atomics.notify(control, READ_POS);
    },
  };

  return new InputStream(inputHandler, () => new Pollable(() => available() > 0 || Atomics.load(control, WRITER_CLOSED) !== 0));
}

export function outputFromSharedBuffer(buffer: SharedArrayBuffer, bufferSize: number): OutputStream {
  const control = new Int32Array(buffer, 0, 4);
  const data = new Uint8Array(buffer, HEADER_SIZE);

  function freeSpace(): number {
    const rp = Atomics.load(control, READ_POS);
    const wp = Atomics.load(control, WRITE_POS);
    return bufferSize - 1 - ((wp - rp + bufferSize) % bufferSize);
  }

  function writeToRing(bytes: Uint8Array): void {
    const wp = Atomics.load(control, WRITE_POS);
    const firstChunk = Math.min(bytes.byteLength, bufferSize - wp);
    data.set(bytes.subarray(0, firstChunk), wp);
    if (bytes.byteLength > firstChunk) {
      data.set(bytes.subarray(firstChunk), 0);
    }
    Atomics.store(control, WRITE_POS, (wp + bytes.byteLength) % bufferSize);
    Atomics.notify(control, WRITE_POS);
  }

  const outputHandler: OutputStreamHandler = {
    checkWrite(): number {
      if (Atomics.load(control, READER_CLOSED)) {
        throw { tag: 'last-operation-failed', val: { toDebugString: () => 'broken-pipe' } } as StreamError;
      }
      return freeSpace();
    },
    write(buf: Uint8Array): void {
      if (Atomics.load(control, READER_CLOSED)) {
        throw { tag: 'last-operation-failed', val: { toDebugString: () => 'broken-pipe' } } as StreamError;
      }
      if (buf.byteLength === 0) return;
      if (buf.byteLength > freeSpace()) {
        throw { tag: 'last-operation-failed', val: { toDebugString: () => 'buffer-overflow' } } as StreamError;
      }
      writeToRing(buf);
    },
    flush(): void {},
    drop(): void {
      Atomics.store(control, WRITER_CLOSED, 1);
      Atomics.notify(control, WRITE_POS);
    },
  };

  const pollReady = () => Atomics.load(control, READER_CLOSED) !== 0 || freeSpace() > 0;
  return new OutputStream(outputHandler, () => new Pollable(
    pollReady,
    () => { while (!pollReady()) { Atomics.wait(control, READ_POS, Atomics.load(control, READ_POS), 100); } },
  ));
}
