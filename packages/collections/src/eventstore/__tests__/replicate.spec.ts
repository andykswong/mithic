
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AutoKeyMapPutBatch, MaybeAsyncReadonlySetBatch } from '@mithic/collections';
import { EventStoreQuery } from '../../eventstore.ts';
import { replicateEvents } from '../replicate.ts';

const CHECKPOINT = ['key5'];
const ENTRIES = [1, 2, 3, 4, 5].map(i => [`key${i}`, `value${i}`] as [string, string]);
const KEYS = ENTRIES.map(entry => entry[0]);
const VALUES = ENTRIES.map(entry => entry[1]);
const EXTRA = { test: 123 };

describe(replicateEvents.name, () => {
  let source: EventStoreQuery<string, string, { test: number }>;
  let target: AutoKeyMapPutBatch<string, string> & MaybeAsyncReadonlySetBatch<string>;

  beforeEach(() => {
    source = {
      entries: jest.fn(async function * () {
        for (const entry of ENTRIES) {
          yield entry;
        }
        return CHECKPOINT;
      }),
      keys: jest.fn(async function * () {
        for (const [key] of ENTRIES) {
          yield key;
        }
        return CHECKPOINT;
      }),
      values: jest.fn(async function * () {
        for (const [, value] of ENTRIES) {
          yield value;
        }
        return CHECKPOINT;
      }),
    };

    let call = 0;
    target = {
      hasMany: jest.fn(async function * (keys: string[]) {
        expect(keys).toEqual(KEYS.slice(call * 2, call * 2 + 2));
        for (let i = 0; i < keys.length; i++) {
          yield call * 2 + i === 2;
        }
        ++call;
      }),
      putMany: jest.fn(async function * (values: string[]) {
        for (let i = 0; i < values.length; i++) {
          yield [`key${call * 2 + i}`] as [string, Error?];
        }
      }),
    };
  });

  it('should call target.putMany() for each batch', async () => {
    const signal = { signal: AbortSignal.timeout(100) };
    const options = { since: ['key0'], limit: 135, ...signal };

    const result = await replicateEvents({ source, target, batchSize: 2, extra: EXTRA, ...options });

    expect(result).toEqual(CHECKPOINT);
    expect(source.entries).toHaveBeenCalledWith({ ...options, ...EXTRA });

    expect(target.hasMany).toHaveBeenCalledTimes(3);
    expect(target.putMany).toHaveBeenCalledTimes(3);
    expect(target.putMany).toHaveBeenNthCalledWith(1, VALUES.slice(0, 2), signal);
    expect(target.putMany).toHaveBeenNthCalledWith(2, VALUES.slice(3, 4), signal);
    expect(target.putMany).toHaveBeenNthCalledWith(3, VALUES.slice(4, 5), signal);
  });

  it('should throw error if target.putMany() fails', async () => {
    (target.putMany as jest.Mocked<typeof target['putMany']>).mockImplementation(async function * (values: string[]) {
      for (let i = 0; i < values.length; i++) {
        yield ['key', new Error('failed to put')];
      }
    });

    await expect(replicateEvents({ source, target, batchSize: 2 })).rejects.toThrow('failed to put');
  });
});
