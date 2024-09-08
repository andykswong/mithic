import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { delay, dispose, SharedArrayBufferChannel } from '@mithic/commons';
import { FD, StreamState } from '../../types.ts';
import { IoMessage, IoOp } from '../codec.ts';
import { IoReactor } from '../reactor.ts';

describe(IoReactor.name, () => {
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
    expect(reactor.started).toBe(true);
  });

  describe('handleRead', () => {
    it('should handle read request', async () => {
      const msg = IoMessage.encode({ op: IoOp.Read, fd: FD.Stdin });
      expect(client.send(msg)).toBe(true);
      await delay(100);
      const message = IoMessage.decode(client.receive() || new Uint8Array());
      expect(message).toEqual({ op: IoOp.Data, fd: FD.Stdin, content: inputChunks[0] });
    });

    it('should respond to read request to correct channel', async () => {
      const client2 = new SharedArrayBufferChannel(reactor.addChannel());
      const msg = IoMessage.encode({ op: IoOp.Read, fd: FD.Stdin });
      expect(client2.send(msg)).toBe(true);
      await delay(100);
      expect(IoMessage.decode(client2.receive()!)).toEqual({ op: IoOp.Data, fd: FD.Stdin, content: inputChunks[0] });
    });
  
    it('should handle concurrent read request', async () => {
      const client2 = new SharedArrayBufferChannel(reactor.addChannel());
      const msg = IoMessage.encode({ op: IoOp.Read, fd: FD.Stdin });
      expect(client.send(msg)).toBe(true);
      expect(client2.send(msg)).toBe(true);
      await delay(100);
      expect(IoMessage.decode(client.receive()!)).toEqual({ op: IoOp.Data, fd: FD.Stdin, content: inputChunks[0] });
      expect(IoMessage.decode(client2.receive()!)).toEqual({ op: IoOp.Data, fd: FD.Stdin, content: inputChunks[1] });
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

      expect(messages).toContainEqual({ op: IoOp.Data, fd: FD.Stdin, content: inputChunks[0] });
      expect(messages).toContainEqual({ op: IoOp.Data, fd: FD.Stdin, content: inputChunks[1] });
      expect(messages).toContainEqual({ op: IoOp.State, fd: FD.Stdin, state: StreamState.Closed });
    });

    it('should handle read request with error', async () => {
      const msg = IoMessage.encode({ op: IoOp.Read, fd: FD.Stdin });
      client.send(msg);
      stdinController.error('failed');
      await delay(100);
      const message = IoMessage.decode(client.receive() || new Uint8Array());
      expect(message).toEqual({ op: IoOp.State, fd: FD.Stdin, state: StreamState.Error });
    });

    it('should handle read request on unknown fd', async () => {
      const fd = 999;
      const msg = IoMessage.encode({ op: IoOp.Read, fd });
      client.send(msg);
      await delay(100);
      const message = IoMessage.decode(client.receive() || new Uint8Array());
      expect(message).toEqual({ op: IoOp.State, fd, state: StreamState.Closed });
    });
  });

  describe('handleWrite', () => {
    it('should handle write request', async () => {
      const data = new Uint8Array([1, 2, 3]);
      const msg = IoMessage.encode({ op: IoOp.Write, fd: FD.Stdout, content: data });
      client.send(msg);
      await delay(100);
      expect(outputChunks).toEqual([data]);
    });

    it('should handle write request with error', async () => {
      const data = new Uint8Array([1, 2, 3]);
      const msg = IoMessage.encode({ op: IoOp.Write, fd: FD.Stdout, content: data });
      client.send(msg);
      stdoutController.error('failed');
      await delay(100);
      const message = IoMessage.decode(client.receive() || new Uint8Array());
      expect(message).toEqual({ op: IoOp.State, fd: FD.Stdout, state: StreamState.Error });
    });

    it('should handle write request on unknown fd', async () => {
      const fd = 999;
      const msg = IoMessage.encode({ op: IoOp.Write, fd, content: new Uint8Array([1]) });
      client.send(msg);
      await delay(100);
      const message = IoMessage.decode(client.receive() || new Uint8Array());
      expect(message).toEqual({ op: IoOp.State, fd, state: StreamState.Closed });
    });
  });
});
