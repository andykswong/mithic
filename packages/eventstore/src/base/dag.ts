import { AppendOnlyAutoKeyMap, AutoKeyMapBatch } from '@mithic/collections';
import {
  AbortOptions, ContentId, ERR_DEPENDENCY_MISSING, OperationError, StringEquatable, equalsOrSameString
} from '@mithic/commons';
import { StandardEvent } from '@mithic/cqrs/event';
import { EventStore, EventStorePutOptions } from '../store.js';
import { DEFAULT_BATCH_SIZE } from '../defaults.js';
import { BaseMapEventStore } from './base.js';

/**
 * An abstract {@link EventStore} storing events that form a DAG.
 * One of `entries` or `keys` query functions must be overridden in subclass, as by default they refer to each other.
 */
export abstract class BaseDagEventStore<
  K extends StringEquatable<K> = ContentId,
  V = unknown,
  QueryExt extends object = NonNullable<unknown>
> extends BaseMapEventStore<K, V, QueryExt> implements EventStore<K, V, QueryExt> {
  /** Cache of event parents during a put/validate operation. */
  protected readonly currentEventDeps: [K, V][] = [];
  /** Set to true to use cache. */
  protected useCache = false;

  public constructor(
    data: AppendOnlyAutoKeyMap<K, V> & Partial<AutoKeyMapBatch<K, V>>,
    /** Returns given event as {@link StandardEvent} format. */
    protected readonly toStandardEvent: (event: V) => StandardEvent<string, unknown, K> | undefined
      = (event) => event as unknown as StandardEvent<string, unknown, K>,
    queryPageSize = DEFAULT_BATCH_SIZE,
  ) {
    super(data, queryPageSize);
  }

  public override async validate(value: V, options?: AbortOptions): Promise<Error | undefined> {
    const error = await super.validate(value, options);
    if (error) {
      return error;
    }

    const event = this.toStandardEvent(value);
    if (!event) {
      return new TypeError('invalid event value');
    }

    const parents = this.useCache ? this.currentEventDeps : [];
    parents.length = 0;

    const deps = [...event.meta?.prev || [], ...event.meta?.refs || []];
    const rootId = event.meta?.root;
    if (!deps.length) {
      if (rootId !== void 0) { // if specified, root Id must be a dependency
        return new TypeError('missing dependency to root Id');
      }
      return;
    }
    if (rootId === void 0) { // root Id must be specified if there are dependencies
      return new TypeError('missing root Id');
    }

    const missing: K[] = [];
    let hasSameRoot = false;
    let i = 0;
    for await (const parent of this.getMany(deps, options)) {
      const key = deps[i++];
      if (!parent) {
        missing.push(key);
        continue;
      }
      parents.push([key, parent]);
      const parentRootId = this.toStandardEvent(parent)?.meta?.root || key;
      hasSameRoot = hasSameRoot || (parentRootId !== void 0 && equalsOrSameString(rootId, parentRootId));
    }

    if (missing.length) {
      return new OperationError('missing dependencies', { code: ERR_DEPENDENCY_MISSING, detail: missing });
    }

    if (!hasSameRoot) { // root Id must match one of parents' root
      return new OperationError('missing dependency to root Id', { code: ERR_DEPENDENCY_MISSING, detail: [rootId] });
    }
  }

  public override async put(value: V, options?: EventStorePutOptions): Promise<K> {
    try {
      this.useCache = true;
      this.currentEventDeps.length = 0;
      return await super.put(value, options);
    } finally {
      this.useCache = false;
      this.currentEventDeps.length = 0;
    }
  }
}
