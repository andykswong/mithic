import { AbortOptions, CountingSemaphore, MaybePromise, Semaphore, Startable } from '@mithic/commons';
import { Queue } from '../queue.js';

/** A queue of async tasks. */
export class TaskQueue implements Startable {
  private paused;
  private _pending = 0;
  private queued = 0;

  constructor(
    private readonly semaphore: Semaphore = new CountingSemaphore(),
    private readonly queue: Queue<RunnableTask> = [],
    autoStart = true,
  ) {
    this.paused = !autoStart;
  }

  public get started(): boolean {
    return !this.paused;
  }

  /** Returns the total number of unfinished tasks. */
  public get size(): number {
    return this.queued + this._pending;
  }

  /** Returns the number of running but unfinished tasks. */
  public get pending(): number {
    return this._pending;
  }

  /** Pauses further task processing. Already started tasks will keep running. */
  public pause(): void {
    this.paused = true;
  }

  public start(): void {
    if (!this.paused) {
      return;
    }
    this.paused = false;

    while (this.pollLoop());
  }

  public async close(options?: AbortOptions): Promise<void> {
    this.paused = true;
    while (this.queued) {
      await this.poll(options);
    }
  }

  /** Adds a task to this {@link TaskQueue}. */
  public async push<T>(task: (options?: AbortOptions) => MaybePromise<T>, options?: TaskOptions): Promise<T> {
    const abortOptions = { signal: options?.signal };

    let resolve: (value: T) => void;
    let reject: (err: unknown) => void;
    const promise = new Promise<T>((resolveFn, rejectFn) => {
      resolve = resolveFn;
      reject = rejectFn;
    });

    this.queue.push(new RunnableTask(async () => {
      try {
        resolve(await task(abortOptions));
      } catch (e) {
        reject(e);
      }
    }, options?.priority));
    ++this.queued;

    this.pollLoop();

    return promise;
  }

  /** Polls and waits for the top queue task to complete. */
  public async poll(options?: AbortOptions): Promise<void> {
    if (!this.queued) {
      return;
    }

    await this.semaphore.acquire(options);
    await this.runOnceThenRelease();
  }

  /** Tries to poll the top queue task and waits for it to complete if not throttled. */
  public tryPoll(): Promise<void> | undefined {
    if (!this.queued || !this.semaphore.tryAcquire()) {
      return;
    }
    return this.runOnceThenRelease();
  }

  private pollLoop(): boolean {
    if (this.paused || !this.queued || !this.semaphore.tryAcquire()) {
      return false;
    }

    Promise.resolve().then(async () => {
      await this.runOnceThenRelease();
      while (this.queued) {
        await this.poll();
      }
    });

    return true;
  }

  private async runOnceThenRelease(): Promise<void> {
    try {
      await this.runOnce();
    } finally {
      this.semaphore.release();
    }
  }

  private async runOnce(): Promise<void> {
    const task = await this.queue.shift();
    if (!task) {
      return;
    }

    --this.queued;
    ++this._pending;

    try {
      await task.run();
    } finally {
      --this._pending;
    }
  }
}

/** A runnable task with priority in a {@link TaskQueue}. */
export class RunnableTask {
  public constructor(
    /** The task's runnable function. */
    public readonly run: () => Promise<void>,
    /** Priority of this task. Operations with greater priority will be scheduled first. Defaults to 0. */
    public readonly priority = 0,
  ) {
  }

  /** Returns priority of this task. */
  public valueOf(): number {
    return this.priority;
  }
}

/** Options for a task in a {@link TaskQueue}. */
export interface TaskOptions extends AbortOptions {
  /** Priority of operation. Operations with greater priority will be scheduled first. Defaults to 0. */
  priority?: number;
}
