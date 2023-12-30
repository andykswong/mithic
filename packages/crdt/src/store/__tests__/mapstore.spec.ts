import { beforeEach, describe, expect, it } from '@jest/globals';
import { MapEntityStore } from '../mapstore.js';
import { MockId } from '../../__tests__/mocks.js';
import { rangeQueryable } from '@mithic/collections';
import { EntityAttrKey } from '../store.js';

const ROOT = new MockId(new Uint8Array(1));
const ROOT2 = new MockId(new Uint8Array(11));
const ID0 = new MockId(new Uint8Array(2));
const ID1 = new MockId(new Uint8Array(3));
const ID2 = new MockId(new Uint8Array(4));
const FIELD0 = 'field0';
const FIELD1 = 'field1';
const FIELD2 = 'field2';
const VALUE0 = 'v0';
const VALUE02 = 'v02';
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

  it('should have correct rangeQueryable tag', () => {
    expect(store[rangeQueryable]).toBe(true);
  });

  describe('getMany', () => {
    it('should return values for existing keys and undefined for non-existing keys', async () => {
      expectEntries([
        [[ROOT, FIELD0, ID0], VALUE0], [[ROOT, FIELD1, ID1], VALUE1],
        [[ROOT, FIELD2, ID1], undefined], [[ROOT, FIELD1, ID0], undefined],
      ]);
    });
  });

  describe('hasMany', () => {
    it('should return true for existing keys and false for non-existing keys', async () => {
      const results = [];
      for await (const result of store.hasMany([
        [ROOT, FIELD0, ID0], [ROOT, FIELD1, ID1], [ROOT, FIELD2, ID1], [ROOT, FIELD1, ID0],
      ])) {
        results.push(result);
      }
      expect(results).toEqual([true, true, false, false]);
    });
  });

  describe('hasEntries', () => {
    it('should return true for existing entry IDs and false for non-existing IDs', async () => {
      const results = [];
      for await (const result of store.isKnown([ID0, ID1, ROOT, ID2])) {
        results.push(result);
      }
      expect(results).toEqual([true, true, false, false]);
    });
  });

  describe('updateMany', () => {
    it('should add or delete entries', async () => {
      for await (const error of store.updateMany([
        [[ROOT, FIELD0, ID0]], [[ROOT, FIELD2, ID2], VALUE2]
      ])) {
        expect(error).toBeUndefined();
      }

      expectEntries([
        [[ROOT, FIELD0, ID0], undefined], [[ROOT, FIELD1, ID1], VALUE1], [[ROOT, FIELD2, ID2], VALUE2],
      ]);
    });
  });

  describe('setMany', () => {
    it('should set values', async () => {
      for await (const error of store.setMany([
        [[ROOT, FIELD0, ID0], VALUE02], [[ROOT, FIELD2, ID2], VALUE2]
      ])) {
        expect(error).toBeUndefined();
      }

      expectEntries([
        [[ROOT, FIELD0, ID0], VALUE02], [[ROOT, FIELD1, ID1], VALUE1], [[ROOT, FIELD2, ID2], VALUE2],
      ]);
    });
  });

  describe('deleteMany', () => {
    it('should delete existing keys and do nothing for non-existing keys', async () => {
      for await (const error of store.deleteMany([[ROOT, FIELD1, ID1], [ROOT, FIELD2, ID2]])) {
        expect(error).toBeUndefined();
      }

      expectEntries([
        [[ROOT, FIELD0, ID0], VALUE0], [[ROOT, FIELD1, ID1], undefined], [[ROOT, FIELD2, ID2], undefined],
      ]);
    });
  });

  describe('entriesByAttr', () => {
    beforeEach(async () => {
      await updateEntries([[[ROOT2, FIELD1, ID2], VALUE2]]);
    });

    it('should iterate over entries', async () => {
      const ids = [];
      for await (const id of store.entriesByAttr({ lower: [FIELD1] })) {
        ids.push(id);
      }
      expect(ids).toEqual([[[ROOT, FIELD1, ID1], VALUE1], [[ROOT2, FIELD1, ID2], VALUE2]]);
    });
  });

  describe('keysByAttr', () => {
    beforeEach(async () => {
      await updateEntries([[[ROOT2, FIELD2, ID2], VALUE2]]);
    });

    it('should iterate over keys', async () => {
      const keys = [];
      for await (const key of store.keysByAttr({ lower: [FIELD1] })) {
        keys.push(key);
      }
      expect(keys).toEqual([[ROOT, FIELD1, ID1], [ROOT2, FIELD2, ID2]]);
    });
  });

  describe('keys', () => {
    beforeEach(async () => {
      await updateEntries([[[ROOT, FIELD2, ID2], VALUE2]]);
    });

    it('should iterate over keys', async () => {
      const keys = [];
      for await (const key of store.keys({ lower: [ROOT, FIELD1] })) {
        keys.push(key);
      }
      expect(keys).toEqual([[ROOT, FIELD1, ID1], [ROOT, FIELD2, ID2]]);
    });
  });

  describe('values', () => {
    it('should iterate over values', async () => {
      const values = [];
      for await (const value of store.values({ upper: [ROOT, FIELD1] })) {
        values.push(value);
      }
      expect(values).toEqual([VALUE0]);
    });
  });

  describe('entries', () => {
    beforeEach(async () => {
      await updateEntries([[[ROOT, FIELD2, ID2], VALUE2]]);
    });

    it('should iterate over entries', async () => {
      const entries = [];
      for await (const entry of store.entries({ limit: 2, reverse: true })) {
        entries.push(entry);
      }
      expect(entries).toEqual([[[ROOT, FIELD2, ID2], VALUE2], [[ROOT, FIELD1, ID1], VALUE1]]);
    });
  });

  describe('asyncIterator', () => {
    it('should async iterate over keys', async () => {
      const results = [];
      for await (const entry of store) {
        results.push(entry);
      }
      expect(results).toEqual([[[ROOT, FIELD0, ID0], VALUE0], [[ROOT, FIELD1, ID1], VALUE1]]);
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
