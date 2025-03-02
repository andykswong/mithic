import type { MaybePromise } from './async/index.ts';

/** A component that can be started and closed later. */
export interface Startable {
  /** Returns if this has started. */
  readonly started: boolean;

  /** Starts this component. */
  start(): MaybePromise<void>;
}

/** A potentially sync or async disposable object. */
export type MaybeDisposable = Partial<Disposable & AsyncDisposable>;

/** Try to dispose a {@link MaybeDisposable} object. */
export function dispose(disposable?: MaybeDisposable): MaybePromise<void> {
  if (disposable === undefined) {
    return;
  }
  if (Symbol.dispose in disposable) {
    return disposable[Symbol.dispose]?.();
  }
  if (Symbol.asyncDispose in disposable) {
    return disposable[Symbol.asyncDispose]?.();
  }
}
