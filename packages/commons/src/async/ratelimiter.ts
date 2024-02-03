import { AbortOptions } from './options.ts';
import { Lock } from './lock.ts';
import { SharedCountingSemaphore } from './semaphore.ts';

/** A {@link Lock} that issues permits at a fixed rate. */
export class RateLimiter implements Lock {
  public readonly semaphore: SharedCountingSemaphore;
  private readonly interval: number;
  private resetTimer = 0;

  public constructor(
    /** Total number of permits issued over given period. */
    permits = 1,
    /** The time period in milliseconds. */
    period = 1000,
    /** Shared array buffer for permit synchronization. */
    buffer?: Int32Array,
  ) {
    this.interval = period / permits;
    this.semaphore = new SharedCountingSemaphore({ buffer, permits, waitInterval: Math.ceil(this.interval + 1) });
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
    this.resetTimer = this.resetTimer || setTimeout(this.resetLimit, this.interval) as unknown as number;
  }

  private resetLimit = () => {
    this.semaphore.release();
    if (this.semaphore.availablePermits < this.semaphore.permits) {
      this.resetTimer = 0;
      this.triggerPermitReset();
    }
  }
}
