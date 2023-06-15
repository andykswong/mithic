import { ErrorName, immediate } from '@mithic/commons';
import { SimpleMessageBus } from '../simple.js';
import { AsyncSubscriber } from '../iterator.js';

describe(AsyncSubscriber.name, () => {
  let eventBus: SimpleMessageBus<number>;
  let subscriber: AsyncSubscriber<number>;

  beforeEach(() => {
    eventBus = new SimpleMessageBus();
    subscriber = new AsyncSubscriber(eventBus);
  });

  afterEach(async () => {
    await subscriber.close();
  });

  it('should return values from the subscription', async () => {
    const events = [1, 2, 3];
    events.forEach(eventBus.dispatch);
    const result = [];

    for await (const event of subscriber) {
      result.push(event);
      if (result.length >= events.length) {
        break;
      }
    }

    expect(result).toEqual(events);
    expect(subscriber['running']).toBe(false);
  });

  it('should close when error is thrown', async () => {
    expect.assertions(3);

    const error = new Error('stop');
    const events = [1, 2, 3];
    events.forEach(eventBus.dispatch);
    const result = [];

    try {
      for await (const event of subscriber) {
        result.push(event);
        if (result.length > 1) {
          throw error;
        }
      }
    } catch (e) {
      expect(e).toBe(error);
    }

    expect(result).toEqual(events.slice(0, 2));
    expect(subscriber['running']).toBe(false);
  });

  it('should close when aborted', async () => {
    expect.assertions(3);

    const controller = new AbortController();
    const subscriber = new AsyncSubscriber(eventBus, controller);
    const events = [1, 2, 3];
    events.forEach(eventBus.dispatch);
    const result = [];

    try {
      for await (const event of subscriber) {
        result.push(event);
        if (result.length > 1) {
          controller.abort();
        }
      }
    } catch (e) {
      expect((e as Error).name).toBe(ErrorName.Abort);
    }

    expect(result).toEqual(events.slice(0, 2));
    expect(subscriber['running']).toBe(false);
  });

  it('should resolve pending pulls when new value arrives', async () => {
    const result = [];
    for (let i = 0; i < 3; ++i) {
      result.push(subscriber.next());
    }

    await immediate();

    eventBus.dispatch(1);
    expect(await result[0]).toEqual({ value: 1, done: false });
    await subscriber.return();

    expect(await result[1]).toEqual({ value: void 0, done: true });
    expect(await result[2]).toEqual({ value: void 0, done: true });
  });

  it('should resolve pending pulls on close', async () => {
    const events = [1, 2];
    events.forEach(eventBus.dispatch);
    const result = [];
    for (let i = 0; i < 4; ++i) {
      result.push(subscriber.next());
    }

    expect(await result[0]).toEqual({ value: events[0], done: false });
    expect(await result[1]).toEqual({ value: events[1], done: false });
    await subscriber.return();

    expect(await result[2]).toEqual({ value: void 0, done: true });
    expect(await result[3]).toEqual({ value: void 0, done: true });
  });

  it('should drop overflowing values', async () => {
    const subscriber = new AsyncSubscriber(eventBus, { bufferSize: 1 });
    const events = [1, 2, 3];
    events.forEach(eventBus.dispatch);

    for await (const event of subscriber) {
      expect(event).toEqual(events[2]); // previous events dropped
      break;
    }
  });

  it('should ignore new values on fcfs mode if buffer is full', async () => {
    const subscriber = new AsyncSubscriber(eventBus, { bufferSize: 1, fcfs: true });
    const events = [1, 2, 3];
    events.forEach(eventBus.dispatch);

    for await (const event of subscriber) {
      expect(event).toEqual(events[0]); // later events dropped
      break;
    }
  });
});