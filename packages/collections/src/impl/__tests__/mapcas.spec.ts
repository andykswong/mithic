import { CodedError, ContentId, sha256 } from '@mithic/commons';
import { CID } from 'multiformats';
import * as Block from 'multiformats/block';
import * as raw from 'multiformats/codecs/raw';
import { ContentAddressedMapStore } from '../mapcas.js';

const BLOCK = new Uint8Array([0x68, 0x65, 0x6C, 0x6C, 0x6F]);
const BLOCK2 = new Uint8Array([0x65, 0x66, 0x67]);
const BLOCK_ENCODED = await Block.encode({ value: BLOCK, codec: raw, hasher: sha256 });
const RANDOM_CID = CID.createV1(0, sha256.digest(new Uint8Array([1])));

describe(ContentAddressedMapStore.name, () => {
  let backingMap: Map<CID, Uint8Array>;
  let store: ContentAddressedMapStore;

  beforeEach(() => {
    store = new ContentAddressedMapStore();
    backingMap = store['map'] as Map<CID, Uint8Array>;
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
    it('should return multiple stored blocks from the store', async () => {
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

  describe('has', () => {
    it('should return true for existent block', async () => {
      const cid = await store.put(BLOCK);
      expect(await store.has(cid)).toBe(true);
    });

    it('should return false for non-existent CID', async () => {
      expect(await store.has(RANDOM_CID)).toBe(false);
    });
  });

  describe('put', () => {
    it('should put block to the store and return its CID', async () => {
      const cid = await store.put(BLOCK);
      expect(backingMap.get(cid)).toEqual(BLOCK);
      expect(cid).toEqual(BLOCK_ENCODED.cid);
    });

    it('should not store duplicate blocks', async () => {
      const cid1 = await store.put(BLOCK);
      const cid2 = await store.put(BLOCK);
      expect(cid1).toEqual(cid2);
      expect(backingMap.size).toBe(1);
    });
  });

  describe('putMany', () => {
    it('should put multiple blocks to the store and return their CIDs', async () => {
      const cid1 = await store.put(BLOCK);
      const cid2 = await store.put(BLOCK2);
      const expectedCids = [cid1, cid2];
      backingMap.clear();

      const cids: ContentId[] = [];
      for await (const cid of store.putMany([BLOCK, BLOCK2])) {
        cids.push(cid);
      }

      expect(cids).toEqual(expectedCids);
      expect(backingMap.size).toBe(2);
    });
  });

  describe('delete', () => {
    it('should delete stored block', async () => {
      const cid = await store.put(BLOCK);
      await store.delete(cid);
      expect(backingMap.has(cid)).toBe(false);
    });
  });
  
  describe('deleteMany', () => {
    it('should delete multiple blocks from the store', async () => {
      const cid1 = await store.put(BLOCK);
      const cid2 = await store.put(BLOCK2);
      const expectedData = [undefined, undefined];

      const data: (CodedError | undefined)[] = [];
      for await (const result of store.deleteMany([cid1, cid2])) {
        data.push(result);
      }

      expect(data).toEqual(expectedData);
    });
  });
});
