import { jest } from '@jest/globals';
import { SimpleAggregateStore, createAggregateStore } from '../aggregate.js';
import { SimpleMessageBus } from '../../bus/index.js';

interface TestEvent {
  type: 'add';
  payload: number;
}

describe(createAggregateStore.name, () => {
  it('should create a store', () => {
    const store = createAggregateStore({
      aggregate: {
        command: {
          create: jest.fn(),
        },
        reduce: jest.fn(),
        validate: async () => undefined,
      },
      initialState: {},
    });
    expect(store).toBeInstanceOf(SimpleAggregateStore);
  });

  it('should dispatch a command and update state', async () => {
    const bus = new SimpleMessageBus<TestEvent>();
    const dispatchSpy = jest.spyOn(bus, 'dispatch');

    const store = createAggregateStore({
      aggregate: {
        command: {
          add: (model: number, payload: number) => ({ type: 'add' as const, payload: model + payload }),
        },
        reduce: (model: number, event: TestEvent) => model + event.payload,
        validate: async () => undefined,
      },
      initialState: 1,
      bus,
    });
    await store.start();

    await store.command.add(123);
    expect(dispatchSpy).toHaveBeenCalledWith({ type: 'add', payload: 124 });
    expect(store.getState()).toBe(125);

    await store.close();
  });
});
