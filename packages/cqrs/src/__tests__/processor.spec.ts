import { jest } from '@jest/globals';
import { EventConsumer, EventSubscription, Unsubscribe } from '../event.js';
import { SimpleEventBus } from '../index.js';
import { EventProcessor } from '../processor.js';

describe(EventProcessor.name, () => {
  let subscription: EventSubscription<string>;
  let mockConsumer: jest.MockedFunction<EventConsumer<string>>;
  let eventProcessor: EventProcessor<string>;

  beforeEach(() => {
    subscription = new SimpleEventBus();
    mockConsumer = jest.fn();
    eventProcessor = new EventProcessor(subscription, mockConsumer);
  });

  describe('start', () => {
    it('should subscribe consumer and set started to true', async () => {
      const subscribeSpy = jest.spyOn(subscription, 'subscribe');
      const mockOptions = { signal: undefined };

      await eventProcessor.start(mockOptions);

      expect(eventProcessor.started).toBe(true);
      expect(subscribeSpy).toHaveBeenCalledWith(mockConsumer, mockOptions);
    });
  });

  describe('close', () => {
    it('should unsubscribe consumer and set started to false', async () => {
      const mockOptions = { signal: undefined };

      await eventProcessor.start();
      const unsubscribeSpy = jest.fn<Unsubscribe>(eventProcessor['handle']);
      eventProcessor['handle'] = unsubscribeSpy;

      await eventProcessor.close(mockOptions);

      expect(eventProcessor.started).toBe(false);
      expect(unsubscribeSpy).toHaveBeenCalledWith(mockOptions);
    });
  });
});
