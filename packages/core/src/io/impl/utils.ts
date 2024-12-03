import { Error } from '@mithic/commons';
import { StreamError, StreamErrorTag, type StreamErrorPayload } from '../errors.ts';

const MIN_BUFFER_SIZE = 4096;

/** Abstract base class for a Read/WriteStream. */
export abstract class BaseStream implements Disposable {
  private _state: number = StreamState.Pending;
  private _error?: StreamErrorPayload;

  public [Symbol.dispose](): void {
    this.close();
  }

  protected get error(): StreamErrorPayload | undefined {
    return this._error;
  }

  protected get state(): number {
    return this._state;
  }

  protected close() {
    this._state = StreamState.Closed;
  }

  protected setError(cause?: unknown) {
    this._state = StreamState.Error;
    return (this._error = {
      tag: StreamErrorTag.LastOperationFailed,
      val: new Error('failed to get reader', { cause })
    });
  }

  protected checkState() {
    const state = this.state;
    assert(state !== StreamState.Closed, { tag: StreamErrorTag.Closed });
    assert(state !== StreamState.Error, this.error ?? {
      tag: StreamErrorTag.LastOperationFailed,
      val: new Error(`stream error`)
    });
  }
}

/** Stream state value. */
export const StreamState = {
  Pending: 0,
  Ready: 1,
  Error: 0x7FFFFFFE,
  Closed: 0x7FFFFFFF,
} as const;

declare const __streamState: unique symbol;

export type StreamState = typeof StreamState[keyof typeof StreamState] | number & { [__streamState]: never };

/**
 * Asserts a condition.
 * @throws {@link StreamError}
 */
export function assert(cond: unknown, error: StreamErrorPayload): asserts cond {
  if (!cond) { throw new StreamError(error); }
}

/** Appends data to given buffer and returns the new buffer. */
export function appendBuffer(
  buffer: Uint8Array | undefined, data: Uint8Array, minBufferSize = MIN_BUFFER_SIZE
): Uint8Array {
  let newBuffer;
  if (!buffer) {
    newBuffer = new Uint8Array(new ArrayBuffer(Math.max(minBufferSize, data.length)), 0, data.length);
    newBuffer.set(data);
  } else if (buffer.buffer.byteLength - buffer.byteOffset < data.length) {
    const len = buffer.length + data.length;
    newBuffer = new Uint8Array(new ArrayBuffer(Math.max(minBufferSize, len)), 0, len);
    newBuffer.set(buffer);
    newBuffer.set(data, buffer.length);
  } else {
    newBuffer = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length + data.length);
    newBuffer.set(data, buffer.length);
  }
  return newBuffer;
}

/** Consumes data from buffer and returns the new remaining buffer. */
export function consumeBuffer(buffer: Uint8Array, len: number): [buffer: Uint8Array, data: Uint8Array] {
  const data = buffer.subarray(0, Math.min(len, buffer.length));
  const newBuffer = buffer.subarray(data.length);
  return [newBuffer, data];
}
