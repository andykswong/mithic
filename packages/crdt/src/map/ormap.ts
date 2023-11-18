import { AbortOptions, ContentId, ERR_DEPENDENCY_MISSING, LockGuard, MaybePromise, NoOpLock, OperationError, ToString } from '@mithic/commons';
import { getCID } from '../defaults.js';
import {
  MapCommand, MapCommandHandler, MapEvent, MapEventOp, MapEventType, MapProjection, MapRangeQuery,
  MapRangeQueryResolver,
} from './map.js';
import { MapStore, MultimapKey, ReadonlyMapStore } from './store.js';

/** Observed-removed multimap command handler. */
export class ORMapCommandHandler<K extends ToString = ContentId, V = unknown> implements MapCommandHandler<K, V> {
  public async handle(
    store: ReadonlyMapStore<K, V>, command: MapCommand<K, V>, options?: AbortOptions
  ): Promise<MapEvent<K, V> | undefined> {
    const root = command.root;
    const type = root === void 0 ? MapEventType.New : MapEventType.Update;
    const link: K[] = [];
    const ops: [...MapEventOp<V>][] = [];

    const values = command.payload.put || {};
    const linkMap: Record<string, number> = {};
    const fieldOpsMap: Record<string, number> = {};

    let i = 0;
    const fields = [...(command.payload.del || []), ...Object.keys(values)];

    if (type === MapEventType.Update && !fields.length) {
      return;
    }

    for (const field of fields) {
      const value = values[field] ?? null;
      const isDelete = i++ < (command.payload.del?.length || 0);

      if (fieldOpsMap[field] !== void 0) { // use existing op on same field
        ops[fieldOpsMap[field]][1] = isDelete ? null : value;
        continue;
      }

      const keysToDelete: number[] = [];
      if (type === MapEventType.Update && root && isDelete) { // for update event, find existing keys to delete
        for await (const [, , parentKey] of store.data.keys({
          gte: [root, field],
          lte: [root, field],
          signal: options?.signal,
        })) {
          const parentKeyStr = `${parentKey}`;
          keysToDelete.push(linkMap[parentKeyStr] ?? (link.push(parentKey!) - 1));
          linkMap[parentKeyStr] = keysToDelete[keysToDelete.length - 1];
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
      type,
      payload: { set: ops },
      root,
      link,
      nonce: command.nonce,
    };
  }

  protected sortOps = (op1: MapEventOp<V>, op2: MapEventOp<V>) => op1[0] < op2[0] ? -1 : op1[0] > op2[0] ? 1 : 0;
}

/** Observed-removed multimap projection. */
export class ORMapProjection<K = ContentId, V = unknown> implements MapProjection<K, V> {
  public constructor(
    /** Function to get key of event. */
    protected readonly getEventKey: (event: MapEvent<K, V>, options?: AbortOptions) => MaybePromise<K> = getCID,
    /** Function to acquire a lock on an event key. */
    protected readonly acquireLock: (key: K, options?: AbortOptions) => MaybePromise<LockGuard> =
      () => LockGuard.acquire(new NoOpLock()),
  ) {
  }

  public async reduce(store: MapStore<K, V>, event: MapEvent<K, V>, options?: AbortOptions): Promise<MapStore<K, V>> {
    const error = await this.validate(store, event, options);
    if (error) {
      throw error;
    }

    const eventKey = await this.getEventKey(event, options);
    const root = event.type === MapEventType.Update ? event.root as K : eventKey;
    const parentKeys = event.link || [];

    // build the entries to update to the store
    const entries: [key: MultimapKey<K>, value?: V][] = [];
    const newKeys: MultimapKey<K>[] = [];
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

    // update store if event not exist. lock is required to avoid race conditions (ABA)
    const lock = await this.acquireLock(eventKey, options);
    try {
      // do not reprocess if event key already exist in store (event already processed)
      for await (const exist of store.data.hasMany(newKeys, options)) {
        if (exist) {
          return store;
        }
      }
      if (store.tombstone) {
        for await (const exist of store.tombstone.hasMany([eventKey], options)) {
          if (exist) {
            return store;
          }
        }
      }

      for await (const error of store.data.updateMany(entries, options)) {
        if (error) {
          throw new OperationError('failed to save event', { cause: error });
        }
      }

      if (store.tombstone && deletedParents.size) {
        const tombstones: K[] = [root]; // add root to tombstone as well in case the whole map at root is deleted
        for (const index of deletedParents) {
          tombstones.push(parentKeys[index]);
        }

        for await (const error of store.tombstone.addMany(tombstones, options)) {
          if (error) {
            throw new OperationError('failed to save event key', { cause: error });
          }
        }
      }
    } finally {
      await lock.close();
    }

    return store;
  }

  public async validate(
    store: ReadonlyMapStore<K, V>, event: MapEvent<K, V>, options?: AbortOptions
  ): Promise<Error | undefined> {
    const eventKey = await this.getEventKey(event, options);
    const root = event.type === MapEventType.Update ? event.root as K : eventKey;

    if (root === void 0) {
      return new TypeError('missing root');
    }
    if (event.type === MapEventType.Update && !event.payload.set.length) {
      return new TypeError('empty operation');
    }

    // verify that set operations are well formed; fields and parent indices must be in asc order
    let lastField = '';
    const dependentKeys: [root: K, field: string, itemKey: K][] = [];
    const dependentKeyEventIndices: number[] = [];
    for (const [field, value, ...parents] of event.payload.set) {
      let isValid = !!field && (!!parents.length || value !== null) && lastField < field;
      lastField = field;

      let lastParent = -1;
      for (const parent of parents) {
        if (event.link?.[parent] === void 0 || lastParent >= parent) {
          isValid = false;
          break;
        }
        dependentKeys.push([root, field, event.link[parent]]);
        dependentKeyEventIndices.push(parent);
        lastParent = parent;
      }
      if (!isValid) {
        return new TypeError(`invalid operation: "${field}"`);
      }
    }

    // check for missing dependencies
    let missingKeys: K[] = [];
    {
      const seenIndices = new Set<number>();
      let i = 0;
      for await (const exist of store.data.hasMany(dependentKeys, options)) {
        const index = dependentKeyEventIndices[i];
        const missingKey = event.link?.[index];
        if (!exist && !seenIndices.has(index) && missingKey !== void 0) {
          missingKeys.push(missingKey);
          seenIndices.add(index);
        }
        ++i;
      }
    }

    if (missingKeys.length && store.tombstone) { // check tombstones as well if exist
      const stillMissingKeys: K[] = [];
      let i = 0;
      for await (const exist of store.tombstone.hasMany(missingKeys, options)) {
        if (!exist) {
          stillMissingKeys.push(missingKeys[i]);
        }
        ++i;
      }
      missingKeys = stillMissingKeys;
    }

    if (missingKeys.length) {
      return new OperationError('missing dependencies', { code: ERR_DEPENDENCY_MISSING, detail: missingKeys });
    }
  }
}

/** Observed-removed multimap range query resolver. */
export class ORMapRangeQueryResolver<K extends ToString = ContentId, V = unknown>
  implements MapRangeQueryResolver<K, V>
{
  public async * resolve(
    store: ReadonlyMapStore<K, V>, query: MapRangeQuery<K, V>, options?: AbortOptions
  ): AsyncIterable<[field: string, value: V]> {
    for await (const [[, field], value] of store.data.entries({
      gte: [query.root, query.gte ?? ''],
      lte: [query.root, query.lte ?? '\udbff\udfff'],
      reverse: query.reverse,
      limit: query.limit,
      signal: options?.signal,
    })) {
      if (field !== void 0 && value !== void 0) {
        yield [field, value];
      }
    }
  }
}
