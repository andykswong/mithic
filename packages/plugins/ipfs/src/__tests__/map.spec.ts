import { jest } from '@jest/globals';
import { IPFS } from 'ipfs-core-types';
import { BlockCodec, CID } from 'multiformats';
import { identity } from 'multiformats/hashes/identity';
import { IpfsMap } from '../map.js';
import { MockIpfs } from './mocks.js';
import { ErrorCode, operationError } from '@mithic/commons';

const DATA = new Uint8Array([1, 2, 3]);
const DATA_CID = CID.createV1(0, identity.digest(DATA));
const CID2 = CID.createV1(0, identity.digest(new Uint8Array([1, 3, 3, 7])));

describe(IpfsMap.name, () => {
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

  let map: IpfsMap;
  let mockIpfs: IPFS;

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    const _mockIpfs = new MockIpfs();
    _mockIpfs.block.data.set(DATA_CID.toString(), [DATA_CID, DATA]);

    mockIpfs = _mockIpfs;
    map = new IpfsMap(mockIpfs, mockCodec, identity);
  });

  it('should have the correct string tag', () => {
    expect(`${map}`).toBe(`[object ${IpfsMap.name}]`);
  });

  describe('get', () => {
    it('should return response from IPFS.block.get', async () => {
      const getSpy = jest.spyOn(mockIpfs.block, 'get');
      const options = { signal: AbortSignal.timeout(1000) };

      expect(await map.get(DATA_CID, options)).toBe(DATA);
      expect(getSpy).toHaveBeenCalledWith(DATA_CID, options);
    });

    it('should return undefined if not exist', async () => {
      expect(await map.get(CID.createV1(0, identity.digest(new Uint8Array([1]))), {})).toBeUndefined();
    });
  });

  describe('has', () => {
    it('should return true if block is found', async () => {
      const getSpy = jest.spyOn(mockIpfs.block, 'get');
      const options = { signal: AbortSignal.timeout(1000) };

      expect(await map.has(DATA_CID, options)).toBe(true);
      expect(getSpy).toHaveBeenCalledWith(DATA_CID, options);
    });

    it('should return false if CID is not found', async () => {
      expect.assertions(1);
      expect(await map.has(CID.createV1(0, identity.digest(new Uint8Array([1]))), {})).toBe(false);
    });
  });

  describe('put', () => {
    it('should pass given options to IPFS.block.put', async () => {
      const encodeSpy = jest.spyOn(mockCodec, 'encode');
      const putSpy = jest.spyOn(mockIpfs.block, 'put');

      const options = { signal: AbortSignal.timeout(1000) };
      const link = await map.put(DATA, options);

      expect(link).toBe(DATA_CID);
      expect(encodeSpy).toBeCalledWith(DATA);
      expect(putSpy).toHaveBeenCalledWith(DATA, { ...options, format: mockCodec.code, version: 1 });
    });
  });

  describe('delete', () => {
    it('should pass given options to IPFS.block.rm', async () => {
      const rmSpy = jest.spyOn(mockIpfs.block, 'rm');

      const options = { signal: AbortSignal.timeout(1000) };
      await map.delete(DATA_CID, options);

      expect(rmSpy).toHaveBeenCalledWith(DATA_CID, { ...options, force: true });
    });

    it('should throw errors returned from IPFS.block.rm', async () => {
      await expect(map.delete(CID2)).rejects.toThrow('mismatched data');
    });
  });

  describe('getMany', () => {
    it('should return response from IPFS.block.get', async () => {
      const getSpy = jest.spyOn(mockIpfs.block, 'get');
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
      const getSpy = jest.spyOn(mockIpfs.block, 'get');
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
    it('should pass given options to IPFS.block.put', async () => {
      const putSpy = jest.spyOn(mockIpfs.block, 'put');
      const options = { signal: AbortSignal.timeout(1000) };

      const data2 = new Uint8Array([1, 3, 3, 7]);
      const cid2 = CID.createV1(mockCodec.code, identity.digest(data2));

      const results = [];
      for await (const result of map.putMany([DATA, data2], options)) {
        results.push(result);
      }

      expect(results).toEqual([
        [DATA_CID],
        [cid2, operationError('Failed to put', ErrorCode.OpFailed, cid2, new Error('mismatched data'))]
      ]);
      expect(putSpy).toHaveBeenCalledWith(DATA, { ...options, format: mockCodec.code, version: 1 });
      expect(putSpy).toHaveBeenCalledWith(data2, { ...options, format: mockCodec.code, version: 1 });
    });
  });

  describe('deleteMany', () => {
    it('should pass given options to IPFS.block.rm', async () => {
      const rmSpy = jest.spyOn(mockIpfs.block, 'rm');

      const options = { signal: AbortSignal.timeout(1000) };

      const results = [];
      for await (const error of map.deleteMany([DATA_CID, CID2], options)) {
        results.push(error);
      }

      expect(results).toEqual([undefined, new Error('mismatched data')]);
      expect(rmSpy).toHaveBeenCalledWith([DATA_CID, CID2], { ...options, force: true });
    });
  });
});
