import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { delay, dispose, SharedArrayBufferChannel } from '@mithic/commons';
import { FD, StreamState } from '../../index.ts';
import { IoMessage, IoOp } from './codec.ts';
import { IoReactor } from './index.ts';

describe('IoReactor', () => {
  let reactor: IoReactor;
  let client: SharedArrayBufferChannel;
  let inputChunks: Uint8Array[];
  let outputChunks: Uint8Array[];
  let stdinController: ReadableStreamDefaultController;
  let stdoutController: WritableStreamDefaultController;

  beforeEach(async () => {
    inputChunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6, 7])];
    outputChunks = [];
    client = new SharedArrayBufferChannel();
    reactor = new IoReactor({
      ...client.buffers,
      stdin: new ReadableStream({
        start(controller) {
          stdinController = controller;
          for (const chunk of inputChunks) {
            controller.enqueue(chunk);
          }
        }
      }),
      stdout: new WritableStream({
        start(controller) {
          stdoutController = controller;
        },
        write(chunk) { outputChunks.push(new Uint8Array(chunk)); }
      })
    });
  });

  afterEach(async () => {
    dispose(reactor);
  });

  it('should start automatically', () => {
    assert.strictEqual(reactor.started, true);
  });

  describe('handleRead', () => {
    it('should handle read request', async () => {
      const msg = IoMessage.encode({ op: IoOp.Read, fd: FD.Stdin });
      assert.strictEqual(client.send(msg), true);
      await delay(100);
      const message = IoMessage.decode(client.receive() || new Uint8Array());
      assert.deepStrictEqual(message, { op: IoOp.Data, fd: FD.Stdin, content: inputChunks[0] });
    });

    it('should respond to read request to correct channel', async () => {
      const client2 = new SharedArrayBufferChannel(reactor.addChannel());
      const msg = IoMessage.encode({ op: IoOp.Read, fd: FD.Stdin });
      assert.strictEqual(client2.send(msg), true);
      await delay(100);
      assert.deepStrictEqual(IoMessage.decode(client2.receive()!), { op: IoOp.Data, fd: FD.Stdin, content: inputChunks[0] });
    });

    it('should handle concurrent read request', async () => {
      const client2 = new SharedArrayBufferChannel(reactor.addChannel());
      const msg = IoMessage.encode({ op: IoOp.Read, fd: FD.Stdin });
      assert.strictEqual(client.send(msg), true);
      assert.strictEqual(client2.send(msg), true);
      await delay(100);
      assert.deepStrictEqual(IoMessage.decode(client.receive()!), { op: IoOp.Data, fd: FD.Stdin, content: inputChunks[0] });
      assert.deepStrictEqual(IoMessage.decode(client2.receive()!), { op: IoOp.Data, fd: FD.Stdin, content: inputChunks[1] });
    });

    it('should handle read request on closed stream', async () => {
      stdinController.close();
      const msg = IoMessage.encode({ op: IoOp.Read, fd: FD.Stdin });
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
        { op: IoOp.Data, fd: FD.Stdin, content: inputChunks[0] },
        { op: IoOp.Data, fd: FD.Stdin, content: inputChunks[1] },
        { op: IoOp.State, fd: FD.Stdin, state: StreamState.Closed },
      ]);
    });

    it('should handle read request with error', async () => {
      const msg = IoMessage.encode({ op: IoOp.Read, fd: FD.Stdin });
      client.send(msg);
      stdinController.error('failed');
      await delay(100);
      const message = IoMessage.decode(client.receive() || new Uint8Array());
      assert.deepStrictEqual(message, { op: IoOp.State, fd: FD.Stdin, state: StreamState.Error });
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

  describe('handleWrite', () => {
    it('should handle write request', async () => {
      const data = new Uint8Array([1, 2, 3]);
      const msg = IoMessage.encode({ op: IoOp.Write, fd: FD.Stdout, content: data });
      client.send(msg);
      await delay(100);
      assert.deepStrictEqual(outputChunks, [data]);
    });

    it('should handle write request with error', async () => {
      const data = new Uint8Array([1, 2, 3]);
      const msg = IoMessage.encode({ op: IoOp.Write, fd: FD.Stdout, content: data });
      client.send(msg);
      stdoutController.error('failed');
      await delay(100);
      const message = IoMessage.decode(client.receive() || new Uint8Array());
      assert.deepStrictEqual(message, { op: IoOp.State, fd: FD.Stdout, state: StreamState.Error });
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
