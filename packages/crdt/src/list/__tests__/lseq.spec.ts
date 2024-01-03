import { beforeEach, describe, expect, it } from '@jest/globals';
import { BTreeMap, RangeQueryOptions, rangeQueryable } from '@mithic/collections';
import { ORMapCommandHandler, ORMapProjection } from '../../map/index.js';
import { EntityAttrKey, EntityStore, EntityStoreProvider, MapEntityStore } from '../../store/index.js';
import { FractionalIndexGenerator } from '../../utils/index.js';
import { ListCommand, ListCommandHandler, ListCommandType, ListEvent, ListEventType, ListProjection } from '../list.js';
import { LSeqCommandHandler, LSeqProjection, ReadonlyLSeq } from '../lseq.js';
import { MockId, getMockEventKey } from '../../__tests__/mocks.js';
import { collect } from '../../__tests__/utils.js';

type V = string;

const GENERATOR = new FractionalIndexGenerator(() => 0.5);
const TYPE = 'lseq';
const NS = '$idx';
const ROOT = new MockId(new Uint8Array(1));
const VALUE0 = 'v0';
const VALUE1 = 'v1';
const VALUE2 = '123';
const VALUE3 = 'true';
const [INDEX0, INDEX1] = [...GENERATOR.create(void 0, void 0, 2)];
const ANCHOR = 'A';
const [INDEXA1, INDEXA2] = [...GENERATOR.create(void 0, ANCHOR, 2)];
const [INDEXAD1, INDEXAD2] = [...GENERATOR.create(INDEXA2, INDEX0, 2)];
const [INDEXSD1, INDEXSD2] = [...GENERATOR.create(void 0, INDEX0, 2)];

const CMD_EMPTY = { type: ListCommandType.Update, payload: { type: TYPE }, nonce: '1' } satisfies ListCommand<MockId, V>;
const CMD_ADD = { type: ListCommandType.Update, payload: { add: [VALUE0, VALUE1], type: TYPE }, root: ROOT, nonce: '2' } satisfies ListCommand<MockId, V>;
const CMD_ADD_AT = { type: ListCommandType.Update, payload: { index: ANCHOR, add: [VALUE1, VALUE2], type: TYPE }, root: ROOT, nonce: '3' } satisfies ListCommand<MockId, V>;
const CMD_DEL = { type: ListCommandType.Update, payload: { index: INDEX0, add: [VALUE1, VALUE3], del: 1, type: TYPE }, root: ROOT, nonce: '4' } satisfies ListCommand<MockId, V>;
const CMD_ADD_CONCURRENT = { type: ListCommandType.Update, payload: { add: [VALUE2, VALUE3], type: TYPE }, root: ROOT, nonce: '5' } satisfies ListCommand<MockId, V>;

describe('LSeq', () => {
  let dataMap: BTreeMap<EntityAttrKey<MockId>, V>;
  let store: EntityStore<MockId, V>;
  const storeProvider: EntityStoreProvider<MockId, V> = (type) => {
    expect(type).toBe(TYPE);
    return store;
  };
  let command: ListCommandHandler<MockId, V>;
  let projection: ListProjection<MockId, V>;

  beforeEach(() => {
    const mapStore = store = new MapEntityStore();
    dataMap = mapStore['data'] as BTreeMap<EntityAttrKey<MockId>, V>;
    command = new LSeqCommandHandler(new ORMapCommandHandler(), GENERATOR);
    projection = new LSeqProjection(new ORMapProjection(getMockEventKey));
  });

  describe(LSeqCommandHandler.name, () => {
    it('should return valid event for new empty set command', async () => {
      const event = await command.handle(storeProvider, CMD_EMPTY);
      expect(event).toEqual({
        type: ListEventType.New,
        payload: { set: [], type: TYPE, ns: NS },
        link: [],
        nonce: CMD_EMPTY.nonce
      } satisfies ListEvent<MockId, V>);
    });

    it('should return undefined for empty command', async () => {
      expect(await command.handle(storeProvider, { type: ListCommandType.Update, payload: { type: TYPE }, root: ROOT, nonce: '1' }))
        .toBeUndefined();
    });

    it('should return valid event for new set command', async () => {
      const event = await command.handle(
        storeProvider,
        { type: ListCommandType.Update, payload: { add: [VALUE0, VALUE1], type: TYPE }, nonce: '123' }
      );
      expect(event).toEqual({
        type: ListEventType.New,
        payload: {
          set: [[INDEX0, VALUE0], [INDEX1, VALUE1]],
          type: TYPE,
          ns: NS,
        },
        link: [],
        nonce: '123',
      } satisfies ListEvent<MockId, V>);
    });

    it('should return valid event for set set command', async () => {
      const event = await command.handle(storeProvider, CMD_ADD);
      expect(event).toEqual({
        type: ListEventType.Update,
        payload: {
          set: [[INDEX0, VALUE0], [INDEX1, VALUE1]],
          type: TYPE,
          ns: NS,
        },
        link: [], root: ROOT,
        nonce: CMD_ADD.nonce,
      } satisfies ListEvent<MockId, V>);
    });

    it('should ignore delete operation if nothing can be deleted', async () => {
      const event = await command.handle(storeProvider, CMD_DEL);
      expect(event).toEqual({
        type: ListEventType.Update,
        payload: {
          set: [[INDEXSD1, VALUE1], [INDEXSD2, VALUE3]],
          type: TYPE,
          ns: NS,
        },
        link: [],
        root: ROOT,
        nonce: CMD_DEL.nonce
      } satisfies ListEvent<MockId, V>);
    });

    it('should return valid event for delete/replace command', async () => {
      const concurrentEvent = await command.handle(storeProvider, CMD_ADD_CONCURRENT);
      await applyCommands(CMD_ADD);
      await projection.reduce(storeProvider, concurrentEvent!);

      const event = await command.handle(storeProvider, CMD_DEL);
      expect(event).toEqual({
        type: ListEventType.Update,
        payload: {
          set: [
            [INDEXSD1, VALUE1],
            [INDEXSD2, VALUE3],
            [INDEX0, null, 0, 1],
          ],
          type: TYPE,
          ns: NS,
        },
        link: [getMockEventKey(CMD_ADD), getMockEventKey(CMD_ADD_CONCURRENT)],
        root: ROOT,
        nonce: CMD_DEL.nonce
      } satisfies ListEvent<MockId, V>);
    });
  });

  describe(LSeqProjection.name, () => {
    describe('validate', () => {
      it('should return no error for valid events', async () => {
        expect(await projection.validate(storeProvider, (await command.handle(storeProvider, CMD_EMPTY))!)).toBeUndefined();
        await applyCommands();
        expect(await projection.validate(storeProvider, (await command.handle(storeProvider, CMD_ADD))!)).toBeUndefined();
        expect(await projection.validate(storeProvider, (await command.handle(storeProvider, CMD_DEL))!)).toBeUndefined();
      });

      it('should return error for malformed events', async () => {
        expect(await projection.validate(storeProvider, {
          type: ListEventType.Update, payload: { set: [], type: TYPE },
          link: [], root: ROOT, nonce: '2',
        })).toEqual(new TypeError('empty operation'));
      });

      it('should return error for invalid index', async () => {
        const index = '+-*012';
        expect(await projection.validate(storeProvider, {
          type: ListEventType.Update,
          payload: { set: [[index, 'test']], type: TYPE, ns: NS },
          link: [], root: ROOT, nonce: '2',
        })).toEqual(new TypeError(`Invalid index: ${index}`));
      });
    });

    describe('reduce', () => {
      it('should save new set with fields correctly', async () => {
        const eventKey = getMockEventKey(CMD_ADD);

        await applyCommands(CMD_ADD);

        expect(dataMap.size).toEqual(2);
        expect(dataMap.get([ROOT, `${NS}/${INDEX0}`, eventKey])).toEqual(VALUE0);
        expect(dataMap.get([ROOT, `${NS}/${INDEX1}`, eventKey])).toEqual(VALUE1);
      });

      it('should remove all concurrent values on delete', async () => {
        const event1Key = getMockEventKey(CMD_ADD);
        const event2Key = getMockEventKey(CMD_ADD_CONCURRENT);
        const event3Key = getMockEventKey(CMD_DEL);

        const concurrentEvent = await command.handle(storeProvider, CMD_ADD_CONCURRENT);
        await applyCommands(CMD_ADD);
        await projection.reduce(storeProvider, concurrentEvent!);
        await applyCommands(CMD_DEL);

        expect(dataMap.size).toEqual(4);
        expect(dataMap.get([ROOT, `${NS}/${INDEXSD1}`, event3Key])).toEqual(VALUE1);
        expect(dataMap.get([ROOT, `${NS}/${INDEXSD2}`, event3Key])).toEqual(VALUE3);
        expect(dataMap.get([ROOT, `${NS}/${INDEX1}`, event1Key])).toEqual(VALUE1);
        expect(dataMap.get([ROOT, `${NS}/${INDEX1}`, event2Key])).toEqual(VALUE3);
      });

      it('should throw error for malformed events when validate = true', async () => {
        await expect(projection.reduce(storeProvider, {
          type: ListEventType.Update,
          payload: { set: [], type: TYPE }, link: [], nonce: '1',
        })).rejects.toEqual(new TypeError('missing root'));
      });
    });
  });

  describe(ReadonlyLSeq.name, () => {
    let lseq: ReadonlyLSeq<V, MockId>;

    beforeEach(async () => {
      lseq = new ReadonlyLSeq(store, ROOT);
    })

    it('should have correct string tag', () => {
      expect(lseq.toString()).toBe(`[object ${ReadonlyLSeq.name}]`);
    });

    it('should have rangeQueryable tag', () => {
      expect(lseq[rangeQueryable]).toBe(true);
    });

    describe('asyncIterator', () => {
      it('should async iterate over default collection', async () => {
        await applyCommands(CMD_ADD);
        const results = await collect(lseq);
        expect(results).toEqual([VALUE0, VALUE1]);
      });

      it('should return empty result for empty / undefined maps', async () => {
        await applyCommands(CMD_EMPTY);
        const results = await collect(lseq);
        expect(results).toEqual([]);
      });
    });

    describe('get', () => {
      it('should return matching field value', async () => {
        await applyCommands(CMD_ADD);
        expect(await lseq.get(INDEX0)).toEqual(VALUE0);
      });

      it('should return undefined for non-existent field', async () => {
        await applyCommands(CMD_ADD);
        expect(await lseq.get(INDEXA2)).toBeUndefined();
      });
    });

    describe('has', () => {
      it('should return true for existing field', async () => {
        await applyCommands(CMD_ADD);
        expect(await lseq.has(INDEX0)).toBe(true);
      });

      it('should return false for non-existent field', async () => {
        await applyCommands(CMD_ADD);
        expect(await lseq.has(INDEXA2)).toBe(false);
      });
    });

    describe('getMany', () => {
      it('should return matching field value', async () => {
        await applyCommands(CMD_ADD);
        expect(await collect(lseq.getMany([INDEX0, INDEXA2]))).toEqual([VALUE0, undefined]);
      });
    });

    describe('hasMany', () => {
      it('should return true for existing field and false otherwise', async () => {
        await applyCommands(CMD_ADD);
        expect(await collect(lseq.hasMany([INDEX0, INDEXA2]))).toEqual([true, false]);
      });
    });

    describe('entries', () => {
      it.each(
        [
          [[CMD_ADD], {}, [[INDEX0, VALUE0], [INDEX1, VALUE1]]],
          [[CMD_ADD, CMD_ADD_AT], {}, [[INDEXA1, VALUE1], [INDEXA2, VALUE2], [INDEX0, VALUE0], [INDEX1, VALUE1]]],
          [[CMD_ADD, CMD_ADD_AT], { limit: 2 }, [[INDEXA1, VALUE1], [INDEXA2, VALUE2]]],
          [[CMD_ADD, CMD_ADD_AT], { limit: 2, reverse: true }, [[INDEX1, VALUE1], [INDEX0, VALUE0]]],
          [[CMD_ADD, CMD_ADD_AT, CMD_DEL], {}, [[INDEXA1, VALUE1], [INDEXA2, VALUE2], [INDEXAD1, VALUE1], [INDEXAD2, VALUE3], [INDEX1, VALUE1]]],
          [[CMD_ADD, CMD_ADD_AT, CMD_DEL], { upper: INDEXAD1, upperOpen: false }, [[INDEXA1, VALUE1], [INDEXA2, VALUE2], [INDEXAD1, VALUE1]]],
        ] satisfies [ListCommand<MockId, V>[], RangeQueryOptions<string>, [string, V][]][]
      )('should return correct results for non-empty maps %#', async (cmds, query, expected) => {
        await applyCommands(...cmds);
        const results = await collect(lseq.entries(query));
        expect(results).toEqual(expected);
      });

      it('should return concurrent values', async () => {
        const concurrentEvent = await command.handle(storeProvider, CMD_ADD_CONCURRENT);
        await applyCommands(CMD_ADD);
        await projection.reduce(storeProvider, concurrentEvent!);

        const results = await collect(lseq.entries());
        expect(results).toEqual([[INDEX0, VALUE0], [INDEX0, VALUE2], [INDEX1, VALUE1], [INDEX1, VALUE3]]);
      });
    });

    describe('keys', () => {
      it.each(
        [
          [[CMD_ADD, CMD_ADD_AT], {}, [INDEXA1, INDEXA2, INDEX0, INDEX1]],
          [[CMD_ADD, CMD_ADD_AT], { limit: 2, reverse: true }, [INDEX1, INDEX0]],
          [[CMD_ADD, CMD_ADD_AT, CMD_DEL], {}, [INDEXA1, INDEXA2, INDEXAD1, INDEXAD2, INDEX1]],
        ] satisfies [ListCommand<MockId, V>[], RangeQueryOptions<string>, string[]][]
      )('should return correct results for non-empty maps %#', async (cmds, query, expected) => {
        await applyCommands(...cmds);
        const results = await collect(lseq.keys(query));
        expect(results).toEqual(expected);
      });
    });

    describe('values', () => {
      it.each(
        [
          [[CMD_ADD], {}, [VALUE0, VALUE1]],
          [[CMD_ADD, CMD_ADD_AT], { limit: 2, reverse: true }, [VALUE1, VALUE0]],
          [[CMD_ADD, CMD_ADD_AT, CMD_DEL], {}, [VALUE1, VALUE2, VALUE1, VALUE3, VALUE1]],
        ] satisfies [ListCommand<MockId, V>[], RangeQueryOptions<string>, V[]][]
      )('should return correct results for non-empty maps %#', async (cmds, query, expected) => {
        await applyCommands(...cmds);
        const results = await collect(lseq.values(query));
        expect(results).toEqual(expected);
      });
    });
  });

  async function applyCommands(...cmds: ListCommand<MockId, V>[]) {
    for (const cmd of cmds) {
      await projection.reduce(storeProvider, (await command.handle(storeProvider, cmd))!);
    }
  }
});
