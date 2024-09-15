import { MaybePromise } from './index.ts';

/** Represents a pool of pollables, where each holds a readiness state. */
export interface Pollables {
  /** Creates a new, pending pollable and returns its ID. */
  create(): number;

  /** Deletes a pollable. */
  delete(id: number): boolean;

  /**
   * Returns the current state of a pollable. This function never blocks.
   * state == 0: pending
   * state > 0: ready
   * state < 0: invalid pollable
   */
  state(id: number): number;

  /** Returns the readiness of a pollable (state > 0). This function never blocks. */
  ready(id: number): boolean;

  /** Returns immediately if the pollable is ready, and otherwise blocks until ready or timeout. */
  wait(id: number, timeoutMs?: number): boolean;

  /**
   * Returns immediately if the pollable is ready, and otherwise a promise that resolves
   * when the pollable is ready or timed out.
   */
  waitAsync(id: number, timeoutMs?: number): MaybePromise<boolean>;

  /**
   * Set new state, notifies any waiting agent, and returns the number of agents being notified.
   * Defaults new state to 1.
   */
  notify(id: number, state?: number): number;
}

const PAGE_SIZE = 1024;
const SIZE_IDX = 0;
const FREE_HEAD_IDX = 1;
const FREE_SIZE_IDX = 2;
const IDX_OFFSET = 3;

/** Pollable states backed by SharedArrayBuffer and Atomics. */
export class AtomicPollables implements Pollables {
  /** The backing data buffer. */
  public readonly buffer: SharedArrayBuffer;
  private readonly _state: Int32Array;

  public constructor(
    /** The backing data buffer. byteLength must be in multiples of 4 and > 12. */
    buffer: SharedArrayBuffer = new SharedArrayBuffer(1024, { maxByteLength: 1048576 }),
  ) {
    this.buffer = buffer;
    this._state = new Int32Array(buffer);
  }

  /** Maximum number of pollables . */
  public get capacity(): number {
    return this.buffer.maxByteLength - IDX_OFFSET;
  }

  /** Number of active pollables. */
  public get size(): number {
    return Atomics.load(this._state, SIZE_IDX) - Atomics.load(this._state, FREE_SIZE_IDX);
  }

  public create(): number {
    // try to use free list first
    for (
      let id = Atomics.load(this._state, FREE_HEAD_IDX);
      Atomics.load(this._state, FREE_SIZE_IDX) > 0 && this.inRange(id);
      id = Atomics.load(this._state, FREE_HEAD_IDX)
    ) {
      const newFreeHead = -Atomics.load(this._state, id);
      if (Atomics.compareExchange(this._state, FREE_HEAD_IDX, id, newFreeHead) === id) {
        Atomics.sub(this._state, FREE_SIZE_IDX, 1);
        Atomics.store(this._state, id, 0);
        return id;
      }
    }

    // else allocate new index
    const id = Atomics.add(this._state, SIZE_IDX, 1) + IDX_OFFSET;
    if (id >= this._state.length) {
      const maxLength = Math.floor(this.buffer.maxByteLength / Int32Array.BYTES_PER_ELEMENT);
      if (id >= maxLength) {
        Atomics.sub(this._state, SIZE_IDX, 1);
        return 0;
      }
      this.buffer.grow(Math.min(this.buffer.byteLength + PAGE_SIZE, maxLength * Int32Array.BYTES_PER_ELEMENT));
    }
    Atomics.store(this._state, id, 0);

    return id;
  }

  public delete(id: number): boolean {
    if (!this.inRange(id)) { return false; }
    let oldValue;
    do {
      if ((oldValue = Atomics.load(this._state, id)) < 0) {
        return false; // already deleted
      }
    } while (Atomics.compareExchange(this._state, id, oldValue, -FREE_HEAD_IDX) !== oldValue);
    const freeHead = Atomics.exchange(this._state, FREE_HEAD_IDX, id) || FREE_HEAD_IDX;
    Atomics.store(this._state, id, -freeHead);
    Atomics.add(this._state, FREE_SIZE_IDX, 1);
    return true;
  }

  public state(id: number): number {
    if (!this.inRange(id)) { return -1; }
    return Atomics.load(this._state, id);
  }

  public ready(id: number): boolean {
    return this.state(id) > 0;
  }

  public wait(id: number, timeoutMs?: number): boolean {
    if (!this.inRange(id)) { return false; }
    return Atomics.wait(this._state, id, 0, timeoutMs) !== 'timed-out';
  }

  public waitAsync(id: number, timeoutMs?: number): MaybePromise<boolean> {
    if (!this.inRange(id)) { return false; }
    const result = Atomics.waitAsync(this._state, id, 0, timeoutMs);
    return MaybePromise.map(result.value, isReady);
  }

  public notify(id: number, state = 1): number {
    if (!this.inRange(id)) { return 0; }
    let origState;
    do {
      origState = Atomics.load(this._state, id);
      if (origState < 0) { return 0; }
    } while (Atomics.compareExchange(this._state, id, origState, state) !== origState);
    return Atomics.notify(this._state, id);
  }

  public get [Symbol.toStringTag](): string {
    return 'Pollables';
  }

  protected inRange(id: number): boolean {
    return id >= IDX_OFFSET && id < Atomics.load(this._state, SIZE_IDX) + IDX_OFFSET;
  }
}

function isReady(state: 'ok' | 'not-equal' | 'timed-out'): boolean {
  return state === 'ok' || state === 'not-equal';
}
