import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { dispose, Error, SyncMessageChannel } from '@mithic/commons';
import type { SyncReadStream, SyncWriteStream } from '../../index.ts';
import { StreamState } from '../utils.ts';
import { IoMessage, IoOp } from './codec.ts';
import { IoStreamClientProvider } from './index.ts';

const STDIN = '/dev/stdin';
const STDOUT = '/dev/stdout';
const FD_STDIN = 0;
const FD_STDOUT = 1;

describe('IoStreamClientProvider', () => {
  let client: IoStreamClientProvider;
  let host: SyncMessageChannel<IoMessage>;
  let ropened: string[];
  let wopened: string[];
  let readCalls: number[];
  let writeCalls: Uint8Array[];
  let closed: number[];

  beforeEach(async () => {
    writeCalls = [];
    ropened = [];
    wopened = [];
    readCalls = [];
    closed = [];

    client = new IoStreamClientProvider();
    host = new SyncMessageChannel({
      codec: IoMessage,
      receiver: true,
      onmessage(message) {
        switch (message.op) {
          case IoOp.Ropen:
            ropened.push(message.id);
            break;
          case IoOp.Wopen:
            wopened.push(message.id);
            break;
          case IoOp.Read:
            readCalls.push(message.fd);
            break;
          case IoOp.Write:
            writeCalls.push(message.content);
            break;
          case IoOp.Close:
            closed.push(message.fd);
            break;
          default:
            throw new Error(`invalid message type: ${message.op}`);
        }
      },
      ...client.channel
    });
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

  describe('openReadStream', () => {
    it('should throw for invalid identifier', () => {
      host.send({ op: IoOp.State, fd: -1, state: StreamState.Closed, id: STDOUT });
      assert.throws(() => client.openReadStream(STDOUT), /StreamError: closed/);
      host.blockingProcess();
      assert.deepStrictEqual(ropened, [STDOUT]);
    });

    describe('ReadStreamClient', () => {
      let stream: SyncReadStream;

      beforeEach(() => {
        host.send({ op: IoOp.State, fd: FD_STDIN, state: StreamState.Pending, id: STDIN });
        stream = client.openReadStream(STDIN);
      });

      describe('dispose', () => {
        it('should close the stream', () => {
          dispose(stream);
          host.blockingProcess();
          assert.deepStrictEqual(closed, [FD_STDIN]);
        });
      });

      describe('read', () => {
        it('should return undefined and send read request for first try', () => {
          const result = stream.read(4);
          assert.strictEqual(result, undefined);
          host.blockingProcess();
          assert.deepStrictEqual(readCalls, [FD_STDIN]);
        });

        it('should read chunk from existing buffer', () => {
          const content = new Uint8Array([1, 2, 3]);
          host.send({ op: IoOp.Data, fd: FD_STDIN, content });
          client['messageChannel'].blockingProcess();

          const result = stream.read(4);
          assert.deepStrictEqual(result, content);
          host.blockingProcess();
          assert.deepStrictEqual(readCalls, []);
        });

        it('should throw error if closed', () => {
          dispose(stream);
          assert.throws(() => stream.read(1), /StreamError: closed/);
        });

        it('should throw for stream error', () => {
          host.send({ op: IoOp.State, fd: FD_STDIN, state: StreamState.Error });
          client['messageChannel'].blockingProcess();
          assert.throws(() => stream.read(1), /StreamError: last-operation-failed/);
        });
      });

      describe('checkRead', () => {
        it('should return 0 if no data', () => {
          assert.strictEqual(stream.checkRead(), 0);
        });

        it('should return existing buffer size', () => {
          const content = new Uint8Array([1, 2, 3]);
          host.send({ op: IoOp.Data, fd: FD_STDIN, content });
          client['messageChannel'].blockingProcess();
          assert.strictEqual(stream.checkRead(), content.length);
        });

        it('should throw error if closed', () => {
          dispose(stream);
          assert.throws(() => stream.checkRead(), /StreamError: closed/);
        });

        it('should throw for stream error', () => {
          host.send({ op: IoOp.State, fd: FD_STDIN, state: StreamState.Error });
          client['messageChannel'].blockingProcess();
          assert.throws(() => stream.checkRead(), /StreamError: last-operation-failed/);
        });
      });
    });
  });

  describe('openWriteStream', () => {
    it('should throw for invalid identifier', () => {
      host.send({ op: IoOp.State, fd: -1, state: StreamState.Closed, id: STDIN });
      assert.throws(() => client.openWriteStream(STDIN), /StreamError: closed/);
      host.blockingProcess();
      assert.deepStrictEqual(wopened, [STDIN]);
    });

    describe('WriteStreamClient', () => {
      let stream: SyncWriteStream;

      beforeEach(() => {
        host.send({ op: IoOp.State, fd: FD_STDOUT, state: StreamState.Pending, id: STDOUT });
        stream = client.openWriteStream(STDOUT);
      });

      describe('dispose', () => {
        it('should close the stream', () => {
          dispose(stream);
          host.blockingProcess();
          assert.deepStrictEqual(closed, [FD_STDOUT]);
        });
      });

      describe('write', () => {
        it('should write data to the stream', () => {
          const data = new Uint8Array([1, 2, 3]);
          stream.write(data);
          host.blockingProcess();
          assert.deepStrictEqual(writeCalls, [data]);
        });

        it('should throw stream error if data size is too large', () => {
          stream.write(new Uint8Array(32768)); // fill write buffer
          assert.throws(() => stream.write(new Uint8Array(1024)), /StreamError: last-operation-failed/);
        });
      });

      describe('checkWrite', () => {
        it('should return max write size', () => {
          const data = new Uint8Array([1, 2, 3]);
          stream.write(data);
          assert.strictEqual(stream.checkWrite(), client['messageChannel'].maxSendSize - IoMessage.headerLength);
        });
      });

      describe('flush', () => {
        it('should wait for write buffer to flush', () => {
          const data = new Uint8Array(4096), data2 = new Uint8Array(6192);
          data[0] = data[4095] = 123;
          data2[0] = data2[6191] = 88;

          stream.write(data);
          stream.write(data2);
          host.process();
          assert.deepStrictEqual(writeCalls, [data]);
          assert.ok(stream.flush());
          host.process();
          assert.deepStrictEqual(writeCalls[0], data);
        });
      });
    });
  });
});
