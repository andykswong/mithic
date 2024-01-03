import { beforeEach, describe, expect, it } from '@jest/globals';
import { MapEntityStore } from '../mapstore.js';
import { MockId } from '../../__tests__/mocks.js';
import { EntityAttrKey } from '../store.js';
import { collect } from '../../__tests__/utils.js';

const ROOT = new MockId(new Uint8Array(1));
const ROOT2 = new MockId(new Uint8Array(11));
const ID0 = new MockId(new Uint8Array(2));
const ID1 = new MockId(new Uint8Array(3));
const ID2 = new MockId(new Uint8Array(4));
const FIELD0 = 'field0';
const FIELD1 = 'field1';
const FIELD2 = 'field2';
const VALUE0 = 'v0';
const VALUE1 = 'v1';
const VALUE2 = 'v2';

describe(MapEntityStore.name, () => {
  let store: MapEntityStore<MockId, string>;

  beforeEach(async () => {
    store = new MapEntityStore();
    await updateEntries([[[ROOT, FIELD0, ID0], VALUE0], [[ROOT, FIELD1, ID1], VALUE1]]);
  });

  it('should have correct string tag', () => {
    expect(store.toString()).toBe(`[object ${MapEntityStore.name}]`);
  });

  describe('asyncIterator', () => {
    it('should be async iterable', async () => {
      const results = [];
      for await (const entry of store) {
        results.push(entry);
      }
      expect(results).toEqual([[[ROOT, FIELD0, ID0], VALUE0], [[ROOT, FIELD1, ID1], VALUE1]]);
    });
  });

  describe('queries', () => {
    beforeEach(async () => {
      await updateEntries([[[ROOT, FIELD2, ID2], VALUE2], [[ROOT2, FIELD2, ID2], VALUE2]]);
    });

    describe('entries', () => {
      it('should iterate over entries', async () => {
        const entries = await collect(store.entries({ upper: [ROOT2, FIELD2], upperOpen: false, limit: 3, reverse: true }));
        expect(entries).toEqual([
          [[ROOT2, FIELD2, ID2], VALUE2],
          [[ROOT, FIELD2, ID2], VALUE2],
          [[ROOT, FIELD1, ID1], VALUE1]
        ]);
      });
    });

    describe('entriesByAttr', () => {
      it('should iterate over entries', async () => {
        const ids = [];
        for await (const id of store.entriesByAttr({ lower: [FIELD1] })) {
          ids.push(id);
        }
        expect(ids).toEqual([[[ROOT, FIELD1, ID1], VALUE1], [[ROOT2, FIELD2, ID2], VALUE2]]);
      });
    });

    describe('findMany', () => {
      it('should return matching entries', async () => {
        const results = [];
        for await (const entries of store.findMany([[ROOT], [ROOT, FIELD1], [ROOT2, FIELD2], [ROOT2, FIELD1]])) {
          const result = [];
          for await (const entry of entries) {
            result.push(entry);
          }
          results.push(result);
        }
        expect(results).toEqual([
          [[[ROOT, FIELD0, ID0], VALUE0], [[ROOT, FIELD1, ID1], VALUE1], [[ROOT, FIELD2, ID2], VALUE2]],
          [[[ROOT, FIELD1, ID1], VALUE1]],
          [[[ROOT2, FIELD2, ID2], VALUE2]],
          []
        ]);
      });
    });

    describe('findManyByAttr', () => {
      beforeEach(async () => {
        await updateEntries([[[ROOT, FIELD2, ID2], VALUE0]]);
      });

      it('should return matching entries', async () => {
        const results = [];
        for await (const entries of store.findManyByAttr([
          [FIELD2], [FIELD2, VALUE2], [FIELD1], [FIELD1, VALUE2]
        ])) {
          const result = [];
          for await (const entry of entries) {
            result.push(entry);
          }
          results.push(result);
        }
        expect(results).toEqual([
          [[[ROOT, FIELD2, ID2], VALUE0], [[ROOT2, FIELD2, ID2], VALUE2]],
          [[[ROOT2, FIELD2, ID2], VALUE2]],
          [[[ROOT, FIELD1, ID1], VALUE1]],
          []
        ]);
      });
    });
  });

  describe('getMany', () => {
    it('should return values for existing keys and undefined for non-existing keys', async () => {
      expectEntries([
        [[ROOT, FIELD0, ID0], VALUE0], [[ROOT, FIELD1, ID1], VALUE1],
        [[ROOT, FIELD2, ID1], undefined], [[ROOT, FIELD1, ID0], undefined],
      ]);
    });
  });

  describe('hasTx', () => {
    it('should return true for existing entry IDs and false for non-existing IDs', async () => {
      expect(await collect(store.hasTx([ID0, ID1, ROOT, ID2]))).toEqual([true, true, false, false]);
    });
  });

  describe('updateMany', () => {
    it('should add or delete entries', async () => {
      expect(await collect(store.updateMany([
        [[ROOT, FIELD0, ID0]], [[ROOT, FIELD2, ID2], VALUE2]
      ]))).toEqual([undefined, undefined])

      expectEntries([
        [[ROOT, FIELD0, ID0], undefined], [[ROOT, FIELD1, ID1], VALUE1], [[ROOT, FIELD2, ID2], VALUE2],
      ]);
    });
  });

  async function updateEntries(entries: Iterable<readonly [key: EntityAttrKey<MockId>, value?: string]>) {
    for await (const error of store.updateMany(entries)) {
      if (error) { throw error; }
    }
  }

  async function expectEntries(entries: Iterable<readonly [key: EntityAttrKey<MockId>, value?: string]>) {
    const results = [];
    for await (const result of store.getMany([...entries].map(([key]) => key))) {
      results.push(result);
    }
    expect(results).toEqual([...entries].map(([, value]) => value));
  }
});
