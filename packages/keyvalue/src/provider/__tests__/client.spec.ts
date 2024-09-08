import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { delay, dispose, SyncMessageChannel } from '@mithic/commons';
import { RemoteKeyValueStore } from '../client.ts';
import { KVStoreMessage, KVStoreOp } from '../codec.ts';
import { StoreError, StoreErrorType } from '../../types.ts';

const BUCKET = 'bucket1';

describe(RemoteKeyValueStore.name, () => {
  let client: RemoteKeyValueStore;
  let host: SyncMessageChannel<KVStoreMessage>;
  let messages: KVStoreMessage[];

  beforeEach(async () => {
    client = new RemoteKeyValueStore();
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

  afterEach(async () => {
    dispose(client);
    dispose(host);
  });

  describe('constructor', () => {
    it('should not start automatically', () => {
      expect(client.started).toBe(false);
    });
  });

  describe('open', () => {
    it('should send open request', async () => {
      const seq = client['seq'];
      const bucketId = 'reply_bucket';
      host.send({ op: KVStoreOp.Response, seq, bucket: bucketId });
      expect(client.open(BUCKET)).toBe(bucketId);
      await delay(100);
      expect(messages).toEqual([{ op: KVStoreOp.Open, seq, bucket: BUCKET }])
    });
  });

  describe('close', () => {
    it('should send close request', async () => {
      const seq = client['seq'];
      host.send({ op: KVStoreOp.Response, seq });
      client.close(BUCKET);
      await delay(100);
      expect(messages).toEqual([{ op: KVStoreOp.Close, seq, bucket: BUCKET }])
    });
  });

  describe('exists', () => {
    it('should send exist request', async () => {
      const seq = client['seq'];
      const key = 'key1';
      host.send({ op: KVStoreOp.Response, seq, success: true });
      expect(client.exists(BUCKET, key)).toBe(true);
      await delay(100);
      expect(messages).toEqual([{ op: KVStoreOp.Exist, seq, bucket: BUCKET, key }])
    });

    it('throws if trying to access a non-opened store', () => {
      const seq = client['seq'];
      host.send({ op: KVStoreOp.Response, seq, error: { tag: StoreErrorType.NoSuchStore } });
      expect(() => client.exists('testtest', 'test'))
        .toThrowError(new StoreError({ tag: StoreErrorType.NoSuchStore }));
    });
  });

  describe('listKeys', () => {
    it('should send keys request', async () => {
      const seq = client['seq'];
      const key = 'key1';
      const selector = { start: key };
      const cursor = 'cursor1', cursor2 = 'cursor2';
      host.send({ op: KVStoreOp.Response, seq, success: true, keys: [key], cursor });
      expect(client.listKeys(BUCKET, selector, cursor2)).toEqual({ keys: [key], cursor })
      await delay(100);
      expect(messages).toEqual([{ op: KVStoreOp.Keys, seq, bucket: BUCKET, selector, cursor: cursor2 }])
    });
  });

  describe('getMany', () => {
    it('should send get request', async () => {
      const seq = client['seq'];
      const key = 'key1', key2 = 'key2', value = new Uint8Array([1, 2, 3]);
      host.send({ op: KVStoreOp.Response, seq, success: true, values: [null, value] });
      expect(client.getMany(BUCKET, [key2, key])).toEqual([null, value])
      await delay(100);
      expect(messages).toEqual([{ op: KVStoreOp.Get, seq, bucket: BUCKET, keys: [key2, key] }]);
    });
  });

  describe('updateMany', () => {
    it('should send update request', async () => {
      const seq = client['seq'];
      const key = 'key1', value = new Uint8Array([1, 2, 3]);
      host.send({ op: KVStoreOp.Response, seq });
      client.updateMany(BUCKET, [[key, value]]);
      await delay(100);
      expect(messages).toEqual([{ op: KVStoreOp.Update, seq, bucket: BUCKET, keyValues: [[key, value]] }]);
    });
  });

  describe('increment', () => {
    it('should send incr request', async () => {
      const seq = client['seq'];
      const key = 'key1';
      const delta = 3n, result = 5n;
      host.send({ op: KVStoreOp.Response, seq, counter: result });
      expect(client.increment(BUCKET, key, delta)).toEqual(result);
      await delay(100);
      expect(messages).toEqual([{ op: KVStoreOp.Incr, seq, bucket: BUCKET, key, delta }])
    });
  });

  describe('compareAndSwap', () => {
    it('should send CAS request', async () => {
      const seq = client['seq'];
      const key = 'key1';
      const oldValue = new Uint8Array([1, 2, 3]), newValue = new Uint8Array([4, 5, 6]);
      host.send({ op: KVStoreOp.Response, seq, success: true });
      expect(client.compareAndSwap(BUCKET, key, oldValue, newValue)).toBe(true);
      await delay(100);
      expect(messages).toEqual([{ op: KVStoreOp.CAS, seq, bucket: BUCKET, key, oldValue, newValue }])
    });
  });
});
