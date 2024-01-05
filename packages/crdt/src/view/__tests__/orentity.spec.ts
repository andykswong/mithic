import { beforeEach, describe, expect, it } from '@jest/globals';
import { MapTripleStore } from '@mithic/triplestore';
import { EntityCommand, EntityCommandHandler, EntityCommandType, EntityProjection, OREntityCommandHandler, OREntityProjection } from '../../mutation/index.js';
import { MockId, getMockEventKey } from '../../__tests__/mocks.js';
import { collect } from '../../__tests__/utils.js';
import { DefaultEntityStore, EntityStore } from '../../store.js';
import { EntityAttrRangeQueryOptions, EntityRangeQueryOptions } from '../entity.js';
import { ReadonlyOREntityCollection } from '../orentity.js';
import { rangeQueryable } from '@mithic/collections';
import { EntityAttrReducers } from '../../index.js';

type V = string | number | boolean | MockId;

const TYPE = 'entity1';
const ROOT = new MockId(new Uint8Array(1));
const ROOT2 = new MockId(new Uint8Array(2));
const ROOT3 = new MockId(new Uint8Array(1999));
const FIELD0 = 'field0';
const FIELD1 = 'field1';
const FIELD2 = 'field2';
const FIELD3 = 'field3';
const VALUE0 = 'v0';
const VALUE1 = 'v1';
const VALUE2 = 123;
const VALUE3 = true;

const CMD_NEW = {
  type: EntityCommandType.Update, nonce: '1',
  payload: { cmd: { [FIELD0]: { set: VALUE0 }, [FIELD1]: { set: VALUE1 } }, type: TYPE }
} satisfies EntityCommand<MockId, V>;
const CMD_NEW2 = {
  type: EntityCommandType.Update, nonce: '2',
  payload: { cmd: { [FIELD1]: { set: VALUE2 }, [FIELD2]: { add: [VALUE2, VALUE3] } }, type: TYPE }
} satisfies EntityCommand<MockId, V>;

describe(ReadonlyOREntityCollection.name, () => {
  let store: MapTripleStore<MockId, V>;
  let state: EntityStore<MockId, V>;
  let command: EntityCommandHandler<MockId, V>;
  let projection: EntityProjection<MockId, V>;
  let view: ReadonlyOREntityCollection<MockId, V>;
  let expectedType: string;

  beforeEach(async () => {
    expectedType = TYPE;
    store = new MapTripleStore();
    state = new DefaultEntityStore<MockId, V>((type) => {
      expect(type).toBe(expectedType);
      return store;
    });
    command = new OREntityCommandHandler<MockId, V>();
    projection = new OREntityProjection(getMockEventKey);
    view = new ReadonlyOREntityCollection(state);

    await applyCommands(CMD_NEW, CMD_NEW2);
  });

  it('should have correct rangeQueryable tag', () => {
    expect(view[rangeQueryable]).toBe(true);
  });

  it('should have correct string tag', () => {
    expect(view.toString()).toBe(`[object ${ReadonlyOREntityCollection.name}]`);
  });

  describe('asyncIterator', () => {
    it('should return correct results %#', async () => {
      expectedType = '';
      expect(await collect(view))
        .toEqual([[ROOT, { [FIELD0]: VALUE0, [FIELD1]: VALUE1 }], [ROOT2, { [FIELD1]: VALUE2, [FIELD2]: VALUE2 }]]);
    });
  });

  describe('has', () => {
    it('should return true for existing entity', async () => {
      expect(await view.has(ROOT, { type: TYPE })).toBe(true);
      expect(await view.has(ROOT2, { type: TYPE })).toBe(true);
    });

    it('should return false for non-existent entity', async () => {
      expect(await view.has(ROOT3, { type: TYPE })).toBe(false);
    });
  });

  describe('hasMany', () => {
    it('should return true for existing field and false otherwise', async () => {
      expect(await collect(view.hasMany([ROOT, ROOT2, ROOT3], { type: TYPE }))).toEqual([true, true, false]);
    });
  });

  describe('get', () => {
    it('should return matching entity', async () => {
      expect(await view.get(ROOT, { type: TYPE })).toEqual({ [FIELD0]: VALUE0, [FIELD1]: VALUE1 });
    });

    it('should resolve multi-entry fields', async () => {
      expect(await view.get(ROOT2, { type: TYPE })).toEqual({ [FIELD1]: VALUE2, [FIELD2]: VALUE2 });
    });

    it('should return only specified attributes', async () => {
      expect(await view.get(ROOT2, {
        type: TYPE, attr: { [FIELD1]: true }
      })).toEqual({ [FIELD1]: VALUE2 });
    });

    it('should use attribute resolver', async () => {
      expect(await view.get(ROOT2, {
        type: TYPE, attr: { [FIELD2]: EntityAttrReducers.asArray }
      })).toEqual({ [FIELD2]: [VALUE2, VALUE3] });
    });

    it('should return undefined for non-existent entity', async () => {
      expect(await view.get(ROOT3, { type: TYPE })).toBeUndefined();
    });

    it('should return undefined for entity without matching attribute', async () => {
      expect(await view.get(ROOT2, { type: TYPE, attr: { [FIELD3]: true } })).toBeUndefined();
    });
  });

  describe('getMany', () => {
    it('should return matching entities', async () => {
      expect(await collect(view.getMany([ROOT, ROOT3], { type: TYPE })))
        .toEqual([{ [FIELD0]: VALUE0, [FIELD1]: VALUE1 }, undefined]);
    });

    it('should return only specified attributes', async () => {
      expect(await collect(view.getMany([ROOT, ROOT2], { type: TYPE, attr: { [FIELD1]: true } })))
        .toEqual([{ [FIELD1]: VALUE1 }, { [FIELD1]: VALUE2 }]);
    });

    it('should return undefined for entity without matching attribute', async () => {
      expect(await collect(view.getMany([ROOT, ROOT2], { type: TYPE, attr: { [FIELD2]: true } })))
        .toEqual([undefined, { [FIELD2]: VALUE2 }]);
    });
  });

  const EXPECTED_ENTRIES = [
    [{ type: TYPE }, [[ROOT, { [FIELD0]: VALUE0, [FIELD1]: VALUE1 }], [ROOT2, { [FIELD1]: VALUE2, [FIELD2]: VALUE2 }]]],
    [{ attr: { [FIELD1]: true }, type: TYPE }, [[ROOT, { [FIELD1]: VALUE1 }], [ROOT2, { [FIELD1]: VALUE2 }]]],
    [{ limit: 1, type: TYPE }, [[ROOT, { [FIELD0]: VALUE0, [FIELD1]: VALUE1 }]]],
    [{ limit: 1, reverse: true, type: TYPE }, [[ROOT2, { [FIELD1]: VALUE2, [FIELD2]: VALUE3 }]]],
    [{ lower: ROOT, upper: ROOT2, lowerOpen: true, upperOpen: false, type: TYPE }, [[ROOT2, { [FIELD1]: VALUE2, [FIELD2]: VALUE2 }]]],
    [{ lower: ROOT, upper: ROOT2, upperOpen: true, type: TYPE }, [[ROOT, { [FIELD0]: VALUE0, [FIELD1]: VALUE1 }]]],
  ] satisfies [EntityRangeQueryOptions<MockId, V>, [MockId, Record<string, unknown>][]][];

  describe('entries', () => {
    it.each(EXPECTED_ENTRIES)('should return correct results %#', async (query, expected) => {
      const results = await collect(view.entries(query));
      expect(results).toEqual(expected);
    });
  });

  describe('keys', () => {
    it.each(EXPECTED_ENTRIES)('should return correct results %#', async (query, expected) => {
      const results = await collect(view.keys(query));
      expect(results).toEqual(expected.map(([id]) => id));
    });
  });

  describe('values', () => {
    it.each(EXPECTED_ENTRIES)('should return correct results %#', async (query, expected) => {
      const results = await collect(view.values(query));
      expect(results).toEqual(expected.map(([, value]) => value));
    });
  });

  const EXPECTED_ENTRIES_FOR_ATTR = [
    [{ by: FIELD1, type: TYPE }, [[ROOT, { [FIELD0]: VALUE0, [FIELD1]: VALUE1 }], [ROOT2, { [FIELD1]: VALUE2, [FIELD2]: VALUE2 }]]],
    [{ by: FIELD1, type: TYPE, limit: 1 }, [[ROOT, { [FIELD0]: VALUE0, [FIELD1]: VALUE1 }]]],
    [{ by: FIELD1, attr: { [FIELD1]: true, [FIELD2]: true }, reverse: true, type: TYPE }, [[ROOT2, { [FIELD1]: VALUE2, [FIELD2]: VALUE2 }], [ROOT, { [FIELD1]: VALUE1 }]]],
    [{ by: FIELD1, lower: VALUE1, upper: VALUE2, lowerOpen: false, upperOpen: false, type: TYPE }, [[ROOT, { [FIELD0]: VALUE0, [FIELD1]: VALUE1 }], [ROOT2, { [FIELD1]: VALUE2, [FIELD2]: VALUE2 }]]],
    [{ by: FIELD1, lower: VALUE1, upper: VALUE2, type: TYPE }, [[ROOT, { [FIELD0]: VALUE0, [FIELD1]: VALUE1 }]]],
  ] satisfies [EntityAttrRangeQueryOptions<V>, [MockId, Record<string, unknown>][]][];

  describe('entriesByAttr', () => {
    it.each(EXPECTED_ENTRIES)('should return correct results for id queries %#', async (query, expected) => {
      const results = await collect(view.entriesByAttr(query));
      expect(results).toEqual(expected);
    });

    it.each(EXPECTED_ENTRIES_FOR_ATTR)('should return correct results for attr queries %#', async (query, expected) => {
      const results = await collect(view.entriesByAttr(query));
      expect(results).toEqual(expected);
    });
  });

  describe('keysByAttr', () => {
    it.each(EXPECTED_ENTRIES)('should return correct results for id queries %#', async (query, expected) => {
      const results = await collect(view.keysByAttr(query));
      expect(results).toEqual(expected.map(([id]) => id));
    });

    it.each(EXPECTED_ENTRIES_FOR_ATTR)('should return correct results for attr queries %#', async (query, expected) => {
      const results = await collect(view.keysByAttr(query));
      expect(results).toEqual(expected.map(([id]) => id));
    });
  });

  describe('valuesByAttr', () => {
    it.each(EXPECTED_ENTRIES)('should return correct results for id queries %#', async (query, expected) => {
      const results = await collect(view.valuesByAttr(query));
      expect(results).toEqual(expected.map(([, value]) => value));
    });

    it.each(EXPECTED_ENTRIES_FOR_ATTR)('should return correct results for attr queries %#', async (query, expected) => {
      const results = await collect(view.valuesByAttr(query));
      expect(results).toEqual(expected.map(([, value]) => value));
    });
  });

  async function applyCommands(...cmds: EntityCommand<MockId, V>[]) {
    for (const cmd of cmds) {
      await projection.reduce(state, (await command.handle(state, cmd))!);
    }
  }
});
