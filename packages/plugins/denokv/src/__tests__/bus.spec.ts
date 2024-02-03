import { Kv, openKv } from '@deno/kv';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { delay } from '@mithic/commons';
import { MessageValidationError } from '@mithic/messaging';
import { DenoKVMessage, DenoKVMessageBus } from '../bus.ts';

const TOPIC = 'testTopic';
const TOPIC2 = 'testTopic2';
const DATA = 'data';
const DATA2 = 'data2';
const OPTIONS = { signal: AbortSignal.timeout(100) };

describe(DenoKVMessageBus.name, () => {
  let bus: DenoKVMessageBus;
  let kv: Kv;

  beforeEach(async () => {
    kv = await openKv();
    bus = new DenoKVMessageBus(kv);
  });

  afterEach(() => {
    bus.close();
  });

  describe('close', () => {
    it('should close underlying Kv', async () => {
      const closeSpy = jest.spyOn(kv, 'close');
      bus.close();
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(bus['started']).toBe(false);
    });
  });

  describe('dispatch', () => {
    it('should dispatch to Deno message queue', async () => {
      const delay = 100;
      const keysIfUndelivered = [['a', 1], ['b', 2]];

      const enqueueSpy = jest.spyOn(kv, 'enqueue');
      await bus.dispatch(DATA, { topic: TOPIC, delay, keysIfUndelivered, ...OPTIONS });
      expect(enqueueSpy).toHaveBeenCalledWith(
        { topic: TOPIC, data: DATA } satisfies DenoKVMessage<string>,
        { delay, keysIfUndelivered }
      );
    });

    it('should use defaultTopic if topic is not specified', async () => {
      const enqueueSpy = jest.spyOn(kv, 'enqueue');
      await bus.dispatch(DATA, OPTIONS);
      expect(enqueueSpy).toHaveBeenCalledWith(
        { topic: bus.defaultTopic, data: DATA } satisfies DenoKVMessage<string>,
        { delay: undefined, keysIfUndelivered: undefined }
      );
    });
  });

  describe('subscribe', () => {
    it('should subscribe to Deno message queue', async () => {
      const listenQueueSpy = jest.spyOn(kv, 'listenQueue');
      const validator = jest.fn(() => undefined as MessageValidationError | undefined);
      const handler = jest.fn(() => undefined);

      await bus.subscribe(handler, { topic: TOPIC, validator });
      await delay();

      expect(listenQueueSpy).toHaveBeenCalledWith(bus['handle']);
      expect(bus['listened']).toBe(true);

      validator
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(new MessageValidationError());

      await kv.enqueue({ topic: TOPIC, data: DATA });
      await delay();
      expect(validator).toHaveBeenCalledWith(DATA, { topic: TOPIC });
      expect(handler).toHaveBeenCalledWith(DATA, { topic: TOPIC });

      await kv.enqueue({ topic: TOPIC, data: DATA2 });
      await delay();
      expect(validator).toHaveBeenCalledWith(DATA2, { topic: TOPIC });
      expect(handler).not.toHaveBeenCalledWith(DATA2, { topic: TOPIC });
    });

    it('should return a function to unsubscribe', async () => {
      const unsubscribe = await bus.subscribe(jest.fn(() => undefined), { topic: TOPIC });
      expect(bus['topicHandlers'].get(TOPIC)?.length).toBe(1);
      await unsubscribe();
      expect(bus['topicHandlers'].get(TOPIC)).toBeUndefined();
    });
  });

  describe('topics', () => {
    it('should return available topics from underlying pubsub', () => {
      const topics = [TOPIC, TOPIC2];
      bus['topicHandlers'].set(TOPIC, [() => { }]);
      bus['topicHandlers'].set(TOPIC2, [() => { }]);

      expect([...bus.topics()]).toEqual(topics);
    });
  });
});
