import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { delay, dispose, SharedArrayBufferChannel } from '@mithic/commons';
import { InMemoryKeyValueProvider } from '../../impl/index.ts';
import type { SyncKeyValueProvider, SyncKeyValueStore } from '../../service.ts';
import { KeyOrder, StoreErrorType } from '../../types.ts';
import { KeyValueStoreReactor } from './index.ts';
import { KVStoreMessage, KVStoreOp } from './codec.ts';

const BUCKET = 'test_bucket';
const KEY1 = 'key1', KEY2 = 'key2';
const VALUE1 = new Uint8Array([1, 2, 3]), VALUE2 = new Uint8Array([4, 5, 6]);

describe('KeyValueStoreReactor', () => {
  let reactor: KeyValueStoreReactor;
  let client: SharedArrayBufferChannel;
  let provider: SyncKeyValueProvider;
  let store: SyncKeyValueStore;
  let seq = 0;

  beforeEach(async () => {
    provider = new InMemoryKeyValueProvider();
    store = provider.open(BUCKET);
    store.updateMany([[KEY2, VALUE2], [KEY1, VALUE1]]);

    client = new SharedArrayBufferChannel();
    reactor = new KeyValueStoreReactor({ provider, ...client.buffers });
    reactor['stores'].set(BUCKET, store);

    await delay(100);
  });

  afterEach(() => {
    dispose(reactor);
  });

  it('should start automatically', () => {
    assert.strictEqual(reactor.started, true);
  });

  describe('open', () => {
    it('should handle open request', async () => {
      assert.strictEqual(send({ op: KVStoreOp.Open, bucket: BUCKET, seq: ++seq }), true);
      await delay(100);
      assert.deepStrictEqual(receive(), { op: KVStoreOp.Response, seq, bucket: BUCKET });
    });
  });

  describe('close', () => {
    it('should handle open request', async () => {
      const disposeSpy = store[Symbol.dispose] = mock.fn<() => void>();
      assert.strictEqual(send({ op: KVStoreOp.Close, bucket: BUCKET, seq: ++seq }), true);
      await delay(100);
      assert.strictEqual(disposeSpy.mock.callCount(), 1);
      assert.strictEqual(reactor['stores'].has(BUCKET), false);
    });
  });

  describe('exist', () => {
    it('should handle exist request', async () => {
      assert.strictEqual(send({ op: KVStoreOp.Exist, bucket: BUCKET, seq: ++seq, key: KEY1 }), true);
      await delay(100);
      assert.deepStrictEqual(receive(), { op: KVStoreOp.Response, seq, success: true });
    });
  });

  describe('get', () => {
    it('should handle get request', async () => {
      assert.strictEqual(send({ op: KVStoreOp.Get, bucket: BUCKET, seq: ++seq, keys: [KEY2, 'unknown', KEY1] }), true);
      await delay(100);
      assert.deepStrictEqual(receive(), { op: KVStoreOp.Response, seq, values: [VALUE2, null, VALUE1] });
    });

    it('should receive error from store', async () => {
      assert.strictEqual(send({ op: KVStoreOp.Get, bucket: 'not exist', seq: ++seq, keys: [KEY1] }), true);
      await delay(100);
      assert.deepStrictEqual(receive(), { op: KVStoreOp.Response, seq, error: { tag: StoreErrorType.NoSuchStore } });
    });

    it('should handle get request from multiple clients', async () => {
      const client2 = new SharedArrayBufferChannel(reactor.addChannel());
      assert.strictEqual(send({ op: KVStoreOp.Get, bucket: BUCKET, seq: ++seq, keys: [KEY1] }, client2), true);
      await delay(100);
      assert.deepStrictEqual(receive(client2), { op: KVStoreOp.Response, seq, values: [VALUE1] });
    });
  });

  describe('update', () => {
    it('should handle update request', async () => {
      const key = 'key3', value = new Uint8Array([7, 8, 9]);
      assert.strictEqual(send({ op: KVStoreOp.Update, bucket: BUCKET, seq: ++seq, keyValues: [[KEY1, null], [key, value]] }), true);
      await delay(100);
      assert.deepStrictEqual(receive(), { op: KVStoreOp.Response, seq });
    });
  });

  describe('keys', () => {
    it('should handle keys request', async () => {
      assert.strictEqual(send({ op: KVStoreOp.Keys, bucket: BUCKET, seq: ++seq, selector: { order: KeyOrder.Asc } }), true);
      await delay(100);
      assert.deepStrictEqual(receive(), { op: KVStoreOp.Response, seq, keys: [KEY1, KEY2] });
    });
  });

  describe('cas', () => {
    it('should handle CAS request', async () => {
      assert.strictEqual(send({ op: KVStoreOp.CAS, bucket: BUCKET, seq: ++seq, key: KEY1, oldValue: VALUE1, newValue: VALUE2 }), true);
      await delay(100);
      assert.deepStrictEqual(receive(), { op: KVStoreOp.Response, seq, success: true });
    });
  });

  describe('incr', () => {
    it('should handle incr request', async () => {
      const key = 'counter';
      store.increment(key, 239n);
      assert.strictEqual(send({ op: KVStoreOp.Incr, bucket: BUCKET, seq: ++seq, key, delta: 123n }), true);
      await delay(100);
      assert.deepStrictEqual(receive(), { op: KVStoreOp.Response, seq, counter: 362n });
    });
  });

  function send(msg: KVStoreMessage, c = client) {
    return c.send(KVStoreMessage.encode(msg));
  }

  function receive(c = client) {
    return KVStoreMessage.decode(c.receive() || new Uint8Array());
  }
});
