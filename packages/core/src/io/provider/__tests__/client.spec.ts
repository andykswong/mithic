import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { delay, dispose, Error, SyncMessageChannel } from '@mithic/commons';
import { FD, StreamError, StreamErrorTag, StreamState } from '../../types.ts';
import { IoMessage, IoOp } from '../codec.ts';
import { RemoteIoProvider } from '../client.ts';

describe(RemoteIoProvider.name, () => {
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
      expect(client.started).toBe(false);
    });
  });

  describe('read', () => {
    it('should read nothing from first try', async () => {
      const result = client.read(FD.Stdin, 4);
      expect(result).toBeUndefined();
    });

    it('should read chunk from input stream', async () => {
      expect(client.checkRead(FD.Stdin)).toBe(0);
      await process();
      let result = client.read(FD.Stdin, 4);
      expect(result).toStrictEqual(inputChunks[0]);
      expect(client.checkRead(FD.Stdin)).toBe(0);
      await process();
      result = client.read(FD.Stdin, 5);
      expect(result).toStrictEqual(inputChunks[1]);
    });

    it('should throw closed error for invalid stream ID', async () => {
      const fd = 123;
      expect(() => client.read(fd, 1)).toThrowError(new StreamError({ tag: StreamErrorTag.Closed }));
    });

    it('should throw for stream error', async () => {
      const fd = 123;
      host.send({ op: IoOp.State, fd, state: StreamState.Error });
      client.blockingProcess(100);
      expect(() => client.read(fd, 1))
        .toThrowError(new StreamError({
          tag: StreamErrorTag.LastOperationFailed,
          val: new Error(`stream i/o failed, fd=${fd}`)
        }));
    });
  });

  describe('write', () => {
    it('should write data to the stream', async () => {
      const data = new Uint8Array([1, 2, 3]);
      expect(client.checkWrite(FD.Stdout)).toBeGreaterThan(0);
      client.write(FD.Stdout, data);
      await delay(100); // for data to pump through
      expect(client.flush(0)).toBe(true);
      expect(outputChunks).toStrictEqual([data]);
    });
  });

  async function process() {
    await delay(100);
    client.process();
  }
});
