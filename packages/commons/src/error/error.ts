import { ERR } from './code.ts';

/** Error with error code. */
export class CodedError<T = unknown, E = unknown> extends Error {
  /** Thr error code. */
  public readonly code: string;

  /** The error cause. */
  public override readonly cause?: E;

  /** Returns any data passed when initializing the error. */
  public detail?: T;

  public constructor(
    message?: string,
    options?: CodedErrorOptions<T>,
  ) {
    super(message, options);
    this.name = options?.name ?? CodedError.name;
    this.code = options?.code ?? ERR;
    this.detail = options?.detail;
  }
}

/** Options for initializing a {@link CodedError}. */
export interface CodedErrorOptions<T> extends ErrorCodeDetailOptions<T> {
  /** Error name. */
  readonly name?: string;
}

/** Options for initializing an error with code and detail. */
export interface ErrorCodeDetailOptions<T> extends ErrorDetailOptions<T> {
  /** Error code. */
  readonly code?: string;
}

/** Options for initializing an error with detail. */
export interface ErrorDetailOptions<T> extends ErrorOptions {
  /** Error details. */
  readonly detail?: T;
}
