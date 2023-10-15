import { Lock } from './lock.js';
import { AbortOptions } from './options.js';
import { MaybePromise } from './promise.js';

/** A {@link Lock} implement using Web Lock API. */
export class WebLock implements Lock {
  /** Unique name of the lock. */
  public readonly name: string;

  /** Whether the lock is shared. */
  public readonly shared: boolean;

  protected readonly locks: LockManager;
  protected count = 0;
  protected resolve?: () => void;
  private handle?: Promise<void>;

  public constructor({
    name = 'lock',
    shared = false,
    locks = navigator.locks,
  }: WebLockOptions = {}) {
    this.name = name;
    this.shared = shared;
    this.locks = locks;
  }

  public async acquire(options?: AbortOptions): Promise<void> {
    if (this.handle) {
      if (this.shared) {
        ++this.count;
        return;
      }

      await this.handle;
      this.handle = void 0;
    }

    await this.requestLock({ ...options, ifAvailable: false });
  }

  public tryAcquire(): MaybePromise<boolean> {
    if (this.handle) {
      if (this.shared) {
        ++this.count;
        return true;
      } else {
        return false;
      }
    }

    return this.requestLock({ ifAvailable: true });
  }
  

  public release(): void {
    if (--this.count <= 0) {
      this.resolve?.();
      this.resolve = void 0;
      this.handle = void 0;
    }
  }

  protected requestLock(options: AbortOptions & { ifAvailable: boolean }): Promise<boolean> {
    let resolve: (value: boolean) => void;
    const request = new Promise<boolean>((_resolve) => resolve = _resolve);
    const lockHandle = this.locks.request(
      this.name,
      {
        ...options,
        mode: this.shared ? 'shared' : 'exclusive',
      },
      async (lock) => {
        options?.signal?.throwIfAborted();
        const success = lock !== null;
        resolve(success);
        if (success) {
          this.count = this.count || 1;
          await this.getHandle();
        }
        return success;
      },
    );
    return Promise.race([request, lockHandle]);
  }

  protected getHandle(): Promise<void> {
    return this.handle || (this.handle = new Promise((resolve) => { this.resolve = resolve; }));
  }
}

/** Options for creating a {@link WebLock}. */
export interface WebLockOptions {
  /** Unique name of the lock. Defaults to `lock`. */
  name?: string;

  /** Whether the lock is shared. Defaults to `false`. */
  shared?: boolean;

  /** Instance of LockManager. */
  locks?: LockManager;
}
