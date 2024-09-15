import type { Queue } from './queue/index.ts';

/** A queue (buffer) of byte data. */
export interface ByteQueue extends Queue<Uint8Array> {
  /** Returns the byte length of available data. */
  readonly byteLength: number;

  /** Returns the maximum byte length that can be held. */
  readonly maxByteLength: number;

  /** Pushes given byte data to the buffer and returns the number of bytes written. */
  push(data: Uint8Array): number;

  /** Pops data to given output buffer and returns the subarray being filled. */
  shift(output?: Uint8Array): Uint8Array | undefined;

  /** Wait for buffer length to change or timeout. */
  wait(timeoutMs?: number): boolean;

  /** Asynchronously wait for buffer length to change or timeout. */
  waitAsync(timeoutMs?: number): Promise<boolean>;
}

const STATE_SIZE = 16;
const LEN_IDX = 0, RESERVED_IDX = 1, START_IDX = 2, END_IDX = 3;

/**
 * A circular buffer backed by SharedArrayBuffer and Atomics.
 * This is intended to be used lock-free for single producer, single consumer.
 * Multiple producers / consumers use case will require locking to avoid partial read / interleaved write.
 */
export class AtomicRingBuffer implements ByteQueue, Iterable<number> {
  /** The backing data buffer. */
  public readonly buffer: SharedArrayBuffer;

  /** The byte data view. */
  private readonly dataView: Uint8Array;
  /**
   * The state of buffer. Layout = [length, reservedLen, startIdx, endIdx]
   */
  private readonly state: Int32Array;

  public constructor(
    /** The backing data buffer. byteLength must be in multiples of 4 and >= 16. */
    buffer: SharedArrayBuffer = new SharedArrayBuffer(STATE_SIZE + 4096),
    /** Offset to the buffer to use. */
    offset = 0,
    /** Length of the buffer to use. */
    maxByteLength = buffer.byteLength - offset,
  ) {
    maxByteLength = Math.min(maxByteLength, buffer.byteLength - offset);
    if (maxByteLength < STATE_SIZE) {
      throw new TypeError(`buffer must be at least ${STATE_SIZE} bytes`);
    }
    this.buffer = buffer;
    this.state = new Int32Array(buffer, offset, STATE_SIZE / 4);
    this.dataView = new Uint8Array(buffer, offset + STATE_SIZE, maxByteLength - STATE_SIZE);
  }

  public *[Symbol.iterator](): IterableIterator<number> {
    const maxLen = this.maxByteLength;
    const start = Atomics.load(this.state, START_IDX);
    const len = this.byteLength;
    for (let i = 0; i < len; i++) {
      yield this.dataView[(start + i) % maxLen];
    }
  }

  /** The byte offset to the buffer. */
  public get byteOffset(): number {
    return this.state.byteOffset;
  }

  public get length(): number {
    return this.byteLength;
  }

  public get byteLength(): number {
    return Atomics.load(this.state, LEN_IDX);
  }

  public get maxByteLength(): number {
    return this.dataView.length;
  }

  public push(data: Uint8Array): number {
    const len = data.length;
    const maxLen = this.maxByteLength;

    let reserved;
    do {
      reserved = Atomics.load(this.state, RESERVED_IDX);
      if (reserved + len > maxLen) { return 0; }
    } while (Atomics.compareExchange(this.state, RESERVED_IDX, reserved, reserved + len) !== reserved);

    let dataStart;
    do {
      dataStart = Atomics.load(this.state, END_IDX);
    } while (Atomics.compareExchange(this.state, END_IDX, dataStart, (dataStart + len) % maxLen) !== dataStart);

    if (dataStart + len > maxLen) {
      const splitPoint = maxLen - dataStart;
      this.dataView.set(data.subarray(0, splitPoint), dataStart);
      this.dataView.set(data.subarray(splitPoint, len), 0);
    } else {
      this.dataView.set(data.subarray(0, len), dataStart);
    }

    Atomics.add(this.state, LEN_IDX, len);
    Atomics.notify(this.state, LEN_IDX);

    return len;
  }

  public shift(output?: Uint8Array): Uint8Array | undefined {
    let len = output ? Math.min(this.byteLength, output.byteLength) : this.byteLength;
    const maxLen = this.maxByteLength;

    let available;
    do {
      available = Atomics.load(this.state, LEN_IDX);
      len = Math.min(len, available);
      if (len <= 0) { return; }
    } while (Atomics.compareExchange(this.state, LEN_IDX, available, available - len) !== available);

    let dataStart, dataEnd;
    do {
      dataStart = Atomics.load(this.state, START_IDX);
      dataEnd = (dataStart + len) % maxLen;
    } while (Atomics.compareExchange(this.state, START_IDX, dataStart, dataEnd) !== dataStart);

    const result = output?.subarray(0, len) || new Uint8Array(len);
    const chunk1 = this.dataView.subarray(dataStart, Math.min(dataStart + len, maxLen));
    result.set(chunk1);
    if (chunk1.length < len) {
      const chunk2 = this.dataView.subarray(0, dataEnd);
      result.set(chunk2, chunk1.length);
    }

    Atomics.sub(this.state, RESERVED_IDX, len);
    Atomics.notify(this.state, LEN_IDX);

    return result;
  }

  public wait(timeoutMs?: number): boolean {
    return Atomics.wait(this.state, LEN_IDX, this.byteLength, timeoutMs) !== 'timed-out';
  }

  public async waitAsync(timeoutMs?: number): Promise<boolean> {
    return (
      await Atomics.waitAsync(this.state, LEN_IDX, this.byteLength, timeoutMs).value
    ) !== 'timed-out';
  }
}
