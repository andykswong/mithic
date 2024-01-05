import { beforeEach, describe, expect, it } from '@jest/globals';
import { BTreeMap } from '@mithic/collections';
import { ERR_DEPENDENCY_MISSING, OperationError } from '@mithic/commons';
import { EntityAttrKey, MapTripleStore } from '@mithic/triplestore';
import { DefaultEntityStore, EntityStore } from '../../store.js';
import { EntityEventType, EntityProjection, EntityEvent } from '../interface.js';
import { OREntityProjection } from '../event.js';
import { MockId, getMockEventKey } from '../../__tests__/mocks.js';

type V = string | number | boolean;

const TYPE = 'ormap';
const ROOT = new MockId(new Uint8Array(1));
const FIELD0 = 'field0';
const FIELD1 = 'field1';
const FIELD2 = 'field2';
const VALUE0 = 'v0';
const VALUE1 = 'v1';
const VALUE2 = 123;
const VALUE3 = 'v2';
const VALUE4 = 456;

const EVENT_NEW_EMPTY = {
  type: EntityEventType.New, nonce: '1',
  payload: { ops: [], type: TYPE }
} satisfies EntityEvent<MockId, V>;
const EVENT_NEW = {
  type: EntityEventType.New, nonce: '1',
  payload: { ops: [[FIELD0, `${VALUE0}`, VALUE0]], type: TYPE }
} satisfies EntityEvent<MockId, V>;
const EVENT_UPDATE = {
  type: EntityEventType.Update, nonce: '3', root: ROOT,
  payload: { ops: [[FIELD1, `${VALUE1}`, VALUE1], [FIELD2, `${VALUE2}`, VALUE2]], type: TYPE }
} satisfies EntityEvent<MockId, V>;
const EVENT_UPDEL = {
  type: EntityEventType.Update, nonce: '5', root: ROOT,
  payload: {
    ops: [[FIELD0, `${VALUE0}`, null, 0], [FIELD1, `${VALUE3}`, VALUE3], [FIELD2, `${VALUE2}`, VALUE4, 1]],
    type: TYPE
  },
  link: [getMockEventKey(EVENT_NEW), getMockEventKey(EVENT_UPDATE)]
} satisfies EntityEvent<MockId, V>;

describe(OREntityProjection.name, () => {
  let dataMap: BTreeMap<EntityAttrKey<MockId>, V>;
  let store: MapTripleStore<MockId, V>;
  let state: EntityStore<MockId, V>;
  let projection: EntityProjection<MockId, V>;

  beforeEach(() => {
    store = new MapTripleStore();
    dataMap = store['data'] as BTreeMap<EntityAttrKey<MockId>, V>;
    state = new DefaultEntityStore<MockId, V>((type) => {
      expect(type).toBe(TYPE);
      return store;
    });
    projection = new OREntityProjection(getMockEventKey);
  });

  describe('validate', () => {
    it('should return no error for valid events', async () => {
      expect(await projection.validate(state, EVENT_NEW_EMPTY)).toBeUndefined();
      await applyEvents(EVENT_NEW);
      expect(await projection.validate(state, EVENT_UPDATE)).toBeUndefined();
    });

    it('should return error for malformed events', async () => {
      expect(await projection.validate(state, {
        type: EntityEventType.Update, payload: { ops: [] },
        link: [], root: ROOT,
      })).toEqual(new TypeError('empty operation'));

      expect(await projection.validate(state, {
        type: EntityEventType.Update,
        payload: { ops: [['field', `true`, true]] },
        link: [],
      })).toEqual(new TypeError('missing root'));

      expect(await projection.validate(state, {
        type: EntityEventType.Update,
        payload: { ops: [['', `true`, true]] },
        link: [], root: ROOT,
      })).toEqual(new TypeError(`invalid operation: ""`));

      expect(await projection.validate(state, {
        type: EntityEventType.Update,
        payload: { ops: [['field', `true`, true, 0]] },
        link: [], root: ROOT,
      })).toEqual(new TypeError(`invalid operation: "field"`));
    });

    it('should return error for missing dependent events', async () => {
      const missingLink = new MockId(new Uint8Array(2));
      const error = await projection.validate(state, {
        type: EntityEventType.Update,
        payload: { ops: [['field', `true`, true, 0]], type: TYPE },
        link: [missingLink], root: ROOT,
      });

      expect(error instanceof OperationError).toBeTruthy();
      expect((error as OperationError).code).toBe(ERR_DEPENDENCY_MISSING);
      expect((error as OperationError).detail).toEqual([missingLink]);
    });
  });

  describe('reduce', () => {
    it('should add new triples correctly', async () => {
      const eventKey = getMockEventKey(EVENT_UPDATE);

      await applyEvents(EVENT_NEW_EMPTY);
      expect(dataMap.size).toEqual(0);

      await applyEvents(EVENT_UPDATE);
      expect(dataMap.size).toEqual(2);
      expect(dataMap.get([ROOT, FIELD1, `${VALUE1}`, eventKey])).toEqual(VALUE1);
      expect(dataMap.get([ROOT, FIELD2, `${VALUE2}`, eventKey])).toEqual(VALUE2);
    });

    it('should upsert or delete triples correctly', async () => {
      const event1Key = getMockEventKey(EVENT_UPDATE);
      const event2Key = getMockEventKey(EVENT_UPDEL);

      await applyEvents(EVENT_NEW);
      await applyEvents(EVENT_UPDATE);
      await applyEvents(EVENT_UPDEL);

      expect(dataMap.size).toEqual(3);
      expect(dataMap.get([ROOT, FIELD1, `${VALUE1}`, event1Key])).toEqual(VALUE1);
      expect(dataMap.get([ROOT, FIELD1, `${VALUE3}`, event2Key])).toEqual(VALUE3);
      expect(dataMap.get([ROOT, FIELD2, `${VALUE2}`, event2Key])).toEqual(VALUE4);
    });

    it('should throw error for malformed events', async () => {
      await expect(projection.reduce(state, {
        type: EntityEventType.Update,
        payload: { ops: [], type: TYPE }, link: [],
      })).rejects.toEqual(new TypeError('missing root'));
    });
  });

  async function applyEvents(...events: EntityEvent<MockId, V>[]) {
    for (const event of events) {
      await projection.reduce(state, event);
    }
  }
});
