import { Error } from '@mithic/commons';

/** An error indicating a stream error. */
export class StreamError extends Error<StreamErrorPayload, Error> {
  public constructor(payload: StreamErrorPayload) {
    super(payload.tag, { name: StreamError.name, payload, cause: payload.val });
  }
}

/** Type of {@link StreamError} */
export const StreamErrorTag = {
  /** The last operation (a write or flush) failed before completion. */
  LastOperationFailed: 'last-operation-failed',
  /** The stream is closed. */
  Closed: 'closed'
} as const;

export type StreamErrorTag = typeof StreamErrorTag[keyof typeof StreamErrorTag];

/** An error for input-stream and output-stream operations. */
export type StreamErrorPayload = {
  tag: typeof StreamErrorTag.LastOperationFailed,
  val: Error,
} | {
  tag: typeof StreamErrorTag.Closed,
  val?: undefined,
};

/** Special file descriptor values. */
export const FD = {
  Stdin: 0,
  Stdout: 1,
  Stderr: 2,
} as const;

/** Special stream state values. */
export const StreamState = {
  Pending: 0,
  Ready: 1,
  Error: 0x7FFFFFFE,
  Closed: 0x7FFFFFFF,
} as const;

export * from './provider/index.ts';
