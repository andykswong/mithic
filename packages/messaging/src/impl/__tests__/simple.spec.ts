import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { SimpleMessageBus } from '../simple.ts';
import { MessageValidationError } from '../../error.ts';

const TOPIC = 'testTopic';
const MSG = 'testEvent';

describe(SimpleMessageBus.name, () => {
  let bus: SimpleMessageBus<string>;

  beforeEach(() => {
    bus = new SimpleMessageBus();
  });

  describe('dispatch', () => {
    it('should dispatch message to `defaultTopic` topic by default', () => {
      const callback = jest.fn(() => undefined);
      bus['handlers'].set(bus['defaultTopic'], [callback]);
      bus.dispatch(MSG);
      expect(callback).toHaveBeenCalledWith(MSG, { topic: bus['defaultTopic'] });
    });

    it('should dispatch message to correct topic', () => {
      const callback = jest.fn(() => undefined);
      const callback2 = jest.fn(() => undefined);
      bus['handlers'].set(TOPIC, [callback, callback2]);
      bus.dispatch(MSG, { topic: TOPIC });
      expect(callback).toHaveBeenCalledWith(MSG, { topic: TOPIC });
      expect(callback2).toHaveBeenCalledWith(MSG, { topic: TOPIC });
    });

    it('should throw error from handlers', () => {
      const error = new Error('test error');
      const callback = jest.fn(() => { throw error; });
      bus.subscribe(callback);
      expect(() => bus.dispatch(MSG)).toThrow(error);
    });
  });

  describe('subscribe', () => {
    it('should subscribe to `defaultTopic` topic by default', () => {
      const callback = jest.fn(() => undefined);
      bus.subscribe(callback);
      const registeredCallbacks = bus['handlers'].get(bus['defaultTopic']);
      expect(registeredCallbacks?.length).toBe(1);
      registeredCallbacks?.[0](MSG, { topic: bus['defaultTopic'] });
      expect(callback).toHaveBeenCalledWith(MSG, { topic: bus['defaultTopic'] });
    });

    it('should subscribe to the correct topic', () => {
      const callback = jest.fn(() => undefined);
      bus.subscribe(callback, { topic: TOPIC });
      const registeredCallbacks = bus['handlers'].get(TOPIC);
      expect(registeredCallbacks?.length).toBe(1);
      registeredCallbacks?.[0](MSG, { topic: TOPIC });
      expect(callback).toHaveBeenCalledWith(MSG, { topic: TOPIC });
    });

    it('should use given validator to validate messages before passing to handler', () => {
      const callback = jest.fn(() => undefined);
      bus.subscribe(callback, { topic: TOPIC, validator: () => new MessageValidationError() });
      bus['handlers'].get(TOPIC)?.[0](MSG, { topic: TOPIC });
      expect(callback).not.toHaveBeenCalled();
    });

    it('should return a function that unsubscribes handler from underlying event dispatcher', () => {
      const callback = jest.fn(() => undefined);
      const callback2 = jest.fn(() => undefined);
      const subscription = bus.subscribe(callback, { topic: TOPIC });
      bus.subscribe(callback2, { topic: TOPIC });
      expect(bus['handlers'].get(TOPIC)?.length).toBe(2);
      subscription();
      expect(bus['handlers'].get(TOPIC)?.length).toBe(1);
      bus['handlers'].get(TOPIC)?.[0](MSG, { topic: TOPIC });
      expect(callback).not.toHaveBeenCalled();
    });
  });
});
