import type { Kv, KvKey } from '@deno/kv';
import type { MaybePromise } from '@mithic/commons';
import { isMessageRecord, Message, MessagingError, MessagingErrorType } from '@mithic/messaging';
import type { MessageHandler, MessageRecord, MessagingService } from '@mithic/messaging';

/**
 * Deno KV implementation of {@link MessagingService} with at-least-once delivery.
 * TODO: cannot have >1 handlers per topic; no request-reply support
 */
export class DenoKvMessagingService implements MessagingService, Disposable {
  private readonly kv = new Map<string, [kv: Kv, handler?: MessageHandler]>();
  private readonly provideKv: (topic: string) => MaybePromise<Kv>;
  private readonly delay?: number;
  private readonly keysIfUndelivered?: (message: MessageRecord) => KvKey[];

  public constructor({ kv, delay, keysIfUndelivered }: DenoKvMessagingServiceOptions) {
    this.provideKv = kv;
    this.delay = delay;
    this.keysIfUndelivered = keysIfUndelivered;
  }

  public [Symbol.dispose](): void {
    for (const [kv,] of this.kv.values()) {
      kv.close();
    }
    this.kv.clear();
  }

  public async send(topic: string, message: Message): Promise<void> {
    const record = { ...message.toRecord(), topic } satisfies MessageRecord;
    await (await this.openKv(topic))
      .enqueue(record, { delay: this.delay, keysIfUndelivered: this.keysIfUndelivered?.(record) });
  }

  public async subscribe(topics: Iterable<string>, handler: MessageHandler): Promise<void> {
    const topicSet = new Set(topics);
    for (const [topic, [kv, topicHandler]] of this.kv.entries()) {
      if (handler === topicHandler && !topicSet.has(topic)) {
        kv.close();
        this.kv.delete(topic);
      }
    }
    for (const topic of topicSet) {
      const kv = await this.openKv(topic);
      if (!this.kv.get(topic)?.[1]) {
        kv.listenQueue(this.handle.bind(this, topic));
        this.kv.set(topic, [kv, handler]);
      }
    }
  }

  private handle = async (topic: string, message: unknown) => {
    if (!isMessageRecord(message) || !this.kv.has(topic)) {
      throw new MessagingError({ tag: MessagingErrorType.Other, val: 'invalid message' });
    }
    return this.kv.get(topic)?.[1]?.handle(Message.from({ ...message, topic }));
  };

  private async openKv(topic: string): Promise<Kv> {
    let kv = this.kv.get(topic)?.[0];
    if (!kv) {
      kv = await this.provideKv(topic);
      this.kv.set(topic, [kv]);
    }
    return kv;
  }
}

/** Options for creating a {@link DenoKvMessagingService}. */
export interface DenoKvMessagingServiceOptions {
  /** Backing Kv provider. */
  readonly kv: (topic: string) => MaybePromise<Kv>;
  /** The delay (in milliseconds) of the value delivery */
  readonly delay?: number;
  /** Returns the keys to be set if message is not successfully delivered after retries. */
  readonly keysIfUndelivered?: (message: MessageRecord) => KvKey[];
}
