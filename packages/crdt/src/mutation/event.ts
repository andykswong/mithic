import {
  AbortOptions, ContentId, ERR_DEPENDENCY_MISSING, LockGuard, MaybePromise, NoOpLock, OperationError, ToString
} from '@mithic/commons';
import { EntityAttrKey } from '@mithic/triplestore';
import { getCID } from '../defaults.js';
import { EntityStore, ReadonlyEntityStore } from '../store.js';
import { EntityEvent, EntityEventType, EntityProjection } from './interface.js';

/** Observed-removed entity event projection. */
export class OREntityProjection<Id extends ToString = ContentId, V = unknown> implements EntityProjection<Id, V> {
  public constructor(
    /** Function to get key of event. */
    protected readonly getEventKey: (event: EntityEvent<Id, V>, options?: AbortOptions) => MaybePromise<Id> = getCID,
    /** Function to acquire a lock on an event key. */
    protected readonly acquireLock: (key: Id, options?: AbortOptions) => MaybePromise<LockGuard> =
      () => LockGuard.acquire(new NoOpLock()),
  ) {
  }

  public async reduce(
    state: EntityStore<Id, V>, event: EntityEvent<Id, V>, options?: AbortOptions
  ): Promise<EntityStore<Id, V>> {
    const eventKey = await this.getEventKey(event, options);
    const root = event.type === EntityEventType.Update ? event.root as Id : eventKey;
    const parentKeys = event.link || [];

    // build the entries to update to the store
    const entries: [key: EntityAttrKey<Id>, value?: V][] = [];
    const newKeys: EntityAttrKey<Id>[] = [];
    for (const [attr, tag, value, ...parents] of event.payload.ops) {
      for (const parent of parents) {
        const parentKey = parentKeys[parent];
        if (parentKey !== void 0) {
          entries.push([[root, attr, tag, parentKey]]);
        }
      }
      if (value !== null) {
        const key = [root, attr, tag, eventKey] as const;
        entries.push([key, value]);
        newKeys.push(key);
      }
    }

    // update store if event is valid and not exist. lock is required to avoid race conditions (ABA)
    const store = state.store(event.payload.type);
    const lock = await this.acquireLock(eventKey, options);
    try {
      const error = await this.validate(state, event, options);
      if (error) { throw error; }

      // do not reprocess if event key already exist in store (event already processed)
      if (newKeys.length) {
        for await (const value of store.getMany(newKeys, options)) {
          if (value !== void 0) { return state; }
        }
      }

      if (entries.length) {
        for await (const error of store.updateMany(entries, options)) {
          if (error) { throw new OperationError('failed to save event', { cause: error }); }
        }
      }

      for await (const error of state.tx.addMany([eventKey], options)) {
        if (error) { throw new OperationError('failed to save event', { cause: error }); }
      }
    } finally {
      await lock.close();
    }

    return state;
  }

  public async validate(
    state: ReadonlyEntityStore<Id, V>, event: EntityEvent<Id, V>, options?: AbortOptions
  ): Promise<Error | undefined> {
    const eventKey = await this.getEventKey(event, options);
    const root = event.type === EntityEventType.Update ? event.root as Id : eventKey;

    if (root === void 0) {
      return new TypeError('missing root');
    }
    if (event.type === EntityEventType.Update && !event.payload.ops.length) {
      return new TypeError('empty operation');
    }

    // verify that set operations are well formed; attribute-tags and parent indices must be in asc order
    let lastAttr = '', lastSortKey = '';
    const dependencyIndices = new Set<number>();
    for (const [attr, tag, value, ...parents] of event.payload.ops) {
      let isValid = !!attr && (!!parents.length || value !== null) &&
        (lastAttr < attr || (lastAttr === attr && lastSortKey < tag));
      lastAttr = attr;
      lastSortKey = tag;

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
        return new TypeError(`invalid operation: "${attr}"`);
      }
    }

    // check for missing dependencies
    const missingKeys: Id[] = [];
    {
      const keys = [...dependencyIndices].map((index) => event.link?.[index] as Id);
      let i = 0;
      for await (const exist of state.tx.hasMany(keys, options)) {
        if (!exist) { missingKeys.push(keys[i]); }
        ++i;
      }
    }

    if (missingKeys.length) {
      return new OperationError('missing dependencies', { code: ERR_DEPENDENCY_MISSING, detail: missingKeys });
    }
  }
}
