import { jest } from '@jest/globals';
import { TypedCustomEvent, TypedEventHandlerFn, createEvent } from '@mithic/commons';
import { MessageConsumer } from '../../bus.js';
import { SimpleMessageBus } from '../simple.js';

const MSG = 'testEvent';

describe(SimpleMessageBus.name, () => {
  let eventBus: SimpleMessageBus<string>;

  beforeEach(() => {
    eventBus = new SimpleMessageBus();
  });

  it('should dispatch message using underlying event dispatcher', () => {
    const dispatch = jest.spyOn(eventBus['dispatcher'], 'dispatchEvent').mockImplementationOnce(() => true);
    eventBus.dispatch(MSG);
    expect(dispatch).toHaveBeenCalledWith(createEvent(eventBus['eventName'], MSG));
  });

  it('should subscribe to message using underlying event dispatcher', () => {
    const addListenerSpy = jest.spyOn(eventBus['dispatcher'], 'addEventListener');
    const callback = jest.fn<MessageConsumer<string>>();
    eventBus.subscribe(callback);
    expect(addListenerSpy).toHaveBeenCalledWith(eventBus['eventName'], expect.anything());
    (addListenerSpy.mock.calls[0][1] as TypedEventHandlerFn<TypedCustomEvent<string, string>>)(
      createEvent(eventBus['eventName'], MSG)
    );
    expect(callback).toHaveBeenCalledWith(MSG);
  });

  it('should unsubscribe from message using underlying event dispatcher', () => {
    const addListenerSpy = jest.spyOn(eventBus['dispatcher'], 'addEventListener');
    const removeListenerSpy = jest.spyOn(eventBus['dispatcher'], 'removeEventListener');
    const callback = jest.fn<MessageConsumer<string>>();
    const subscription = eventBus.subscribe(callback);
    expect(addListenerSpy).toHaveBeenCalledWith(eventBus['eventName'], expect.anything());
    const listener = addListenerSpy.mock.calls[0][1];
    subscription();
    expect(removeListenerSpy).toHaveBeenCalledWith(eventBus['eventName'], listener);
  });
});
