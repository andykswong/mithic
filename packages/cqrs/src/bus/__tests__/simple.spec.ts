import { jest } from '@jest/globals';
import { MessageConsumer } from '../../bus.js';
import { SimpleMessageBus } from '../simple.js';

const EVENT = 'testEvent';

describe(SimpleMessageBus.name, () => {
  let eventBus: SimpleMessageBus<string>;

  beforeEach(() => {
    eventBus = new SimpleMessageBus();
  });

  it('should dispatch message using underlying event emitter', () => {
    const emitSpy = jest.spyOn(eventBus['emitter'], 'emit');
    eventBus.dispatch(EVENT);
    expect(emitSpy).toHaveBeenCalledWith(eventBus['eventName'], EVENT);
  });

  it('should subscribe to message using underlying event emitter', () => {
    const addListenerSpy = jest.spyOn(eventBus['emitter'], 'addListener');
    const callback = jest.fn<MessageConsumer<string>>();
    eventBus.subscribe(callback);
    expect(addListenerSpy).toHaveBeenCalledWith(eventBus['eventName'], callback);
  });

  it('should unsubscribe from message using underlying event emitter', () => {
    const removeListenerSpy = jest.spyOn(eventBus['emitter'], 'removeListener');
    const callback = jest.fn<MessageConsumer<string>>();
    const subscription = eventBus.subscribe(callback);
    subscription();
    expect(removeListenerSpy).toHaveBeenCalledWith(eventBus['eventName'], callback);
  });
});
