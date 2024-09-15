import { type Startable } from '../lifecycle.ts';
import { type MaybePromise } from './promise.ts';
import { type Queue } from '../queue/index.ts';
import { AtomicSemaphore, type Semaphore } from './semaphore.ts';

/** A queue of async tasks. */
export class TaskQueue implements Startable, AsyncDisposable {
  private readonly semaphore: Semaphore;
  private readonly queue: Queue<RunnableTask>;
  private readonly timeoutMs: number;
  private paused;
  private _pending = 0;
  private queued = 0;

  constructor({
    semaphore = new AtomicSemaphore(),
    queue = [],
    start = true,
    timeoutMs = Infinity,
  }: TaskQueueOptions = {}) {
    this.semaphore = semaphore;
    this.queue = queue;
    this.timeoutMs = timeoutMs;
    this.paused = !start;
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    this.paused = true;
    while (this.queued) {
      await this.poll();
    }
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

  /** Adds a task to this {@link TaskQueue} and returns a promise for completion of the task. */
  public async push<T>(task: Task<T>, options?: TaskOptions): Promise<T> {
    let resolve: (value: T) => void;
    let reject: (err: unknown) => void;
    const promise = new Promise<T>((resolveFn, rejectFn) => {
      resolve = resolveFn;
      reject = rejectFn;
    });

    this.queue.push(new RunnableTask(async () => {
      try {
        resolve(await task(options?.timeoutMs ?? this.timeoutMs));
      } catch (e) {
        reject(e);
      }
    }, options?.priority));
    ++this.queued;

    this.pollLoop();

    return promise;
  }

  /** Polls and waits for the top queue task to complete. */
  public async poll(timeoutMs?: number): Promise<void> {
    if (!this.queued) {
      return;
    }

    await this.semaphore.waitAsync(1, timeoutMs);
    await this.runOnceThenRelease();
  }

  /** Tries to poll the top queue task and returns a task completion promise if not throttled. */
  public pollOnce(): Promise<void> | undefined {
    if (!this.queued || !this.semaphore.wait(1, 0)) {
      return;
    }
    return this.runOnceThenRelease();
  }

  private pollLoop(): boolean {
    if (this.paused || !this.queued || !this.semaphore.wait(1, 0)) {
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
      await this.semaphore.notify(1);
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

/** A maybe async task function. */
export interface Task<T = unknown> {
  (timeoutMs?: number): MaybePromise<T>;
}

/** A runnable task with priority in a {@link TaskQueue}. */
export class RunnableTask {
   /** The task's runnable function. */
   public readonly run: () => Promise<void>;
   /** Priority of this task. Operations with greater priority will be scheduled first. */
   public readonly priority;

  public constructor(
    /** The task's runnable function. */
    run: () => Promise<void>,
    /** Priority of this task. Operations with greater priority will be scheduled first. Defaults to 0. */
    priority = 0,
  ) {
    this.run = run;
    this.priority = priority;
  }

  /** Returns priority of this task. */
  public valueOf(): number {
    return this.priority;
  }
}

/** Options for a task in a {@link TaskQueue}. */
export interface TaskOptions {
  /** Priority of operation. Operations with greater priority may be scheduled first. Defaults to 0. */
  readonly priority?: number;
  /** Timeout for the task in milliseconds. */
  readonly timeoutMs?: number;
}

/** Options for creating a {@link TaskQueue}. */
export interface TaskQueueOptions {
  /** Semaphore to control task execution concurrency. */
  readonly semaphore?: Semaphore;
  /** Underlying task queue. */
  readonly queue?: Queue<RunnableTask>;
  /** Whether to start the task queue immediately. Defaults to `true`. */
  readonly start?: boolean;
  /** Default timeout for tasks in milliseconds. Defaults to Infinity (no timeout). */
  readonly timeoutMs?: number;
}
