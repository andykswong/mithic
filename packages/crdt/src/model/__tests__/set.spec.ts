import { BTreeMap } from '@mithic/collections';
import { ORSet, ORSetCommand, ORSetEventType, ORSetQuery } from '../set.js';
import { MockId } from '../../__tests__/mocks.js';
import { ErrorCode, operationError } from '@mithic/commons';
import { getEventIndexKey, getFieldValueKey, getHeadIndexKey } from '../keys.js';

type V = string | number | boolean;

const ROOT = new MockId(new Uint8Array(1));
const VALUE0 = 'v0';
const VALUE1 = 'v1';
const VALUE2 = 123;
const VALUE3 = true;
const CMD_EMPTY = { createdAt: 1 };
const CMD_NEW = { add: [VALUE0], nounce: 123, createdAt: 1 };
const CMD_ADD = { ref: ROOT, add: [VALUE1, VALUE2], createdAt: 2 };
const CMD_ADD_CONCURRENT = { ref: ROOT, add: [VALUE2, VALUE3], createdAt: 3 };
const CMD_DEL = { ref: ROOT, add: [VALUE1], del: [VALUE2], createdAt: 4 };

describe(ORSet.name, () => {
  let set: ORSet<MockId, V>;
  let store: BTreeMap<string, MockId | V>;

  beforeEach(() => {
    set = new ORSet({
      eventRef: (event) => new MockId(new Uint8Array(event.meta.createdAt || 0)),
      stringify: (value) => `${value}`,
    });
    store = set['store'] as BTreeMap<string, MockId | V>;
  });

  describe('query', () => {
    it('should return empty result for empty / undefined sets', async () => {
      await applyCommand();
      for await (const _ of set.query({ ref: ROOT })) {
        throw new Error('should not be called');
      }
    });

    it.each([
      [[CMD_ADD], { ref: ROOT }, [VALUE2, VALUE1] as const],
      [[CMD_ADD, CMD_ADD_CONCURRENT], { ref: ROOT }, [VALUE2, VALUE3, VALUE1] as const],
      [[CMD_ADD, CMD_ADD_CONCURRENT], { ref: ROOT, limit: 2 }, [VALUE2, VALUE3] as const],
      [[CMD_ADD, CMD_ADD_CONCURRENT], { ref: ROOT, limit: 2, reverse: true }, [VALUE1, VALUE3] as const],
      [[CMD_ADD, CMD_ADD_CONCURRENT, CMD_DEL], { ref: ROOT, gte: VALUE2, lte: VALUE1 }, [VALUE3, VALUE1] as const],
    ])(
      'should return correct results for non-empty sets',
      async (cmds: ORSetCommand<MockId, V>[], query: ORSetQuery<MockId, V>, expected: readonly V[]) => {
        await applyCommand();
        for (const cmd of cmds) {
          await applyCommand(cmd);
        }
        const results = [];
        for await (const entry of set.query(query)) {
          results.push(entry);
        }
        expect(results).toEqual(expected);
      }
    );

    it('should return unique values on concurrent updates', async () => {
      await applyCommand();
      const concurrentEvent = await set.command(CMD_ADD_CONCURRENT);
      await applyCommand(CMD_ADD);
      await set.apply(concurrentEvent);

      const results = [];
      for await (const entry of set.query({ ref: ROOT })) {
        results.push(entry);
      }
      expect(results).toEqual([VALUE2, VALUE3, VALUE1]);
    });
  });
  
  describe('command', () => {
    beforeEach(async () => {
      await applyCommand();
    });

    it('should return valid event for new empty set command', async () => {
      const event = await set.command(CMD_EMPTY);
      expect(event).toEqual({
        type: ORSetEventType.New,
        payload: { ops: [] },
        meta: { parents: [], createdAt: 1 },
      });
    });

    it('should return valid event for new set command', async () => {
      const event = await set.command(CMD_NEW);
      expect(event).toEqual({
        type: ORSetEventType.New,
        payload: {
          ops: [[VALUE0]],
          nounce: 123,
        },
        meta: { parents: [], createdAt: 1 },
      });
    });

    it('should return valid event for set set command', async () => {
      const event = await set.command(CMD_ADD);
      expect(event).toEqual({
        type: ORSetEventType.Update,
        payload: {
          ops: [[VALUE1], [VALUE2]]
        },
        meta: { parents: [], root: ROOT, createdAt: 2 },
      });
    });

    it('should return valid event for set delete command', async () => {
      const concurrentEvent = await set.command(CMD_ADD_CONCURRENT);
      await applyCommand(CMD_ADD);
      await set.apply(concurrentEvent);
      const event = await set.command(CMD_DEL);
      expect(event).toEqual({
        type: ORSetEventType.Update,
        payload: {
          ops: [[VALUE2, 0, 1]]
        },
        meta: {
          parents: [new MockId(new Uint8Array(2)), new MockId(new Uint8Array(3))],
          root: ROOT, createdAt: 4
        },
      });
    });

    it('should ignore delete operation if field does not already exist', async () => {
      await applyCommand(CMD_NEW);
      const event = await set.command(CMD_DEL);
      expect(event).toEqual({
        type: ORSetEventType.Update,
        payload: {
          ops: [[VALUE1]]
        },
        meta: {
          parents: [],
          root: ROOT, createdAt: 4
        },
      });
    });

    it('should throw for empty update command', async () => {
      await expect(() => set.command({ ref: ROOT, createdAt: 2 }))
        .rejects.toEqual(operationError('Empty operation', ErrorCode.InvalidArg));
    });
  });

  describe('validate', () => {
    it('should return no error for valid events', async () => {
      expect(await set.validate(await set.command(CMD_NEW))).toBeUndefined();
      await applyCommand(CMD_NEW);
      expect(await set.validate(await set.command(CMD_ADD))).toBeUndefined();
    });

    it('should return error for malformed events', async () => {
      expect(await set.validate({
        type: ORSetEventType.Update, payload: { ops: [] },
        meta: { parents: [], root: ROOT, createdAt: 2 },
      })).toEqual(operationError('Empty operation', ErrorCode.InvalidArg));

      expect(await set.validate({
        type: ORSetEventType.Update,
        payload: { ops: [['value']] },
        meta: { parents: [], createdAt: 2 },
      })).toEqual(operationError('Missing root', ErrorCode.InvalidArg));

      expect(await set.validate({
        type: ORSetEventType.Update,
        payload: { ops: [['value', 0]] },
        meta: { parents: [], root: ROOT, createdAt: 2 },
      })).toEqual(operationError(`Invalid delete operation: "value"`, ErrorCode.InvalidArg));
    });

    it('should return error for missing dependent events', async () => {
      expect(await set.validate({
        type: ORSetEventType.Update,
        payload: { ops: [['value', 0]] },
        meta: { parents: [new MockId(new Uint8Array(2))], root: ROOT, createdAt: 3 },
      })).toEqual(operationError('Missing dependencies', ErrorCode.MissingDep, [new MockId(new Uint8Array(2)), ROOT]));
    });
  });

  describe('apply', () => {
    it('should save new set with fields correctly', async () => {
      await applyCommand();
      await applyCommand(CMD_ADD);

      expect(store.size).toEqual(6);
      expect(store.get(getEventIndexKey(`${ROOT}`))).toEqual(1);
      const expectedEventRef = new MockId(new Uint8Array(2));
      expect(store.get(getEventIndexKey(expectedEventRef.toString()))).toEqual(2);
      expect(store.get(getHeadIndexKey(`${ROOT}`, `${VALUE1}`, expectedEventRef.toString()))).toEqual(expectedEventRef);
      expect(store.get(getHeadIndexKey(`${ROOT}`, `${VALUE2}`, expectedEventRef.toString()))).toEqual(expectedEventRef);
      expect(store.get(getFieldValueKey(`${ROOT}`, `${VALUE1}`, expectedEventRef.toString()))).toEqual(VALUE1);
      expect(store.get(getFieldValueKey(`${ROOT}`, `${VALUE2}`, expectedEventRef.toString()))).toEqual(VALUE2);
    });

    it('should keep concurrent updates', async () => {
      await applyCommand(CMD_NEW); // 3 store entries
      const cmd1 = await set.command(CMD_ADD); // 5 store entries
      const cmd2 = await set.command(CMD_ADD_CONCURRENT); // 5 store entries
      await set.apply(cmd1);
      await set.apply(cmd2);
      const eventRef1 = new MockId(new Uint8Array(CMD_ADD.createdAt));
      const eventRef2 = new MockId(new Uint8Array(CMD_ADD_CONCURRENT.createdAt));

      expect(store.size).toEqual(13);

      expect(store.get(getHeadIndexKey(`${ROOT}`, `${VALUE2}`, eventRef1.toString()))).toEqual(eventRef1);
      expect(store.get(getHeadIndexKey(`${ROOT}`, `${VALUE2}`, eventRef2.toString()))).toEqual(eventRef2);
      expect(store.get(getFieldValueKey(`${ROOT}`, `${VALUE2}`, eventRef1.toString()))).toEqual(VALUE2);
      expect(store.get(getFieldValueKey(`${ROOT}`, `${VALUE2}`, eventRef2.toString()))).toEqual(VALUE2);
    });

    it('should remove all concurrent values on delete', async () => {
      const eventRef1 = new MockId(new Uint8Array(CMD_ADD.createdAt));
      const eventRef2 = new MockId(new Uint8Array(CMD_ADD_CONCURRENT.createdAt));

      await applyCommand(CMD_NEW); // 3 store entries
      const cmd1 = await set.command(CMD_ADD); // 5 store entries
      const cmd2 = await set.command(CMD_ADD_CONCURRENT); // 5 store entries
      await set.apply(cmd1);
      await set.apply(cmd2);
      await applyCommand(CMD_DEL); // +1 -4 store entries

      expect(store.size).toEqual(10);

      expect(store.get(getHeadIndexKey(`${ROOT}`, `${VALUE2}`, eventRef1.toString()))).toBeUndefined();
      expect(store.get(getHeadIndexKey(`${ROOT}`, `${VALUE2}`, eventRef2.toString()))).toBeUndefined();
      expect(store.get(getFieldValueKey(`${ROOT}`, `${VALUE2}`, eventRef1.toString()))).toBeUndefined();
      expect(store.get(getFieldValueKey(`${ROOT}`, `${VALUE2}`, eventRef2.toString()))).toBeUndefined();
    });

    it('should throw error for malformed events when validate = true', async () => {
      await expect(() => set.apply({
        type: ORSetEventType.Update,
        payload: { ops: [] }, meta: { parents: [], createdAt: 1 },
      })).rejects.toEqual(operationError('Empty operation', ErrorCode.UnsupportedOp));
    });
  });

  async function applyCommand(cmd: ORSetCommand<MockId, V> = CMD_EMPTY) {
    await set.apply(await set.command(cmd));
  }
});
