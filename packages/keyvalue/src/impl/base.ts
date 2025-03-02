import { MaybePromise } from '@mithic/commons';
import type { KeyResponse, KeySelector } from '../types.ts';
import type { KeyValueStore } from '../service.ts';

/** Abstract base class to simplify {@link KeyValueStore} implementation. */
export abstract class BaseKeyValueStore implements KeyValueStore {
  public abstract listKeys( selector?: KeySelector, cursor?: string): MaybePromise<KeyResponse>;
  public abstract getMany(keys: string[]): MaybePromise<(Uint8Array | null)[]>;
  public abstract updateMany(keyValues: [key: string, value: Uint8Array | null][]): MaybePromise<void>;
  public abstract increment(key: string, delta: bigint): MaybePromise<bigint>;
  public abstract compareAndSwap(key: string, oldValue?: Uint8Array, newValue?: Uint8Array): MaybePromise<boolean>;

  public exists(key: string): MaybePromise<boolean> {
    return MaybePromise.map(this.getMany([key]), exists);
  }

  protected get(key: string): MaybePromise<Uint8Array | null> {
    return MaybePromise.map(this.getMany([key]), getFirst);
  }

  protected keyInRange(key: string, selector?: KeySelector): boolean {
    if (selector?.start !== undefined && key < selector.start) { return false; }
    if (selector?.end !== undefined && key >= selector.end) { return false; }
    return true;
  }
}

function getFirst(results: Iterable<(Uint8Array | null)>): Uint8Array | null {
  for (const result of results) {
    return result;
  }
  return null;
}

function exists(results: Iterable<(Uint8Array | null)>): boolean {
  return !!getFirst(results);
}
