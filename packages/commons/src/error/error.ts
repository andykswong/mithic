import { ErrorCode, ErrorName } from './enums.js';

/** Error with error code. */
export class CodedError<T = unknown, E = unknown> extends Error {
  /** Thr error code. */
  public readonly code: ErrorCode | string;

  /** The error cause. */
  public override readonly cause?: E;

  /** Returns any data passed when initializing the error. */
  public detail?: T;

  constructor(
    message?: string,
    options?: CodedErrorOptions<T>,
  ) {
    super(message, options);
    this.name = options?.name ?? ErrorName.Coded;
    this.code = options?.code ?? ErrorCode.Error;
    this.detail = options?.detail;
  }
}

/** Options for initializing a {@link CodedError}. */
export interface CodedErrorOptions<T> extends ErrorOptions {
  /** Error code. */
  code?: ErrorCode | string;

  /** Error name. */
  name?: string;

  /** Error details. */
  detail?: T;
}
