import { BTreeMap } from '@mithic/collections';
import { MapStore, ORMapCommandHandler, ORMapProjection } from '../../map/index.js';
import { ListCommand, ListCommandHandler, ListCommandType, ListEvent, ListEventType, ListProjection, ListRangeQuery, ListRangeQueryResolver } from '../list.js';
import { LSeqCommandHandler, LSeqProjection, LSeqRangeQueryResolver } from '../lseq.js';
import { MockId, MockIdStringCodec, MockMultimapKeyCodec, createMockMapStore, getMockEventKey } from '../../__tests__/mocks.js';
import { FractionalIndexGenerator } from '../fractional.js';

type V = string;

const GENERATOR = new FractionalIndexGenerator(() => 0.5);

const ROOT = new MockId(new Uint8Array(1));
const VALUE0 = 'v0';
const VALUE1 = 'v1';
const VALUE2 = '123';
const VALUE3 = 'true';
const [INDEX0, INDEX1] = [...GENERATOR.create(void 0, void 0, 2)];
const ANCHOR = 'A';
const [INDEXA1, INDEXA2] = [...GENERATOR.create(void 0, ANCHOR, 2)];
const [INDEXAD1, INDEXAD2] = [...GENERATOR.create(INDEXA2, INDEX0, 2)];
const [INDEXSD1, INDEXSD2] = [...GENERATOR.create(void 0, INDEX0, 2)];

const CMD_EMPTY = { type: ListCommandType.Update, payload: {}, nonce: '1' } satisfies ListCommand<MockId, V>;
const CMD_ADD = { type: ListCommandType.Update, payload: { add: [VALUE0, VALUE1] }, root: ROOT, nonce: '2' } satisfies ListCommand<MockId, V>;
const CMD_ADD_AT = { type: ListCommandType.Update, payload: { index: ANCHOR, add: [VALUE1, VALUE2] }, root: ROOT, nonce: '3' } satisfies ListCommand<MockId, V>;
const CMD_DEL = { type: ListCommandType.Update, payload: { index: INDEX0, add: [VALUE1, VALUE3], del: 1 }, root: ROOT, nonce: '4' } satisfies ListCommand<MockId, V>;
const CMD_ADD_CONCURRENT = { type: ListCommandType.Update, payload: { add: [VALUE2, VALUE3] }, root: ROOT, nonce: '5' } satisfies ListCommand<MockId, V>;

describe('LSeq', () => {
  let keySet: Set<string>;
  let dataMap: BTreeMap<string, V>;
  let store: MapStore<MockId, V>;
  let command: ListCommandHandler<MockId, V>;
  let projection: ListProjection<MockId, V>;

  beforeEach(() => {
    ({ store, set: keySet, map: dataMap } = createMockMapStore<V>());
    command = new LSeqCommandHandler(new ORMapCommandHandler(), GENERATOR);
    projection = new LSeqProjection(new ORMapProjection(getMockEventKey));
  });

  describe(LSeqCommandHandler.name, () => {
    it('should return valid event for new empty set command', async () => {
      const event = await command.handle(store, CMD_EMPTY);
      expect(event).toEqual({
        type: ListEventType.New,
        payload: { set: [] },
        link: [],
        nonce: CMD_EMPTY.nonce
      } satisfies ListEvent<MockId, V>);
    });

    it('should return undefined for empty command', async () => {
      expect(await command.handle(store, { type: ListCommandType.Update, payload: {}, root: ROOT, nonce: '1' }))
        .toBeUndefined();
    });

    it('should return valid event for new set command', async () => {
      const event = await command.handle(
        store,
        { type: ListCommandType.Update, payload: { add: [VALUE0, VALUE1] }, nonce: '123' }
      );
      expect(event).toEqual({
        type: ListEventType.New,
        payload: {
          set: [[INDEX0, VALUE0], [INDEX1, VALUE1]],
        },
        link: [],
        nonce: '123',
      } satisfies ListEvent<MockId, V>);
    });

    it('should return valid event for set set command', async () => {
      const event = await command.handle(store, CMD_ADD);
      expect(event).toEqual({
        type: ListEventType.Update,
        payload: {
          set: [[INDEX0, VALUE0], [INDEX1, VALUE1]]
        },
        link: [], root: ROOT,
        nonce: CMD_ADD.nonce,
      } satisfies ListEvent<MockId, V>);
    });

    it('should ignore delete operation if nothing can be deleted', async () => {
      const event = await command.handle(store, CMD_DEL);
      expect(event).toEqual({
        type: ListEventType.Update,
        payload: {
          set: [[INDEXSD1, VALUE1], [INDEXSD2, VALUE3]]
        },
        link: [],
        root: ROOT,
        nonce: CMD_DEL.nonce
      } satisfies ListEvent<MockId, V>);
    });

    it('should return valid event for delete/replace command', async () => {
      const concurrentEvent = await command.handle(store, CMD_ADD_CONCURRENT);
      await applyCommand(CMD_ADD);
      await projection.reduce(store, concurrentEvent!);

      const event = await command.handle(store, CMD_DEL);
      expect(event).toEqual({
        type: ListEventType.Update,
        payload: {
          set: [
            [INDEXSD1, VALUE1],
            [INDEXSD2, VALUE3],
            [INDEX0, null, 0, 1],
          ]
        },
        link: [getMockEventKey(CMD_ADD), getMockEventKey(CMD_ADD_CONCURRENT)],
        root: ROOT,
        nonce: CMD_DEL.nonce
      } satisfies ListEvent<MockId, V>);
    });
  });

  describe(LSeqProjection.name, () => {
    describe('validate', () => {
      it('should return no error for valid events', async () => {
        expect(await projection.validate(store, (await command.handle(store, CMD_EMPTY))!)).toBeUndefined();
        await applyCommand();
        expect(await projection.validate(store, (await command.handle(store, CMD_ADD))!)).toBeUndefined();
        expect(await projection.validate(store, (await command.handle(store, CMD_DEL))!)).toBeUndefined();
      });

      it('should return error for malformed events', async () => {
        expect(await projection.validate(store, {
          type: ListEventType.Update, payload: { set: [] },
          link: [], root: ROOT, nonce: '2',
        })).toEqual(new TypeError('empty operation'));
      });

      it('should return error for invalid index', async () => {
        const index = '+-*012';
        expect(await projection.validate(store, {
          type: ListEventType.Update,
          payload: { set: [[index, 'test']] },
          link: [], root: ROOT, nonce: '2',
        })).toEqual(new TypeError(`Invalid index: ${index}`));
      });
    });

    describe('reduce', () => {
      it('should save new set with fields correctly', async () => {
        const eventKey = getMockEventKey(CMD_ADD);

        await applyCommand();
        await applyCommand(CMD_ADD);

        expect(dataMap.size).toEqual(2);
        expect(dataMap.get(MockMultimapKeyCodec.encode([ROOT, INDEX0, eventKey]))).toEqual(VALUE0);
        expect(dataMap.get(MockMultimapKeyCodec.encode([ROOT, INDEX1, eventKey]))).toEqual(VALUE1);
      });

      it('should remove all concurrent values on delete', async () => {
        const event1Key = getMockEventKey(CMD_ADD);
        const event2Key = getMockEventKey(CMD_ADD_CONCURRENT);
        const event3Key = getMockEventKey(CMD_DEL);

        await applyCommand();
        const concurrentEvent = await command.handle(store, CMD_ADD_CONCURRENT);
        await applyCommand(CMD_ADD);
        await projection.reduce(store, concurrentEvent!);
        await applyCommand(CMD_DEL);

        expect(keySet.size).toEqual(3);
        expect(keySet.has(MockIdStringCodec.encode(getMockEventKey(CMD_EMPTY)))).toBe(true);
        expect(keySet.has(MockIdStringCodec.encode(event1Key))).toBe(true);
        expect(keySet.has(MockIdStringCodec.encode(event2Key))).toBe(true);

        expect(dataMap.size).toEqual(4);
        expect(dataMap.get(MockMultimapKeyCodec.encode([ROOT, INDEXSD1, event3Key]))).toEqual(VALUE1);
        expect(dataMap.get(MockMultimapKeyCodec.encode([ROOT, INDEXSD2, event3Key]))).toEqual(VALUE3);
        expect(dataMap.get(MockMultimapKeyCodec.encode([ROOT, INDEX1, event1Key]))).toEqual(VALUE1);
        expect(dataMap.get(MockMultimapKeyCodec.encode([ROOT, INDEX1, event2Key]))).toEqual(VALUE3);
      });

      it('should throw error for malformed events when validate = true', async () => {
        await expect(() => projection.reduce(store, {
          type: ListEventType.Update,
          payload: { set: [] }, link: [], nonce: '1',
        })).rejects.toEqual(new TypeError('missing root'));
      });
    });
  });

  describe(LSeqRangeQueryResolver.name, () => {
    let resolver: ListRangeQueryResolver<MockId, V>;

    beforeEach(() => {
      resolver = new LSeqRangeQueryResolver();
    })

    it('should return empty result for empty / undefined maps', async () => {
      await applyCommand();
      for await (const _ of resolver.resolve(store, { root: ROOT })) {
        throw new Error('should not be called');
      }
    });

    it.each([
      [[CMD_ADD], { root: ROOT }, [[INDEX0, VALUE0], [INDEX1, VALUE1]] as const],
      [[CMD_ADD, CMD_ADD_AT], { root: ROOT }, [[INDEXA1, VALUE1], [INDEXA2, VALUE2], [INDEX0, VALUE0], [INDEX1, VALUE1]] as const],
      [[CMD_ADD, CMD_ADD_AT], { root: ROOT, limit: 2 }, [[INDEXA1, VALUE1], [INDEXA2, VALUE2]] as const],
      [[CMD_ADD, CMD_ADD_AT], { root: ROOT, limit: 2, reverse: true }, [[INDEX1, VALUE1], [INDEX0, VALUE0]] as const],
      [[CMD_ADD, CMD_ADD_AT, CMD_DEL], { root: ROOT }, [[INDEXA1, VALUE1], [INDEXA2, VALUE2], [INDEXAD1, VALUE1], [INDEXAD2, VALUE3], [INDEX1, VALUE1]] as const],
    ])(
      'should return correct results for non-empty LSeq %#',
      async (cmds: ListCommand<MockId, V>[], query: ListRangeQuery<MockId, V>, expected: readonly (readonly [string, V])[]) => {
        await applyCommand();
        for (const cmd of cmds) {
          await applyCommand(cmd);
        }
        const results: [string, V][] = [];
        for await (const entry of resolver.resolve(store, query)) {
          results.push(entry);
        }
        expect(results).toEqual(expected);
      }
    );

    it('should return all values on concurrent updates', async () => {
      await applyCommand();
      const concurrentEvent = await command.handle(store, CMD_ADD_CONCURRENT);
      await applyCommand(CMD_ADD);
      await projection.reduce(store, concurrentEvent!);

      const results: [string, V][] = [];
      for await (const entry of resolver.resolve(store, { root: ROOT })) {
        results.push(entry);
      }
      expect(results).toEqual([[INDEX0, VALUE0], [INDEX0, VALUE2], [INDEX1, VALUE1], [INDEX1, VALUE3]]);
    });
  });

  async function applyCommand(cmd: ListCommand<MockId, V> = CMD_EMPTY) {
    return await projection.reduce(store, (await command.handle(store, cmd))!);
  }
});
