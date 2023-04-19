import {
  AbortOptions, CodedError, ContentId, ErrorCode, MaybePromise, maybeAsync, operationError
} from '@mithic/commons';
import { resolve } from '@mithic/commons/maybeAsync';
import { ContentAddressedStore, ContentAddressedStoreBatch } from '../map.js';

const REASON_DELETE_FAILED = 'Failed to delete';

/** An abstract base class of {@link ContentAddressedStore}. */
export abstract class BaseContentAddressedStore<Id = ContentId, T = Uint8Array>
  implements ContentAddressedStore<Id, T>, ContentAddressedStoreBatch<Id, T>
{
  public abstract delete(id: Id, options?: AbortOptions): MaybePromise<void>;

  public abstract put(block: T, options?: AbortOptions): MaybePromise<Id>;

  public abstract get(cid: Id, options?: AbortOptions): MaybePromise<T | undefined>;

  public has = maybeAsync(function* (this: ContentAddressedStore<Id, T>, cid: Id, options?: AbortOptions) {
    const value = yield* resolve(this.get(cid, options));
    return !!value;
  }, this);

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
