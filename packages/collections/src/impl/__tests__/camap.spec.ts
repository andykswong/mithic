import { beforeEach, describe, expect, it } from '@jest/globals';
import { ContentId } from '@mithic/commons';
import { CID } from 'multiformats';
import * as Block from 'multiformats/block';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from 'multiformats/hashes/sha2';
import { MaybeAsyncMap } from '../../map.js';
import { ContentAddressedMapStore } from '../camap.js';

const BLOCK = new Uint8Array([0x68, 0x65, 0x6C, 0x6C, 0x6F]);
const BLOCK2 = new Uint8Array([0x65, 0x66, 0x67]);
const BLOCK_ENCODED = await Block.encode({ value: BLOCK, codec: raw, hasher: sha256 });
const BLOCK2_ENCODED = await Block.encode({ value: BLOCK2, codec: raw, hasher: sha256 });
const RANDOM_CID = CID.createV1(0, await sha256.digest(new Uint8Array([1])));

type IterableBackingMap = MaybeAsyncMap<ContentId, Uint8Array> & Iterable<[ContentId, Uint8Array]>;

describe(ContentAddressedMapStore.name, () => {
  let store: ContentAddressedMapStore<ContentId, Uint8Array, IterableBackingMap>;

  beforeEach(() => {
    store = new ContentAddressedMapStore();
  });

  it('should have correct string tag', () => {
    expect(store.toString()).toBe(`[object ${ContentAddressedMapStore.name}]`);
  });

  describe('get', () => {
    it('should return stored block', async () => {
      const cid = await store.put(BLOCK);
      const block = await store.get(cid);
      expect(block).toEqual(BLOCK);
    });

    it('should return undefined for non-existent CID', async () => {
      const block = await store.get(RANDOM_CID);
      expect(block).toBeUndefined();
    });
  });

  describe('getMany', () => {
    it.each([
      [() => store],
      [() => new ContentAddressedMapStore(new Map())],
    ])('should return multiple stored blocks from the store', async (storeCreator) => {
      store = storeCreator();

      const cid1 = await store.put(BLOCK);
      const cid2 = await store.put(BLOCK2);
      const expectedData = [BLOCK, BLOCK2];

      const data: (Uint8Array | undefined)[] = [];
      for await (const result of store.getMany([cid1, cid2])) {
        data.push(result);
      }

      expect(data).toEqual(expectedData);
    });
  });

  describe('getKey', () => {
    it('should return the correct CID', async () => {
      expect(await store.getKey(BLOCK)).toEqual(BLOCK_ENCODED.cid);
    });
  });

  describe('has', () => {
    it('should return true for existent block', async () => {
      const cid = await store.put(BLOCK);
      expect(await store.has(cid)).toBe(true);
    });

    it('should return false for non-existent CID', async () => {
      expect(await store.has(RANDOM_CID)).toBe(false);
    });
  });

  describe('hasMany', () => {
    it.each([
      [() => new ContentAddressedMapStore<ContentId, Uint8Array, IterableBackingMap>()],
      [() => new ContentAddressedMapStore(new Map())],
    ])('should return true/false for existent/non-existent blocks', async (storeCreator) => {
      store = storeCreator();

      const cid1 = await store.put(BLOCK);
      const cid2 = await store.put(BLOCK2);
      const keys = [cid1, cid2, RANDOM_CID];
      const expectedResult = [true, true, false];

      const results: boolean[] = [];
      for await (const result of store.hasMany(keys)) {
        results.push(result);
      }

      expect(results).toEqual(expectedResult);
    });
  });

  describe('put', () => {
    it('should put block to the store and return its CID', async () => {
      const cid = await store.put(BLOCK);
      expect(await store['map'].get(cid)).toEqual(BLOCK);
      expect(cid).toEqual(BLOCK_ENCODED.cid);
    });

    it('should not store duplicate blocks', async () => {
      const cid1 = await store.put(BLOCK);
      const cid2 = await store.put(BLOCK);
      expect(cid1).toEqual(cid2);
    });
  });

  describe('putMany', () => {
    it('should put multiple blocks to the store and return their CIDs', async () => {
      const expectedCids = [BLOCK_ENCODED.cid, BLOCK2_ENCODED.cid];
      const cids: ContentId[] = [];
      for await (const [cid, error] of store.putMany([BLOCK, BLOCK2])) {
        cids.push(cid);
        expect(error).toBeUndefined();
      }

      expect(cids).toEqual(expectedCids);
      expect(await store['map'].get(BLOCK_ENCODED.cid)).toEqual(BLOCK);
      expect(await store['map'].get(BLOCK2_ENCODED.cid)).toEqual(BLOCK2);
    });
  });

  describe('delete', () => {
    it('should delete stored block', async () => {
      const cid = await store.put(BLOCK);
      await store.delete(cid);
      expect(await store['map'].has(cid)).toBe(false);
    });
  });

  describe('deleteMany', () => {
    it.each([
      [() => new ContentAddressedMapStore<ContentId, Uint8Array, IterableBackingMap>()],
      [() => new ContentAddressedMapStore(new Map())],
    ])('should delete multiple blocks from the store', async (storeCreator) => {
      store = storeCreator();

      const cid1 = await store.put(BLOCK);
      const cid2 = await store.put(BLOCK2);

      for await (const result of store.deleteMany([cid1, cid2])) {
        expect(result).toBeUndefined();
      }
      expect(await store['map'].has(cid1)).toBe(false);
      expect(await store['map'].has(cid2)).toBe(false);
    });
  });
  
  describe('iterator', () => {
    it('should iterate over keys', async () => {
      const cid1 = await store.put(BLOCK);
      const cid2 = await store.put(BLOCK2);

      expect([...store].map(([k, v]) => [k.toString(), v]))
        .toEqual([[cid1.toString(), BLOCK], [cid2.toString(), BLOCK2]]);
    });
  });

  describe('asyncIterator', () => {
    it('should async iterate over keys', async () => {
      const cid1 = await store.put(BLOCK);
      const cid2 = await store.put(BLOCK2);

      const results = [];
      for await (const [k, v] of store[Symbol.asyncIterator]()) {
        results.push([k.toString(), v]);
      }
      expect(results).toEqual([[cid1.toString(), BLOCK], [cid2.toString(), BLOCK2]]);
    });
  });
});
