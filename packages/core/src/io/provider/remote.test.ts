import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { delay, dispose, Error, SyncMessageChannel } from '@mithic/commons';
import { FD, StreamError, StreamErrorTag, StreamState } from '../../index.ts';
import { IoMessage, IoOp } from './codec.ts';
import { RemoteIoProvider } from './index.ts';

describe('RemoteIoProvider', () => {
  let client: RemoteIoProvider;
  let host: SyncMessageChannel<IoMessage>;
  let inputChunks: Uint8Array[];
  let outputChunks: Uint8Array[];

  beforeEach(async () => {
    inputChunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6, 7])];
    outputChunks = [];

    client = new RemoteIoProvider();
    let read = 0;
    host = new SyncMessageChannel({
      codec: IoMessage,
      receiver: true,
      onmessage(message) {
        switch (message.op) {
          case IoOp.Read:
            host.send({ op: IoOp.Data, fd: FD.Stdin, content: inputChunks[read++] });
            break;
          case IoOp.Write:
            outputChunks.push(message.content);
            break;
          default:
            throw new Error(`invalid message type: ${message.op}`);
        }
      },
      ...client.channel
    });
  });

  afterEach(async () => {
    dispose(client);
    dispose(host);
  });

  describe('constructor', () => {
    it('should not start automatically', () => {
      assert.strictEqual(client.started, false);
    });
  });

  describe('read', () => {
    it('should read nothing from first try', async () => {
      const result = client.read(FD.Stdin, 4);
      assert.strictEqual(result, undefined);
    });

    it('should read chunk from input stream', async () => {
      assert.strictEqual(client.checkRead(FD.Stdin), 0);
      await process();
      let result = client.read(FD.Stdin, 4);
      assert.deepStrictEqual(result, inputChunks[0]);
      assert.strictEqual(client.checkRead(FD.Stdin), 0);
      await process();
      result = client.read(FD.Stdin, 5);
      assert.deepStrictEqual(result, inputChunks[1]);
    });

    it('should throw closed error for invalid stream ID', async () => {
      const fd = 123;
      assert.throws(() => client.read(fd, 1), new StreamError({ tag: StreamErrorTag.Closed }));
    });

    it('should throw for stream error', async () => {
      const fd = 123;
      host.send({ op: IoOp.State, fd, state: StreamState.Error });
      client.blockingProcess(100);
      assert.throws(() => client.read(fd, 1),
        new StreamError({
          tag: StreamErrorTag.LastOperationFailed,
          val: new Error(`stream i/o failed, fd=${fd}`)
        }));
    });
  });

  describe('write', () => {
    it('should write data to the stream', async () => {
      const data = new Uint8Array([1, 2, 3]);
      assert(client.checkWrite(FD.Stdout) > 0);
      client.write(FD.Stdout, data);
      await delay(100); // for data to pump through
      assert.strictEqual(client.flush(0), true);
      assert.deepStrictEqual(outputChunks, [data]);
    });
  });

  async function process() {
    await delay(100);
    client.process();
  }
});
