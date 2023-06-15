import { BTreeMap } from '@mithic/collections';
import { ORMap, ORMapCommand, ORMapEventType, ORMapQuery } from '../map.js';
import { MockId } from '../../__tests__/mocks.js';
import { getEventIndexKey, getFieldValueKey, getHeadIndexKey } from '../keys.js';
import { ErrorCode, operationError } from '@mithic/commons';

type V = string | number | boolean | null;

const NAME = 'abc';
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
const CMD_NEW = { name: NAME, set: { [FIELD0]: VALUE0 }, createdAt: 1 };
const CMD_WITH_FIELDS = { name: NAME, set: { [FIELD1]: VALUE1, [FIELD2]: VALUE2 }, createdAt: 2 };
const CMD_WITH_FIELDS2 = { name: NAME, set: { [FIELD3]: VALUE3 }, createdAt: 3 };
const CMD_WITH_UPDEL = { name: NAME, set: { [FIELD1]: new MockId(), [FIELD2]: VALUE22, [FIELD3]: VALUE32 }, createdAt: 4 };
const CMD_WITH_FIELDS_CONCURRENT = { name: NAME, set: { [FIELD1]: VALUE12 }, createdAt: 5 };

describe(ORMap.name, () => {
  let map: ORMap<MockId, V>;
  let store: BTreeMap<string, MockId | V>;

  beforeEach(() => {
    map = new ORMap({
      eventRef: (event) => new MockId(new Uint8Array(event.meta.createdAt || 0)),
      voidRef: () => new MockId(),
    });
    store = map['store'] as BTreeMap<string, MockId | V>;
  });

  describe('command', () => {
    it('should throw for empty command', async () => {
      await expect(() => map.command({ name: NAME, set: {}, createdAt: 1 }))
        .rejects.toEqual(operationError('Empty operation', ErrorCode.InvalidArg));
    });

    it('should return valid event for new map command', async () => {
      const event = await map.command(CMD_WITH_FIELDS);
      expect(event).toEqual({
        type: ORMapEventType.Set,
        payload: {
          name: NAME, set: [
            [FIELD1, VALUE1],
            [FIELD2, VALUE2]
          ]
        },
        meta: { parents: [], createdAt: 2 },
      });
    });

    it('should return valid event for set map command with dependency', async () => {
      await applyCommand(CMD_WITH_FIELDS);
      await applyCommand(CMD_WITH_FIELDS2);
      const event = await map.command(CMD_WITH_UPDEL);
      expect(event).toEqual({
        type: ORMapEventType.Set,
        payload: {
          name: NAME, set: [
            [FIELD1, new MockId(), 0],
            [FIELD2, VALUE22, 0],
            [FIELD3, VALUE32, 1],
          ]
        },
        meta: {
          parents: [new MockId(new Uint8Array(2)), new MockId(new Uint8Array(3))],
          root: new MockId(new Uint8Array(2)),
          createdAt: 4
        },
      });
    });

    it('should ignore delete operation if field does not already exist', async () => {
      await applyCommand(CMD_WITH_FIELDS2);
      const event = await map.command(CMD_WITH_UPDEL);
      expect(event).toEqual({
        type: ORMapEventType.Set,
        payload: {
          name: NAME, set: [
            [FIELD2, VALUE22],
            [FIELD3, VALUE32, 0],
          ]
        },
        meta: {
          parents: [new MockId(new Uint8Array(3))],
          root: new MockId(new Uint8Array(3)),
          createdAt: 4
        },
      });
    });
  });

  describe('validate', () => {
    it('should return no error for valid events', async () => {
      expect(await map.validate(await map.command(CMD_NEW))).toBeUndefined();
      expect(await map.validate(await map.command(CMD_WITH_FIELDS))).toBeUndefined();
    });

    it('should return error for malformed events', async () => {
      expect(await map.validate({
        type: 'ERR' as ORMapEventType.Set,
        payload: { name: NAME, set: [] }, meta: { parents: [], createdAt: 1 },
      })).toEqual(operationError('Unsupported event type', ErrorCode.UnsupportedOp));

      expect(await map.validate({
        type: ORMapEventType.Set, payload: { name: NAME, set: [] },
        meta: { parents: [], root: new MockId(new Uint8Array(1)), createdAt: 2 },
      })).toEqual(operationError('Empty operation', ErrorCode.InvalidArg));

      expect(await map.validate({
        type: ORMapEventType.Set,
        payload: { name: NAME, set: [['', true]] },
        meta: { parents: [], root: new MockId(new Uint8Array(1)), createdAt: 2 },
      })).toEqual(operationError(`Invalid field operation: ""`, ErrorCode.InvalidArg));

      expect(await map.validate({
        type: ORMapEventType.Set,
        payload: { name: NAME, set: [['field', new MockId()]] },
        meta: { parents: [], root: new MockId(new Uint8Array(1)), createdAt: 2 },
      })).toEqual(operationError(`Invalid field operation: "field"`, ErrorCode.InvalidArg));

      expect(await map.validate({
        type: ORMapEventType.Set,
        payload: { name: NAME, set: [['field', true, 0]] },
        meta: { parents: [], root: new MockId(new Uint8Array(1)), createdAt: 2 },
      })).toEqual(operationError(`Invalid field operation: "field"`, ErrorCode.InvalidArg));
    });

    it('should return error for missing dependent events', async () => {
      expect(await map.validate({
        type: ORMapEventType.Set,
        payload: { name: NAME, set: [['field', true, 0]] },
        meta: { parents: [new MockId(new Uint8Array(2))], root: new MockId(new Uint8Array(1)), createdAt: 2 },
      })).toEqual(operationError('Missing dependencies', ErrorCode.MissingDep, [new MockId(new Uint8Array(2)), new MockId(new Uint8Array(1))]));
    });
  });

  describe('apply', () => {
    it('should save new map with fields correctly', async () => {
      await applyCommand(CMD_WITH_FIELDS);

      expect(store.size).toEqual(6);
      const expectedEventRef = new MockId(new Uint8Array(2));
      expect(store.get(getEventIndexKey(expectedEventRef.toString()))).toEqual(2);
      expect(store.get(getHeadIndexKey(NAME))).toEqual(expectedEventRef);
      expect(store.get(getHeadIndexKey(NAME, FIELD1, expectedEventRef.toString()))).toEqual(expectedEventRef);
      expect(store.get(getHeadIndexKey(NAME, FIELD2, expectedEventRef.toString()))).toEqual(expectedEventRef);
      expect(store.get(getFieldValueKey(NAME, FIELD1, expectedEventRef.toString()))).toEqual(VALUE1);
      expect(store.get(getFieldValueKey(NAME, FIELD2, expectedEventRef.toString()))).toEqual(VALUE2);
    });

    it('should keep concurrent updates', async () => {
      await applyCommand(CMD_NEW); // 4 store entries
      const cmd1 = await map.command(CMD_WITH_FIELDS); // 5 store entries
      const cmd2 = await map.command(CMD_WITH_FIELDS_CONCURRENT); // 3 store entries
      await map.apply(cmd1);
      await map.apply(cmd2);
      const eventRef1 = new MockId(new Uint8Array(CMD_WITH_FIELDS.createdAt));
      const eventRef2 = new MockId(new Uint8Array(CMD_WITH_FIELDS_CONCURRENT.createdAt));

      expect(store.size).toEqual(12);

      expect(store.get(getHeadIndexKey(NAME, FIELD1, eventRef1.toString()))).toEqual(eventRef1);
      expect(store.get(getHeadIndexKey(NAME, FIELD1, eventRef2.toString()))).toEqual(eventRef2);
      expect(store.get(getFieldValueKey(NAME, FIELD1, eventRef1.toString()))).toEqual(VALUE1);
      expect(store.get(getFieldValueKey(NAME, FIELD1, eventRef2.toString()))).toEqual(VALUE12);
    });

    it('should resolve concurrent values on update', async () => {
      await applyCommand(CMD_NEW); // 4 store entries
      const cmd1 = await map.command(CMD_WITH_FIELDS); // 5 store entries
      const cmd2 = await map.command(CMD_WITH_FIELDS_CONCURRENT); // 3 store entries
      await map.apply(cmd1);
      await map.apply(cmd2);
      await applyCommand(CMD_WITH_UPDEL); // +5 -4 -2 store entries
      const eventRef1 = new MockId(new Uint8Array(CMD_WITH_FIELDS.createdAt));
      const eventRef2 = new MockId(new Uint8Array(CMD_WITH_FIELDS_CONCURRENT.createdAt));
      const eventRef3 = new MockId(new Uint8Array(CMD_WITH_UPDEL.createdAt));

      expect(store.size).toEqual(11);

      expect(store.get(getHeadIndexKey(NAME, FIELD1, eventRef1.toString()))).toBeUndefined();
      expect(store.get(getHeadIndexKey(NAME, FIELD1, eventRef2.toString()))).toBeUndefined();
      expect(store.get(getFieldValueKey(NAME, FIELD1, eventRef1.toString()))).toBeUndefined();
      expect(store.get(getFieldValueKey(NAME, FIELD1, eventRef2.toString()))).toBeUndefined();

      expect(store.get(getHeadIndexKey(NAME, FIELD2, eventRef1.toString()))).toBeUndefined();
      expect(store.get(getHeadIndexKey(NAME, FIELD2, eventRef3.toString()))).toEqual(eventRef3);
      expect(store.get(getFieldValueKey(NAME, FIELD2, eventRef1.toString()))).toBeUndefined();
      expect(store.get(getFieldValueKey(NAME, FIELD2, eventRef3.toString()))).toEqual(VALUE22);
    });

    it('should throw error for malformed events when validate = true', async () => {
      await expect(() => map.apply({
        type: 'ERR' as ORMapEventType.Set,
        payload: { name: NAME, set: [] }, meta: { parents: [], createdAt: 1 },
      })).rejects.toEqual(operationError('Unsupported event type', ErrorCode.UnsupportedOp));
    });

    it('should try to process malformed events without validation when validate = false', async () => {
      await map.apply({
        type: 'ERR' as ORMapEventType.Set,
        payload: {
          name: NAME, set: [
            [FIELD1, VALUE1],
            [FIELD2, VALUE2]
          ]
        },
        meta: { parents: [], createdAt: 2 },
      }, { validate: false });
      expect(store.size).toEqual(6);
    });
  });

  describe('query', () => {
    it('should return empty result for empty maps', async () => {
      await applyCommand();
      for await (const _ of map.query({ name: 'unknown' })) {
        throw new Error('should not be called');
      }
    });

    it.each([
      [[CMD_WITH_FIELDS], {}, [[FIELD1, VALUE1], [FIELD2, VALUE2]] as const],
      [[CMD_WITH_FIELDS, CMD_WITH_FIELDS2], {}, [[FIELD1, VALUE1], [FIELD2, VALUE2], [FIELD3, VALUE3]] as const],
      [[CMD_WITH_FIELDS, CMD_WITH_FIELDS2], { limit: 2 }, [[FIELD1, VALUE1], [FIELD2, VALUE2]] as const],
      [[CMD_WITH_FIELDS, CMD_WITH_FIELDS2], { limit: 2, reverse: true }, [[FIELD3, VALUE3], [FIELD2, VALUE2]] as const],
      [[CMD_WITH_FIELDS, CMD_WITH_FIELDS2], { gte: FIELD2, lte: FIELD2 }, [[FIELD2, VALUE2]] as const],
    ])(
      'should return correct results for non-empty maps',
      async (cmds: ORMapCommand<MockId, V>[], query: ORMapQuery, expected: readonly (readonly [string, V])[]) => {
        for (const cmd of cmds) {
          await applyCommand(cmd);
        }
        const results = [];
        for await (const entry of map.query({ name: CMD_WITH_FIELDS.name, ...query })) {
          results.push(entry);
        }
        expect(results).toEqual(expected);
      }
    );

    it('should return concurrent values when lww = false', async () => {
      await applyCommand(CMD_NEW);
      const event1 = await map.command(CMD_WITH_FIELDS);
      const event2 = await map.command(CMD_WITH_UPDEL);
      await map.apply(event1);
      await map.apply(event2);

      const results = [];
      for await (const entry of map.query({ name: CMD_WITH_FIELDS.name })) {
        results.push(entry);
      }
      expect(results).toEqual([
        [FIELD0, VALUE0], [FIELD1, VALUE1],
        [FIELD2, VALUE2], [FIELD2, VALUE22],
        [FIELD3, VALUE32]
      ]);
    });

    it('should return LWW values when lww = true', async () => {
      await applyCommand(CMD_NEW);
      const event1 = await map.command(CMD_WITH_FIELDS);
      const event2 = await map.command(CMD_WITH_UPDEL);
      await map.apply(event1);
      await map.apply(event2);

      const results = [];
      for await (const entry of map.query({ name: CMD_WITH_FIELDS.name, gte: FIELD1, lte: FIELD3, lww: true })) {
        results.push(entry);
      }
      expect(results).toEqual([[FIELD1, VALUE1], [FIELD2, VALUE22], [FIELD3, VALUE32]]);
    });
  });

  async function applyCommand(cmd: ORMapCommand<MockId, V> = CMD_NEW) {
    await map.apply(await map.command(cmd));
  }
});
