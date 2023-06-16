import { BTreeMap } from '@mithic/collections';
import { MockId } from '../../__tests__/mocks.js';
import { LSeq, LSeqCommand, LSeqEventType } from '../lseq.js';
import { ORMap, ORMapQuery } from '../map.js';
import { ErrorCode, operationError } from '@mithic/commons';
import { getEventIndexKey, getFieldValueKey, getHeadIndexKey } from '../keys.js';

type V = string | number | boolean;

const ROOT = new MockId(new Uint8Array(1));
const VALUE0 = 'v0';
const VALUE1 = 'v1';
const VALUE2 = 123;
const VALUE3 = true;
const INDEX0 = 'UUUUUUUU';
const INDEX1 = 'kkkkkkkk';
const INDEX2 = 'KUUUUUUU';
const INDEX3 = 'Pkkkkkkk';
const INDEX4 = 'ckkkkkkk';
const CMD_EMPTY = { createdAt: 1 };
const CMD_ADD = { ref: ROOT, add: [VALUE0, VALUE1], createdAt: 2 };
const CMD_ADD2 = { ref: ROOT, index: 'A', add: [VALUE1, VALUE2], createdAt: 3 };
const CMD_DEL = { ref: ROOT, index: 'UUUUUUUU', add: [VALUE1, VALUE3], del: 1, createdAt: 4 };
const CMD_ADD_CONCURRENT = { ref: ROOT, add: [VALUE2, VALUE3], createdAt: 5 };

describe(LSeq.name, () => {
  let lseq: LSeq<MockId, V>;
  let store: BTreeMap<string, MockId | V>;

  beforeEach(() => {
    const map = new ORMap<MockId, V>({
      eventRef: (event) => new MockId(new Uint8Array(event.meta.createdAt || 0)),
    });
    lseq = new LSeq({
      map,
      rand: () => 0.5,
    });
    store = map['store'] as BTreeMap<string, MockId | V>;
  });

  describe('command', () => {
    beforeEach(async () => {
      await applyCommand();
    });

    it('should return valid event for new empty set command', async () => {
      const event = await lseq.command(CMD_EMPTY);
      expect(event).toEqual({
        type: LSeqEventType.New,
        payload: { ops: [] },
        meta: { parents: [], createdAt: 1 },
      });
    });

    it('should return valid event for new set command', async () => {
      const event = await lseq.command({ add: [VALUE0, VALUE1], nounce: 123, createdAt: 1 });
      expect(event).toEqual({
        type: LSeqEventType.New,
        payload: {
          ops: [[INDEX0, VALUE0, false], [INDEX1, VALUE1, false]],
          nounce: 123,
        },
        meta: { parents: [], createdAt: 1 },
      });
    });

    it('should return valid event for set set command', async () => {
      const event = await lseq.command(CMD_ADD);
      expect(event).toEqual({
        type: LSeqEventType.Update,
        payload: {
          ops: [[INDEX0, VALUE0, false], [INDEX1, VALUE1, false]]
        },
        meta: { parents: [], root: ROOT, createdAt: 2 },
      });
    });

    it('should return valid event for set delete/replace command', async () => {
      const concurrentEvent = await lseq.command(CMD_ADD_CONCURRENT);
      await applyCommand(CMD_ADD);
      await lseq.apply(concurrentEvent);
      const event = await lseq.command(CMD_DEL);
      expect(event).toEqual({
        type: LSeqEventType.Update,
        payload: {
          ops: [[INDEX0, VALUE1, false, 0, 1], [INDEX4, VALUE3, false]]
        },
        meta: {
          parents: [new MockId(new Uint8Array(2)), new MockId(new Uint8Array(5))],
          root: ROOT, createdAt: 4
        },
      });
    });

    it('should ignore delete operation if nothing can be deleted', async () => {
      const event = await lseq.command(CMD_DEL);
      expect(event).toEqual({
        type: LSeqEventType.Update,
        payload: {
          ops: [[INDEX1, VALUE1, false], ['ssssssss', VALUE3, false]]
        },
        meta: {
          parents: [],
          root: ROOT, createdAt: 4
        },
      });
    });

    it('should throw for empty update command', async () => {
      await expect(() => lseq.command({ ref: ROOT, createdAt: 2 }))
        .rejects.toEqual(operationError('Empty operation', ErrorCode.InvalidArg));
    });
  });

  describe('query', () => {
    it('should return empty result for empty / undefined maps', async () => {
      await applyCommand();
      for await (const _ of lseq.query({ ref: ROOT })) {
        throw new Error('should not be called');
      }
    });

    it.each([
      [[CMD_ADD], { ref: ROOT }, [[INDEX0, VALUE0], [INDEX1, VALUE1]] as const],
      [[CMD_ADD, CMD_ADD2], { ref: ROOT }, [[INDEX2, VALUE1], [INDEX3, VALUE2], [INDEX0, VALUE0], [INDEX1, VALUE1]] as const],
      [[CMD_ADD, CMD_ADD2], { ref: ROOT, limit: 2 }, [[INDEX2, VALUE1], [INDEX3, VALUE2]] as const],
      [[CMD_ADD, CMD_ADD2], { ref: ROOT, limit: 2, reverse: true }, [[INDEX1, VALUE1], [INDEX0, VALUE0]] as const],
      [[CMD_ADD, CMD_ADD2, CMD_DEL], { ref: ROOT }, [[INDEX2, VALUE1], [INDEX3, VALUE2], [INDEX0, VALUE1], [INDEX4, VALUE3], [INDEX1, VALUE1]] as const],
    ])(
      'should return correct results for non-empty LSeqs',
      async (cmds: LSeqCommand<MockId, V>[], query: ORMapQuery<MockId>, expected: readonly (readonly [string, V])[]) => {
        await applyCommand();
        for (const cmd of cmds) {
          await applyCommand(cmd);
        }
        const results = [];
        for await (const entry of lseq.query(query)) {
          results.push(entry);
        }
        expect(results).toEqual(expected);
      }
    );

    it('should return all values on concurrent updates', async () => {
      await applyCommand();
      const concurrentEvent = await lseq.command(CMD_ADD_CONCURRENT);
      await applyCommand(CMD_ADD);
      await lseq.apply(concurrentEvent);

      const results = [];
      for await (const entry of lseq.query({ ref: ROOT })) {
        results.push(entry);
      }
      expect(results).toEqual([[INDEX0, VALUE0], [INDEX0, VALUE2], [INDEX1, VALUE1], [INDEX1, VALUE3]]);
    });
  });

  describe('validate', () => {
    it('should return no error for valid events', async () => {
      expect(await lseq.validate(await lseq.command(CMD_EMPTY))).toBeUndefined();
      await applyCommand();
      expect(await lseq.validate(await lseq.command(CMD_ADD))).toBeUndefined();
      expect(await lseq.validate(await lseq.command(CMD_DEL))).toBeUndefined();
    });

    it('should return error for malformed events', async () => {
      expect(await lseq.validate({
        type: LSeqEventType.Update, payload: { ops: [] },
        meta: { parents: [], root: ROOT, createdAt: 2 },
      })).toEqual(operationError('Empty operation', ErrorCode.InvalidArg));
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
      expect(store.get(getHeadIndexKey(`${ROOT}`, INDEX0, expectedEventRef.toString()))).toEqual(expectedEventRef);
      expect(store.get(getHeadIndexKey(`${ROOT}`, INDEX1, expectedEventRef.toString()))).toEqual(expectedEventRef);
      expect(store.get(getFieldValueKey(`${ROOT}`, INDEX0, expectedEventRef.toString()))).toEqual(VALUE0);
      expect(store.get(getFieldValueKey(`${ROOT}`, INDEX1, expectedEventRef.toString()))).toEqual(VALUE1);
    });

    it('should remove all concurrent values on delete', async () => {
      const eventRef1 = new MockId(new Uint8Array(CMD_ADD.createdAt));
      const eventRef2 = new MockId(new Uint8Array(CMD_ADD_CONCURRENT.createdAt));

      await applyCommand();
      const concurrentEvent = await lseq.command(CMD_ADD_CONCURRENT);
      await applyCommand(CMD_ADD);
      await lseq.apply(concurrentEvent);
      await applyCommand(CMD_DEL);

      expect(store.get(getHeadIndexKey(`${ROOT}`, `${INDEX0}`, eventRef1.toString()))).toBeUndefined();
      expect(store.get(getHeadIndexKey(`${ROOT}`, `${INDEX0}`, eventRef2.toString()))).toBeUndefined();
      expect(store.get(getFieldValueKey(`${ROOT}`, `${INDEX0}`, eventRef1.toString()))).toBeUndefined();
      expect(store.get(getFieldValueKey(`${ROOT}`, `${INDEX0}`, eventRef2.toString()))).toBeUndefined();
    });

    it('should throw error for malformed events when validate = true', async () => {
      await expect(() => lseq.apply({
        type: LSeqEventType.Update,
        payload: { ops: [] }, meta: { parents: [], createdAt: 1 },
      })).rejects.toEqual(operationError('Empty operation', ErrorCode.UnsupportedOp));
    });
  });

  async function applyCommand(cmd: LSeqCommand<MockId, V> = CMD_EMPTY) {
    await lseq.apply(await lseq.command(cmd));
  }
});
