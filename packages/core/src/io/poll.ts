import type { Pollables } from '@mithic/commons';
import { Io } from './types.ts';

const DEFAULT_POLL_MS = 200;

/** Represents a single I/O event which may be ready. */
export class Pollable {
  /** Estimated time of completion in milliseconds. */
  public readonly eta: number;

  /** The underlying {@link Pollables} buffer. */
  private readonly pollables: Pollables;
  private readonly pollReady?: (pollables: Pollables, id: number, estTime: number) => boolean;
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
    if (this.pollables.ready(this._id)) {
      return true;
    }
    if (this.pollReady?.(this.pollables, this._id, this.estTime)) {
      this.pollables.notify(this._id);
      return true;
    }
    return false;
  }

  /** Returns immediately if the pollable is ready, and otherwise blocks until ready. */
  public block(): void {
    while (!this.wait());
  }

  /** Synchronously waits for the readiness of this pollable until ETA. */
  public wait(): boolean {
    return this.ready() || this.pollables.wait(this._id, this.estTime);
  }

  /** Asynchronously waits for the readiness of this pollable until ETA. */
  public async waitAsync(): Promise<boolean> {
    return this.ready() || await this.pollables.waitAsync(this._id, this.estTime);
  }
}

/** Options for creating a {@link Pollable}. */
export interface PollableOptions {
  pollables?: Pollables;
  id?: number;
  pollReady?: (pollables: Pollables, id: number, estTime: number) => boolean;
  eta?: number;
  deleteOnDispose?: boolean;
}

/** Polls for completion on a set of pollables. */
export function poll(pollables: Pollable[]): number[] {
  const ready = [];
  while (pollables.length && !ready.length) {
    let fastestPollable = 0, eta = pollables[0].eta;
    for (let i = 0; i < pollables.length; ++i) {
      if (pollables[i].ready()) {
        ready.push(i);
      } else if (pollables[i].eta < eta) {
        fastestPollable = i;
        eta = pollables[i].eta;
      }
    }
    if (!ready.length) {
      pollables[fastestPollable].wait();
    }
  }
  return ready;
}
