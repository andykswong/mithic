import { BTreeMap } from '@mithic/collections';
import { MockId } from '../../__tests__/mocks.js';
import { LSeqAggregate, LSeqCommand, LSeqCommandType, LSeqEvent, LSeqEventType } from '../lseq.js';
import { ORMap, MapQuery } from '../map.js';
import { getFieldValueKey, getHeadIndexKey } from '../keys.js';

type V = string | number | boolean;

const ROOT = new MockId(new Uint8Array(1));
const VALUE0 = 'v0';
const VALUE1 = 'v1';
const VALUE2 = 123;
const VALUE3 = true;
const INDEX0 = 'UUUUUUUU';
const INDEX1 = 'kkkkkkkkUU';
const INDEX2 = 'KUUUUUUUU';
const INDEX3 = 'PkkkkkkkkU';
const INDEX4 = 'ckkkkkkkUU';
const CMD_EMPTY = { type: LSeqCommandType.Update, payload: {}, time: 1 } satisfies LSeqCommand<MockId, V>;
const CMD_ADD = { type: LSeqCommandType.Update, payload: { add: [VALUE0, VALUE1] }, root: ROOT, time: 2 } satisfies LSeqCommand<MockId, V>;
const CMD_ADD2 = { type: LSeqCommandType.Update, payload: { index: 'A', add: [VALUE1, VALUE2] }, root: ROOT, time: 3 } satisfies LSeqCommand<MockId, V>;
const CMD_DEL = { type: LSeqCommandType.Update, payload: { index: 'UUUUUUUU', add: [VALUE1, VALUE3], del: 1 }, root: ROOT, time: 4 } satisfies LSeqCommand<MockId, V>;
const CMD_ADD_CONCURRENT = { type: LSeqCommandType.Update, payload: { add: [VALUE2, VALUE3] }, root: ROOT, time: 5 } satisfies LSeqCommand<MockId, V>;

describe(LSeqAggregate.name, () => {
  let lseq: LSeqAggregate<MockId, V>;
  let store: BTreeMap<string, MockId | V>;

  beforeEach(() => {
    const map = new ORMap<MockId, V>({
      eventKey: (event) => new MockId(new Uint8Array(event.time || 0)),
    });
    lseq = new LSeqAggregate({
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
        link: [], time: 1,
      } satisfies LSeqEvent<MockId, V>);
    });

    it('should return valid event for new set command', async () => {
      const event = await lseq.command({ type: LSeqCommandType.Update, payload: { add: [VALUE0, VALUE1] }, nonce: '123', time: 1 });
      expect(event).toEqual({
        type: LSeqEventType.New,
        payload: {
          ops: [[INDEX0, VALUE0, false], [INDEX1, VALUE1, false]],
        },
        link: [], nonce: '123', time: 1,
      } satisfies LSeqEvent<MockId, V>);
    });

    it('should return valid event for set set command', async () => {
      const event = await lseq.command(CMD_ADD);
      expect(event).toEqual({
        type: LSeqEventType.Update,
        payload: {
          ops: [[INDEX0, VALUE0, false], [INDEX1, VALUE1, false]]
        },
        link: [], root: ROOT, time: 2,
      } satisfies LSeqEvent<MockId, V>);
    });

    it('should return valid event for set delete/replace command', async () => {
      const concurrentEvent = await lseq.command(CMD_ADD_CONCURRENT);
      await applyCommand(CMD_ADD);
      await lseq.reduce(concurrentEvent);
      const event = await lseq.command(CMD_DEL);
      expect(event).toEqual({
        type: LSeqEventType.Update,
        payload: {
          ops: [[INDEX0, VALUE1, false, 0, 1], [INDEX4, VALUE3, false]]
        },
        link: [new MockId(new Uint8Array(2)), new MockId(new Uint8Array(5))],
        root: ROOT, time: 4
      } satisfies LSeqEvent<MockId, V>);
    });

    it('should ignore delete operation if nothing can be deleted', async () => {
      const event = await lseq.command(CMD_DEL);
      expect(event).toEqual({
        type: LSeqEventType.Update,
        payload: {
          ops: [[INDEX1, VALUE1, false], ['sssssssskkU', VALUE3, false]]
        },
        link: [],
        root: ROOT, time: 4
      } satisfies LSeqEvent<MockId, V>);
    });

    it('should throw for empty update command', async () => {
      await expect(() => lseq.command({ type: LSeqCommandType.Update, payload: {}, root: ROOT, time: 2 }))
        .rejects.toEqual(new TypeError('empty operation'));
    });
  });

  describe('query', () => {
    it('should return empty result for empty / undefined maps', async () => {
      await applyCommand();
      for await (const _ of lseq.query({ root: ROOT })) {
        throw new Error('should not be called');
      }
    });

    it.each([
      [[CMD_ADD], { root: ROOT }, [[INDEX0, VALUE0], [INDEX1, VALUE1]] as const],
      [[CMD_ADD, CMD_ADD2], { root: ROOT }, [[INDEX2, VALUE1], [INDEX3, VALUE2], [INDEX0, VALUE0], [INDEX1, VALUE1]] as const],
      [[CMD_ADD, CMD_ADD2], { root: ROOT, limit: 2 }, [[INDEX2, VALUE1], [INDEX3, VALUE2]] as const],
      [[CMD_ADD, CMD_ADD2], { root: ROOT, limit: 2, reverse: true }, [[INDEX1, VALUE1], [INDEX0, VALUE0]] as const],
      [[CMD_ADD, CMD_ADD2, CMD_DEL], { root: ROOT }, [[INDEX2, VALUE1], [INDEX3, VALUE2], [INDEX0, VALUE1], [INDEX4, VALUE3], [INDEX1, VALUE1]] as const],
    ])(
      'should return correct results for non-empty LSeqs',
      async (cmds: LSeqCommand<MockId, V>[], query: MapQuery<MockId, V>, expected: readonly (readonly [string, V])[]) => {
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
      await lseq.reduce(concurrentEvent);

      const results = [];
      for await (const entry of lseq.query({ root: ROOT })) {
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
        link: [], root: ROOT, time: 2,
      })).toEqual(new TypeError('empty operation'));
    });
  });

  describe('apply', () => {
    it('should save new set with fields correctly', async () => {
      const expectedEventRef = new MockId(new Uint8Array(2));

      expect(await applyCommand()).toEqual(ROOT);
      expect(await applyCommand(CMD_ADD)).toEqual(expectedEventRef);

      expect(store.size).toEqual(4);
      expect(store.get(getHeadIndexKey(`${ROOT}`, INDEX0, expectedEventRef.toString()))).toEqual(expectedEventRef);
      expect(store.get(getHeadIndexKey(`${ROOT}`, INDEX1, expectedEventRef.toString()))).toEqual(expectedEventRef);
      expect(store.get(getFieldValueKey(`${ROOT}`, INDEX0, expectedEventRef.toString()))).toEqual(VALUE0);
      expect(store.get(getFieldValueKey(`${ROOT}`, INDEX1, expectedEventRef.toString()))).toEqual(VALUE1);
    });

    it('should remove all concurrent values on delete', async () => {
      const eventRef1 = new MockId(new Uint8Array(CMD_ADD.time));
      const eventRef2 = new MockId(new Uint8Array(CMD_ADD_CONCURRENT.time));

      await applyCommand();
      const concurrentEvent = await lseq.command(CMD_ADD_CONCURRENT);
      await applyCommand(CMD_ADD);
      await lseq.reduce(concurrentEvent);
      await applyCommand(CMD_DEL);

      expect(store.get(getHeadIndexKey(`${ROOT}`, `${INDEX0}`, eventRef1.toString()))).toBeUndefined();
      expect(store.get(getHeadIndexKey(`${ROOT}`, `${INDEX0}`, eventRef2.toString()))).toBeUndefined();
      expect(store.get(getFieldValueKey(`${ROOT}`, `${INDEX0}`, eventRef1.toString()))).toBeUndefined();
      expect(store.get(getFieldValueKey(`${ROOT}`, `${INDEX0}`, eventRef2.toString()))).toBeUndefined();
    });

    it('should throw error for malformed events when validate = true', async () => {
      await expect(() => lseq.reduce({
        type: LSeqEventType.Update,
        payload: { ops: [] }, link: [], time: 1,
      })).rejects.toEqual(new TypeError('empty operation'));
    });
  });

  async function applyCommand(cmd: LSeqCommand<MockId, V> = CMD_EMPTY) {
    return await lseq.reduce(await lseq.command(cmd));
  }
});
