import { jest } from '@jest/globals';
import { EventConsumer } from '../../event.js';
import { SimpleEventBus } from '../simple.js';

const EVENT = 'testEvent';

describe(SimpleEventBus.name, () => {
  let eventBus: SimpleEventBus<string>;

  beforeEach(() => {
    eventBus = new SimpleEventBus();
  });

  it('should dispatch event using underlying event emitter', () => {
    const emitSpy = jest.spyOn(eventBus['emitter'], 'emit');
    eventBus.dispatch(EVENT);
    expect(emitSpy).toHaveBeenCalledWith(eventBus['eventName'], EVENT);
  });

  it('should subscribe to event using underlying event emitter', () => {
    const addListenerSpy = jest.spyOn(eventBus['emitter'], 'addListener');
    const callback = jest.fn<EventConsumer<string>>();
    eventBus.subscribe(callback);
    expect(addListenerSpy).toHaveBeenCalledWith(eventBus['eventName'], callback);
  });

  it('should unsubscribe from event using underlying event emitter', () => {
    const removeListenerSpy = jest.spyOn(eventBus['emitter'], 'removeListener');
    const callback = jest.fn<EventConsumer<string>>();
    const subscription = eventBus.subscribe(callback);
    subscription();
    expect(removeListenerSpy).toHaveBeenCalledWith(eventBus['eventName'], callback);
  });
});
