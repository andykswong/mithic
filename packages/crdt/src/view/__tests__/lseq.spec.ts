import { beforeEach, describe, expect, it } from '@jest/globals';
import { MapTripleStore, RangeQueryOptions, rangeQueryable } from '@mithic/collections';
import { FractionalIndexGenerator } from '../../utils/index.ts';
import { MockId, getMockEventKey } from '../../__tests__/mocks.ts';
import { collect } from '../../__tests__/utils.ts';
import { ReadonlyLSeq } from '../lseq.ts';
import { EntityCommand, EntityCommandHandler, EntityCommandType, EntityProjection, OREntityCommandHandler, OREntityProjection } from '../../mutation/index.ts';
import { DefaultEntityStore, EntityStore } from '../../store.ts';

type V = string;

const GENERATOR = new FractionalIndexGenerator(() => 0.5);
const TYPE = 'lseq';
const ATTR = '$idx';
const ROOT = new MockId(new Uint8Array(1));
const VALUE0 = 'v0';
const VALUE1 = 'v1';
const VALUE2 = '123';
const VALUE3 = 'true';
const [INDEX0, INDEX1] = [...GENERATOR.create(void 0, void 0, 2)];
const ANCHOR = 'A';
const [INDEXA1, INDEXA2] = [...GENERATOR.create(void 0, ANCHOR, 2)];
const [INDEXAD1, INDEXAD2] = [...GENERATOR.create(INDEXA2, INDEX0, 2)];

const CMD_EMPTY = {
  type: EntityCommandType.Update, nonce: '1',
  payload: { cmd: {}, type: TYPE }
} satisfies EntityCommand<MockId, V>;
const CMD_SPLICE = {
  type: EntityCommandType.Update, nonce: '7', root: ROOT,
  payload: { cmd: { [ATTR]: { splice: ['', 0, VALUE0, VALUE1] } }, type: TYPE }
} satisfies EntityCommand<MockId, V>;
const CMD_SPLICE2 = {
  type: EntityCommandType.Update, nonce: '11', root: ROOT,
  payload: { cmd: { [ATTR]: { splice: ['', 0, VALUE2, VALUE3] } }, type: TYPE }
} satisfies EntityCommand<MockId, V>;
const CMD_SPLICE_AT = {
  type: EntityCommandType.Update, nonce: '3', root: ROOT,
  payload: { cmd: { [ATTR]: { splice: [ANCHOR, 0, VALUE1, VALUE2] } }, type: TYPE }
} satisfies EntityCommand<MockId, V>;
const CMD_SPLICE_DEL = {
  type: EntityCommandType.Update, nonce: '13', root: ROOT,
  payload: { cmd: { [ATTR]: { splice: [INDEX0, 2, VALUE1, VALUE3] } }, type: TYPE }
} satisfies EntityCommand<MockId, V>;

describe(ReadonlyLSeq.name, () => {
  let store: MapTripleStore<MockId, V>;
  let state: EntityStore<MockId, V>;
  let command: EntityCommandHandler<MockId, V>;
  let projection: EntityProjection<MockId, V>;
  let lseq: ReadonlyLSeq<V, MockId>;

  beforeEach(() => {
    store = new MapTripleStore();
    state = new DefaultEntityStore<MockId, V>((type) => {
      expect(type).toBe(TYPE);
      return store;
    });
    command = new OREntityCommandHandler<MockId, V>(undefined, GENERATOR);
    projection = new OREntityProjection(getMockEventKey);
    lseq = new ReadonlyLSeq(store, ROOT, ATTR);
  });

  it('should have correct string tag', () => {
    expect(lseq.toString()).toBe(`[object ${ReadonlyLSeq.name}]`);
  });

  it('should have rangeQueryable tag', () => {
    expect(lseq[rangeQueryable]).toBe(true);
  });

  describe('asyncIterator', () => {
    it('should async iterate over default collection', async () => {
      await applyCommands(CMD_SPLICE);
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
      await applyCommands(CMD_SPLICE);
      expect(await lseq.get(INDEX0)).toEqual(VALUE0);
    });

    it('should return undefined for non-existent field', async () => {
      await applyCommands(CMD_SPLICE);
      expect(await lseq.get(INDEXA2)).toBeUndefined();
    });
  });

  describe('has', () => {
    it('should return true for existing field', async () => {
      await applyCommands(CMD_SPLICE);
      expect(await lseq.has(INDEX0)).toBe(true);
    });

    it('should return false for non-existent field', async () => {
      await applyCommands(CMD_SPLICE);
      expect(await lseq.has(INDEXA2)).toBe(false);
    });
  });

  describe('getMany', () => {
    it('should return matching field value', async () => {
      await applyCommands(CMD_SPLICE);
      expect(await collect(lseq.getMany([INDEX0, INDEXA2]))).toEqual([VALUE0, undefined]);
    });
  });

  describe('hasMany', () => {
    it('should return true for existing field and false otherwise', async () => {
      await applyCommands(CMD_SPLICE);
      expect(await collect(lseq.hasMany([INDEX0, INDEXA2]))).toEqual([true, false]);
    });
  });

  describe('entries', () => {
    it.each(
      [
        [[CMD_SPLICE], {}, [[INDEX0, VALUE0], [INDEX1, VALUE1]]],
        [[CMD_SPLICE, CMD_SPLICE_AT], {}, [[INDEXA1, VALUE1], [INDEXA2, VALUE2], [INDEX0, VALUE0], [INDEX1, VALUE1]]],
        [[CMD_SPLICE, CMD_SPLICE_AT], { limit: 2 }, [[INDEXA1, VALUE1], [INDEXA2, VALUE2]]],
        [[CMD_SPLICE, CMD_SPLICE_AT], { limit: 2, reverse: true }, [[INDEX1, VALUE1], [INDEX0, VALUE0]]],
        [[CMD_SPLICE, CMD_SPLICE_AT, CMD_SPLICE_DEL], {}, [[INDEXA1, VALUE1], [INDEXA2, VALUE2], [INDEXAD1, VALUE1], [INDEXAD2, VALUE3]]],
        [[CMD_SPLICE, CMD_SPLICE_AT, CMD_SPLICE_DEL], { upper: INDEXAD1, upperOpen: false }, [[INDEXA1, VALUE1], [INDEXA2, VALUE2], [INDEXAD1, VALUE1]]],
      ] satisfies [EntityCommand<MockId, V>[], RangeQueryOptions<string>, [string, V][]][]
    )('should return correct results for non-empty maps %#', async (cmds, query, expected) => {
      await applyCommands(...cmds);
      const results = await collect(lseq.entries(query));
      expect(results).toEqual(expected);
    });

    it('should return concurrent values', async () => {
      const concurrentEvent = await command.handle(state, CMD_SPLICE2);
      await applyCommands(CMD_SPLICE);
      await projection.reduce(state, concurrentEvent!);

      const results = await collect(lseq.entries());
      expect(results).toEqual([[INDEX0, VALUE0], [INDEX0, VALUE2], [INDEX1, VALUE1], [INDEX1, VALUE3]]);
    });
  });

  describe('keys', () => {
    it.each(
      [
        [[CMD_SPLICE, CMD_SPLICE_AT], {}, [INDEXA1, INDEXA2, INDEX0, INDEX1]],
        [[CMD_SPLICE, CMD_SPLICE_AT], { limit: 2, reverse: true }, [INDEX1, INDEX0]],
        [[CMD_SPLICE, CMD_SPLICE_AT, CMD_SPLICE_DEL], {}, [INDEXA1, INDEXA2, INDEXAD1, INDEXAD2]],
      ] satisfies [EntityCommand<MockId, V>[], RangeQueryOptions<string>, string[]][]
    )('should return correct results for non-empty maps %#', async (cmds, query, expected) => {
      await applyCommands(...cmds);
      const results = await collect(lseq.keys(query));
      expect(results).toEqual(expected);
    });
  });

  describe('values', () => {
    it.each(
      [
        [[CMD_SPLICE], {}, [VALUE0, VALUE1]],
        [[CMD_SPLICE, CMD_SPLICE_AT], { limit: 2, reverse: true }, [VALUE1, VALUE0]],
        [[CMD_SPLICE, CMD_SPLICE_AT, CMD_SPLICE_DEL], {}, [VALUE1, VALUE2, VALUE1, VALUE3]],
      ] satisfies [EntityCommand<MockId, V>[], RangeQueryOptions<string>, V[]][]
    )('should return correct results for non-empty maps %#', async (cmds, query, expected) => {
      await applyCommands(...cmds);
      const results = await collect(lseq.values(query));
      expect(results).toEqual(expected);
    });
  });

  async function applyCommands(...cmds: EntityCommand<MockId, V>[]) {
    for (const cmd of cmds) {
      await projection.reduce(state, (await command.handle(state, cmd))!);
    }
  }
});
