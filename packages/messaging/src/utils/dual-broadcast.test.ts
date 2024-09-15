import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { delay, dispose } from '@mithic/commons';
import { DualBroadcastChannel } from './index.ts';

describe('DualBroadcastChannel', () => {
  let channel: DualBroadcastChannel;

  beforeEach(() => {
    channel = new DualBroadcastChannel('test');
  });

  afterEach(() => {
    dispose(channel);
  });

  it('should receive messages sent by itself', async () => {
    const message = { sender: 'test', content: 'Hello, world!' };
    const receivedMessages: object[] = [];
    channel.addEventListener('message', (event) => {
      receivedMessages.push(event.data);
    });

    channel.postMessage(message);

    await delay(100); // Wait for the message to be delivered
    assert.deepStrictEqual(receivedMessages, [message]);
  });

  it('should not receive duplicate messages sent from other instances', async () => {
    const otherChannel = new BroadcastChannel('test');
    const message = { sender: 'other', content: 'Hello, world!' };
    const receivedMessages: object[] = [];
    channel.addEventListener('message', (event) => {
      receivedMessages.push(event.data);
    });

    otherChannel.postMessage(message);

    await delay(100); // Wait for the message to be delivered
    assert.deepStrictEqual(receivedMessages, [message]);

    otherChannel.close();
  });
});
