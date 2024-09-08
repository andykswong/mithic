import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { TextCodec } from '../../codec.ts';
import { dispose } from '../../lifecycle.ts';
import { delay } from '../../async/index.ts';
import { SyncMessageChannel } from '../message.ts';
import { SyncMessageChannelReactor } from '../reactor.ts';

describe(SyncMessageChannelReactor.name, () => {
  let reactor: SyncMessageChannelReactor<string>;
  let client: SyncMessageChannel<string>;
  let codec: TextCodec;
  let handler: jest.Mock<(channel: SyncMessageChannel<string>, message: string) => void>;

  beforeEach(() => {
    codec = new TextCodec();
    handler = jest.fn();
    client = new SyncMessageChannel({ codec });
    reactor = new SyncMessageChannelReactor({ codec, onmessage: handler, ...client.buffers });
  });

  afterEach(() => {
    dispose(reactor);
  });

  it('should start by default', () => {
    expect(reactor.started).toBe(true);
  });

  it('should create a channel on construct', () => {
    expect([...reactor.channels()].length).toBe(1);
  });

  describe('onmessage', () => {
    it('should process messages from client', async () => {
      const input = 'This is a testing.';
      expect(client.send(input)).toBe(true);
      await delay(10);
      expect(handler).toHaveBeenCalledWith([...reactor.channels()][0], input);
    });

    it('should support multiple clients', async () => {
      const client2 = new SyncMessageChannel({ codec, ...reactor.addChannel() });
      const input2 = 'This is a testing.';
      expect(client2.send(input2)).toBe(true);
      const input = 'This is another test.';
      expect(client.send(input)).toBe(true);

      await delay(10);
      const channels = [...reactor.channels()];
      expect(channels.length).toBe(2);
      expect(handler).toHaveBeenCalledWith(channels[0], input);
      expect(handler).toHaveBeenCalledWith(channels[1], input2);
    });
  });

  describe('onaddchannel', () => {
    it('should be called when new channel is added', async () => {
      let channel = null;
      reactor.onaddchannel = (_channel) => {
        channel = _channel.buffers;
      };

      const buffers = reactor.addChannel();
      expect(channel).toEqual(buffers);
      expect([...reactor.channels()].length).toBe(2);
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
      expect(channel).toEqual(buffers);
      expect([...reactor.channels()].length).toBe(1);
    });
  });
});
