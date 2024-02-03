import { AsyncDisposableCloseable, Closeable } from '../lifecycle/index.ts';
import { Lock } from './lock.ts';
import { MaybePromise, maybeAsync } from './promise.ts';

/** A disposable {@link Lock} wrapper for RAII-style lock. */
export class LockGuard extends AsyncDisposableCloseable implements Closeable, AsyncDisposable {
  private count = 1;

  private constructor(private readonly lock: Lock) {
    super();
  }

  /** Acquires a lock and returns a {@link LockGuard} for the {@link Lock}. */
  public static acquire = maybeAsync(function* <L extends Lock>(
    lock: L, ...options: Parameters<L['acquire']>
  ) {
    yield lock.acquire(...options);
    return new LockGuard(lock);
  });

  public override close(): MaybePromise<void> {
    if (this.count-- > 0) {
      return this.lock.release();
    }
  }
}
