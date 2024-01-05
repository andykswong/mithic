import { beforeEach, describe, expect, it } from '@jest/globals';
import { MapTripleStore } from '@mithic/triplestore';
import { DefaultEntityStore, EntityStore } from '../../store.js';
import { FractionalIndexGenerator } from '../../utils/index.js';
import { OREntityCommandHandler } from '../command.js';
import { OREntityProjection } from '../event.js';
import { EntityCommand, EntityCommandHandler, EntityCommandType, EntityEvent, EntityEventType, EntityProjection } from '../interface.js';
import { MockId, getMockEventKey } from '../../__tests__/mocks.js';
import { defaultStringify } from '../../defaults.js';

type V = string | number | boolean;

const GENERATOR = new FractionalIndexGenerator(() => 0.5);

const TYPE = 'ormap';
const ROOT = new MockId(new Uint8Array(1));
const FIELD0 = 'field0';
const FIELD1 = 'field1';
const FIELD2 = 'field2';
const FIELD3 = 'field3';
const VALUE0 = 'v0';
const VALUE1 = 'v1';
const VALUE2 = 123;
const VALUE22 = 456;
const VALUE3 = true;
const VALUE32 = false;
const [INDEX0, INDEX1] = [...GENERATOR.create(void 0, void 0, 2)];
const [INDEXSD1, INDEXSD2] = [...GENERATOR.create(void 0, INDEX0, 2)];

const CMD_EMPTY = {
  type: EntityCommandType.Update, nonce: '1',
  payload: { cmd: {}, type: TYPE }
} satisfies EntityCommand<MockId, V>;
const CMD_NEW = {
  type: EntityCommandType.Update, nonce: '1',
  payload: { cmd: { [FIELD0]: { set: VALUE0 } }, type: TYPE }
} satisfies EntityCommand<MockId, V>;
const CMD_ADD = {
  type: EntityCommandType.Update, nonce: '3', root: ROOT,
  payload: { cmd: { [FIELD1]: { set: VALUE1 }, [FIELD2]: { add: [VALUE2, VALUE3] } }, type: TYPE }
} satisfies EntityCommand<MockId, V>;
const CMD_ADD2 = {
  type: EntityCommandType.Update, nonce: '4', root: ROOT,
  payload: { cmd: { [FIELD3]: { add: [VALUE2, VALUE3] } }, type: TYPE }
} satisfies EntityCommand<MockId, V>;
const CMD_UPDEL = {
  type: EntityCommandType.Update, nonce: '5', root: ROOT,
  payload: { cmd: { [FIELD1]: { del: true }, [FIELD2]: { set: VALUE22 }, [FIELD3]: { add: [VALUE32], del: [VALUE3] } }, type: TYPE }
} satisfies EntityCommand<MockId, V>;
const CMD_SPLICE = {
  type: EntityCommandType.Update, nonce: '7', root: ROOT,
  payload: { cmd: { [FIELD1]: { splice: ['', 0, VALUE0, VALUE1] } }, type: TYPE }
} satisfies EntityCommand<MockId, V>;
const CMD_SPLICE2 = {
  type: EntityCommandType.Update, nonce: '11', root: ROOT,
  payload: { cmd: { [FIELD1]: { splice: ['', 0, VALUE2, VALUE3] } }, type: TYPE }
} satisfies EntityCommand<MockId, V>;
const CMD_SPLICE_DEL = {
  type: EntityCommandType.Update, nonce: '13', root: ROOT,
  payload: { cmd: { [FIELD1]: { splice: [INDEX0, 2, VALUE1, VALUE3] } }, type: TYPE }
} satisfies EntityCommand<MockId, V>;

describe(OREntityCommandHandler.name, () => {
  let store: MapTripleStore<MockId, V>;
  let state: EntityStore<MockId, V>;
  let command: EntityCommandHandler<MockId, V>;
  let projection: EntityProjection<MockId, V>;

  beforeEach(() => {
    store = new MapTripleStore();
    state = new DefaultEntityStore<MockId, V>((type) => {
      expect(type).toBe(TYPE);
      return store;
    });
    command = new OREntityCommandHandler<MockId, V>(defaultStringify, GENERATOR);
    projection = new OREntityProjection(getMockEventKey);
  });

  it('should return valid event for new empty entity command', async () => {
    const event = await command.handle(state, CMD_EMPTY);
    expect(event).toEqual({
      type: EntityEventType.New, nonce: CMD_EMPTY.nonce,
      payload: { ops: [], type: TYPE }, link: [],
    } satisfies EntityEvent<MockId, V>);
  });

  it('should return undefined for empty command', async () => {
    expect(await command.handle(state, { type: EntityCommandType.Update, payload: { cmd: {} }, root: ROOT, nonce: '1' }))
      .toBeUndefined();
  });

  it('should return valid event for set new entity command', async () => {
    const event = await command.handle(state, CMD_NEW);
    expect(event).toEqual({
      type: EntityEventType.New, nonce: CMD_NEW.nonce,
      payload: { ops: [[FIELD0, `"${VALUE0}"`, VALUE0]], type: TYPE }, link: [],
    } satisfies EntityEvent<MockId, V>);
  });

  it('should return valid event for update entity command', async () => {
    const event = await command.handle(state, CMD_ADD);
    expect(event).toEqual({
      type: EntityEventType.Update, root: ROOT, nonce: CMD_ADD.nonce, link: [],
      payload: {
        ops: [[FIELD1, `"${VALUE1}"`, VALUE1], [FIELD2, `${VALUE2}`, VALUE2], [FIELD2, `${VALUE3}`, VALUE3]],
        type: TYPE,
      },
    } satisfies EntityEvent<MockId, V>);
  });

  it('should return valid event for update/delete entity command', async () => {
    await applyCommands(CMD_ADD, CMD_ADD2);

    const event = await command.handle(state, CMD_UPDEL);
    expect(event).toEqual({
      type: EntityEventType.Update, root: ROOT, nonce: CMD_UPDEL.nonce,
      payload: {
        ops: [
          [FIELD1, `"${VALUE1}"`, null, 0],
          [FIELD2, `${VALUE2}`, null, 0],
          [FIELD2, `${VALUE22}`, VALUE22],
          [FIELD2, `${VALUE3}`, null, 0],
          [FIELD3, `${VALUE32}`, VALUE32],
          [FIELD3, `${VALUE3}`, null, 1],
        ],
        type: TYPE,
      },
      link: [getMockEventKey(CMD_ADD), getMockEventKey(CMD_ADD2)],
    } satisfies EntityEvent<MockId, V>);
  });

  it('should ignore delete operation if attribute does not already exist', async () => {
    await applyCommands(CMD_ADD2);
    const event = await command.handle(state, CMD_UPDEL);
    expect(event).toEqual({
      type: EntityEventType.Update, root: ROOT, nonce: CMD_UPDEL.nonce,
      payload: {
        ops: [
          [FIELD2, `${VALUE22}`, VALUE22],
          [FIELD3, `${VALUE32}`, VALUE32],
          [FIELD3, `${VALUE3}`, null, 0],
        ],
        type: TYPE,
      },
      link: [getMockEventKey(CMD_ADD2)],
    } satisfies EntityEvent<MockId, V>);
  });

  it('should return valid event for splice command', async () => {
    const event = await command.handle(state, CMD_SPLICE);
    expect(event).toEqual({
      type: EntityEventType.Update, root: ROOT, nonce: CMD_SPLICE.nonce, link: [],
      payload: {
        ops: [[FIELD1, INDEX0, VALUE0], [FIELD1, INDEX1, VALUE1]],
        type: TYPE,
      },
    } satisfies EntityEvent<MockId, V>);
  });

  it('should return valid event for splice update command', async () => {
    const concurrentEvent = await command.handle(state, CMD_SPLICE2);
    await applyCommands(CMD_SPLICE);
    await projection.reduce(state, concurrentEvent!);

    const event = await command.handle(state, CMD_SPLICE_DEL);
    expect(event).toEqual({
      type: EntityEventType.Update, root: ROOT, nonce: CMD_SPLICE_DEL.nonce,
      payload: {
        ops: [
          [FIELD1, INDEXSD1, VALUE1],
          [FIELD1, INDEXSD2, VALUE3],
          [FIELD1, INDEX0, null, 0, 1],
        ],
        type: TYPE,
      },
      link: [getMockEventKey(CMD_SPLICE), getMockEventKey(CMD_SPLICE2)],
    } satisfies EntityEvent<MockId, V>);
  });

  it('should ignore splice delete operation if nothing can be deleted', async () => {
    const event = await command.handle(state, CMD_SPLICE_DEL);
    expect(event).toEqual({
      type: EntityEventType.Update, root: ROOT, nonce: CMD_SPLICE_DEL.nonce, link: [],
      payload: {
        ops: [[FIELD1, INDEXSD1, VALUE1], [FIELD1, INDEXSD2, VALUE3]],
        type: TYPE,
      },
    } satisfies EntityEvent<MockId, V>);
  });

  async function applyCommands(...cmds: EntityCommand<MockId, V>[]) {
    for (const cmd of cmds) {
      await projection.reduce(state, (await command.handle(state, cmd))!);
    }
  }
});
