import {
  AbortOptions, CodedError, ContentId, ErrorCode, MaybePromise, mapAsync, operationError
} from '@mithic/commons';
import { ContentAddressedStore } from '../cas.js';

const REASON_DELETE_FAILED = 'Failed to delete';

/**
 * An abstract base class of {@link ContentAddressedStore}.
 */
export abstract class BaseContentAddressedStore<Id = ContentId, T = Uint8Array> implements ContentAddressedStore<Id, T> {
  public abstract delete(id: Id, options?: AbortOptions): MaybePromise<void>;

  public abstract put(block: T, options?: AbortOptions): MaybePromise<Id>;

  public abstract get(cid: Id, options?: AbortOptions): MaybePromise<T | undefined>;

  /** Returns if the store contains data identified by given ID. */
  public has(cid: Id, options?: AbortOptions): MaybePromise<boolean> {
    return mapAsync(this.get(cid, options), isDefined);
  }

  public async * deleteMany(cids: Iterable<Id>, options?: AbortOptions): AsyncIterableIterator<CodedError<Id> | undefined> {
    for (const cid of cids) {
      try {
        this.delete(cid, options);
        yield undefined;
      } catch (e) {
        if (e instanceof CodedError) {
          yield new CodedError(REASON_DELETE_FAILED, { name: e.name, code: e.code, detail: cid, cause: e });
        } else {
          yield operationError(REASON_DELETE_FAILED, ErrorCode.OpFailed, cid, e);
        }
      }
    }
  }

  public async * putMany(values: Iterable<T>, options?: AbortOptions): AsyncIterableIterator<Id> {
    for (const value of values) {
      yield this.put(value, options);
    }
  }

  public async * getMany(cids: Iterable<Id>, options?: AbortOptions): AsyncIterableIterator<T | undefined> {
    for (const cid of cids) {
      yield this.get(cid, options);
    }
  }
}

function isDefined<T>(value: T | undefined): value is T {
  return !!value;
}
