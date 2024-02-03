import { beforeEach, describe, expect, it } from '@jest/globals';
import { MapTripleStore, RangeQueryOptions, rangeQueryable } from '@mithic/collections';
import { ReadonlyORSet } from '../orset.ts';
import { EntityCommand, EntityCommandHandler, EntityCommandType, EntityProjection, OREntityCommandHandler, OREntityProjection } from '../../mutation/index.ts';
import { MockId, getMockEventKey } from '../../__tests__/mocks.ts';
import { collect } from '../../__tests__/utils.ts';
import { DefaultEntityStore, EntityStore } from '../../store.ts';

type V = string | number | boolean;

const ATTR = '$val';
const TYPE = 'orset';
const ROOT = new MockId(new Uint8Array(1));
const VALUE1 = 'v1';
const VALUE2 = 123;
const VALUE3 = true;

const CMD_EMPTY = {
  type: EntityCommandType.Update, nonce: '1',
  payload: { cmd: {}, type: TYPE }
} satisfies EntityCommand<MockId, V>;
const CMD_ADD = {
  type: EntityCommandType.Update, nonce: '3', root: ROOT,
  payload: { cmd: { [ATTR]: { add: [VALUE1, VALUE2] } }, type: TYPE }
} satisfies EntityCommand<MockId, V>;
const CMD_ADD3_DEL2 = {
  type: EntityCommandType.Update, nonce: '4', root: ROOT,
  payload: { cmd: { [ATTR]: { add: [VALUE2, VALUE3], del: [VALUE2] } }, type: TYPE }
} satisfies EntityCommand<MockId, V>;
const CMD_REPLACE1 = {
  type: EntityCommandType.Update, nonce: '5', root: ROOT,
  payload: { cmd: { [ATTR]: { add: [VALUE1], del: [VALUE1, VALUE2] } }, type: TYPE }
} satisfies EntityCommand<MockId, V>;

describe(ReadonlyORSet.name, () => {
  let store: MapTripleStore<MockId, V>;
  let state: EntityStore<MockId, V>;
  let command: EntityCommandHandler<MockId, V>;
  let projection: EntityProjection<MockId, V>;
  let set: ReadonlyORSet<V, MockId>;

  beforeEach(() => {
    store = new MapTripleStore();
    state = new DefaultEntityStore<MockId, V>((type) => {
      expect(type).toBe(TYPE);
      return store;
    });
    command = new OREntityCommandHandler();
    projection = new OREntityProjection(getMockEventKey);
    set = new ReadonlyORSet(store, ROOT, ATTR);
  })

  it('should have correct string tag', () => {
    expect(set.toString()).toBe(`[object ${ReadonlyORSet.name}]`);
  });

  it('should have rangeQueryable tag', () => {
    expect(set[rangeQueryable]).toBe(true);
  });

  describe('asyncIterator', () => {
    it('should async iterate over default collection', async () => {
      await applyCommands(CMD_ADD);
      const results = await collect(set);
      expect(results).toEqual([VALUE1, VALUE2]);
    });

    it('should return empty result for empty / undefined sets', async () => {
      await applyCommands(CMD_EMPTY);
      const results = await collect(set);
      expect(results).toEqual([]);
    });
  });

  describe('has', () => {
    it('should return true for existing field', async () => {
      await applyCommands(CMD_ADD);
      expect(await set.has(VALUE1)).toBe(true);
    });

    it('should return false for non-existent field', async () => {
      await applyCommands(CMD_ADD);
      expect(await set.has(VALUE3)).toBe(false);
    });
  });

  describe('hasMany', () => {
    it('should return true for existing field and false otherwise', async () => {
      await applyCommands(CMD_ADD);
      expect(await collect(set.hasMany([VALUE1, VALUE3]))).toEqual([true, false]);
    });
  });

  const ITER_TEST_CASE = [
    [[CMD_ADD], {}, [VALUE1, VALUE2]],
    [[CMD_ADD, CMD_ADD3_DEL2], {}, [VALUE1, VALUE2, VALUE3]],
    [[CMD_ADD, CMD_ADD3_DEL2], { limit: 2 }, [VALUE1, VALUE2]],
    [[CMD_ADD, CMD_ADD3_DEL2], { limit: 2, reverse: true }, [VALUE3, VALUE2]],
    [[CMD_ADD, CMD_ADD3_DEL2, CMD_REPLACE1], { lower: VALUE1, upper: VALUE2, upperOpen: false }, [VALUE1]],
  ] satisfies [EntityCommand<MockId, V>[], RangeQueryOptions<V>, V[]][];

  describe('keys', () => {
    it.each(ITER_TEST_CASE)('should return correct results for non-empty maps %#', async (cmds, query, expected) => {
      await applyCommands(...cmds);
      let results = await collect(set.keys(query));
      expect(results).toEqual(expected);
      results = await collect(set.values(query));
      expect(results).toEqual(expected);
    });

    it('should return concurrent values', async () => {
      const concurrentEvent = await command.handle(state, CMD_ADD3_DEL2);
      await applyCommands(CMD_ADD);
      await projection.reduce(state, concurrentEvent!);
      const results = await collect(set.keys());
      expect(results).toEqual([VALUE1, VALUE2, VALUE2, VALUE3]);
    });
  });

  describe('values', () => {
    it.each(ITER_TEST_CASE)('should return correct results for non-empty maps %#', async (cmds, query, expected) => {
      await applyCommands(...cmds);
      const results = await collect(set.values(query));
      expect(results).toEqual(expected);
    });
  });

  describe('entries', () => {
    it.each(ITER_TEST_CASE)('should return correct results for non-empty maps %#', async (cmds, query, expected) => {
      await applyCommands(...cmds);
      const results = await collect(set.entries(query));
      expect(results).toEqual(expected.map(v => [v, v]));
    });
  });

  async function applyCommands(...cmds: EntityCommand<MockId, V>[]) {
    for (const cmd of cmds) {
      await projection.reduce(state, (await command.handle(state, cmd))!);
    }
  }
});
