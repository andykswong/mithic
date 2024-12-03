import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { delay, dispose, SharedArrayBufferChannel } from '@mithic/commons';
import { WebReadStream, WebWriteStream } from '../webstreams.ts';
import { StreamState } from '../utils.ts';
import { IoMessage, IoOp } from './codec.ts';
import { IoStreamReactor } from './index.ts';

const STDIN = '/dev/stdin';
const STDOUT = '/dev/stdout';
const FD_STDIN = 0;
const FD_STDOUT = 1;

describe('IoStreamReactor', () => {
  let reactor: IoStreamReactor;
  let client: SharedArrayBufferChannel;
  let inputChunks: Uint8Array[];
  let outputChunks: Uint8Array[];
  let stdinController: ReadableStreamDefaultController;
  let stdoutController: WritableStreamDefaultController;

  beforeEach(() => {
    inputChunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6, 7])];
    outputChunks = [];
    client = new SharedArrayBufferChannel();

    const stdin = new WebReadStream(new ReadableStream({
      start(controller) {
        stdinController = controller;
        for (const chunk of inputChunks) {
          controller.enqueue(chunk);
        }
      }
    }));
    const stdout = new WebWriteStream(new WritableStream({
      start(controller) {
        stdoutController = controller;
      },
      write(chunk) { outputChunks.push(new Uint8Array(chunk)); }
    }));

    reactor = new IoStreamReactor({
      ...client.buffers,
      read(id: string) { if (id === STDIN) { return [FD_STDIN, stdin]; } },
      write(id: string) { if (id === STDOUT) { return [FD_STDOUT, stdout]; } }
    });
  });

  afterEach(() => {
    dispose(reactor);
  });

  it('should start automatically', () => {
    assert.strictEqual(reactor.started, true);
  });

  describe('Ropen', () => {
    it('should open read stream', async () => {
      const msg = IoMessage.encode({ op: IoOp.Ropen, id: STDIN });
      assert.strictEqual(client.send(msg), true);
      await delay(100);
      const message = IoMessage.decode(client.receive() || new Uint8Array());
      assert.deepStrictEqual(message, { op: IoOp.State, id: STDIN, fd: FD_STDIN, state: StreamState.Pending });
    });

    it('should reply with closed for invalid stream', async () => {
      const msg = IoMessage.encode({ op: IoOp.Ropen, id: STDOUT });
      assert.strictEqual(client.send(msg), true);
      await delay(100);
      const message = IoMessage.decode(client.receive() || new Uint8Array());
      assert.deepStrictEqual(message, { op: IoOp.State, id: STDOUT, fd: 4294967295, state: StreamState.Closed });
    });
  });

  describe('Wopen', () => {
    it('should open write stream', async () => {
      const msg = IoMessage.encode({ op: IoOp.Wopen, id: STDOUT });
      assert.strictEqual(client.send(msg), true);
      await delay(100);
      const message = IoMessage.decode(client.receive() || new Uint8Array());
      assert.deepStrictEqual(message, { op: IoOp.State, id: STDOUT, fd: FD_STDOUT, state: StreamState.Pending });
    });

    it('should reply with closed for invalid stream', async () => {
      const msg = IoMessage.encode({ op: IoOp.Wopen, id: STDIN });
      assert.strictEqual(client.send(msg), true);
      await delay(100);
      const message = IoMessage.decode(client.receive() || new Uint8Array());
      assert.deepStrictEqual(message, { op: IoOp.State, id: STDIN, fd: 4294967295, state: StreamState.Closed });
    });
  });

  describe('Close', () => {
    beforeEach(async () => {
      client.send(IoMessage.encode({ op: IoOp.Ropen, id: STDIN }));
      client.send(IoMessage.encode({ op: IoOp.Wopen, id: STDOUT }));
      await delay(100);
      client.receive();
      client.receive();
    });

    it('should close read stream', async () => {
      const msg = IoMessage.encode({ op: IoOp.Close, fd: FD_STDIN });
      assert.strictEqual(client.send(msg), true);
      await delay(100);
      assert.ok(!reactor['readStreams'].has(FD_STDIN));
    });

    it('should close write stream', async () => {
      const msg = IoMessage.encode({ op: IoOp.Close, fd: FD_STDOUT });
      assert.strictEqual(client.send(msg), true);
      await delay(100);
      assert.ok(!reactor['writeStreams'].has(FD_STDOUT));
    });
  });

  describe('Read', () => {
    beforeEach(async () => {
      client.send(IoMessage.encode({ op: IoOp.Ropen, id: STDIN }));
      await delay(100);
      client.receive();
    });

    it('should reply with stream data', async () => {
      const msg = IoMessage.encode({ op: IoOp.Read, fd: FD_STDIN });
      assert.strictEqual(client.send(msg), true);
      await delay(100);
      const message = IoMessage.decode(client.receive() || new Uint8Array());
      assert.deepStrictEqual(message, { op: IoOp.Data, fd: FD_STDIN, content: inputChunks[0] });
    });

    it('should respond to read request to correct channel', async () => {
      const client2 = new SharedArrayBufferChannel(reactor.addChannel());
      const msg = IoMessage.encode({ op: IoOp.Read, fd: FD_STDIN });
      assert.strictEqual(client2.send(msg), true);
      await delay(100);
      assert.deepStrictEqual(IoMessage.decode(client2.receive()!), { op: IoOp.Data, fd: FD_STDIN, content: inputChunks[0] });
    });

    it('should handle concurrent read request', async () => {
      const client2 = new SharedArrayBufferChannel(reactor.addChannel());
      const msg = IoMessage.encode({ op: IoOp.Read, fd: FD_STDIN });
      assert.strictEqual(client.send(msg), true);
      assert.strictEqual(client2.send(msg), true);
      await delay(100);
      assert.deepStrictEqual(IoMessage.decode(client.receive()!), { op: IoOp.Data, fd: FD_STDIN, content: inputChunks[0] });
      assert.deepStrictEqual(IoMessage.decode(client2.receive()!), { op: IoOp.Data, fd: FD_STDIN, content: inputChunks[1] });
    });

    it('should handle read request on closed stream', async () => {
      stdinController.close();
      const msg = IoMessage.encode({ op: IoOp.Read, fd: FD_STDIN });
      client.send(msg);
      client.send(msg);
      await delay(100);
      client.send(msg);
      await delay(100);

      const messages = [];
      let rawMessage;
      while ((rawMessage = client.receive())) {
        const message = IoMessage.decode(rawMessage);
        if (message) { messages.push(message); }
      }

      assert.deepStrictEqual(messages, [
        { op: IoOp.Data, fd: FD_STDIN, content: inputChunks[0] },
        { op: IoOp.Data, fd: FD_STDIN, content: inputChunks[1] },
        { op: IoOp.State, fd: FD_STDIN, state: StreamState.Closed },
      ]);
    });

    it('should handle read request with error', async () => {
      const msg = IoMessage.encode({ op: IoOp.Read, fd: FD_STDIN });
      client.send(msg);
      stdinController.error('failed');
      await delay(100);
      const message = IoMessage.decode(client.receive() || new Uint8Array());
      assert.deepStrictEqual(message, { op: IoOp.State, fd: FD_STDIN, state: StreamState.Error });
    });

    it('should handle read request on unknown fd', async () => {
      const fd = 999;
      const msg = IoMessage.encode({ op: IoOp.Read, fd });
      client.send(msg);
      await delay(100);
      const message = IoMessage.decode(client.receive() || new Uint8Array());
      assert.deepStrictEqual(message, { op: IoOp.State, fd, state: StreamState.Closed });
    });
  });

  describe('Write', () => {
    beforeEach(async () => {
      client.send(IoMessage.encode({ op: IoOp.Wopen, id: STDOUT }));
      await delay(100);
      client.receive();
    });

    it('should handle write request', async () => {
      const data = new Uint8Array([1, 2, 3]);
      const msg = IoMessage.encode({ op: IoOp.Write, fd: FD_STDOUT, content: data });
      client.send(msg);
      await delay(100);
      assert.deepStrictEqual(outputChunks, [data]);
    });

    it('should handle write request with error', async () => {
      const data = new Uint8Array([1, 2, 3]);
      const msg = IoMessage.encode({ op: IoOp.Write, fd: FD_STDOUT, content: data });
      client.send(msg);
      stdoutController.error('failed');
      await delay(100);
      const message = IoMessage.decode(client.receive() || new Uint8Array());
      assert.deepStrictEqual(message, { op: IoOp.State, fd: FD_STDOUT, state: StreamState.Error });
    });

    it('should handle write request on unknown fd', async () => {
      const fd = 999;
      const msg = IoMessage.encode({ op: IoOp.Write, fd, content: new Uint8Array([1]) });
      client.send(msg);
      await delay(100);
      const message = IoMessage.decode(client.receive() || new Uint8Array());
      assert.deepStrictEqual(message, { op: IoOp.State, fd, state: StreamState.Closed });
    });
  });
});
