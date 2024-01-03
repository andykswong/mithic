import { beforeEach, describe, expect, it } from '@jest/globals';
import { BTreeMap, RangeQueryOptions, rangeQueryable } from '@mithic/collections';
import { ORMapCommandHandler, ORMapProjection } from '../../map/index.js';
import { EntityAttrKey, EntityStore, EntityStoreProvider, MapEntityStore } from '../../store/index.js';
import { ORSetCommandHandler, ORSetProjection, ReadonlyORSet } from '../orset.js';
import { SetCommand, SetCommandHandler, SetCommandType, SetEvent, SetEventType, SetProjection } from '../set.js';
import { MockId, getMockEventKey } from '../../__tests__/mocks.js';
import { collect } from '../../__tests__/utils.js';

type V = string | number | boolean;

const NS = '$val';
const TYPE = 'orset';
const ROOT = new MockId(new Uint8Array(1));
const VALUE0 = 'v0';
const VALUE1 = 'v1';
const VALUE2 = 123;
const VALUE3 = true;
const CMD_EMPTY = { type: SetCommandType.Update, payload: { type: TYPE }, nonce: '1' } satisfies SetCommand<MockId, V>;
const CMD_NEW = { type: SetCommandType.Update, payload: { add: [VALUE0], type: TYPE }, nonce: '1' } satisfies SetCommand<MockId, V>;
const CMD_ADD = { type: SetCommandType.Update, payload: { add: [VALUE1, VALUE2], type: TYPE }, root: ROOT, nonce: '2' } satisfies SetCommand<MockId, V>;
const CMD_ADD_CONCURRENT = { type: SetCommandType.Update, payload: { add: [VALUE2, VALUE3], del: [VALUE2], type: TYPE }, root: ROOT, nonce: '3' } satisfies SetCommand<MockId, V>;
const CMD_DEL = { type: SetCommandType.Update, payload: { add: [VALUE1], del: [VALUE1, VALUE2], type: TYPE }, root: ROOT, nonce: '4' } satisfies SetCommand<MockId, V>;

const hash = (value: V) => `${value}`;

describe('ORSet', () => {
  let dataMap: BTreeMap<EntityAttrKey<MockId>, V>;
  let store: EntityStore<MockId, V>;
  const storeProvider: EntityStoreProvider<MockId, V> = (type) => {
    expect(type).toBe(TYPE);
    return store;
  };
  let command: SetCommandHandler<MockId, V>;
  let projection: SetProjection<MockId, V>;

  beforeEach(() => {
    const mapStore = store = new MapEntityStore();
    dataMap = mapStore['data'] as BTreeMap<EntityAttrKey<MockId>, V>;
    command = new ORSetCommandHandler(new ORMapCommandHandler(), hash);
    projection = new ORSetProjection(new ORMapProjection(getMockEventKey), hash);
  });

  describe(ORSetCommandHandler.name, () => {
    it('should return valid event for new empty set command', async () => {
      const event = await command.handle(storeProvider, CMD_EMPTY);
      expect(event).toEqual({
        type: SetEventType.New,
        payload: { set: [], type: TYPE, ns: NS },
        link: [],
        nonce: CMD_EMPTY.nonce,
      } satisfies SetEvent<MockId, V>);
    });

    it('should return undefined for empty set command', async () => {
      expect(await command.handle(storeProvider, { type: SetCommandType.Update, payload: {}, root: ROOT, nonce: '2' }))
        .toBeUndefined();
    });

    it('should return valid event for new set command', async () => {
      const event = await command.handle(storeProvider, CMD_NEW);
      expect(event).toEqual({
        type: SetEventType.New,
        payload: {
          set: [[VALUE0, true]],
          type: TYPE,
          ns: NS,
        },
        link: [],
        nonce: CMD_NEW.nonce,
      } satisfies SetEvent<MockId, V>);
    });

    it('should return valid event for update set command with add ops', async () => {
      const event = await command.handle(storeProvider, CMD_ADD);
      expect(event).toEqual({
        type: SetEventType.Update,
        payload: {
          set: [[VALUE2, true], [VALUE1, true]],
          type: TYPE,
          ns: NS,
        },
        link: [],
        root: ROOT,
        nonce: CMD_ADD.nonce,
      } satisfies SetEvent<MockId, V>);
    });

    it('should return valid event for update set command with delete ops', async () => {
      const concurrentEvent = await command.handle(storeProvider, CMD_ADD_CONCURRENT);
      await applyCommands(CMD_ADD);
      await projection.reduce(storeProvider, concurrentEvent!);
      const event = await command.handle(storeProvider, CMD_DEL);
      expect(event).toEqual({
        type: SetEventType.Update,
        payload: {
          set: [
            [VALUE2, false, 0, 1],
            [VALUE1, true, 0],
          ],
          type: TYPE,
          ns: NS,
        },
        link: [getMockEventKey(CMD_ADD), getMockEventKey(CMD_ADD_CONCURRENT)],
        root: ROOT,
        nonce: CMD_DEL.nonce
      } satisfies SetEvent<MockId, V>);
    });

    it('should ignore delete operation if field does not already exist', async () => {
      await applyCommands(CMD_NEW);
      const event = await command.handle(storeProvider, CMD_DEL);
      expect(event).toEqual({
        type: SetEventType.Update,
        payload: {
          set: [[VALUE1, true]],
          type: TYPE,
          ns: NS,
        },
        link: [],
        root: ROOT,
        nonce: CMD_DEL.nonce
      } satisfies SetEvent<MockId, V>);
    });
  });

  describe(ORSetProjection.name, () => {
    describe('validate', () => {
      it('should return no error for valid events', async () => {
        expect(await projection.validate(storeProvider, (await command.handle(storeProvider, CMD_NEW))!)).toBeUndefined();
        await applyCommands(CMD_NEW);
        expect(await projection.validate(storeProvider, (await command.handle(storeProvider, CMD_ADD))!)).toBeUndefined();
      });

      it('should return error for malformed events', async () => {
        expect(await projection.validate(storeProvider, {
          type: SetEventType.Update, payload: { set: [], type: TYPE },
          link: [], root: ROOT, nonce: '2',
        })).toEqual(new TypeError('empty operation'));

        expect(await projection.validate(storeProvider, {
          type: SetEventType.Update,
          payload: { set: [['value', true]], type: TYPE },
          link: [], nonce: '2',
        })).toEqual(new TypeError('missing root'));

        expect(await projection.validate(storeProvider, {
          type: SetEventType.Update,
          payload: { set: [['value', false, 0]], type: TYPE, ns: NS },
          link: [], root: ROOT, nonce: '2',
        })).toEqual(new TypeError(`invalid operation: "${NS}/value"`));
      });
    });

    describe('reduce', () => {
      it('should save new set with fields correctly', async () => {
        await applyCommands(CMD_EMPTY);
        expect(dataMap.size).toEqual(0);

        await applyCommands(CMD_ADD);
        const eventKey = getMockEventKey(CMD_ADD);
        expect(dataMap.size).toEqual(2);
        expect(dataMap.get([ROOT, `${NS}/${VALUE1}`, eventKey])).toEqual(VALUE1);
        expect(dataMap.get([ROOT, `${NS}/${VALUE2}`, eventKey])).toEqual(VALUE2);
      });

      it('should keep concurrent updates', async () => {
        await applyCommands(CMD_NEW);
        const cmd1 = await command.handle(storeProvider, CMD_ADD);
        const cmd2 = await command.handle(storeProvider, CMD_ADD_CONCURRENT);
        await projection.reduce(storeProvider, cmd1!);
        await projection.reduce(storeProvider, cmd2!);

        const event0Key = getMockEventKey(CMD_NEW);
        const event1Key = getMockEventKey(CMD_ADD);
        const event2Key = getMockEventKey(CMD_ADD_CONCURRENT);

        expect(dataMap.size).toEqual(5);
        expect(dataMap.get([ROOT, `${NS}/${VALUE0}`, event0Key])).toEqual(VALUE0);
        expect(dataMap.get([ROOT, `${NS}/${VALUE1}`, event1Key])).toEqual(VALUE1);
        expect(dataMap.get([ROOT, `${NS}/${VALUE2}`, event1Key])).toEqual(VALUE2);
        expect(dataMap.get([ROOT, `${NS}/${VALUE2}`, event2Key])).toEqual(VALUE2);
        expect(dataMap.get([ROOT, `${NS}/${VALUE3}`, event2Key])).toEqual(VALUE3);
      });

      it('should remove all concurrent values on delete', async () => {
        const cmd1 = await command.handle(storeProvider, CMD_ADD);
        const cmd2 = await command.handle(storeProvider, CMD_ADD_CONCURRENT);
        await projection.reduce(storeProvider, cmd1!);
        await projection.reduce(storeProvider, cmd2!);
        await applyCommands(CMD_DEL);

        const event2Key = getMockEventKey(CMD_ADD_CONCURRENT);
        const event3Key = getMockEventKey(CMD_DEL);

        expect(dataMap.size).toEqual(2);
        expect(dataMap.get([ROOT, `${NS}/${VALUE1}`, event3Key])).toEqual(VALUE1);
        expect(dataMap.get([ROOT, `${NS}/${VALUE3}`, event2Key])).toEqual(VALUE3);
      });

      it('should throw error for malformed events when validate = true', async () => {
        await expect(projection.reduce(storeProvider, {
          type: SetEventType.Update,
          payload: { set: [], type: TYPE }, link: [], nonce: '1',
        })).rejects.toEqual(new TypeError('missing root'));
      });
    });
  });

  describe(ReadonlyORSet.name, () => {
    let set: ReadonlyORSet<V, MockId>;

    beforeEach(async () => {
      set = new ReadonlyORSet(store, ROOT, hash);
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
        expect(results).toEqual([VALUE2, VALUE1]);
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

    describe('keys', () => {
      it.each(
        [
          [[CMD_ADD], {}, [VALUE2, VALUE1]],
          [[CMD_ADD, CMD_ADD_CONCURRENT], {}, [VALUE2, VALUE3, VALUE1]],
          [[CMD_ADD, CMD_ADD_CONCURRENT], { limit: 2 }, [VALUE2, VALUE3]],
          [[CMD_ADD, CMD_ADD_CONCURRENT], { limit: 2, reverse: true }, [VALUE1, VALUE3]],
          [[CMD_ADD, CMD_ADD_CONCURRENT, CMD_DEL], { lower: VALUE2, upper: VALUE1, upperOpen: false }, [VALUE3, VALUE1]],
        ] satisfies [SetCommand<MockId, V>[], RangeQueryOptions<V>, V[]][]
      )('should return correct results for non-empty maps %#', async (cmds, query, expected) => {
        await applyCommands(...cmds);
        let results = await collect(set.keys(query));
        expect(results).toEqual(expected);
        results = await collect(set.values(query));
        expect(results).toEqual(expected);
      });

      it('should return concurrent values', async () => {
        const concurrentEvent = await command.handle(storeProvider, CMD_ADD_CONCURRENT);
        await applyCommands(CMD_ADD);
        await projection.reduce(storeProvider, concurrentEvent!);
        const results = await collect(set.keys());
        expect(results).toEqual([VALUE2, VALUE2, VALUE3, VALUE1]);
      });
    });

    describe('values', () => {
      it.each(
        [
          [[CMD_ADD], {}, [VALUE2, VALUE1]],
          [[CMD_ADD, CMD_ADD_CONCURRENT], {}, [VALUE2, VALUE3, VALUE1]],
          [[CMD_ADD, CMD_ADD_CONCURRENT], { limit: 2 }, [VALUE2, VALUE3]],
          [[CMD_ADD, CMD_ADD_CONCURRENT], { limit: 2, reverse: true }, [VALUE1, VALUE3]],
          [[CMD_ADD, CMD_ADD_CONCURRENT, CMD_DEL], { lower: VALUE2, upper: VALUE1, upperOpen: false }, [VALUE3, VALUE1]],
        ] satisfies [SetCommand<MockId, V>[], RangeQueryOptions<V>, V[]][]
      )('should return correct results for non-empty maps %#', async (cmds, query, expected) => {
        await applyCommands(...cmds);
        const results = await collect(set.values(query));
        expect(results).toEqual(expected);
      });
    });

    describe('entries', () => {
      it.each(
        [
          [[CMD_ADD], {}, [VALUE2, VALUE1]],
          [[CMD_ADD, CMD_ADD_CONCURRENT], {}, [VALUE2, VALUE3, VALUE1]],
          [[CMD_ADD, CMD_ADD_CONCURRENT], { limit: 2 }, [VALUE2, VALUE3]],
          [[CMD_ADD, CMD_ADD_CONCURRENT], { limit: 2, reverse: true }, [VALUE1, VALUE3]],
          [[CMD_ADD, CMD_ADD_CONCURRENT, CMD_DEL], { lower: VALUE2, upper: VALUE1, upperOpen: false }, [VALUE3, VALUE1]],
        ] satisfies [SetCommand<MockId, V>[], RangeQueryOptions<V>, V[]][]
      )('should return correct results for non-empty maps %#', async (cmds, query, expected) => {
        await applyCommands(...cmds);
        const results = await collect(set.entries(query));
        expect(results).toEqual(expected.map(v => [v, v]));
      });
    });

  });

  async function applyCommands(...cmds: SetCommand<MockId, V>[]) {
    for (const cmd of cmds) {
      await projection.reduce(storeProvider, (await command.handle(storeProvider, cmd))!);
    }
  }
});