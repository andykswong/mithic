import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { delay, dispose, SyncMessageChannel } from '@mithic/commons';
import type { SyncKeyValueStore } from '../../service.ts';
import { StoreError, StoreErrorType } from '../../types.ts';
import { KeyValueStoreClient } from './index.ts';
import { KVStoreMessage, KVStoreOp } from './codec.ts';

const BUCKET = 'bucket1';

describe('KeyValueStoreClient', () => {
  let client: KeyValueStoreClient;
  let host: SyncMessageChannel<KVStoreMessage>;
  let messages: KVStoreMessage[];

  beforeEach(async () => {
    client = new KeyValueStoreClient();
    messages = [];
    host = new SyncMessageChannel({
      codec: KVStoreMessage,
      receiver: true,
      onmessage(message) {
        messages.push(message);
      },
      ...client.channel
    });

    await delay(100);
  });

  afterEach(() => {
    dispose(client);
    dispose(host);
  });

  describe('constructor', () => {
    it('should not start automatically', () => {
      assert.strictEqual(client.started, false);
    });
  });

  describe('open', () => {
    it('should send open request', async () => {
      const seq = client['seq'];
      host.send({ op: KVStoreOp.Response, seq, bucket: BUCKET });
      assert.ok(client.open(BUCKET));
      await delay(100);
      assert.deepStrictEqual(messages, [{ op: KVStoreOp.Open, seq, bucket: BUCKET }]);
    });
  });

  describe('KeyValueStore', () => {
    let store: SyncKeyValueStore;

    beforeEach(async () => {
      const seq = client['seq'];
      host.send({ op: KVStoreOp.Response, seq, bucket: BUCKET });
      store = client.open(BUCKET);
      await delay(100);
      messages = [];
    });

    describe('dispose', () => {
      it('should send close request', async () => {
        const seq = client['seq'];
        dispose(store);
        await delay(100);
        assert.deepStrictEqual(messages, [{ op: KVStoreOp.Close, seq, bucket: BUCKET }]);
      });
    });

    describe('exists', () => {
      it('should send exist request', async () => {
        const seq = client['seq'];
        const key = 'key1';
        host.send({ op: KVStoreOp.Response, seq, success: true });
        assert.strictEqual(store.exists(key), true);
        await delay(100);
        assert.deepStrictEqual(messages, [{ op: KVStoreOp.Exist, seq, bucket: BUCKET, key }]);
      });

      it('throws error from host', () => {
        const seq = client['seq'];
        host.send({ op: KVStoreOp.Response, seq, error: { tag: StoreErrorType.AccessDenied } });
        assert.throws(() => store.exists('test'), new StoreError({ tag: StoreErrorType.AccessDenied }));
      });
    });

    describe('listKeys', () => {
      it('should send keys request', async () => {
        const seq = client['seq'];
        const key = 'key1';
        const selector = { start: key };
        const cursor = 'cursor1', cursor2 = 'cursor2';
        host.send({ op: KVStoreOp.Response, seq, success: true, keys: [key], cursor });
        assert.deepStrictEqual(store.listKeys(selector, cursor2), { keys: [key], cursor });
        await delay(100);
        assert.deepStrictEqual(messages, [{ op: KVStoreOp.Keys, seq, bucket: BUCKET, selector, cursor: cursor2 }]);
      });
    });

    describe('getMany', () => {
      it('should send get request', async () => {
        const seq = client['seq'];
        const key = 'key1', key2 = 'key2', value = new Uint8Array([1, 2, 3]);
        host.send({ op: KVStoreOp.Response, seq, success: true, values: [null, value] });
        assert.deepStrictEqual(store.getMany([key2, key]), [null, value]);
        await delay(100);
        assert.deepStrictEqual(messages, [{ op: KVStoreOp.Get, seq, bucket: BUCKET, keys: [key2, key] }]);
      });
    });

    describe('updateMany', () => {
      it('should send update request', async () => {
        const seq = client['seq'];
        const key = 'key1', value = new Uint8Array([1, 2, 3]);
        host.send({ op: KVStoreOp.Response, seq });
        store.updateMany([[key, value]]);
        await delay(100);
        assert.deepStrictEqual(messages, [{ op: KVStoreOp.Update, seq, bucket: BUCKET, keyValues: [[key, value]] }]);
      });
    });

    describe('increment', () => {
      it('should send incr request', async () => {
        const seq = client['seq'];
        const key = 'key1';
        const delta = 3n, result = 5n;
        host.send({ op: KVStoreOp.Response, seq, counter: result });
        assert.deepStrictEqual(store.increment(key, delta), result);
        await delay(100);
        assert.deepStrictEqual(messages, [{ op: KVStoreOp.Incr, seq, bucket: BUCKET, key, delta }]);
      });
    });

    describe('compareAndSwap', () => {
      it('should send CAS request', async () => {
        const seq = client['seq'];
        const key = 'key1';
        const oldValue = new Uint8Array([1, 2, 3]), newValue = new Uint8Array([4, 5, 6]);
        host.send({ op: KVStoreOp.Response, seq, success: true });
        assert.strictEqual(store.compareAndSwap(key, oldValue, newValue), true);
        await delay(100);
        assert.deepStrictEqual(messages, [{ op: KVStoreOp.CAS, seq, bucket: BUCKET, key, oldValue, newValue }]);
      });
    });
  });
});
