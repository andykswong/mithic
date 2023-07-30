import { jest } from '@jest/globals';
import { delay } from '../async/index.js';
import { EventDispatcher, TypedCustomEvent, TypedEvent, TypedEventTarget, consumer, createEvent } from '../event.js';

enum Events {
  Test = 'test',
  Test2 = 'test2'
}

describe('EventDispatcher', () => {
  it('should be compatible with EventTarget', () => {
    const _ = new EventTarget() as EventDispatcher<[TypedEvent<Events.Test>]>;
  });
});

describe(TypedEventTarget.name, () => {
  it('should dispatch events correctly', () => {
    const target = new TypedEventTarget<[TypedCustomEvent<Events.Test, string>, TypedCustomEvent<Events.Test2, number>]>();
    const listener = jest.fn<(event: TypedCustomEvent<Events.Test2, number>) => void>();

    target.addEventListener(Events.Test2, listener);

    expect(target.dispatchEvent(createEvent(Events.Test, 'testing'))).toBe(true);
    expect(listener).not.toHaveBeenCalled();

    const event2 = createEvent(Events.Test2, 123);
    expect(target.dispatchEvent(event2)).toBe(true);
    expect(listener).toHaveBeenCalledWith(event2);
  });

  it('should remove listener correctly', () => {
    const target = new TypedEventTarget<[TypedCustomEvent<Events.Test, string>]>();
    const listener = jest.fn<(event: TypedCustomEvent<Events.Test, string>) => void>();
    target.addEventListener(Events.Test, listener);
    target.removeEventListener(Events.Test, listener);

    expect(target.dispatchEvent(createEvent(Events.Test, 'testing'))).toBe(true);
    expect(listener).not.toHaveBeenCalled();
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

    expect(consumerFn(1)).toEqual({ done: false, value: undefined });
    expect(consumerFn(2)).toEqual({ done: true, value: undefined });
    expect(consumerFn(3)).toEqual({ done: true, value: undefined });
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
