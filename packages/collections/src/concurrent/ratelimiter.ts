import { AbortOptions, CountingSemaphore, Semaphore } from '@mithic/commons';
import { SyncQueue } from '../queue.js';
import { Deque } from '../impl/index.js';

/** A semaphore that limits access to resources by issuing fixed number of permits per period. */
export class RateLimiter implements Semaphore {
  private semaphore: Semaphore;
  private resetQueue: SyncQueue<number> = new Deque();
  private resetTimer = 0;

  public constructor(
    /** Total number of permits over given interval. */
    limit = 1,
    /** The interval. */
    private readonly interval = 1000,
    /** Function to return the current time. */
    private readonly now: () => number = Date.now,
  ) {
    this.semaphore = new CountingSemaphore(limit);
  }

  public async acquire(options?: AbortOptions): Promise<void> {
    await this.semaphore.acquire(options);
    this.triggerPermitReset();
  }

  public tryAcquire(): boolean {
    if (this.semaphore.tryAcquire()) {
      this.triggerPermitReset();
      return true;
    }
    return false;
  }

  public release(): void {
    // no op
  }

  private triggerPermitReset(): void {
    if (!this.resetTimer) {
      this.resetTimer = setTimeout(this.resetLimit, this.interval) as unknown as number;
    } else {
      this.resetQueue.push(this.now());
    }
  }

  private resetLimit = () => {
    this.semaphore.release();
    const now = this.now();
    const next = this.resetQueue.shift() ?? -1;
    this.resetTimer = next < 0 ? 0 : setTimeout(this.resetLimit, Math.max(next - now, 0)) as unknown as number;
  }
}
