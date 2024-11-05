import type { MaybePromise, Pollables } from '@mithic/commons';
import { Io } from './types.ts';

const DEFAULT_POLL_MS = 200;

/** Represents a single I/O event which may be ready. */
export class Pollable implements PromiseLike<void> {
  /** Estimated time of completion in milliseconds. */
  public readonly eta: number;

  /** The underlying {@link Pollables} buffer. */
  private readonly pollables: Pollables;
  private readonly pollReady?: (pollables: Pollables, id: number) => boolean;
  private readonly deleteOnDispose: boolean;
  private _id: number;

  public constructor({
    pollables = Io.pollables,
    id = pollables.create(),
    eta = performance.now() + DEFAULT_POLL_MS,
    pollReady,
    deleteOnDispose = true,
  }: PollableOptions = {}) {
    this.pollables = pollables;
    this._id = id;
    this.eta = eta;
    this.pollReady = pollReady;
    this.deleteOnDispose = deleteOnDispose;
  }

  public [Symbol.dispose](): void {
    if (this.deleteOnDispose) {
      this.pollables.delete(this._id);
    }
    this._id = 0;
  }

  /** Returns the ID of this pollable. */
  public get id(): number {
    return this._id;
  }

  /** Estimated time to completion in milliseconds. */
  private get estTime(): number {
    return Math.max(0, this.eta - performance.now());
  }

  /** Returns the readiness of this pollable. This function never blocks. */
  public ready(): boolean {
    const readyState = this.pollables.ready(this._id);
    if (this.pollReady) {
      const isReady = this.pollReady(this.pollables, this._id);
      if (readyState !== isReady) {
        this.pollables.notify(this._id, isReady ? 1 : 0);
        return isReady;
      }
    }
    return readyState;
  }

  /** Returns immediately if the pollable is ready, and otherwise blocks until ready. */
  public block(): void {
    while (!this.wait());
  }

  public then<Result>(onfulfilled?: ((value: void) => MaybePromise<Result>) | null): PromiseLike<Result> {
    return (async () => { while (!(await this.waitAsync())); })().then(onfulfilled);
  }

  /** Synchronously waits for the readiness of this pollable or until timeout. */
  public wait(timeoutMs = Math.max(this.estTime, DEFAULT_POLL_MS)): boolean {
    return this.ready() || this.pollables.wait(this._id, timeoutMs);
  }

  /** Asynchronously waits for the readiness of this pollable or until timeout. */
  public async waitAsync(timeoutMs = Math.max(this.estTime, DEFAULT_POLL_MS)): Promise<boolean> {
    return this.ready() || await this.pollables.waitAsync(this._id, timeoutMs);
  }
}

/** Options for creating a {@link Pollable}. */
export interface PollableOptions {
  pollables?: Pollables;
  id?: number;
  pollReady?: (pollables: Pollables, id: number) => boolean;
  eta?: number;
  deleteOnDispose?: boolean;
}

/** Polls for completion on a set of pollables. */
export function poll(pollables: Pollable[]): number[] {
  const ready = [];
  while (pollables.length && !ready.length) {
    const now = performance.now();
    let fastestI = 0, estTime = Math.max(pollables[0].eta - now, DEFAULT_POLL_MS);
    for (let i = 0; i < pollables.length; ++i) {
      if (pollables[i].ready()) {
        ready.push(i);
        continue;
      }
      const estTimeI = Math.max(pollables[i].eta - now, DEFAULT_POLL_MS);
      if (estTimeI < estTime) {
        fastestI = i;
        estTime = estTimeI;
      }
    }
    if (!ready.length) {
      pollables[fastestI].wait();
    }
  }
  return ready;
}
