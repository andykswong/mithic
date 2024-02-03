import { AbortOptions, MaybePromise } from '../async/index.ts';

/** A resource-holding object that can be closed to release resources. */
export interface Closeable {
  /** Closes this object and releases any system resource associated with it. */
  close(options?: AbortOptions): MaybePromise<void>;
}

/** An abstract base class that implements synchronous Disposable using {@link Closeable} */
export abstract class DisposableCloseable implements Closeable, Disposable {
  public [Symbol.dispose](): void {
    this.close();
  }

  public abstract close(options?: AbortOptions): void;
}

/** An abstract base class that implements AsyncDisposable/Disposable using {@link Closeable} */
export abstract class AsyncDisposableCloseable implements Closeable, AsyncDisposable {
  public async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  public abstract close(options?: AbortOptions): MaybePromise<void>;
}
