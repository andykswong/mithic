import type { MaybePromise } from '../async/promise.ts';
import { AtomicRingBuffer } from '../buffer.ts';
import type { Channel } from './channel.ts';

const DEFAULT_BUFFER_SIZE = 8192;
const SIZE_LEN = 4;

/**
 * A {@link Channel} that transfers binary messages with length encoding using 2 {@link AtomicRingBuffer}.
 * Note that this is intended for lock-free single producer, single consumer use.
 */
export class SharedArrayBufferChannel implements Channel<Uint8Array> {
  /** The ring buffer queue for sender side. */
  public readonly sendQueue: AtomicRingBuffer;
  /** The ring buffer queue for receiver side. */
  public readonly recvQueue: AtomicRingBuffer;
  /** Whether this channel instance is on the receiver side. */
  public readonly receiver: boolean;

  private sendBuffer?: Uint8Array;
  private recvBuffer?: Uint8Array;
  private recvMsgLen = new Uint8Array(SIZE_LEN);
  private readonly recvMsgLenView = new DataView(this.recvMsgLen.buffer);

  public constructor({
    send = [new SharedArrayBuffer(DEFAULT_BUFFER_SIZE)],
    recv = [new SharedArrayBuffer(DEFAULT_BUFFER_SIZE)],
    sendQueue = new AtomicRingBuffer(...send),
    recvQueue = new AtomicRingBuffer(...recv),
    receiver = false,
  }: SharedArrayBufferChannelOptions = {}) {
    if (sendQueue.maxByteLength < SIZE_LEN) {
      throw new TypeError('send buffer too small');
    }
    this.sendQueue = sendQueue;
    this.recvQueue = recvQueue;
    this.receiver = receiver;
  }

  /** Returns the shared buffers for channel communication. */
  public get buffers(): SharedChannelBuffers {
    return {
      send: [this.sendQueue.buffer, this.sendQueue.byteOffset, this.sendQueue.maxByteLength],
      recv: [this.recvQueue.buffer, this.recvQueue.byteOffset, this.recvQueue.maxByteLength],
    };
  }

  public get maxSendSize(): number {
    this.flushSendBuffer();
    return this.writeQueueSize - (this.sendBuffer?.byteLength || 0) - SIZE_LEN; // each message needs a size header
  }

  public send(message: Uint8Array): boolean {
    if (message.byteLength === 0) { return true; }
    if (this.maxSendSize <= 0 && this.sendBuffer?.byteLength) { return false; }

    const fullMsgSize = message.byteLength + SIZE_LEN;
    const sendBuffer = this.sendBuffer = (this.sendBuffer?.buffer.byteLength || 0) < fullMsgSize ?
      new Uint8Array(fullMsgSize) :
      new Uint8Array(this.sendBuffer!.buffer, 0, fullMsgSize);
    new DataView(sendBuffer.buffer).setUint32(0, message.byteLength, true);
    sendBuffer.set(message, SIZE_LEN);

    const sentLen = this.writeQueue.push(sendBuffer.subarray(0, this.writeQueue.maxByteLength - this.writeQueue.byteLength));
    this.sendBuffer = sendBuffer.subarray(sentLen);
    return sentLen > 0;
  }

  public receive(): Uint8Array | undefined {
    const msgSize = this.getMsgLen();
    if (msgSize <= 0) { return; }

    this.recvBuffer = this.recvBuffer || new Uint8Array(msgSize);
    const filledBuffer = this.readQueue.shift(this.recvBuffer);
    if (filledBuffer) {
      this.recvBuffer = this.recvBuffer.subarray(filledBuffer.byteLength);
    }
    if (this.recvBuffer.byteLength > 0) { return; }

    const msg = new Uint8Array(this.recvBuffer.buffer, 0, msgSize);
    this.resetMsgLen();
    this.recvBuffer = undefined;
    return msg;
  }

  public wait(timeoutMs?: number): boolean {
    if (this.readQueue.byteLength > 0) {
      return true;
    }
    return this.readQueue.wait(timeoutMs);
  }

  public waitAsync(timeoutMs?: number): MaybePromise<boolean> {
    if (this.readQueue.byteLength > 0) {
      return true;
    }
    return this.readQueue.waitAsync(timeoutMs);
  }

  public flush(timeoutMs?: number): boolean {
    this.flushSendBuffer();
    if (!this.sendBuffer?.byteLength) {
      return true;
    }
    this.writeQueue.wait(timeoutMs);
    this.flushSendBuffer();
    return !this.sendBuffer?.byteLength;
  }

  public async flushAsync(timeoutMs?: number): Promise<boolean> {
    this.flushSendBuffer();
    if (!this.sendBuffer?.byteLength) {
      return true;
    }
    await this.writeQueue.waitAsync(timeoutMs);
    this.flushSendBuffer();
    return !this.sendBuffer?.byteLength;
  }

  private getMsgLen(): number {
    if (this.recvMsgLen.byteLength > 0) {
      const received = this.readQueue.shift(this.recvMsgLen);
      if (received) {
        this.recvMsgLen = this.recvMsgLen.subarray(received.byteLength);
      }
    }
    return this.recvMsgLen.byteLength > 0 ? 0 : this.recvMsgLenView.getUint32(0, true);
  }

  private resetMsgLen() {
    this.recvMsgLen = new Uint8Array(this.recvMsgLen.buffer);
  }

  private flushSendBuffer() {
    const size = this.writeQueueSize;
    if (size && this.sendBuffer?.byteLength) {
      const sentLen = this.sendQueue.push(this.sendBuffer.subarray(0, size));
      this.sendBuffer = this.sendBuffer.subarray(sentLen);
    }
  }

  private get writeQueueSize(): number {
    return this.writeQueue.maxByteLength - this.writeQueue.byteLength;
  }

  private get writeQueue() {
    return this.receiver ? this.recvQueue : this.sendQueue;
  }

  private get readQueue() {
    return this.receiver ? this.sendQueue : this.recvQueue;
  }
}

/** Options for creating {@link SharedArrayBufferChannel}. */
export interface SharedArrayBufferChannelOptions extends Partial<SharedChannelBuffers> {
  /** The ring buffer queue for sending data. */
  readonly sendQueue?: AtomicRingBuffer;
  /** The ring buffer queue for receiving data. */
  readonly recvQueue?: AtomicRingBuffer;
  /** Set to true to act as receiving side, which treats the send/recv queues in reverse. */
  readonly receiver?: boolean;
}

/** The shared buffers used for {@link SharedArrayBufferChannel}. */
export interface SharedChannelBuffers {
  /** The send buffer. */
  readonly send: [buffer: SharedArrayBuffer, byteOffset?: number, maxByteLength?: number];
  /** The receive buffer. */
  readonly recv: [buffer: SharedArrayBuffer, byteOffset?: number, maxByteLength?: number];
}
