import { BTreeMap, ContentAddressedMapStore } from '@mithic/collections';
import { ContentId, ErrorCode, operationError } from '@mithic/commons';
import { SimpleEventStore } from '../store.js';
import { MultihashDigest, MultibaseEncoder } from 'multiformats';
import { base64 } from 'multiformats/bases/base64';
import { Event, EventMetadata } from '../../event.js';

class Id implements ContentId {
  code = 123;
  multihash!: MultihashDigest<number>;

  constructor(public bytes: Uint8Array) {
  }

  toJSON(): { '/': string; } {
    return { '/': this.toString() };
  }

  toString(base: MultibaseEncoder<string> = base64): string {
    return base.encode(this.bytes);
  }

  equals(rhs: Id): boolean {
    return this.toString() === rhs.toString();
  }
}

type EventType = Event<[number, Id], EventMetadata<Id>>;

const TYPE1 = 'EVENT_CREATED';
const TYPE2 = 'EVENT_UPDATED';
const ID1 = new Id(new Uint8Array([1, 1, 1]));
const ID2 = new Id(new Uint8Array([2, 2, 2]));
const ID3 = new Id(new Uint8Array([3, 3, 3]));
const EVENT1: EventType = { type: TYPE1, payload: [1, ID1], meta: { parents: [] } };
const EVENT2: EventType = { type: TYPE2, payload: [2, ID2], meta: { parents: [ID1], root: ID1 } };

describe(SimpleEventStore.name, () => {
  let store: SimpleEventStore<Id, EventType>;
  let data: ContentAddressedMapStore<Id, EventType>;
  let index: BTreeMap<Uint8Array, Id>;

  beforeEach(async () => {
    store = new SimpleEventStore({
      data: new ContentAddressedMapStore(void 0, (event) => event.payload[1])
    });
    data = store['data'] as ContentAddressedMapStore<Id, EventType>;
    index = store['index'] as BTreeMap<Uint8Array, Id>;

    await store.put(EVENT1);
    await store.put(EVENT2);
    expect(index.size).toBe(18);
  });

  describe('put', () => {
    it('should save event and return the key', async () => {
      const key = new Id(new Uint8Array([1, 3, 5]));
      const event: EventType = { type: TYPE1, payload: [3, key], meta: { root: ID1, parents: [ID1] } };
      const result = await store.put(event);
      expect(key).toEqual(result);
      expect(data.has(key)).toBeTruthy();
      expect(index.size).toBe(30);
    });

    it('should replace head event indices', async () => {
      const key = new Id(new Uint8Array([1, 3, 5]));
      const event: EventType = { type: TYPE1, payload: [3, key], meta: { root: ID1, parents: [ID2] } };
      const result = await store.put(event);
      expect(key).toEqual(result);
      expect(data.has(key)).toBeTruthy();
      expect(index.size).toBe(24);
    });

    it('should return the key of event if already exists', async () => {
      const key = await store.put(EVENT1);
      expect(key).toEqual(ID1);
      const event = await store.get(key);
      expect(event).toBe(EVENT1);
    });

    it('should throw an error if there are missing dependencies', async () => {
      const event: EventType = {
        type: TYPE1,
        payload: [3, new Id(new Uint8Array([1, 3, 5]))],
        meta: { root: ID1, parents: [ID1, ID3] }
      };
      await expect(store.put(event)).rejects
        .toThrowError(operationError('Missing dependencies', ErrorCode.MissingDep, [ID3]));
    });

    it('should throw an error if root Id is invalid', async () => {
      const event: EventType = {
        type: TYPE1,
        payload: [3, new Id(new Uint8Array([1, 3, 5]))],
        meta: { root: ID2, parents: [ID1] }
      };
      await expect(store.put(event)).rejects
        .toThrowError(operationError('Invalid root Id', ErrorCode.InvalidArg));
    });

    it('should throw an error if the root Id is missing', async () => {
      const event: EventType = {
        type: TYPE1,
        payload: [3, new Id(new Uint8Array([1, 3, 5]))],
        meta: { parents: [ID1] }
      };
      await expect(store.put(event)).rejects.toThrowError(operationError('Missing root Id', ErrorCode.InvalidArg));
    });
  });

  describe('putMany', () => {
    it('should save event and return the key / error', async () => {
      const key1 = new Id(new Uint8Array([1]));
      const key2 = new Id(new Uint8Array([2]));
      const event1: EventType = { type: TYPE1, payload: [3, key1], meta: { root: ID1, parents: [ID1] } };
      const event2: EventType = { type: TYPE2, payload: [4, key2], meta: { root: ID3, parents: [ID3] } };

      const results = [];
      for await (const result of store.putMany([event1, event2])) {
        results.push(result);
      }
      expect(results).toEqual([
        [key1],
        [key2, operationError('Missing dependencies', ErrorCode.MissingDep, [ID3])]
      ]);
    });

  });

  describe('get', () => {
    it('should return the event when the key is valid', async () => {
      const event = await store.get(ID1);
      expect(event).toBe(EVENT1);
    });

    it('should return undefined when the key is invalid', async () => {
      const event = await store.get(ID3);
      expect(event).toBeUndefined();
    });
  });

  describe('getMany', () => {
    it('should return the event when the key is valid, undefined otherwise', async () => {
      const results = [];
      for await (const event of store.getMany([ID1, ID2, ID3])) {
        results.push(event);
      }
      expect(results).toEqual([EVENT1, EVENT2, undefined]);
    });
  });

  
  describe('getKey', () => {
    it('should return the correct key', async () => {
      const key = new Id(new Uint8Array([1, 3, 5]));
      const event: EventType = { type: TYPE1, payload: [3, key], meta: { root: ID1, parents: [ID1] } };
      const result = await store.getKey(event);
      expect(key).toEqual(result);
    });
  });

  describe('has', () => {
    test('should return true when the key is valid', async () => {
      const hasKey = await store.has(ID1);
      expect(hasKey).toBe(true);
    });

    test('should return false when the key is invalid', async () => {
      const hasKey = await store.has(ID3);
      expect(hasKey).toBe(false);
    });
  });

  describe('hasMany', () => {
    it('should return true when the key is valid, false otherwise', async () => {
      const results = [];
      for await (const event of store.hasMany([ID1, ID3, ID2])) {
        results.push(event);
      }
      expect(results).toEqual([true, false, true]);
    });
  });

  describe('asyncIterator', () => {
    it('should return all entries', async () => {
      const results = [];
      for await (const entry of store) {
        results.push(entry);
      }
      expect(results).toEqual([[ID1, EVENT1], [ID2, EVENT2]]);
    });
  });

  describe('query', () => {
    const TYPE3 = 'EVENT_DELETED';
    const ID4 = new Id(new Uint8Array([3, 4]));
    const ID5 = new Id(new Uint8Array([3, 5]));
    const ID6 = new Id(new Uint8Array([4, 6]));
    const ID7 = new Id(new Uint8Array([1, 7]));
    const EVENT3: EventType = { type: TYPE1, payload: [3, ID3], meta: { parents: [] } };
    const EVENT4: EventType = { type: TYPE2, payload: [4, ID4], meta: { parents: [ID3], root: ID3 } };
    const EVENT5: EventType = { type: TYPE2, payload: [5, ID5], meta: { parents: [ID3], root: ID3 } };
    const EVENT6: EventType = { type: TYPE2, payload: [6, ID6], meta: { parents: [ID4], root: ID3 } };
    const EVENT7: EventType = { type: TYPE3, payload: [7, ID7], meta: { parents: [ID2], root: ID1 } };

    beforeEach(async () => {
      await store.put(EVENT3);
    });

    it.each([
      [{ type: TYPE1 }, [EVENT1, EVENT3], false],
      [{ type: TYPE2 }, [EVENT2], false],
      [{ type: 'EVENT' }, [EVENT1, EVENT2, EVENT3], false],
      [{ type: 'EVENT', limit: 2 }, [EVENT1, EVENT2], true],
      [{ type: TYPE1, head: true }, [EVENT3], false],
      [{ root: ID1 }, [EVENT1, EVENT2], false],
      [{ root: ID1, type: TYPE1 }, [EVENT1], false],
      [{ root: ID1, type: TYPE1, head: true }, [], false],
      [{ root: ID1, type: 'EVENT', head: true }, [EVENT2], false],
      [{ head: true }, [EVENT5, EVENT6, EVENT7], true],
      [{ head: true, limit: 2 }, [EVENT5, EVENT6], true],
      [{ since: [ID3] }, [EVENT4, EVENT5, EVENT6, EVENT7], true],
      [{ since: [ID3], limit: 3 }, [EVENT4, EVENT5, EVENT6], true],
      [{ type: TYPE2, since: [ID4] }, [EVENT5, EVENT6], true],
      [{ root: ID1, type: 'EVENT', since: [ID2] }, [EVENT7], true],
      [{ since: [ID3], head: true, type: TYPE2 }, [EVENT5, EVENT6], true],
      [{ since: [ID3], head: true, type: TYPE2, root: ID1 }, [], true],
    ])('should return values matching the query options: %j', async (options, expectedResults, extraEvents) => {
      if (extraEvents) {
        await putExtraEvents();
      }

      const results = [];
      const iter = store.values(options);
      let result;
      for (result = await iter.next(); !result.done; result = await iter.next()) {
        results.push(result.value);
      }
      expect(results).toEqual(expectedResults);
      expect(result.value).toEqual(expectedResults.length ? [expectedResults[expectedResults.length - 1].payload[1]] : []);
    });

    async function putExtraEvents() {
      await store.put(EVENT4);
      await store.put(EVENT5);
      await store.put(EVENT6);
      await store.put(EVENT7);
    }
  });
});
