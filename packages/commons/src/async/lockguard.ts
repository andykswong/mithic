import { AsyncDisposableCloseable, Closeable } from '../lifecycle/index.js';
import { Lock } from './lock.js';
import { MaybePromise } from './promise.js';

/** A disposable {@link Lock} wrapper for RAII-style lock. */
export class LockGuard extends AsyncDisposableCloseable implements Closeable, AsyncDisposable {
  private count = 1;

  private constructor(private readonly lock: Lock) {
    super();
  }

  /** Acquires a lock and returns a {@link LockGuard} for the {@link Lock}. */
  public static async acquire<L extends Lock>(lock: L, ...options: Parameters<L['acquire']>): Promise<LockGuard> {
    await lock.acquire(...options);
    return new LockGuard(lock);
  }

  public override close(): MaybePromise<void> {
    if (this.count-- > 0) {
      return this.lock.release();
    }
  }
}
