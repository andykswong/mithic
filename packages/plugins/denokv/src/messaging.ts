import type { Kv, KvKey } from '@deno/kv';
import type { MaybePromise } from '@mithic/commons';
import {
  isMessage, MessagingError, MessagingErrorType, type Message, type MessageHandler, type MessagingService
} from '@mithic/messaging';

/**
 * Deno KV implementation of {@link MessagingService}. Currently it has no request-reply support.
 */
export class DenoKvMessagingService implements MessagingService, Disposable {
  public onmessage: MessageHandler | null = null;

  private readonly kv = new Map<string, [kv: Kv, listening: boolean]>();
  private readonly provideKv: (topic: string) => MaybePromise<Kv>;
  private readonly delay?: number;
  private readonly keysIfUndelivered?: (message: Message) => KvKey[];

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

  public async send(message: Message): Promise<void> {
    await (await this.openKv(message.topic))
      .enqueue(message, { delay: this.delay, keysIfUndelivered: this.keysIfUndelivered?.(message) });
  }

  public async subscribe(topics: string[]): Promise<void> {
    for (const [topic, [kv]] of this.kv.entries()) {
      if (!topics.includes(topic)) {
        kv.close();
        this.kv.delete(topic);
      }
    }
    for (const topic of topics) {
      const kv = await this.openKv(topic);
      if (!this.kv.get(topic)?.[1]) {
        kv.listenQueue(this.handle);
        this.kv.set(topic, [kv, true]);
      }
    }
  }

  private handle = async (message: unknown) => {
    if (!isMessage(message) || !this.kv.has(message.topic)) {
      throw new MessagingError({ tag: MessagingErrorType.Abandoned, val: 'invalid message' });
    }
    try {
      return await this.onmessage?.(message);
    } catch { /** noop */ }
  }

  private async openKv(topic: string): Promise<Kv> {
    let kv = this.kv.get(topic)?.[0];
    if (!kv) {
      kv = await this.provideKv(topic);
      this.kv.set(topic, [kv, false]);
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
  readonly keysIfUndelivered?: (message: Message) => KvKey[];
}
