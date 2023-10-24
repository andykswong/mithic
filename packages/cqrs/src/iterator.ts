import { ArrayDeque } from '@mithic/collections';
import { AbortOptions, Closeable, MaybePromise } from '@mithic/commons';
import { MessageSubscription, Unsubscribe } from '@mithic/messaging';

/**
 * Subscribe to an {@link MessageSubscription} as AsyncIterator.
 * This is useful for GraphQL subscriptions.
 */
export class AsyncSubscriber<Message> implements AsyncIterableIterator<Message>, Closeable, AsyncDisposable {
  private readonly pullQueue: ArrayDeque<(value: IteratorResult<Message>) => void> = new ArrayDeque();
  private readonly pushQueue: ArrayDeque<Message> = new ArrayDeque();
  private readonly bufferSize: number;
  private readonly fcfs: boolean;
  private readonly abort: AbortSignal | undefined;
  private unsubscribe: MaybePromise<Unsubscribe>;
  private running = true;

  public constructor(
    /** Subscription to listen to. */
    subscription: MessageSubscription<Message>,
    /** Optional options. */
    options?: AsyncSubscriberOptions,
  ) {
    this.push = this.push.bind(this);
    this.unsubscribe = subscription.subscribe(this.push);
    this.abort = options?.signal;
    this.bufferSize = (((options?.bufferSize || 0) > 0) && options?.bufferSize) || Infinity;
    this.fcfs = !!options?.fcfs;
  }

  public [Symbol.asyncIterator]() {
    return this;
  }

  public async next(): Promise<IteratorResult<Message>> {
    try {
      this.abort?.throwIfAborted();
      this.unsubscribe = await this.unsubscribe;
      return this.pull();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  public async return(): Promise<IteratorResult<Message>> {
    await this.close();
    return { value: void 0, done: true };
  }

  public async throw(error: unknown): Promise<IteratorResult<Message>> {
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

  public [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  private async push(value: Message) {
    const resolve = this.pullQueue.shift();
    if (resolve) {
      resolve(this.running ? { value, done: false } : { value: void 0, done: true });
    } else if (this.running) {
      this.pushQueue.push(value);
      while (this.pushQueue.size > this.bufferSize) {
        this.fcfs ? this.pushQueue.pop() : this.pushQueue.shift(); // Drop overflowing events
      }
    }
  }

  private pull(): Promise<IteratorResult<Message>> {
    return new Promise((resolve) => {
      const value = this.pushQueue.shift();
      if (value !== void 0) {
        resolve(this.running ? { value, done: false } : { value: void 0, done: true });
      } else if (this.running) {
        this.pullQueue.push(resolve);
      }
    });
  }
}

/** Options for creating an {@link AsyncSubscriber}. */
export interface AsyncSubscriberOptions extends AbortOptions {
  /** Event buffer size. Events may be dropped if buffer size is reached. Defaults to Infinity. */
  readonly bufferSize?: number;

  /**
   * If true, set to first-come-first-serve mode, which ignores new events if buffer size is reached.
   * Defaults to false, which drops earlier events if buffer size is reached.
   */
  readonly fcfs?: boolean;
}
