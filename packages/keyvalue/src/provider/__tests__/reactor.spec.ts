import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { delay, dispose, SharedArrayBufferChannel } from '@mithic/commons';
import { KeyValueStoreReactor } from '../reactor.ts';
import type { KeyValueStore } from '../adapter.ts';
import { InMemoryKeyValueStore } from '../../impl/index.ts';
import { KeyOrder, StoreErrorType } from '../../types.ts';
import { KVStoreMessage, KVStoreOp } from '../codec.ts';

const BUCKET = 'test_bucket';
const KEY1 = 'key1', KEY2 = 'key2';
const VALUE1 = new Uint8Array([1, 2, 3]), VALUE2 = new Uint8Array([4, 5, 6]);

describe(KeyValueStoreReactor.name, () => {
  let reactor: KeyValueStoreReactor;
  let client: SharedArrayBufferChannel;
  let store: KeyValueStore;
  let seq = 0;

  beforeEach(async () => {
    store = new InMemoryKeyValueStore();
    store.open(BUCKET);
    store.updateMany(BUCKET, [[KEY2, VALUE2], [KEY1, VALUE1]]);

    client = new SharedArrayBufferChannel();
    reactor = new KeyValueStoreReactor({ store, ...client.buffers });

    await delay(100);
  });

  afterEach(async () => {
    dispose(reactor);
    jest.restoreAllMocks();
  });

  it('should start automatically', () => {
    expect(reactor.started).toBe(true);
  });

  describe('open', () => {
    it('should handle open request', async () => {
      expect(send({ op: KVStoreOp.Open, bucket: BUCKET, seq: ++seq })).toBe(true);
      await delay(100);
      expect(receive()).toEqual({ op: KVStoreOp.Response, seq, bucket: BUCKET });
    });
  });

  describe('close', () => {
    it('should handle open request', async () => {
      const closeSpy = jest.spyOn(store, 'close');
      expect(send({ op: KVStoreOp.Close, bucket: BUCKET, seq: ++seq })).toBe(true);
      await delay(100);
      expect(closeSpy).toHaveBeenCalledWith(BUCKET);
    });
  });

  describe('exist', () => {
    it('should handle exist request', async () => {
      expect(send({ op: KVStoreOp.Exist, bucket: BUCKET, seq: ++seq, key: KEY1 })).toBe(true);
      await delay(100);
      expect(receive()).toEqual({ op: KVStoreOp.Response, seq, success: true });
    });
  });

  describe('get', () => {
    it('should handle get request', async () => {
      expect(send({ op: KVStoreOp.Get, bucket: BUCKET, seq: ++seq, keys: [KEY2, 'unknown', KEY1] })).toBe(true);
      await delay(100);
      expect(receive()).toEqual({ op: KVStoreOp.Response, seq, values: [VALUE2, null, VALUE1] });
    });

    it('should receive error from store', async () => {
      expect(send({ op: KVStoreOp.Get, bucket: 'not exist', seq: ++seq, keys: [KEY1] })).toBe(true);
      await delay(100);
      expect(receive()).toEqual({ op: KVStoreOp.Response, seq, error: { tag: StoreErrorType.NoSuchStore } });
    });

    it('should handle get request from multiple clients', async () => {
      const client2 = new SharedArrayBufferChannel(reactor.addChannel());
      expect(send({ op: KVStoreOp.Get, bucket: BUCKET, seq: ++seq, keys: [KEY1] }, client2)).toBe(true);
      await delay(100);
      expect(receive(client2)).toEqual({ op: KVStoreOp.Response, seq, values: [VALUE1] });
    });
  });

  describe('update', () => {
    it('should handle update request', async () => {
      const key = 'key3', value = new Uint8Array([7, 8, 9]);
      expect(send({ op: KVStoreOp.Update, bucket: BUCKET, seq: ++seq, keyValues: [[KEY1, null], [key, value]] })).toBe(true);
      await delay(100);
      expect(receive()).toEqual({ op: KVStoreOp.Response, seq });
    });
  });

  describe('keys', () => {
    it('should handle keys request', async () => {
      expect(send({ op: KVStoreOp.Keys, bucket: BUCKET, seq: ++seq, selector: { order: KeyOrder.Asc } })).toBe(true);
      await delay(100);
      expect(receive()).toEqual({ op: KVStoreOp.Response, seq, keys: [KEY1, KEY2] });
    });
  });

  describe('cas', () => {
    it('should handle CAS request', async () => {
      expect(send({ op: KVStoreOp.CAS, bucket: BUCKET, seq: ++seq, key: KEY1, oldValue: VALUE1, newValue: VALUE2 })).toBe(true);
      await delay(100);
      expect(receive()).toEqual({ op: KVStoreOp.Response, seq, success: true });
    });
  });

  describe('incr', () => {
    it('should handle incr request', async () => {
      const key = 'counter';
      store.increment(BUCKET, key, 239n);
      expect(send({ op: KVStoreOp.Incr, bucket: BUCKET, seq: ++seq, key, delta: 123n })).toBe(true);
      await delay(100);
      expect(receive()).toEqual({ op: KVStoreOp.Response, seq, counter: 362n });
    });
  });

  function send(msg: KVStoreMessage, c = client) {
    return c.send(KVStoreMessage.encode(msg));
  }

  function receive(c = client) {
    return KVStoreMessage.decode(c.receive() || new Uint8Array());
  }
});
