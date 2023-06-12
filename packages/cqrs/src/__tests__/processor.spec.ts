import { jest } from '@jest/globals';
import { MessageConsumer, MessageSubscription, Unsubscribe } from '../bus.js';
import { SimpleMessageBus } from '../bus/index.js';
import { MessageProcessor } from '../processor.js';

describe(MessageProcessor.name, () => {
  let subscription: MessageSubscription<string>;
  let mockConsumer: jest.MockedFunction<MessageConsumer<string>>;
  let processor: MessageProcessor<string>;

  beforeEach(() => {
    subscription = new SimpleMessageBus();
    mockConsumer = jest.fn();
    processor = new MessageProcessor(subscription, mockConsumer);
  });

  describe('start', () => {
    it('should subscribe consumer and set started to true', async () => {
      const subscribeSpy = jest.spyOn(subscription, 'subscribe');
      const mockOptions = { signal: undefined };

      await processor.start(mockOptions);

      expect(processor.started).toBe(true);
      expect(subscribeSpy).toHaveBeenCalledWith(mockConsumer, mockOptions);
    });
  });

  describe('close', () => {
    it('should unsubscribe consumer and set started to false', async () => {
      const mockOptions = { signal: undefined };

      await processor.start();
      const unsubscribeSpy = jest.fn<Unsubscribe>(processor['handle']);
      processor['handle'] = unsubscribeSpy;

      await processor.close(mockOptions);

      expect(processor.started).toBe(false);
      expect(unsubscribeSpy).toHaveBeenCalledWith(mockOptions);
    });
  });
});
