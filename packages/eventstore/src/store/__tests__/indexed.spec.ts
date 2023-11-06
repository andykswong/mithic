import { beforeEach, describe, expect, it } from '@jest/globals';
import { BTreeMap, ContentAddressedMapStore } from '@mithic/collections';
import { ERR_DEPENDENCY_MISSING, OperationError } from '@mithic/commons';
import { IndexedEventStore } from '../indexed.js';
import { MockEvent, MockId } from '../../__tests__/mocks.js';

const TYPE1 = 'EVENT_CREATED';
const TYPE2 = 'EVENT_UPDATED';
const ID1 = new MockId(new Uint8Array([1, 1, 1]));
const ID2 = new MockId(new Uint8Array([2, 2, 2]));
const ID3 = new MockId(new Uint8Array([3, 3, 3]));
const EVENT1 = { type: TYPE1, payload: 1, id: ID1, link: [], time: 1 } satisfies MockEvent;
const EVENT2 = { type: TYPE2, payload: 2, id: ID2, link: [ID1], root: ID1 } satisfies MockEvent;
const EVENT2_FULL = { ...EVENT2, time: 2 } satisfies MockEvent;

describe(IndexedEventStore.name, () => {
  let store: IndexedEventStore<MockId, MockEvent>;
  let data: ContentAddressedMapStore<MockId, MockEvent>;
  let index: BTreeMap<string, MockId>;

  beforeEach(async () => {
    store = new IndexedEventStore({
      data: new ContentAddressedMapStore(void 0, (event) => event.id),
      setEventTime: (event, time) => { return { ...event, time }; },
      tick: (() => {
        let time = 0;
        return (refTime = 0) => (time = Math.max(time + 1, refTime + 1));
      })(),
    });
    data = store['data'] as ContentAddressedMapStore<MockId, MockEvent>;
    index = store['index'] as BTreeMap<string, MockId>;

    await store.put(EVENT1);
    await store.put(EVENT2);
  });

  it('should have the correct index size', () => {
    expect(index.size).toBe(18);
  });

  describe('put', () => {
    it('should save event and return the key', async () => {
      const key = new MockId(new Uint8Array([1, 3, 5]));
      const event = { type: TYPE1, payload: 3, id: key, root: ID1, link: [ID1] } satisfies MockEvent;
      const result = await store.put(event);
      expect(key).toEqual(result);
      expect(data.has(key)).toBeTruthy();
      expect(index.size).toBe(30);
    });

    it('should replace head event indices', async () => {
      const key = new MockId(new Uint8Array([1, 3, 5]));
      const event = { type: TYPE1, payload: 3, id: key, root: ID1, link: [ID2] } satisfies MockEvent;
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
      const event = {
        type: TYPE1,
        payload: 3,
        id: new MockId(new Uint8Array([1, 3, 5])),
        root: ID1,
        link: [ID1, ID3]
      } satisfies MockEvent;
      await expect(store.put(event)).rejects
        .toThrowError(new OperationError('missing dependencies', { code: ERR_DEPENDENCY_MISSING, detail: [ID3] }));
    });

    it('should throw an error if root Id is invalid', async () => {
      const event = {
        type: TYPE1,
        payload: 3,
        id: new MockId(new Uint8Array([1, 3, 5])),
        root: ID2,
        link: [ID1]
      } satisfies MockEvent;
      await expect(store.put(event)).rejects
        .toThrowError(new TypeError('missing dependency to root Id'));
    });

    it('should throw an error if the root Id is missing', async () => {
      const event = {
        type: TYPE1,
        payload: 3,
        id: new MockId(new Uint8Array([1, 3, 5])),
        link: [ID1]
      } satisfies MockEvent;
      await expect(store.put(event)).rejects.toThrowError(new TypeError('missing root Id'));
    });
  });

  describe('putMany', () => {
    it('should save event and return the key / error', async () => {
      const key1 = new MockId(new Uint8Array([1]));
      const key2 = new MockId(new Uint8Array([2]));
      const event1 = { type: TYPE1, payload: 3, id: key1, root: ID1, link: [ID1] } satisfies MockEvent;
      const event2 = { type: TYPE2, payload: 4, id: key2, root: ID3, link: [ID3] } satisfies MockEvent;

      const results = [];
      for await (const result of store.putMany([event1, event2])) {
        results.push(result);
      }
      expect(results).toEqual([
        [key1],
        [key2, new OperationError('missing dependencies', { code: ERR_DEPENDENCY_MISSING, detail: [ID3] })]
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
      expect(results).toEqual([EVENT1, EVENT2_FULL, undefined]);
    });
  });


  describe('getKey', () => {
    it('should return the correct key', async () => {
      const key = new MockId(new Uint8Array([1, 3, 5]));
      const event = { type: TYPE1, payload: 3, id: key, root: ID1, link: [ID1] } satisfies MockEvent;
      const result = await store.getKey(event);
      expect(key).toEqual(result);
    });
  });

  describe('has', () => {
    it('should return true when the key is valid', async () => {
      const hasKey = await store.has(ID1);
      expect(hasKey).toBe(true);
    });

    it('should return false when the key is invalid', async () => {
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
      expect(results).toEqual([[ID1, EVENT1], [ID2, EVENT2_FULL]]);
    });
  });

  describe('query', () => {
    const TYPE3 = 'EVENT_DELETED';
    const ID4 = new MockId(new Uint8Array([3, 4]));
    const ID5 = new MockId(new Uint8Array([3, 5]));
    const ID6 = new MockId(new Uint8Array([4, 6]));
    const ID7 = new MockId(new Uint8Array([1, 7]));
    const EVENT3 = { type: TYPE1, payload: 3, id: ID3, link: [], time: 33 } satisfies MockEvent;
    const EVENT4 = { type: TYPE2, payload: 4, id: ID4, link: [ID3], root: ID3, time: 44 } satisfies MockEvent;
    const EVENT5 = { type: TYPE2, payload: 5, id: ID5, link: [ID3], root: ID3, time: 55 } satisfies MockEvent;
    const EVENT6 = { type: TYPE2, payload: 6, id: ID6, link: [ID4], root: ID3, time: 66 } satisfies MockEvent;
    const EVENT7 = { type: TYPE3, payload: 7, id: ID7, link: [ID2], root: ID1, time: 77 } satisfies MockEvent;

    beforeEach(async () => {
      await store.put(EVENT3);
    });

    it.each([
      [{ type: TYPE1 }, [EVENT1, EVENT3], false],
      [{ type: TYPE2 }, [EVENT2_FULL], false],
      [{ type: 'EVENT' }, [EVENT1, EVENT2_FULL, EVENT3], false],
      [{ type: 'EVENT', limit: 2 }, [EVENT1, EVENT2_FULL], true],
      [{ type: TYPE1, head: true }, [EVENT3], false],
      [{ root: ID1 }, [EVENT1, EVENT2_FULL], false],
      [{ root: ID1, type: TYPE1 }, [EVENT1], false],
      [{ root: ID1, type: TYPE1, head: true }, [], false],
      [{ root: ID1, type: 'EVENT', head: true }, [EVENT2_FULL], false],
      [{ head: true }, [EVENT5, EVENT6, EVENT7], true],
      [{ head: true, limit: 2 }, [EVENT5, EVENT6], true],
      [{ since: [ID3] }, [EVENT4, EVENT5, EVENT6, EVENT7], true],
      [{ since: [ID3], limit: 3 }, [EVENT4, EVENT5, EVENT6], true],
      [{ type: TYPE2, since: [ID4] }, [EVENT5, EVENT6], true],
      [{ root: ID1, type: 'EVENT', since: [ID2] }, [EVENT7], true],
      [{ since: [ID3], head: true, type: TYPE2 }, [EVENT5, EVENT6], true],
      [{ since: [ID3], head: true, type: TYPE2, root: ID1 }, [], true],
    ])('should return values matching the query options %#: %j', async (options, expectedResults, extraEvents) => {
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
      expect(result.value).toEqual(expectedResults.length ? [expectedResults[expectedResults.length - 1].id] : []);
    });

    async function putExtraEvents() {
      await store.put(EVENT4);
      await store.put(EVENT5);
      await store.put(EVENT6);
      await store.put(EVENT7);
    }
  });
});
