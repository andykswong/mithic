import { EntityAttrSearchKey, ReadonlyTripleStore } from '@mithic/collections';
import { AbortOptions, ContentId, MaybePromise, ToString } from '@mithic/commons';
import { defaultStringify } from '../defaults.ts';
import { ReadonlyEntityStore } from '../store.ts';
import { FractionalIndexGenerator, IndexGenerator } from '../utils/index.ts';
import {
  EntityAttrCommand, EntityCommand, EntityCommandHandler, EntityEvent, EntityEventOp, EntityEventType
} from './interface.ts';

/** Observed-removed entity command handler. */
export class OREntityCommandHandler<Id extends ToString = ContentId, V = unknown>
  implements EntityCommandHandler<Id, V>
{
  public constructor(
    /** Function for converting value to string. */
    protected readonly stringify: (value: V, options?: AbortOptions) => MaybePromise<string> = defaultStringify,
    /** {@link IndexGenerator} instance. */
    protected readonly generator: IndexGenerator<string> = new FractionalIndexGenerator(),
  ) { }

  public async handle(
    state: ReadonlyEntityStore<Id, V>, command: EntityCommand<Id, V>, options?: AbortOptions
  ): Promise<EntityEvent<Id, V> | undefined> {
    const root = command.root;
    const cmds = command.payload.cmd;
    const attrs = Object.keys(cmds);
    const type = root === void 0 ? EntityEventType.New : EntityEventType.Update;
    const link: Id[] = [];
    const linkMap: Record<string, number> = {};
    const ops: [...EntityEventOp<V>][] = [];
    const attrSortOpsMap: Record<string, number> = {};

    if (type === EntityEventType.Update && !attrs.length) { return; }

    const store = state.store(command.payload.type);
    for (const attr of attrs) {
      const cmd = cmds[attr];
      const isDelete =
        cmd.del === true || !!cmd.del?.length ||
        cmd.set !== void 0 ||
        (cmd.splice?.[1] || 0) > 0;

      if (type === EntityEventType.Update && root && isDelete) {
        for (const op of await this.getDeleteOps(store, root, attr, cmd, link, linkMap, options)) {
          ops.push(op);
          attrSortOpsMap[`${op[0]}#${op[1]}`] = ops.length - 1;
        }
      }

      for (const [tag, value] of await this.getNewTagValues(store, root, attr, cmd, options)) {
        const attrTag = `${attr}#${tag}`;
        const index = attrSortOpsMap[attrTag] ?? -1;
        if (index >= 0) {
          ops[index][2] = value;
        } else {
          ops.push([attr, tag, value]);
          attrSortOpsMap[attrTag] = ops.length - 1;
        }
      }
    }

    ops.sort(this.sortOps); // ops must be sorted

    const event = {
      type, link, root,
      payload: { ops, type: command.payload.type },
      nonce: command.nonce,
    };
    if (event.root === void 0) { delete event.root; }
    if (event.nonce === void 0) { delete event.nonce; }
    if (event.payload.type === void 0) { delete event.payload.type; }

    return event;
  }

  protected sortOps = (op1: EntityEventOp<V>, op2: EntityEventOp<V>) =>
    op1[0] < op2[0] ? -1 : op1[0] > op2[0] ? 1 :
      op1[1] < op2[1] ? -1 : op1[1] > op2[1] ? 1 : 0;

  private async getDeleteOps(
    store: ReadonlyTripleStore<Id, V>, root: Id, attr: string, cmd: EntityAttrCommand<V>,
    link: Id[], linkMap: Record<string, number>, options?: AbortOptions
  ): Promise<[...EntityEventOp<V>][]> {
    const ops: [...EntityEventOp<V>][] = [];

    // Finds all existing tags to delete
    const keys: EntityAttrSearchKey<Id>[] = [];
    const isDeleteAll = cmd.del === true || cmd.set !== void 0;
    if (isDeleteAll) { // delete all from attribute
      keys.push([root, attr]);
    } else if (cmd.del?.length) { // delete specific values
      for (const value of cmd.del) {
        keys.push([root, attr, await this.stringify(value, options)]);
      }
    }

    // Finds all existing transaction Ids for tags
    // TODO: call findMany in batch for all attributes
    if (keys.length) {
      const keysToDelete = new Set<number>();
      let lastTag = '';
      for await (const iter of store.findMany(keys, options)) {
        for await (const [[, , tag, parentTxId]] of iter) {
          if (tag !== lastTag) {
            if (keysToDelete.size) {
              ops.push([attr, lastTag, null, ...[...keysToDelete].sort()]);
              keysToDelete.clear();
            }
            lastTag = tag;
          }
          const parentTxIdStr = `${parentTxId}`;
          keysToDelete.add(linkMap[parentTxIdStr] = linkMap[parentTxIdStr] ?? (link.push(parentTxId!) - 1));
        }
      }
      if (keysToDelete.size) {
        ops.push([attr, lastTag, null, ...[...keysToDelete].sort()]);
      }
    }

    // Find entries after given list index to delete
    if (!isDeleteAll && cmd.splice && cmd.splice[1] > 0) {
      const keysToDelete = new Set<number>();
      let lastTag = '';
      for await (const [[_id, _attr, index, parentTxId]] of store.entries({
        ...options,
        lower: [root, attr, cmd.splice[0]],
        upper: [root, attr],
        upperOpen: false,
        limit: cmd.splice[1],
      })) {
        if (index !== lastTag) {
          if (keysToDelete.size) {
            ops.push([attr, lastTag, null, ...[...keysToDelete].sort()]);
            keysToDelete.clear();
          }
          lastTag = index;
        }
        const parentTxIdStr = `${parentTxId}`;
        keysToDelete.add(linkMap[parentTxIdStr] = linkMap[parentTxIdStr] ?? (link.push(parentTxId!) - 1));
      }
      if (keysToDelete.size) {
        ops.push([attr, lastTag, null, ...[...keysToDelete].sort()]);
      }
    }

    return ops;
  }

  private async getNewTagValues(
    store: ReadonlyTripleStore<Id, V>, root: Id | undefined, attr: string, cmd: EntityAttrCommand<V>,
    options?: AbortOptions
  ): Promise<[tag: string, value: V][]> {
    if (cmd.set !== void 0) { // set attribute to single value
      return [[await this.stringify(cmd.set, options), cmd.set]];
    }

    const results: [tag: string, value: V][] = [];

    for (const value of cmd.add || []) { // add unique values
      results.push([await this.stringify(value, options), value]);
    }

    if (cmd.splice && cmd.splice.length > 2) { // add before given list index
      let startIndex: string | undefined;
      const [endIndex, _deleteCount, ...values] = cmd.splice;

      if (root !== void 0) { // try to find an index before given index to insert in between
        for await (const [[_id, _attr, index]] of store.entries({
          ...options,
          lower: [root, attr, ''],
          upper: [root, attr, endIndex],
          limit: 1,
          reverse: true,
        })) {
          startIndex = index;
          break;
        }
      }

      let i = 0;
      for (const index of this.generator.create(startIndex, endIndex, values.length)) {
        results.push([index, values[i++]]);
      }
    }

    return results;
  }
}
