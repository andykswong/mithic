import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { OperationError } from '@mithic/commons';
import { MemoryBlockstore } from 'blockstore-core';
import { Blockstore } from 'interface-blockstore';
import { BlockCodec, CID } from 'multiformats';
import { identity } from 'multiformats/hashes/identity';
import { BlockstoreMap } from '../blockstore.js';

const DATA = new Uint8Array([1, 2, 3]);
const DATA_CID = CID.createV1(0x999, identity.digest(DATA));
const CID2 = CID.createV1(0x999, identity.digest(new Uint8Array([1, 3, 3, 7])));

describe(BlockstoreMap.name, () => {
  const mockCodec: BlockCodec<number, Uint8Array> = {
    name: 'mock',
    code: 0x999,
    encode(data: Uint8Array) {
      return data;
    },
    decode(bytes: Uint8Array) {
      return bytes;
    }
  };

  let map: BlockstoreMap;
  let blockstore: Blockstore;

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    blockstore = new MemoryBlockstore();
    await blockstore.put(DATA_CID, DATA);
    map = new BlockstoreMap(blockstore, mockCodec, identity);
  });

  it('should have the correct string tag', () => {
    expect(`${map}`).toBe(`[object ${BlockstoreMap.name}]`);
  });

  describe('get', () => {
    it('should return response from blockstore.get', async () => {
      const getSpy = jest.spyOn(blockstore, 'get');
      const options = { signal: AbortSignal.timeout(1000) };

      expect(await map.get(DATA_CID, options)).toBe(DATA);
      expect(getSpy).toHaveBeenCalledWith(DATA_CID, options);
    });

    it('should return undefined if not exist', async () => {
      expect(await map.get(CID.createV1(0, identity.digest(new Uint8Array([1]))), {})).toBeUndefined();
    });
  });

  describe('getKey', () => {
    it('returns the correct key', () => {
      expect(map.getKey(DATA)).toEqual(DATA_CID);
    });
  });

  describe('has', () => {
    it('should return true if block is found', async () => {
      const getSpy = jest.spyOn(blockstore, 'get');
      const options = { signal: AbortSignal.timeout(1000) };

      expect(await map.has(DATA_CID, options)).toBe(true);
      expect(getSpy).toHaveBeenCalledWith(DATA_CID, options);
    });

    it('should return false if CID is not found', async () => {
      expect(await map.has(CID.createV1(0, identity.digest(new Uint8Array([1]))), {})).toBe(false);
    });
  });

  describe('put', () => {
    it('should pass given options to blockstore.put', async () => {
      const encodeSpy = jest.spyOn(mockCodec, 'encode');
      const putSpy = jest.spyOn(blockstore, 'put');

      const options = { signal: AbortSignal.timeout(1000) };
      const result = await map.put(DATA, options);

      expect(result).toStrictEqual(DATA_CID);
      expect(encodeSpy).toBeCalledWith(DATA);
      expect(putSpy).toHaveBeenCalledWith(DATA_CID, DATA, options);
    });
  });

  describe('delete', () => {
    it('should pass given options to blockstore.delete', async () => {
      const deleteSpy = jest.spyOn(blockstore, 'delete');

      const options = { signal: AbortSignal.timeout(1000) };
      await map.delete(DATA_CID, options);

      expect(deleteSpy).toHaveBeenCalledWith(DATA_CID, options);
    });
  });

  describe('getMany', () => {
    it('should return response from blockstore.get', async () => {
      const getSpy = jest.spyOn(blockstore, 'get');
      const options = { signal: AbortSignal.timeout(1000) };

      const results = [];
      for await (const result of map.getMany([DATA_CID, CID2], options)) {
        results.push(result);
      }

      expect(results).toEqual([DATA, undefined]);
      expect(getSpy).toHaveBeenCalledWith(DATA_CID, options);
      expect(getSpy).toHaveBeenCalledWith(CID2, options);
    });
  });

  describe('hasMany', () => {
    it('should return true if key is found and false otherwise', async () => {
      const getSpy = jest.spyOn(blockstore, 'get');
      const options = { signal: AbortSignal.timeout(1000) };

      const results = [];
      for await (const result of map.hasMany([DATA_CID, CID2], options)) {
        results.push(result);
      }

      expect(results).toEqual([true, false]);
      expect(getSpy).toHaveBeenCalledWith(DATA_CID, options);
      expect(getSpy).toHaveBeenCalledWith(CID2, options);
    });
  });

  describe('putMany', () => {
    it('should pass given options to blockstore.put', async () => {
      const options = { signal: AbortSignal.timeout(1000) };
      const error = new Error('ERROR_DATA2');
      const data2 = new Uint8Array([1, 3, 3, 7]);
      const cid2 = CID.createV1(mockCodec.code, identity.digest(data2));

      const blockstorePut = blockstore.put.bind(blockstore);
      const putMock = jest.spyOn(blockstore, 'put')
        .mockImplementation(async (key, data, options) => {
          if (cid2.equals(key)) {
            throw error;
          }
          return blockstorePut(key, data, options);
        });

      const results = [];
      for await (const result of map.putMany([DATA, data2], options)) {
        results.push(result);
      }

      expect(results).toEqual([
        [DATA_CID],
        [cid2, new OperationError('failed to put', { detail: cid2, cause: error })]
      ]);
      expect(putMock).toHaveBeenCalledWith(DATA_CID, DATA, options);
      expect(putMock).toHaveBeenCalledWith(cid2, data2, options);
    });
  });

  describe('deleteMany', () => {
    it('should pass given options to blockstore.delete', async () => {
      const deleteSpy = jest.spyOn(blockstore, 'delete');

      const options = { signal: AbortSignal.timeout(1000) };

      const results = [];
      for await (const error of map.deleteMany([DATA_CID, CID2], options)) {
        results.push(error);
      }

      expect(results).toEqual([undefined, undefined]);
      expect(deleteSpy).toHaveBeenCalledWith(DATA_CID, options);
      expect(deleteSpy).toHaveBeenCalledWith(CID2, options);
    });
  });
});
