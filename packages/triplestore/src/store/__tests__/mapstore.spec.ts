import { beforeEach, describe, expect, it } from '@jest/globals';
import { rangeQueryable } from '@mithic/collections';
import { CID } from 'multiformats';
import { EntityAttrKey } from '../../store.js';
import { MapTripleStore } from '../mapstore.js';
import { collect, createCID } from '../../__tests__/utils.js';

const ROOT = createCID(new Uint8Array(1));
const ROOT2 = createCID(new Uint8Array(11));
const ID0 = createCID(new Uint8Array(2));
const ID1 = createCID(new Uint8Array(3));
const ID2 = createCID(new Uint8Array(4));
const ID3 = createCID(new Uint8Array(5));
const FIELD0 = 'field0';
const FIELD1 = 'field1';
const FIELD2 = 'field2';
const VALUE0 = 'v0';
const VALUE1 = 'v1';
const VALUE2 = 'v2';

describe(MapTripleStore.name, () => {
  let store: MapTripleStore<CID, string>;

  beforeEach(async () => {
    store = new MapTripleStore();
    await updateEntries([[[ROOT, FIELD0, VALUE0, ID0], VALUE0], [[ROOT, FIELD1, VALUE1, ID1], VALUE1]]);
  });

  it('should have correct rangeQueryable tag', () => {
    expect(store[rangeQueryable]).toBe(true);
  });

  it('should have correct string tag', () => {
    expect(store.toString()).toBe(`[object ${MapTripleStore.name}]`);
  });

  describe('asyncIterator', () => {
    it('should be async iterable', async () => {
      const results = [];
      for await (const entry of store) {
        results.push(entry);
      }
      expect(results).toEqual([[[ROOT, FIELD0, VALUE0, ID0], VALUE0], [[ROOT, FIELD1, VALUE1, ID1], VALUE1]]);
    });
  });

  describe('queries', () => {
    beforeEach(async () => {
      await updateEntries([[[ROOT, FIELD2, VALUE2, ID2], VALUE2], [[ROOT2, FIELD2, VALUE2, ID3], VALUE2]]);
    });

    describe('entries', () => {
      it('should iterate over entries', async () => {
        const entries = await collect(store.entries({ lower: [ROOT], upper: [ROOT, FIELD2], upperOpen: false, limit: 3, reverse: true }));
        expect(entries).toEqual([
          [[ROOT, FIELD2, VALUE2, ID2], VALUE2],
          [[ROOT, FIELD1, VALUE1, ID1], VALUE1],
          [[ROOT, FIELD0, VALUE0, ID0], VALUE0],
        ]);
      });
    });

    describe('keys', () => {
      it('should iterate over keys', async () => {
        const keys = await collect(store.keys({ lower: [ROOT], upper: [ROOT, FIELD2], upperOpen: false, limit: 3, reverse: true }));
        expect(keys).toEqual([[ROOT, FIELD2, VALUE2, ID2], [ROOT, FIELD1, VALUE1, ID1], [ROOT, FIELD0, VALUE0, ID0]]);
      });
    });

    describe('values', () => {
      it('should iterate over values', async () => {
        const values = await collect(store.values({ lower: [ROOT], upper: [ROOT, FIELD2], upperOpen: false, limit: 3, reverse: true }));
        expect(values).toEqual([VALUE2, VALUE1, VALUE0]);
      });
    });

    describe('entriesByAttr', () => {
      it('should iterate over entries', async () => {
        const entries = await collect(store.entriesByAttr({ lower: [FIELD2] }));
        expect(entries).toEqual([
          [[ROOT, FIELD2, VALUE2, ID2], VALUE2],
          [[ROOT2, FIELD2, VALUE2, ID3], VALUE2]
        ]);
      });
    });

    describe('keysByAttr', () => {
      it('should iterate over keys', async () => {
        const keys = await collect(store.keysByAttr({ lower: [FIELD2] }));
        expect(keys).toEqual([[ROOT, FIELD2, VALUE2, ID2], [ROOT2, FIELD2, VALUE2, ID3]]);
      });
    });

    describe('valuesByAttr', () => {
      it('should iterate over values', async () => {
        const values = await collect(store.valuesByAttr({ lower: [FIELD2] }));
        expect(values).toEqual([VALUE2, VALUE2]);
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
          [[[ROOT, FIELD0, VALUE0, ID0], VALUE0], [[ROOT, FIELD1, VALUE1, ID1], VALUE1], [[ROOT, FIELD2, VALUE2, ID2], VALUE2]],
          [[[ROOT, FIELD1, VALUE1, ID1], VALUE1]],
          [[[ROOT2, FIELD2, VALUE2, ID3], VALUE2]],
          []
        ]);
      });
    });

    describe('findManyByAttr', () => {
      beforeEach(async () => {
        await updateEntries([[[ROOT, FIELD2, VALUE0, ID1], VALUE0]]);
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
          [[[ROOT, FIELD2, VALUE0, ID1], VALUE0], [[ROOT, FIELD2, VALUE2, ID2], VALUE2], [[ROOT2, FIELD2, VALUE2, ID3], VALUE2]],
          [[[ROOT, FIELD2, VALUE2, ID2], VALUE2], [[ROOT2, FIELD2, VALUE2, ID3], VALUE2]],
          [[[ROOT, FIELD1, VALUE1, ID1], VALUE1]],
          []
        ]);
      });
    });
  });

  describe('getMany', () => {
    it('should return values for existing keys and undefined for non-existing keys', async () => {
      expectEntries([
        [[ROOT, FIELD0, VALUE0, ID0], VALUE0], [[ROOT, FIELD1, VALUE1, ID1], VALUE1],
        [[ROOT, FIELD2, VALUE2, ID1], undefined], [[ROOT, FIELD1, VALUE1, ID0], undefined],
      ]);
    });
  });

  describe('hasMany', () => {
    it('should return true for existing keys and false for non-existing keys', async () => {
      const results = await collect(store.hasMany([[ROOT, FIELD0, VALUE0, ID0], [ROOT, FIELD2, VALUE2, ID1]]));
      expect(results).toEqual([true, false]);
    });
  });

  describe('get', () => {
    it('should return values for existing keys', async () => {
      expect(await store.get([ROOT, FIELD0, VALUE0, ID0])).toBe(VALUE0);
    });

    it('should return undefined for non-existing keys', async () => {
      expect(await store.get([ROOT, FIELD0, VALUE0, ID1])).toBeUndefined();
    });
  });

  describe('has', () => {
    it('should return true for existing keys', async () => {
      expect(await store.has([ROOT, FIELD0, VALUE0, ID0])).toBe(true);
    });

    it('should return false for non-existing keys', async () => {
      expect(await store.has([ROOT, FIELD0, VALUE1, ID1])).toBe(false);
    });
  });

  describe('set', () => {
    it('should update existing entry', async () => {
      await store.set([ROOT, FIELD0, VALUE0, ID0], VALUE2);
      expectEntries([[[ROOT, FIELD0, VALUE0, ID0], VALUE2]]);
    });
  });

  describe('delete', () => {
    it('should delete existing entry', async () => {
      await store.delete([ROOT, FIELD0, VALUE0, ID0]);
      expectEntries([[[ROOT, FIELD0, VALUE0, ID0], undefined]]);
    });
  });

  describe('updateMany', () => {
    it('should add or delete entries', async () => {
      expect(await collect(store.updateMany([
        [[ROOT, FIELD0, VALUE0, ID0]], [[ROOT, FIELD2, VALUE2, ID2], VALUE2]
      ]))).toEqual([undefined, undefined])

      expectEntries([
        [[ROOT, FIELD0, VALUE0, ID0], undefined],
        [[ROOT, FIELD1, VALUE1, ID1], VALUE1],
        [[ROOT, FIELD2, VALUE2, ID2], VALUE2],
      ]);
    });
  });

  describe('setMany', () => {
    it('should add or update entries', async () => {
      expect(await collect(store.setMany([
        [[ROOT, FIELD0, VALUE0, ID0], VALUE2], [[ROOT, FIELD2, VALUE2, ID2], VALUE2]
      ]))).toEqual([undefined, undefined])

      expectEntries([[[ROOT, FIELD0, VALUE0, ID0], VALUE2], [[ROOT, FIELD2, VALUE2, ID2], VALUE2]]);
    });
  });

  describe('deleteMany', () => {
    it('should delete entries', async () => {
      expect(await collect(store.deleteMany([[ROOT, FIELD0, VALUE0, ID0]]))).toEqual([undefined])
      expectEntries([[[ROOT, FIELD0, VALUE0, ID0], undefined]]);
    });
  });

  async function updateEntries(entries: Iterable<readonly [key: EntityAttrKey<CID>, value?: string]>) {
    for await (const error of store.updateMany(entries)) {
      if (error) { throw error; }
    }
  }

  async function expectEntries(entries: Iterable<readonly [key: EntityAttrKey<CID>, value?: string]>) {
    const results = await collect(store.getMany([...entries].map(([key]) => key)));
    expect(results).toEqual([...entries].map(([, value]) => value));
  }
});
