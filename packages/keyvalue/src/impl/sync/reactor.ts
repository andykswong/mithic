import {
  dispose, type SyncMessageChannel, SyncMessageChannelReactor, type SharedChannelBuffers, type Startable
} from '@mithic/commons';
import type { KeyValueProvider, KeyValueStore } from '../../service.ts';
import { StoreError, StoreErrorType } from '../../types.ts';
import { InMemoryKeyValueProvider } from '../index.ts';
import { KVStoreMessage, KVStoreOp } from './codec.ts';

const ABORT_ERROR_NAME = 'AbortError';

/** Reactor for keyvalue store operations. */
export class KeyValueStoreReactor implements Startable, Disposable {
  private readonly reactor: SyncMessageChannelReactor<KVStoreMessage>;
  private readonly provider: KeyValueProvider;
  private readonly stores = new Map<string, KeyValueStore>();

  public constructor({
    start = true,
    provider = new InMemoryKeyValueProvider(),
    send, recv
  }: KeyValueStoreReactorOptions) {
    this.provider = provider;
    this.reactor = new SyncMessageChannelReactor({
      codec: KVStoreMessage,
      onmessage: this.handle,
      send, recv, start
    });
  }

  public [Symbol.dispose](): void {
    dispose(this.reactor);
  }

  public start(): void {
    this.reactor.start();
  }

  public get started(): boolean {
    return this.reactor.started;
  }

  /**
   * Creates a new channel for client, and returns the shared channel buffers to use by the client.
   * Each channel buffer is only valid for single client-reactor connection.
   */
  public addChannel(buffers?: SharedChannelBuffers): SharedChannelBuffers {
    return this.reactor.addChannel(buffers);
  }

  /** Removes a channel by its shared channel buffers. */
  public removeChannel(buffers: SharedChannelBuffers): void {
    this.reactor.removeChannel(buffers);
  }

  private handle = async (channel: SyncMessageChannel<KVStoreMessage>, message: KVStoreMessage) => {
    const response = {
      op: KVStoreOp.Response,
      seq: message.seq,
    } satisfies KVStoreMessage;

    try {
      switch (message.op) {
        case KVStoreOp.Open:
          await this.openStore(message.bucket);
          await channel.sendAsync({
            ...response,
            bucket: message.bucket,
          });
          break;
        case KVStoreOp.Close: {
          const store = this.stores.get(message.bucket);
          if (store) {
            dispose(store);
            this.stores.delete(message.bucket);
          }
          break;
        }
        case KVStoreOp.Exist:
          await channel.sendAsync({
            ...response,
            success: await this.getStore(message.bucket).exists(message.key),
          });
          break;
        case KVStoreOp.Get:
          await channel.sendAsync({
            ...response,
            values: await this.getStore(message.bucket).getMany(message.keys),
          });
          break;
        case KVStoreOp.Update:
          await this.getStore(message.bucket).updateMany(message.keyValues);
          await channel.sendAsync(response);
          break;
        case KVStoreOp.Keys:
          await channel.sendAsync({
            ...response,
            ...(await this.getStore(message.bucket).listKeys(message.selector, message.cursor)),
          });
          break;
        case KVStoreOp.CAS:
          await channel.sendAsync({
            ...response,
            success: await this.getStore(message.bucket)
              .compareAndSwap(message.key, message.oldValue, message.newValue),
          });
          break;
        case KVStoreOp.Incr:
          await channel.sendAsync({
            ...response,
            counter: await this.getStore(message.bucket).increment(message.key, message.delta),
          });
          break;
      }
    } catch (e) {
      const error = ((e as Error)?.name === ABORT_ERROR_NAME) ? { tag: StoreErrorType.Timeout } :
        (e instanceof StoreError && e.payload) || { tag: StoreErrorType.Other, val: `internal error: ${e}` };
      await channel.sendAsync({ ...response, error });
    }
  };

  private async openStore(bucket: string): Promise<KeyValueStore> {
    let store = this.stores.get(bucket);
    if (!store) {
      store = await this.provider.open(bucket);
      this.stores.set(bucket, store);
    }
    return store;
  }

  private getStore(bucket: string): KeyValueStore {
    const store = this.stores.get(bucket);
    if (!store) {
      throw new StoreError({ tag: StoreErrorType.NoSuchStore });
    }
    return store;
  }
}

/** Options for creating {@link KeyValueStoreReactor}. */
export interface KeyValueStoreReactorOptions extends Partial<SharedChannelBuffers> {
  /** Start on construct? */
  start?: boolean;
  /** Backing key-value store provider. */
  provider?: KeyValueProvider;
}
