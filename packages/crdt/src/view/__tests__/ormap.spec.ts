import { beforeEach, describe, expect, it } from '@jest/globals';
import { MapTripleStore, RangeQueryOptions, rangeQueryable } from '@mithic/collections';
import { EntityCommand, EntityCommandHandler, EntityCommandType, EntityProjection, OREntityCommandHandler, OREntityProjection } from '../../mutation/index.ts';
import { ReadonlyORMap } from '../ormap.ts';
import { MockId, getMockEventKey } from '../../__tests__/mocks.ts';
import { collect } from '../../__tests__/utils.ts';
import { DefaultEntityStore, EntityStore } from '../../store.ts';

type V = string | number | boolean;

const TYPE = 'ormap';
const ROOT = new MockId(new Uint8Array(1));
const FIELD0 = 'field0';
const FIELD1 = 'field1';
const FIELD2 = 'field2';
const FIELD3 = 'field3';
const VALUE0 = 'v0';
const VALUE1 = 'v1';
const VALUE2 = 123;
const VALUE22 = 456;
const VALUE3 = true;
const VALUE32 = false;

const CMD_EMPTY = {
  type: EntityCommandType.Update, nonce: '1',
  payload: { cmd: {}, type: TYPE }
} satisfies EntityCommand<MockId, V>;
const CMD_NEW = {
  type: EntityCommandType.Update, nonce: '1',
  payload: { cmd: { [FIELD0]: { set: VALUE0 } }, type: TYPE }
} satisfies EntityCommand<MockId, V>;
const CMD_ADD = {
  type: EntityCommandType.Update, nonce: '3', root: ROOT,
  payload: { cmd: { [FIELD1]: { set: VALUE1 }, [FIELD2]: { add: [VALUE2, VALUE3] } }, type: TYPE }
} satisfies EntityCommand<MockId, V>;
const CMD_ADD2 = {
  type: EntityCommandType.Update, nonce: '4', root: ROOT,
  payload: { cmd: { [FIELD3]: { add: [VALUE2, VALUE3] } }, type: TYPE }
} satisfies EntityCommand<MockId, V>;
const CMD_UPDEL = {
  type: EntityCommandType.Update, nonce: '5', root: ROOT,
  payload: { cmd: { [FIELD1]: { del: true }, [FIELD2]: { set: VALUE22 }, [FIELD3]: { add: [VALUE32], del: [VALUE3] } }, type: TYPE }
} satisfies EntityCommand<MockId, V>;

describe(ReadonlyORMap.name, () => {
  let store: MapTripleStore<MockId, V>;
  let state: EntityStore<MockId, V>;
  let command: EntityCommandHandler<MockId, V>;
  let projection: EntityProjection<MockId, V>;
  let map: ReadonlyORMap<V, MockId>;

  beforeEach(() => {
    store = new MapTripleStore();
    state = new DefaultEntityStore<MockId, V>((type) => {
      expect(type).toBe(TYPE);
      return store;
    });
    command = new OREntityCommandHandler<MockId, V>();
    projection = new OREntityProjection(getMockEventKey);
    map = new ReadonlyORMap(store, ROOT);
  });

  it('should have correct string tag', () => {
    expect(map.toString()).toBe(`[object ${ReadonlyORMap.name}]`);
  });

  it('should have rangeQueryable tag', () => {
    expect(map[rangeQueryable]).toBe(true);
  });

  describe('asyncIterator', () => {
    it('should async iterate over all entries', async () => {
      await applyCommands(CMD_ADD);
      const results = await collect(map);
      expect(results).toEqual([[FIELD1, VALUE1], [FIELD2, VALUE2], [FIELD2, VALUE3]]);
    });

    it('should return empty result for empty / undefined maps', async () => {
      await applyCommands(CMD_EMPTY);
      const results = await collect(map);
      expect(results).toEqual([]);
    });
  });

  describe('getList', () => {
    it('should return ReadonlyLSeq of given attribute', () => {
      const lseq = map.getList(FIELD1);
      expect(lseq['store']).toBe(store);
      expect(lseq['entityId']).toBe(ROOT);
      expect(lseq['attr']).toBe(FIELD1);
    });
  });

  describe('getSet', () => {
    it('should return ReadonlyORSet of given attribute', () => {
      const lseq = map.getSet(FIELD1);
      expect(lseq['store']).toBe(store);
      expect(lseq['entityId']).toBe(ROOT);
      expect(lseq['attr']).toBe(FIELD1);
    });
  });

  describe('get', () => {
    it('should return matching field value', async () => {
      await applyCommands(CMD_ADD);
      expect(await map.get(FIELD1)).toEqual(VALUE1);
    });

    it('should return undefined for non-existent field', async () => {
      await applyCommands(CMD_ADD);
      expect(await map.get(FIELD3)).toBeUndefined();
    });
  });

  describe('has', () => {
    it('should return true for existing field', async () => {
      await applyCommands(CMD_ADD);
      expect(await map.has(FIELD1)).toBe(true);
    });

    it('should return false for non-existent field', async () => {
      await applyCommands(CMD_ADD);
      expect(await map.has(FIELD3)).toBe(false);
    });
  });

  describe('getMany', () => {
    it('should return matching field value', async () => {
      await applyCommands(CMD_ADD);
      expect(await collect(map.getMany([FIELD1, FIELD3]))).toEqual([VALUE1, undefined]);
    });
  });

  describe('hasMany', () => {
    it('should return true for existing field and false otherwise', async () => {
      await applyCommands(CMD_ADD);
      expect(await collect(map.hasMany([FIELD1, FIELD3]))).toEqual([true, false]);
    });
  });

  describe('entries', () => {
    it.each(
      [
        [[CMD_ADD], {}, [[FIELD1, VALUE1], [FIELD2, VALUE2], [FIELD2, VALUE3]]],
        [[CMD_ADD, CMD_ADD2], {}, [[FIELD1, VALUE1], [FIELD2, VALUE2], [FIELD2, VALUE3], [FIELD3, VALUE2], [FIELD3, VALUE3]]],
        [[CMD_ADD, CMD_ADD2], { limit: 2 }, [[FIELD1, VALUE1], [FIELD2, VALUE2]]],
        [[CMD_ADD, CMD_ADD2], { limit: 2, reverse: true }, [[FIELD3, VALUE3], [FIELD3, VALUE2]]],
        [[CMD_ADD, CMD_ADD2], { lower: FIELD2, upper: FIELD2, upperOpen: false }, [[FIELD2, VALUE2], [FIELD2, VALUE3]]],
      ] satisfies [EntityCommand<MockId, V>[], RangeQueryOptions<string>, [string, V][]][]
    )('should return correct results for non-empty maps %#', async (cmds, query, expected) => {
      await applyCommands(...cmds);
      const results = await collect(map.entries(query));
      expect(results).toEqual(expected);
    });

    it('should return concurrent values', async () => {
      await applyCommands(CMD_NEW);
      const event1 = await command.handle(state, CMD_ADD);
      const event2 = await command.handle(state, CMD_UPDEL);
      await projection.reduce(state, event1!);
      await projection.reduce(state, event2!);

      const results = await collect(map.entries());
      expect(results).toEqual([
        [FIELD0, VALUE0], [FIELD1, VALUE1], [FIELD2, VALUE2], [FIELD2, VALUE22], [FIELD2, VALUE3], [FIELD3, VALUE32]
      ]);
    });
  });

  describe('keys', () => {
    it.each(
      [
        [[CMD_ADD, CMD_ADD2], {}, [FIELD1, FIELD2, FIELD2, FIELD3, FIELD3]],
        [[CMD_ADD, CMD_ADD2], { limit: 3, reverse: true }, [FIELD3, FIELD3, FIELD2]],
        [[CMD_ADD, CMD_ADD2], { lower: FIELD2, upper: FIELD2, upperOpen: false }, [FIELD2, FIELD2]],
      ] satisfies [EntityCommand<MockId, V>[], RangeQueryOptions<string>, string[]][]
    )('should return correct results for non-empty maps %#', async (cmds, query, expected) => {
      await applyCommands(...cmds);
      const results = await collect(map.keys(query));
      expect(results).toEqual(expected);
    });
  });

  describe('values', () => {
    it.each(
      [
        [[CMD_ADD, CMD_ADD2], {}, [VALUE1, VALUE2, VALUE3, VALUE2, VALUE3]],
        [[CMD_ADD, CMD_ADD2], { limit: 3, reverse: true }, [VALUE3, VALUE2, VALUE3]],
        [[CMD_ADD, CMD_ADD2], { lower: FIELD2, upper: FIELD2, upperOpen: false }, [VALUE2, VALUE3]],
      ] satisfies [EntityCommand<MockId, V>[], RangeQueryOptions<string>, V[]][]
    )('should return correct results for non-empty maps %#', async (cmds, query, expected) => {
      await applyCommands(...cmds);
      const results = await collect(map.values(query));
      expect(results).toEqual(expected);
    });
  });

  async function applyCommands(...cmds: EntityCommand<MockId, V>[]) {
    for (const cmd of cmds) {
      await projection.reduce(state, (await command.handle(state, cmd))!);
    }
  }
});
