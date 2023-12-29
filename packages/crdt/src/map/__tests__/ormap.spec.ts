import { BTreeMap } from '@mithic/collections';
import { ERR_DEPENDENCY_MISSING, OperationError } from '@mithic/commons';
import { EntityFieldKey, EntityStore, MapEntityStore } from '../../store/index.js';
import { MapCommand, MapEventType, MapRangeQuery, MapCommandType, MapEvent, MapCommandHandler, MapProjection, MapRangeQueryResolver } from '../map.js';
import { ORMapCommandHandler, ORMapProjection, ORMapRangeQueryResolver } from '../ormap.js';
import { MockId, getMockEventKey } from '../../__tests__/mocks.js';

type V = string | number | boolean;

const ROOT = new MockId(new Uint8Array(1));
const FIELD0 = 'field0';
const FIELD1 = 'field1';
const FIELD2 = 'field2';
const FIELD3 = 'field3';
const VALUE0 = 'v0';
const VALUE1 = 'v1';
const VALUE12 = 'v2';
const VALUE2 = 123;
const VALUE22 = 456;
const VALUE3 = true;
const VALUE32 = false;
const CMD_EMPTY = { type: MapCommandType.Update, payload: { put: {} }, nonce: '1' } satisfies MapCommand<MockId, V>;
const CMD_NEW = { type: MapCommandType.Update, payload: { put: { [FIELD0]: VALUE0 } }, nonce: '1' } satisfies MapCommand<MockId, V>;
const CMD_WITH_FIELDS = { type: MapCommandType.Update, payload: { put: { [FIELD1]: VALUE1, [FIELD2]: VALUE2 } }, root: ROOT, nonce: '3' } satisfies MapCommand<MockId, V>;
const CMD_WITH_FIELDS2 = { type: MapCommandType.Update, payload: { put: { [FIELD3]: VALUE3 } }, root: ROOT, nonce: '4' } satisfies MapCommand<MockId, V>;
const CMD_WITH_UPDEL = { type: MapCommandType.Update, payload: { put: { [FIELD2]: VALUE22, [FIELD3]: VALUE32 }, del: [FIELD1, FIELD2, FIELD3] }, root: ROOT, nonce: '5' } satisfies MapCommand<MockId, V>;
const CMD_WITH_FIELDS_CONCURRENT = { type: MapCommandType.Update, payload: { put: { [FIELD1]: VALUE12 }, del: [FIELD1] }, root: ROOT, nonce: '6' } satisfies MapCommand<MockId, V>;

describe('ORMap', () => {
  let dataMap: BTreeMap<EntityFieldKey<MockId>, V>;
  let store: EntityStore<MockId, V>;
  let command: MapCommandHandler<MockId, V>;
  let projection: MapProjection<MockId, V>;

  beforeEach(() => {
    const mapStore = store = new MapEntityStore();
    dataMap = mapStore['data'] as BTreeMap<EntityFieldKey<MockId>, V>;
    command = new ORMapCommandHandler();
    projection = new ORMapProjection(getMockEventKey);
  });

  describe(ORMapCommandHandler.name, () => {
    it('should return valid event for new empty map command', async () => {
      const event = await command.handle(store, CMD_EMPTY);
      expect(event).toEqual({
        type: MapEventType.New,
        payload: { set: [] },
        link: [],
        nonce: CMD_EMPTY.nonce,
      } satisfies MapEvent<MockId, V>);
    });

    it('should return undefined for empty set command', async () => {
      expect(await command.handle(store, { type: MapCommandType.Update, payload: { put: {} }, root: ROOT, nonce: '1' }))
        .toBeUndefined();
    });

    it('should return valid event for new map command', async () => {
      const event = await command.handle(store, CMD_NEW);
      expect(event).toEqual({
        type: MapEventType.New,
        payload: {
          set: [[FIELD0, VALUE0]],
        },
        link: [],
        nonce: CMD_NEW.nonce,
      } satisfies MapEvent<MockId, V>);
    });

    it('should return valid event for update map command', async () => {
      const event = await command.handle(store, CMD_WITH_FIELDS);
      expect(event).toEqual({
        type: MapEventType.Update,
        payload: {
          set: [
            [FIELD1, VALUE1],
            [FIELD2, VALUE2]
          ]
        },
        link: [],
        root: ROOT,
        nonce: CMD_WITH_FIELDS.nonce,
      } satisfies MapEvent<MockId, V>);
    });

    it('should return valid event for update map command with dependency', async () => {
      for await (const error of store.setMany([
        [[ROOT, FIELD1, getMockEventKey(CMD_WITH_FIELDS)], VALUE1],
        [[ROOT, FIELD2, getMockEventKey(CMD_WITH_FIELDS)], VALUE2],
        [[ROOT, FIELD3, getMockEventKey(CMD_WITH_FIELDS2)], VALUE3],
      ])) {
        expect(error).toBeUndefined();
      }

      const event = await command.handle(store, CMD_WITH_UPDEL);
      expect(event).toEqual({
        type: MapEventType.Update,
        payload: {
          set: [
            [FIELD1, null, 0],
            [FIELD2, VALUE22, 0],
            [FIELD3, VALUE32, 1],
          ]
        },
        link: [getMockEventKey(CMD_WITH_FIELDS), getMockEventKey(CMD_WITH_FIELDS2)],
        root: ROOT,
        nonce: CMD_WITH_UPDEL.nonce,
      } satisfies MapEvent<MockId, V>);
    });

    it('should ignore delete operation if field does not already exist', async () => {
      await applyCommand(CMD_WITH_FIELDS2);
      const event = await command.handle(store, CMD_WITH_UPDEL);
      expect(event).toEqual({
        type: MapEventType.Update,
        payload: {
          set: [
            [FIELD2, VALUE22],
            [FIELD3, VALUE32, 0],
          ]
        },
        link: [getMockEventKey(CMD_WITH_FIELDS2)],
        root: ROOT,
        nonce: CMD_WITH_UPDEL.nonce,
      } satisfies MapEvent<MockId, V>);
    });
  });

  describe(ORMapProjection.name, () => {
    describe('validate', () => {
      it('should return no error for valid events', async () => {
        expect(await projection.validate(store, (await command.handle(store, CMD_NEW))!)).toBeUndefined();
        await applyCommand(CMD_NEW);
        expect(await projection.validate(store, (await command.handle(store, CMD_WITH_FIELDS))!)).toBeUndefined();
      });

      it('should return error for malformed events', async () => {
        expect(await projection.validate(store, {
          type: MapEventType.Update, payload: { set: [] },
          link: [], root: ROOT,
        })).toEqual(new TypeError('empty operation'));

        expect(await projection.validate(store, {
          type: MapEventType.Update,
          payload: { set: [['field', true]] },
          link: [],
        })).toEqual(new TypeError('missing root'));

        expect(await projection.validate(store, {
          type: MapEventType.Update,
          payload: { set: [['', true]] },
          link: [], root: ROOT,
        })).toEqual(new TypeError(`invalid operation: ""`));

        expect(await projection.validate(store, {
          type: MapEventType.Update,
          payload: { set: [['field', true, 0]] },
          link: [], root: ROOT,
        })).toEqual(new TypeError(`invalid operation: "field"`));
      });

      it('should return error for missing dependent events', async () => {
        const missingLink = new MockId(new Uint8Array(2));
        const error = await projection.validate(store, {
          type: MapEventType.Update,
          payload: { set: [['field', true, 0]] },
          link: [missingLink], root: ROOT,
        });

        expect(error instanceof OperationError).toBeTruthy();
        expect((error as OperationError).code).toBe(ERR_DEPENDENCY_MISSING);
        expect((error as OperationError).detail).toEqual([missingLink]);
      });
    });

    describe('reduce', () => {
      it('should save new map with fields correctly', async () => {
        await applyCommand();
        expect(dataMap.size).toEqual(0);

        await applyCommand(CMD_WITH_FIELDS);
        const eventKey = getMockEventKey(CMD_WITH_FIELDS);
        expect(dataMap.size).toEqual(2);
        expect(dataMap.get([ROOT, FIELD1, eventKey])).toEqual(VALUE1);
        expect(dataMap.get([ROOT, FIELD2, eventKey])).toEqual(VALUE2);
      });

      it('should keep concurrent updates', async () => {
        const event1 = await command.handle(store, CMD_WITH_FIELDS);
        const event2 = await command.handle(store, CMD_WITH_FIELDS_CONCURRENT);
        const event0Key = getMockEventKey(CMD_NEW);
        const event1Key = getMockEventKey(CMD_WITH_FIELDS);
        const event2Key = getMockEventKey(CMD_WITH_FIELDS_CONCURRENT);

        await applyCommand(CMD_NEW);
        await projection.reduce(store, event1!);
        await projection.reduce(store, event2!);

        expect(dataMap.size).toEqual(4);
        expect(dataMap.get([ROOT, FIELD0, event0Key])).toEqual(VALUE0);
        expect(dataMap.get([ROOT, FIELD1, event1Key])).toEqual(VALUE1);
        expect(dataMap.get([ROOT, FIELD1, event2Key])).toEqual(VALUE12);
        expect(dataMap.get([ROOT, FIELD2, event1Key])).toEqual(VALUE2);
      });

      it('should delete all concurrent values on update', async () => {
        const event1 = await command.handle(store, CMD_WITH_FIELDS);
        const event2 = await command.handle(store, CMD_WITH_FIELDS_CONCURRENT);
        const event3Key = getMockEventKey(CMD_WITH_UPDEL);

        await projection.reduce(store, event1!);
        await projection.reduce(store, event2!);
        await applyCommand(CMD_WITH_UPDEL);

        expect(dataMap.size).toEqual(2);
        expect(dataMap.get([ROOT, FIELD2, event3Key])).toEqual(VALUE22);
        expect(dataMap.get([ROOT, FIELD3, event3Key])).toEqual(VALUE32);
      });

      it('should throw error for malformed events', async () => {
        await expect(projection.reduce(store, {
          type: MapEventType.Update,
          payload: { set: [] }, link: [],
        })).rejects.toEqual(new TypeError('missing root'));
      });
    });
  });

  describe(ORMapRangeQueryResolver.name, () => {
    let resolver: MapRangeQueryResolver<MockId, V>;

    beforeEach(() => {
      resolver = new ORMapRangeQueryResolver();
    })

    it('should return empty result for empty / undefined maps', async () => {
      await applyCommand();
      for await (const _ of resolver.resolve(store, { root: ROOT })) {
        throw new Error('should not be called');
      }
    });

    it.each(
      [
        [[CMD_WITH_FIELDS], { root: ROOT }, [[FIELD1, VALUE1], [FIELD2, VALUE2]]],
        [[CMD_WITH_FIELDS, CMD_WITH_FIELDS2], { root: ROOT }, [[FIELD1, VALUE1], [FIELD2, VALUE2], [FIELD3, VALUE3]]],
        [[CMD_WITH_FIELDS, CMD_WITH_FIELDS2], { root: ROOT, limit: 2 }, [[FIELD1, VALUE1], [FIELD2, VALUE2]]],
        [[CMD_WITH_FIELDS, CMD_WITH_FIELDS2], { root: ROOT, limit: 2, reverse: true }, [[FIELD3, VALUE3], [FIELD2, VALUE2]]],
        [[CMD_WITH_FIELDS, CMD_WITH_FIELDS2], { root: ROOT, lower: FIELD2, upper: FIELD2, upperOpen: false }, [[FIELD2, VALUE2]]],
      ] satisfies [MapCommand<MockId, V>[], MapRangeQuery<MockId, V>, [string, V][]][]
    )('should return correct results for non-empty maps %#', async (cmds, query, expected) => {
      await applyCommand();
      for (const cmd of cmds) {
        await applyCommand(cmd);
      }
      const results = [];
      for await (const entry of resolver.resolve(store, query)) {
        results.push(entry);
      }
      expect(results).toEqual(expected);
    });

    it('should return concurrent values', async () => {
      await applyCommand(CMD_NEW);
      const event1 = await command.handle(store, CMD_WITH_FIELDS);
      const event2 = await command.handle(store, CMD_WITH_UPDEL);
      await projection.reduce(store, event1!);
      await projection.reduce(store, event2!);

      const results = [];
      for await (const entry of resolver.resolve(store, { root: ROOT })) {
        results.push(entry);
      }
      expect(results).toEqual([
        [FIELD0, VALUE0], [FIELD1, VALUE1], [FIELD2, VALUE2], [FIELD2, VALUE22], [FIELD3, VALUE32]
      ]);
    });
  });

  async function applyCommand(cmd: MapCommand<MockId, V> = CMD_EMPTY) {
    return await projection.reduce(store, (await command.handle(store, cmd))!);
  }
});
