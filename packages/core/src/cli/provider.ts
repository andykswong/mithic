import type { MaybePromise } from '@mithic/commons';
import type { ReadStream, WriteStream } from '../io/index.ts';

/** Provider of stdio streams. */
export interface StdioProvider {
  /** Provides the stdin stream. */
  getStdin(): MaybePromise<ReadStream>;

  /** Provides the stdout stream. */
  getStdout(): MaybePromise<WriteStream>;

  /** Provides the stderr stream. */
  getStderr(): MaybePromise<WriteStream>;
}
