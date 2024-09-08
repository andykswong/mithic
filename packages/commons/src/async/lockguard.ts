import { MaybePromise } from './promise.ts';
import { type Semaphore } from './semaphore.ts';

/** A RAII-style async lock guard that uses a {@link Semaphore}. */
export class LockGuard implements AsyncDisposable {
  private count = 1;

  private constructor(private readonly semaphore: Semaphore) {
  }

  /**
   * Acquires a lock and returns a {@link LockGuard}.
   * @throws AbortError if the operation timed out.
   */
  public static acquire = MaybePromise.coroutine(function* <S extends Semaphore>(
    semaphore: S, timeoutMs?: number,
  ) {
    if (!(yield semaphore.waitAsync(1, timeoutMs))) {
      AbortSignal.abort().throwIfAborted();
    }
    return new LockGuard(semaphore);
  });

  public async [Symbol.asyncDispose](): Promise<void> {
    if (this.count-- > 0) {
      await this.semaphore.notify();
    }
  }
}
