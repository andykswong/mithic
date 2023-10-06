import { jest } from '@jest/globals';
import { TypedCustomEvent, TypedEventHandlerFn, createEvent } from '@mithic/commons';
import { MessageHandler } from '../../messaging.js';
import { EventTargetMessageBus } from '../eventtarget.js';
import { MessageValidationError } from '../../error.js';

const TOPIC = 'testTopic';
const MSG = 'testEvent';

describe(EventTargetMessageBus.name, () => {
  let eventBus: EventTargetMessageBus<string>;

  beforeEach(() => {
    eventBus = new EventTargetMessageBus();
  });

  describe('dispatch', () => {
    it('should dispatch message using underlying event dispatcher', () => {
      const dispatch = jest.spyOn(eventBus['dispatcher'], 'dispatchEvent').mockImplementationOnce(() => true);
      eventBus.dispatch(MSG);
      expect(dispatch).toHaveBeenCalledWith(createEvent(eventBus['defaultTopic'], MSG));
    });
  });

  describe('subscribe', () => {
    it('should subscribe to underlying event dispatcher using default topic', () => {
      const addListenerSpy = jest.spyOn(eventBus['dispatcher'], 'addEventListener');
      const callback = jest.fn<MessageHandler<string>>();
      eventBus.subscribe(callback);
      expect(addListenerSpy).toHaveBeenCalledWith(eventBus['defaultTopic'], expect.anything());
      (addListenerSpy.mock.calls[0][1] as TypedEventHandlerFn<TypedCustomEvent<string, string>>)(
        createEvent(eventBus['defaultTopic'], MSG)
      );
      expect(callback).toHaveBeenCalledWith(MSG, { topic: eventBus['defaultTopic'] });
    });

    it('should subscribe to underlying event dispatcher using given topic', () => {
      const addListenerSpy = jest.spyOn(eventBus['dispatcher'], 'addEventListener');
      const callback = jest.fn<MessageHandler<string>>();
      eventBus.subscribe(callback, { topic: TOPIC });
      expect(addListenerSpy).toHaveBeenCalledWith(TOPIC, expect.anything());
      (addListenerSpy.mock.calls[0][1] as TypedEventHandlerFn<TypedCustomEvent<string, string>>)(
        createEvent(TOPIC, MSG)
      );
      expect(callback).toHaveBeenCalledWith(MSG, { topic: TOPIC });
    });

    it('should use given validator to validate messages before passing to handler', () => {
      const addListenerSpy = jest.spyOn(eventBus['dispatcher'], 'addEventListener');
      const callback = jest.fn<MessageHandler<string>>();
      eventBus.subscribe(callback, { topic: TOPIC, validator: () => new MessageValidationError() });
      expect(addListenerSpy).toHaveBeenCalledWith(TOPIC, expect.anything());
      (addListenerSpy.mock.calls[0][1] as TypedEventHandlerFn<TypedCustomEvent<string, string>>)(
        createEvent(TOPIC, MSG)
      );
      expect(callback).not.toHaveBeenCalled();
    });

    it('should return a function that unsubscribes handler from underlying event dispatcher', () => {
      const addListenerSpy = jest.spyOn(eventBus['dispatcher'], 'addEventListener');
      const removeListenerSpy = jest.spyOn(eventBus['dispatcher'], 'removeEventListener');
      const callback = jest.fn<MessageHandler<string>>();
      const subscription = eventBus.subscribe(callback);
      expect(addListenerSpy).toHaveBeenCalledWith(eventBus['defaultTopic'], expect.anything());
      const listener = addListenerSpy.mock.calls[0][1];
      subscription();
      expect(removeListenerSpy).toHaveBeenCalledWith(eventBus['defaultTopic'], listener);
    });
  });
});
