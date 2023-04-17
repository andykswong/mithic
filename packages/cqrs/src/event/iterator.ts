import { ArrayDeque } from '@mithic/collections';
import { AbortOptions, Closeable, MaybePromise } from '@mithic/commons';
import { EventSubscription, Unsubscribe } from '../event.js';

/**
 * Subscribe to an {@link EventSubscription} as AsyncIterator.
 * This is useful for GraphQL subscriptions.
 */
export class AsyncEventSubscriber<Event> implements AsyncIterableIterator<Event>, Closeable {
  private readonly pullQueue: ArrayDeque<(value: IteratorResult<Event>) => void> = new ArrayDeque();
  private readonly pushQueue: ArrayDeque<Event> = new ArrayDeque();
  private readonly abort: AbortSignal | undefined;
  private unsubscribe: MaybePromise<Unsubscribe>;
  private running = true;

  public constructor(
    /** Subscription to listen to. */
    subscription: EventSubscription<Event>,
    /** Optional abort options. */
    options?: AbortOptions,
  ) {
    this.unsubscribe = subscription.subscribe(this.push);
    this.abort = options?.signal;
  }

  public [Symbol.asyncIterator]() {
    return this;
  }

  public async next(): Promise<IteratorResult<Event>> {
    try {
      this.abort?.throwIfAborted();
      await this.unsubscribe;
      return this.pull();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  public async return(): Promise<IteratorResult<Event>> {
    await this.close();
    return { value: void 0, done: true };
  }

  public async throw(error: unknown): Promise<IteratorResult<Event>> {
    await this.close();
    throw error;
  }

  public async close(): Promise<void> {
    if (!this.running) {
      return;
    }
    for (const resolve of this.pullQueue) {
      resolve({ value: void 0, done: true });
    }
    this.pullQueue.clear();
    this.pushQueue.clear();
    await (await this.unsubscribe)();
    this.running = false;
  }

  private push = async (value: Event) => {
    const resolve = this.pullQueue.shift();
    if (resolve) {
      resolve(this.running ? { value, done: false } : { value: void 0, done: true });
    } else if (this.running) {
      this.pushQueue.push(value);
    }
  }

  private pull(): Promise<IteratorResult<Event>> {
    return new Promise((resolve) => {
      const value = this.pushQueue.shift();
      if (value) {
        resolve(this.running ? { value, done: false } : { value: void 0, done: true });
      } else if (this.running) {
        this.pullQueue.push(resolve);
      }
    });
  }
}
