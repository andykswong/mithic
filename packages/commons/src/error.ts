/** A resource which represents some error information. */
export class Error<T = unknown, E = unknown> extends globalThis.Error {
  /** The error code. */
  public readonly code?: string;
  /** The error cause. */
  declare public readonly cause?: E;
  /** Returns any data passed when initializing the error. */
  public payload?: T;

  public constructor(
    message?: string,
    options?: ExtendedErrorOptions<T>,
  ) {
    super(message, options);
    this.name = options?.name ?? Error.name;
    this.code = options?.code;
    this.payload = options?.payload;
  }

  /** Returns a string that is suitable to assist humans in debugging this error. */
  public toDebugString(): string {
    return this.message;
  }
}

/** Extended options for initializing an {@link Error}. */
export interface ExtendedErrorOptions<T> extends ErrorOptions {
  /** Error name. */
  readonly name?: string;

  /** Error code. */
  readonly code?: string;

  /** Error payload. */
  readonly payload?: T;
}
