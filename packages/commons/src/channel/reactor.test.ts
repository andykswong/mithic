import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock, type Mock } from 'node:test';
import { TextCodec } from '../codec.ts';
import { dispose } from '../lifecycle.ts';
import { delay } from '../async/index.ts';
import { SyncMessageChannel } from './message.ts';
import { SyncMessageChannelReactor } from './reactor.ts';

describe('SyncMessageChannelReactor', () => {
  let reactor: SyncMessageChannelReactor<string>;
  let client: SyncMessageChannel<string>;
  let codec: TextCodec;
  let handler: Mock<(channel: SyncMessageChannel<string>, message: string) => void>;

  beforeEach(() => {
    codec = new TextCodec();
    handler = mock.fn();
    client = new SyncMessageChannel({ codec });
    reactor = new SyncMessageChannelReactor({ codec, onmessage: handler, ...client.buffers });
  });

  afterEach(() => {
    dispose(reactor);
  });

  it('should start by default', () => {
    assert.strictEqual(reactor.started, true);
  });

  it('should create a channel on construct', () => {
    assert.strictEqual([...reactor.channels()].length, 1);
  });

  describe('onmessage', () => {
    it('should process messages from client', async () => {
      const input = 'This is a testing.';
      assert.strictEqual(client.send(input), true);
      await delay(10);
      assert.deepStrictEqual(handler.mock.calls[0].arguments, [[...reactor.channels()][0], input]);
    });

    it('should support multiple clients', async () => {
      const client2 = new SyncMessageChannel({ codec, ...reactor.addChannel() });
      const input2 = 'This is a testing.';
      assert.strictEqual(client2.send(input2), true);
      const input = 'This is another test.';
      assert.strictEqual(client.send(input), true);

      await delay(10);
      const channels = [...reactor.channels()];
      assert.strictEqual(channels.length, 2);
      assert.deepStrictEqual(handler.mock.calls[1].arguments, [channels[0], input]);
      assert.deepStrictEqual(handler.mock.calls[0].arguments, [channels[1], input2]);
    });
  });

  describe('onaddchannel', () => {
    it('should be called when new channel is added', async () => {
      let channel = null;
      reactor.onaddchannel = (_channel) => {
        channel = _channel.buffers;
      };

      const buffers = reactor.addChannel();
      assert.deepStrictEqual(channel, buffers);
      assert.strictEqual([...reactor.channels()].length, 2);
    });
  });

  describe('onremovechannel', () => {
    it('should be called when channel is deleted', async () => {
      const buffers = reactor.addChannel();
      let channel = null;
      reactor.onremovechannel = (_channel) => {
        channel = _channel.buffers;
      };
      reactor.removeChannel(buffers);
      assert.deepStrictEqual(channel, buffers);
      assert.strictEqual([...reactor.channels()].length, 1);
    });
  });
});
