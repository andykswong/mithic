import { BTreeMap, BTreeSet } from '@mithic/collections';
import { ORMapCommandHandler, ORMapProjection, ORMapRangeQueryResolver } from '../../map/index.js';
import { MapStore, MultimapKey, createDefaultMapStore } from '../../store.js';
import { ORSetCommandHandler, ORSetProjection, ORSetRangeQueryResolver } from '../orset.js';
import { SetCommand, SetCommandHandler, SetCommandType, SetEvent, SetEventType, SetProjection, SetRangeQuery, SetRangeQueryResolver } from '../set.js';
import { MockId, getMockEventKey } from '../../__tests__/mocks.js';

type V = string | number | boolean;

const ROOT = new MockId(new Uint8Array(1));
const VALUE0 = 'v0';
const VALUE1 = 'v1';
const VALUE2 = 123;
const VALUE3 = true;
const CMD_EMPTY = { type: SetCommandType.Update, payload: {}, nonce: '1' } satisfies SetCommand<MockId, V>;
const CMD_NEW = { type: SetCommandType.Update, payload: { add: [VALUE0] }, nonce: '1' } satisfies SetCommand<MockId, V>;
const CMD_ADD = { type: SetCommandType.Update, payload: { add: [VALUE1, VALUE2] }, root: ROOT, nonce: '2' } satisfies SetCommand<MockId, V>;
const CMD_ADD_CONCURRENT = { type: SetCommandType.Update, payload: { add: [VALUE2, VALUE3], del: [VALUE2] }, root: ROOT, nonce: '3' } satisfies SetCommand<MockId, V>;
const CMD_DEL = { type: SetCommandType.Update, payload: { add: [VALUE1], del: [VALUE1, VALUE2] }, root: ROOT, nonce: '4' } satisfies SetCommand<MockId, V>;

const hash = (value: V) => `${value}`;

describe('ORSet', () => {
  let keySet: BTreeSet<MockId>;
  let dataMap: BTreeMap<MultimapKey<MockId>, V>;
  let store: MapStore<MockId, V>;
  let command: SetCommandHandler<MockId, V>;
  let projection: SetProjection<MockId, V>;

  beforeEach(() => {
    store = createDefaultMapStore();
    keySet = store.tombstone as BTreeSet<MockId>;
    dataMap = store.data as BTreeMap<MultimapKey<MockId>, V>;
    command = new ORSetCommandHandler(new ORMapCommandHandler(), hash);
    projection = new ORSetProjection(new ORMapProjection(getMockEventKey), hash);
  });

  describe(ORSetCommandHandler.name, () => {
    it('should return valid event for new empty set command', async () => {
      const event = await command.handle(store, CMD_EMPTY);
      expect(event).toEqual({
        type: SetEventType.New,
        payload: { set: [] },
        link: [],
        nonce: CMD_EMPTY.nonce,
      } satisfies SetEvent<MockId, V>);
    });

    it('should return undefined for empty set command', async () => {
      expect(await command.handle(store, { type: SetCommandType.Update, payload: {}, root: ROOT, nonce: '2' }))
        .toBeUndefined();
    });

    it('should return valid event for new set command', async () => {
      const event = await command.handle(store, CMD_NEW);
      expect(event).toEqual({
        type: SetEventType.New,
        payload: {
          set: [[VALUE0, true]],
        },
        link: [],
        nonce: CMD_NEW.nonce,
      } satisfies SetEvent<MockId, V>);
    });

    it('should return valid event for update set command with add ops', async () => {
      const event = await command.handle(store, CMD_ADD);
      expect(event).toEqual({
        type: SetEventType.Update,
        payload: {
          set: [[VALUE2, true], [VALUE1, true]]
        },
        link: [],
        root: ROOT,
        nonce: CMD_ADD.nonce,
      } satisfies SetEvent<MockId, V>);
    });

    it('should return valid event for update set command with delete ops', async () => {
      const concurrentEvent = await command.handle(store, CMD_ADD_CONCURRENT);
      await applyCommand(CMD_ADD);
      await projection.reduce(store, concurrentEvent!);
      const event = await command.handle(store, CMD_DEL);
      expect(event).toEqual({
        type: SetEventType.Update,
        payload: {
          set: [
            [VALUE2, false, 0, 1],
            [VALUE1, true, 0],
          ]
        },
        link: [getMockEventKey(CMD_ADD), getMockEventKey(CMD_ADD_CONCURRENT)],
        root: ROOT,
        nonce: CMD_DEL.nonce
      } satisfies SetEvent<MockId, V>);
    });

    it('should ignore delete operation if field does not already exist', async () => {
      await applyCommand(CMD_NEW);
      const event = await command.handle(store, CMD_DEL);
      expect(event).toEqual({
        type: SetEventType.Update,
        payload: {
          set: [[VALUE1, true]]
        },
        link: [],
        root: ROOT,
        nonce: CMD_DEL.nonce
      } satisfies SetEvent<MockId, V>);
    });
  });

  describe(ORSetProjection.name, () => {
    describe('validate', () => {
      it('should return no error for valid events', async () => {
        expect(await projection.validate(store, (await command.handle(store, CMD_NEW))!)).toBeUndefined();
        await applyCommand(CMD_NEW);
        expect(await projection.validate(store, (await command.handle(store, CMD_ADD))!)).toBeUndefined();
      });

      it('should return error for malformed events', async () => {
        expect(await projection.validate(store, {
          type: SetEventType.Update, payload: { set: [] },
          link: [], root: ROOT, nonce: '2',
        })).toEqual(new TypeError('empty operation'));

        expect(await projection.validate(store, {
          type: SetEventType.Update,
          payload: { set: [['value', true]] },
          link: [], nonce: '2',
        })).toEqual(new TypeError('missing root'));

        expect(await projection.validate(store, {
          type: SetEventType.Update,
          payload: { set: [['value', false, 0]] },
          link: [], root: ROOT, nonce: '2',
        })).toEqual(new TypeError(`invalid operation: "value"`));
      });
    });

    describe('reduce', () => {
      it('should save new set with fields correctly', async () => {
        await applyCommand();
        expect(dataMap.size).toEqual(0);

        await applyCommand(CMD_ADD);
        const eventKey = getMockEventKey(CMD_ADD);
        expect(dataMap.size).toEqual(2);
        expect(dataMap.get([ROOT, `${VALUE1}`, eventKey])).toEqual(VALUE1);
        expect(dataMap.get([ROOT, `${VALUE2}`, eventKey])).toEqual(VALUE2);
      });

      it('should keep concurrent updates', async () => {
        await applyCommand(CMD_NEW);
        const cmd1 = await command.handle(store, CMD_ADD);
        const cmd2 = await command.handle(store, CMD_ADD_CONCURRENT);
        await projection.reduce(store, cmd1!);
        await projection.reduce(store, cmd2!);

        const event0Key = getMockEventKey(CMD_NEW);
        const event1Key = getMockEventKey(CMD_ADD);
        const event2Key = getMockEventKey(CMD_ADD_CONCURRENT);

        expect(dataMap.size).toEqual(5);
        expect(dataMap.get([ROOT, `${VALUE0}`, event0Key])).toEqual(VALUE0);
        expect(dataMap.get([ROOT, `${VALUE1}`, event1Key])).toEqual(VALUE1);
        expect(dataMap.get([ROOT, `${VALUE2}`, event1Key])).toEqual(VALUE2);
        expect(dataMap.get([ROOT, `${VALUE2}`, event2Key])).toEqual(VALUE2);
        expect(dataMap.get([ROOT, `${VALUE3}`, event2Key])).toEqual(VALUE3);
      });

      it('should remove all concurrent values on delete', async () => {
        const cmd1 = await command.handle(store, CMD_ADD);
        const cmd2 = await command.handle(store, CMD_ADD_CONCURRENT);
        await projection.reduce(store, cmd1!);
        await projection.reduce(store, cmd2!);
        await applyCommand(CMD_DEL);

        const event1Key = getMockEventKey(CMD_ADD);
        const event2Key = getMockEventKey(CMD_ADD_CONCURRENT);
        const event3Key = getMockEventKey(CMD_DEL);

        expect(keySet.size).toEqual(3);
        expect(keySet.has(getMockEventKey(CMD_EMPTY))).toBe(true);
        expect(keySet.has(event1Key)).toBe(true);
        expect(keySet.has(event2Key)).toBe(true);

        expect(dataMap.size).toEqual(2);
        expect(dataMap.get([ROOT, `${VALUE1}`, event3Key])).toEqual(VALUE1);
        expect(dataMap.get([ROOT, `${VALUE3}`, event2Key])).toEqual(VALUE3);
      });

      it('should throw error for malformed events when validate = true', async () => {
        await expect(() => projection.reduce(store, {
          type: SetEventType.Update,
          payload: { set: [] }, link: [], nonce: '1',
        })).rejects.toEqual(new TypeError('missing root'));
      });
    });
  });

  describe(ORSetRangeQueryResolver.name, () => {
    let resolver: SetRangeQueryResolver<MockId, V>;

    beforeEach(() => {
      resolver = new ORSetRangeQueryResolver(new ORMapRangeQueryResolver(), hash);
    })

    it('should return empty result for empty / undefined sets', async () => {
      await applyCommand();
      for await (const _ of resolver.resolve(store, { root: ROOT })) {
        throw new Error('should not be called');
      }
    });

    it.each(
      [
        [[CMD_ADD], { root: ROOT }, [VALUE2, VALUE1]],
        [[CMD_ADD, CMD_ADD_CONCURRENT], { root: ROOT }, [VALUE2, VALUE3, VALUE1]],
        [[CMD_ADD, CMD_ADD_CONCURRENT], { root: ROOT, limit: 2 }, [VALUE2, VALUE3]],
        [[CMD_ADD, CMD_ADD_CONCURRENT], { root: ROOT, limit: 2, reverse: true }, [VALUE1, VALUE3]],
        [[CMD_ADD, CMD_ADD_CONCURRENT, CMD_DEL], { root: ROOT, lower: VALUE2, upper: VALUE1, upperOpen: false }, [VALUE3, VALUE1]],
      ] satisfies [SetCommand<MockId, V>[], SetRangeQuery<MockId, V>, V[]][]
    )('should return correct results for non-empty sets', async (cmds, query, expected) => {
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

    it('should return concurrent values on concurrent updates', async () => {
      await applyCommand();
      const concurrentEvent = await command.handle(store, CMD_ADD_CONCURRENT);
      await applyCommand(CMD_ADD);
      await projection.reduce(store, concurrentEvent!);

      const results = [];
      for await (const entry of resolver.resolve(store, { root: ROOT })) {
        results.push(entry);
      }
      expect(results).toEqual([VALUE2, VALUE2, VALUE3, VALUE1]);
    });
  });

  async function applyCommand(cmd: SetCommand<MockId, V> = CMD_EMPTY) {
    return await projection.reduce(store, (await command.handle(store, cmd))!);
  }
});
