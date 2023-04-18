import { jest } from '@jest/globals';
import { EventEmitter as NodeEventEmitter } from 'events';
import { delay } from '../async/index.js';
import { EventEmitter, EventHandler, TypedEventEmitter, consumer } from '../event.js';

describe('TypedEventEmitter', () => {
  it('should be compatible with EventEmitter from node:events', () => {
    const _ = new NodeEventEmitter() as TypedEventEmitter<{ test: [] }>;
  });
});

describe(EventEmitter.name, () => {
  const TYPE = 'test';
  const TYPE2 = 'test2';

  it('should add listener correctly', () => {
    const emitter = new EventEmitter<{ [TYPE]: [string] }>();
    const addListenerSpy = jest.spyOn(emitter['emitter'], 'addListener');
    const listener = jest.fn<EventHandler<[string]>>();

    expect(emitter.addListener(TYPE, listener)).toBe(emitter);
    expect(addListenerSpy).toHaveBeenCalledWith(TYPE, listener);
  });

  it('should remove listener correctly', () => {
    const emitter = new EventEmitter<{ [TYPE]: [string] }>();
    const removeListenerSpy = jest.spyOn(emitter['emitter'], 'removeListener');
    const listener = jest.fn<EventHandler<[string]>>();

    expect(emitter.removeListener(TYPE, listener)).toBe(emitter);
    expect(removeListenerSpy).toHaveBeenCalledWith(TYPE, listener);
  });

  it('should remove all listeners correctly', () => {
    const emitter = new EventEmitter<{ [TYPE]: [string] }>();
    const removeAllListenersSpy = jest.spyOn(emitter['emitter'], 'removeAllListeners');

    expect(emitter.removeAllListeners(TYPE)).toBe(emitter);
    expect(removeAllListenersSpy).toHaveBeenCalledWith(TYPE);

    expect(emitter.removeAllListeners()).toBe(emitter);
    expect(removeAllListenersSpy).toHaveBeenLastCalledWith(undefined);
  });

  it('should dispatch events correctly', () => {
    const emitter = new EventEmitter<{ [TYPE]: [string];[TYPE2]: [number, boolean]; }>();
    const listener = jest.fn<EventHandler<[number]>>();

    emitter.addListener(TYPE2, listener);

    expect(emitter.emit(TYPE, 'test')).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    const event2 = [123, true] as const;
    expect(emitter.emit(TYPE2, ...event2)).toBe(true);
    expect(listener).toHaveBeenCalledWith(...event2);
  });
});

describe('consumer', () => {
  it('should execute the entire coroutine', () => {
    expect.assertions(5);

    const consumerFn = consumer<number>(function* () {
      const _ = 3 + 5; // just do some work
      const b = yield;
      expect(b).toBe(1);
      const c = yield;
      expect(c).toBe(2);
    });

    expect(consumerFn(1).done).toBe(false);
    expect(consumerFn(2).done).toBe(true);
    expect(consumerFn(3).done).toBe(true);
  });

  it('should handle async coroutines', async () => {
    expect.assertions(5);

    const consumerFn = consumer<number>(async function* () {
      await delay(); // just do some work
      const b = yield;
      expect(b).toBe(1);
      await delay(); // just do some work
      const c = yield;
      expect(c).toBe(2);
      await delay(); // just do some work
    });

    await expect(consumerFn(1)).resolves.toEqual({ done: false, value: undefined });
    await expect(consumerFn(2)).resolves.toEqual({ done: true, value: undefined });
    await expect(consumerFn(3)).resolves.toEqual({ done: true, value: undefined });
  });
});
