import { BTreeMap } from '@mithic/collections';
import { ORSet, SetCommand, SetCommandType, SetEvent, SetEventType, SetQuery } from '../set.js';
import { getFieldValueKey, getHeadIndexKey } from '../keys.js';
import { ORMap } from '../map.js';
import { MockId } from '../../__tests__/mocks.js';

type V = string | number | boolean;

const ROOT = new MockId(new Uint8Array(1));
const VALUE0 = 'v0';
const VALUE1 = 'v1';
const VALUE2 = 123;
const VALUE3 = true;
const CMD_EMPTY = { type: SetCommandType.Update, payload: {}, time: 1 } satisfies SetCommand<MockId, V>;
const CMD_NEW = { type: SetCommandType.Update, payload: { add: [VALUE0] }, nonce: '123', time: 1 } satisfies SetCommand<MockId, V>;
const CMD_ADD = { type: SetCommandType.Update, payload: { add: [VALUE1, VALUE2] }, root: ROOT, time: 2 } satisfies SetCommand<MockId, V>;
const CMD_ADD_CONCURRENT = { type: SetCommandType.Update, payload: { add: [VALUE2, VALUE3] }, root: ROOT, time: 3 } satisfies SetCommand<MockId, V>;
const CMD_DEL = { type: SetCommandType.Update, payload: { add: [VALUE1], del: [VALUE2] }, root: ROOT, time: 4 } satisfies SetCommand<MockId, V>;

describe(ORSet.name, () => {
  let set: ORSet<MockId, V>;
  let store: BTreeMap<string, MockId | V>;

  beforeEach(() => {
    const map = new ORMap<MockId, V>({
      eventKey: (event) => new MockId(new Uint8Array(event.time || 0)),
    })
    set = new ORSet({
      map,
      stringify: (value) => `${value}`,
    });
    store = map['store'] as BTreeMap<string, MockId | V>;
  });

  describe('query', () => {
    it('should return empty result for empty / undefined sets', async () => {
      await applyCommand();
      for await (const _ of set.query({ root: ROOT })) {
        throw new Error('should not be called');
      }
    });

    it.each([
      [[CMD_ADD], { root: ROOT }, [VALUE2, VALUE1] as const],
      [[CMD_ADD, CMD_ADD_CONCURRENT], { root: ROOT }, [VALUE2, VALUE3, VALUE1] as const],
      [[CMD_ADD, CMD_ADD_CONCURRENT], { root: ROOT, limit: 2 }, [VALUE2, VALUE3] as const],
      [[CMD_ADD, CMD_ADD_CONCURRENT], { root: ROOT, limit: 2, reverse: true }, [VALUE1, VALUE3] as const],
      [[CMD_ADD, CMD_ADD_CONCURRENT, CMD_DEL], { root: ROOT, gte: VALUE2, lte: VALUE1 }, [VALUE3, VALUE1] as const],
    ])(
      'should return correct results for non-empty sets',
      async (cmds: SetCommand<MockId, V>[], query: SetQuery<MockId, V>, expected: readonly V[]) => {
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
      await set.reduce(concurrentEvent);

      const results = [];
      for await (const entry of set.query({ root: ROOT })) {
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
        type: SetEventType.New,
        payload: { ops: [] },
        link: [], time: 1,
      } satisfies SetEvent<MockId, V>);
    });

    it('should return valid event for new set command', async () => {
      const event = await set.command(CMD_NEW);
      expect(event).toEqual({
        type: SetEventType.New,
        payload: {
          ops: [[VALUE0]],
        },
        link: [], nonce: '123', time: 1,
      } satisfies SetEvent<MockId, V>);
    });

    it('should return valid event for set set command', async () => {
      const event = await set.command(CMD_ADD);
      expect(event).toEqual({
        type: SetEventType.Update,
        payload: {
          ops: [[VALUE2], [VALUE1]]
        },
        link: [], root: ROOT, time: 2,
      } satisfies SetEvent<MockId, V>);
    });

    it('should return valid event for set delete command', async () => {
      const concurrentEvent = await set.command(CMD_ADD_CONCURRENT);
      await applyCommand(CMD_ADD);
      await set.reduce(concurrentEvent);
      const event = await set.command(CMD_DEL);
      expect(event).toEqual({
        type: SetEventType.Update,
        payload: {
          ops: [[VALUE2, 0, 1]]
        },
        link: [new MockId(new Uint8Array(2)), new MockId(new Uint8Array(3))],
        root: ROOT, time: 4
      } satisfies SetEvent<MockId, V>);
    });

    it('should ignore delete operation if field does not already exist', async () => {
      await applyCommand(CMD_NEW);
      const event = await set.command(CMD_DEL);
      expect(event).toEqual({
        type: SetEventType.Update,
        payload: {
          ops: [[VALUE1]]
        },
        link: [],
        root: ROOT, time: 4
      } satisfies SetEvent<MockId, V>);
    });

    it('should throw for empty update command', async () => {
      await expect(() => set.command({ type: SetCommandType.Update, payload: {}, root: ROOT, time: 2 }))
        .rejects.toEqual(new TypeError('empty operation'));
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
        type: SetEventType.Update, payload: { ops: [] },
        link: [], root: ROOT, time: 2,
      })).toEqual(new TypeError('empty operation'));

      expect(await set.validate({
        type: SetEventType.Update,
        payload: { ops: [['value']] },
        link: [], time: 2,
      })).toEqual(new TypeError('missing root'));

      expect(await set.validate({
        type: SetEventType.Update,
        payload: { ops: [['value', 0]] },
        link: [], root: ROOT, time: 2,
      })).toEqual(new TypeError(`invalid operation: "value"`));
    });
  });

  describe('apply', () => {
    it('should save new set with fields correctly', async () => {
      const expectedEventRef = new MockId(new Uint8Array(2));

      expect(await applyCommand()).toEqual(ROOT);
      expect(await applyCommand(CMD_ADD)).toEqual(expectedEventRef);

      expect(store.size).toEqual(4);
      expect(store.get(getHeadIndexKey(`${ROOT}`, `${VALUE1}`, expectedEventRef.toString()))).toEqual(expectedEventRef);
      expect(store.get(getHeadIndexKey(`${ROOT}`, `${VALUE2}`, expectedEventRef.toString()))).toEqual(expectedEventRef);
      expect(store.get(getFieldValueKey(`${ROOT}`, `${VALUE1}`, expectedEventRef.toString()))).toEqual(VALUE1);
      expect(store.get(getFieldValueKey(`${ROOT}`, `${VALUE2}`, expectedEventRef.toString()))).toEqual(VALUE2);
    });

    it('should keep concurrent updates', async () => {
      await applyCommand(CMD_NEW);
      const cmd1 = await set.command(CMD_ADD);
      const cmd2 = await set.command(CMD_ADD_CONCURRENT);
      await set.reduce(cmd1);
      await set.reduce(cmd2);
      const eventRef1 = new MockId(new Uint8Array(CMD_ADD.time));
      const eventRef2 = new MockId(new Uint8Array(CMD_ADD_CONCURRENT.time));

      expect(store.get(getHeadIndexKey(`${ROOT}`, `${VALUE2}`, eventRef1.toString()))).toEqual(eventRef1);
      expect(store.get(getHeadIndexKey(`${ROOT}`, `${VALUE2}`, eventRef2.toString()))).toEqual(eventRef2);
      expect(store.get(getFieldValueKey(`${ROOT}`, `${VALUE2}`, eventRef1.toString()))).toEqual(VALUE2);
      expect(store.get(getFieldValueKey(`${ROOT}`, `${VALUE2}`, eventRef2.toString()))).toEqual(VALUE2);
    });

    it('should remove all concurrent values on delete', async () => {
      const eventRef1 = new MockId(new Uint8Array(CMD_ADD.time));
      const eventRef2 = new MockId(new Uint8Array(CMD_ADD_CONCURRENT.time));

      await applyCommand(CMD_NEW);
      const cmd1 = await set.command(CMD_ADD);
      const cmd2 = await set.command(CMD_ADD_CONCURRENT);
      await set.reduce(cmd1);
      await set.reduce(cmd2);
      await applyCommand(CMD_DEL);

      expect(store.size).toEqual(6); // 3 entries remaining

      expect(store.get(getHeadIndexKey(`${ROOT}`, `${VALUE2}`, eventRef1.toString()))).toBeUndefined();
      expect(store.get(getHeadIndexKey(`${ROOT}`, `${VALUE2}`, eventRef2.toString()))).toBeUndefined();
      expect(store.get(getFieldValueKey(`${ROOT}`, `${VALUE2}`, eventRef1.toString()))).toBeUndefined();
      expect(store.get(getFieldValueKey(`${ROOT}`, `${VALUE2}`, eventRef2.toString()))).toBeUndefined();
    });

    it('should throw error for malformed events when validate = true', async () => {
      await expect(() => set.reduce({
        type: SetEventType.Update,
        payload: { ops: [] }, link: [], time: 1,
      })).rejects.toEqual(new TypeError('empty operation'));
    });
  });

  async function applyCommand(cmd: SetCommand<MockId, V> = CMD_EMPTY) {
    return await set.reduce(await set.command(cmd));
  }
});
