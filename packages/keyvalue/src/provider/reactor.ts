import {
  dispose, type SyncMessageChannel, SyncMessageChannelReactor, type SharedChannelBuffers, type Startable
} from '@mithic/commons';
import type { KeyValueStore } from './adapter.ts';
import { InMemoryKeyValueStore } from '../impl/index.ts';
import { StoreError, StoreErrorType } from '../types.ts';
import { KVStoreMessage, KVStoreOp } from './codec.ts';

const ABORT_ERROR_NAME = 'AbortError';

/** Reactor for keyvalue store operations. */
export class KeyValueStoreReactor implements Startable, Disposable {
  private readonly reactor: SyncMessageChannelReactor<KVStoreMessage>;
  private readonly store: KeyValueStore;

  public constructor({
    start = true,
    store = new InMemoryKeyValueStore(),
    send, recv
  }: KeyValueStoreReactorOptions) {
    this.store = store;
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
          await channel.sendAsync({
            ...response,
            bucket: await this.store.open(message.bucket),
          });
          break;
        case KVStoreOp.Close:
          this.store.close(message.bucket);
          break;
        case KVStoreOp.Exist:
          await channel.sendAsync({
            ...response,
            success: await this.store.exists(message.bucket, message.key),
          });
          break;
        case KVStoreOp.Get:
          await channel.sendAsync({
            ...response,
            values: await this.store.getMany(message.bucket, message.keys),
          });
          break;
        case KVStoreOp.Update:
          await this.store.updateMany(message.bucket, message.keyValues);
          await channel.sendAsync(response);
          break;
        case KVStoreOp.Keys:
          await channel.sendAsync({
            ...response,
            ...(await this.store.listKeys(message.bucket, message.selector, message.cursor)),
          });
          break;
        case KVStoreOp.CAS:
          await channel.sendAsync({
            ...response,
            success: await this.store.compareAndSwap(message.bucket, message.key, message.oldValue, message.newValue),
          });
          break;
        case KVStoreOp.Incr:
          await channel.sendAsync({
            ...response,
            counter: await this.store.increment(message.bucket, message.key, message.delta),
          });
          break;
      }
    } catch (e) {
      const error = ((e as Error)?.name === ABORT_ERROR_NAME) ? { tag: StoreErrorType.Timeout } :
        (e instanceof StoreError && e.payload) || { tag: StoreErrorType.Other, val: `internal error: ${e}` };
      await channel.sendAsync({ ...response, error });
    }
  };
}

/** Options for creating {@link KeyValueStoreReactor}. */
export interface KeyValueStoreReactorOptions extends Partial<SharedChannelBuffers> {
  /** Start on construct? */
  start?: boolean;
  /** Backing key-value store. */
  store?: KeyValueStore;
}
