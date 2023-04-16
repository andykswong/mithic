import { jest } from '@jest/globals';
import { EventEmitter as NodeEventEmitter } from 'events';
import { EventEmitter, EventHandler, TypedEventEmitter } from '../event.js';

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
    const listener: EventHandler<[string]> = jest.fn();

    expect(emitter.addListener(TYPE, listener)).toBe(emitter);
    expect(addListenerSpy).toHaveBeenCalledWith(TYPE, listener);
  });
  
  it('should remove listener correctly', () => {
    const emitter = new EventEmitter<{ [TYPE]: [string] }>();
    const removeListenerSpy = jest.spyOn(emitter['emitter'], 'removeListener');
    const listener: EventHandler<[string]> = jest.fn();

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
    const emitter = new EventEmitter<{ [TYPE]: [string]; [TYPE2]: [number, boolean]; }>();
    const listener: EventHandler<[number]> = jest.fn();

    emitter.addListener(TYPE2, listener);

    expect(emitter.emit(TYPE, 'test')).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    const event2 = [123, true] as const;
    expect(emitter.emit(TYPE2, ...event2)).toBe(true);
    expect(listener).toHaveBeenCalledWith(...event2);
  });
});
