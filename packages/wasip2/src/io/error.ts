/**
 * Implements wasi:io/error - error resource for I/O operations.
 * Matches jco's IoError which stores a payload and exposes toDebugString().
 */
export class IoError {
  payload: unknown;
  #message: string;

  constructor(message: unknown = '') {
    if (typeof message === 'string') {
      this.#message = message;
    } else if (message instanceof Error) {
      this.#message = message.message;
    } else {
      this.#message = String(message);
    }
    this.payload = message;
  }

  toDebugString(): string {
    return this.#message;
  }
}

/** Alias matching WIT resource name for jco compatibility. */
export { IoError as Error };
