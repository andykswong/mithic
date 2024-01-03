import {
  MaybeAsyncReadonlyMap, MaybeAsyncReadonlyMapBatch, RangeQueryOptions, RangeQueryable, rangeQueryable
} from '@mithic/collections';
import {
  AbortOptions, ContentId, ERR_DEPENDENCY_MISSING, LockGuard, MaybePromise, NoOpLock, OperationError, ToString
} from '@mithic/commons';
import { getCID } from '../defaults.js';
import {
  EntityAttrKey, EntityStoreProvider, ReadonlyEntityStore, ReadonlyEntityStoreProvider
} from '../store/index.js';
import { MapCommand, MapCommandHandler, MapEvent, MapEventOp, MapEventType, MapProjection } from './map.js';

/** Observed-removed map command handler. */
export class ORMapCommandHandler<Id extends ToString = ContentId, V = unknown> implements MapCommandHandler<Id, V> {
  public async handle(
    storeProvider: ReadonlyEntityStoreProvider<Id, V>, command: MapCommand<Id, V>, options?: AbortOptions
  ): Promise<MapEvent<Id, V> | undefined> {
    const root = command.root;
    const type = root === void 0 ? MapEventType.New : MapEventType.Update;
    const link: Id[] = [];
    const ops: [...MapEventOp<V>][] = [];

    const values = command.payload.put || {};
    const linkMap: Record<string, number> = {};
    const fieldOpsMap: Record<string, number> = {};

    let i = 0;
    const fields = [...(command.payload.del || []), ...Object.keys(values)];

    if (type === MapEventType.Update && !fields.length) {
      return;
    }

    const store = await storeProvider(command.payload.type);
    for (const field of fields) {
      const value = values[field] ?? null;
      const isDelete = i++ < (command.payload.del?.length || 0);

      if (fieldOpsMap[field] !== void 0) { // use existing op on same field
        ops[fieldOpsMap[field]][1] = isDelete ? null : value;
        continue;
      }

      const keysToDelete: number[] = [];
      if (type === MapEventType.Update && root && isDelete) { // for update event, find existing keys to delete
        // TODO: call findMany in batch
        for await (const iter of store.findMany([[root, field]], options)) {
          for await (const [[, , parentTxId]] of iter) {
            const parentTxIdStr = `${parentTxId}`;
            keysToDelete.push(linkMap[parentTxIdStr] ?? (link.push(parentTxId!) - 1));
            linkMap[parentTxIdStr] = keysToDelete[keysToDelete.length - 1];
          }
        }
        keysToDelete.sort();
      }

      if (isDelete && !keysToDelete.length) {
        continue; // nothing to delete
      }

      ops.push([field, isDelete ? null : value, ...keysToDelete]);
      fieldOpsMap[field] = ops.length - 1;
    }

    // Sort the ops by field name
    ops.sort(this.sortOps);

    return {
      type, link, root,
      payload: { set: ops, type: command.payload.type },
      nonce: command.nonce,
    };
  }

  protected sortOps = (op1: MapEventOp<V>, op2: MapEventOp<V>) => op1[0] < op2[0] ? -1 : op1[0] > op2[0] ? 1 : 0;
}

/** Observed-removed map event projection. */
export class ORMapProjection<Id = ContentId, V = unknown> implements MapProjection<Id, V> {
  public constructor(
    /** Function to get key of event. */
    protected readonly getEventKey: (event: MapEvent<Id, V>, options?: AbortOptions) => MaybePromise<Id> = getCID,
    /** Function to acquire a lock on an event key. */
    protected readonly acquireLock: (key: Id, options?: AbortOptions) => MaybePromise<LockGuard> =
      () => LockGuard.acquire(new NoOpLock()),
  ) {
  }

  public async reduce(
    storeProvider: EntityStoreProvider<Id, V>, event: MapEvent<Id, V>, options?: AbortOptions
  ): Promise<EntityStoreProvider<Id, V>> {
    const eventKey = await this.getEventKey(event, options);
    const root = event.type === MapEventType.Update ? event.root as Id : eventKey;
    const parentKeys = event.link || [];

    // build the entries to update to the store
    const entries: [key: EntityAttrKey<Id>, value?: V][] = [];
    const newKeys: EntityAttrKey<Id>[] = [];
    const deletedParents = new Set<number>();
    for (const [field, value, ...parents] of event.payload.set) {
      for (const parent of parents) {
        const parentKey = parentKeys[parent];
        if (parentKey !== void 0) {
          entries.push([[root, field, parentKey]]);
          deletedParents.add(parent);
        }
      }
      if (value !== null) {
        // TODO: if current event is the root, we can skip the event key suffix
        const key = [root, field, eventKey] as const;
        entries.push([key, value]);
        newKeys.push(key);
      }
    }

    // update store if event is valid and not exist. lock is required to avoid race conditions (ABA)
    const store = await storeProvider(event.payload.type);
    const lock = await this.acquireLock(eventKey, options);
    try {
      const error = await this.validate(storeProvider, event, options);
      if (error) { throw error; }

      // do not reprocess if event key already exist in store (event already processed)
      for await (const value of store.getMany(newKeys, options)) {
        if (value !== void 0) { return storeProvider; }
      }

      for await (const error of store.updateMany(entries, options)) {
        if (error) { throw new OperationError('failed to save event', { cause: error }); }
      }
    } finally {
      await lock.close();
    }

    return storeProvider;
  }

  public async validate(
    storeProvider: ReadonlyEntityStoreProvider<Id, V>, event: MapEvent<Id, V>, options?: AbortOptions
  ): Promise<Error | undefined> {
    const eventKey = await this.getEventKey(event, options);
    const root = event.type === MapEventType.Update ? event.root as Id : eventKey;

    if (root === void 0) {
      return new TypeError('missing root');
    }
    if (event.type === MapEventType.Update && !event.payload.set.length) {
      return new TypeError('empty operation');
    }

    // verify that set operations are well formed; fields and parent indices must be in asc order
    let lastField = '';
    const dependencyIndices = new Set<number>();
    for (const [field, value, ...parents] of event.payload.set) {
      let isValid = !!field && (!!parents.length || value !== null) && lastField < field;
      lastField = field;

      let lastParent = -1;
      for (const parent of parents) {
        if (event.link?.[parent] === void 0 || lastParent >= parent) {
          isValid = false;
          break;
        }
        dependencyIndices.add(parent);
        lastParent = parent;
      }
      if (!isValid) {
        return new TypeError(`invalid operation: "${field}"`);
      }
    }

    // check for missing dependencies
    const store = await storeProvider(event.payload.type);
    const missingKeys: Id[] = [];
    {
      const keys = [...dependencyIndices].map((index) => event.link?.[index] as Id);
      let i = 0;
      for await (const exist of store.hasTx(keys, options)) {
        if (!exist) { missingKeys.push(keys[i]); }
        ++i;
      }
    }

    if (missingKeys.length) {
      return new OperationError('missing dependencies', { code: ERR_DEPENDENCY_MISSING, detail: missingKeys });
    }
  }
}

/** Readonly observed-removed map. */
export class ReadonlyORMap<V = unknown, Id = ContentId>
  implements MaybeAsyncReadonlyMap<string, V>, MaybeAsyncReadonlyMapBatch<string, V>,
  RangeQueryable<string, V>, AsyncIterable<[string, V]>
{
  public constructor(
    /** The underlying store. */
    protected readonly store: ReadonlyEntityStore<Id, V>,
    /** The map entity ID. */
    public readonly entityId: Id,
  ) { }

  public async get(key: string, options?: AbortOptions): Promise<V | undefined> {
    for await (const [, value] of this.store.entries({
      ...options,
      lower: [this.entityId, key],
      upper: [this.entityId, key],
      upperOpen: false,
      limit: 1,
    })) {
      return value;
    }
  }

  public async has(key: string, options?: AbortOptions): Promise<boolean> {
    return (await this.get(key, options)) !== void 0;
  }

  public async * getMany(keys: Iterable<string>, options?: AbortOptions): AsyncIterableIterator<V | undefined> {
    for await (const iter of this.store.findMany([...keys].map((key) => [this.entityId, key]), options)) {
      const result = await iter.next();
      yield result.done ? void 0 : result.value[1];
    }
  }

  public async * hasMany(keys: Iterable<string>, options?: AbortOptions): AsyncIterableIterator<boolean> {
    for await (const value of this.getMany(keys, options)) { yield value !== void 0; }
  }

  public async * entries(options?: RangeQueryOptions<string>): AsyncIterableIterator<[string, V]> {
    for await (const [[, field], value] of this.store.entries({
      ...options,
      lower: [this.entityId, options?.lower ?? ''],
      upper: [this.entityId, options?.upper],
    })) {
      yield [field, value];
    }
  }

  public async * keys(options?: RangeQueryOptions<string>): AsyncIterableIterator<string> {
    for await (const [key] of this.entries(options)) { yield key; }
  }

  public async * values(options?: RangeQueryOptions<string>): AsyncIterableIterator<V> {
    for await (const [, value] of this.entries(options)) { yield value; }
  }

  public [Symbol.asyncIterator](): AsyncIterator<[string, V]> {
    return this.entries();
  }

  public get [rangeQueryable](): true {
    return true;
  }

  public get [Symbol.toStringTag](): string {
    return ReadonlyORMap.name;
  }
}
