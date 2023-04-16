import { wait } from '@mithic/commons';
import { DualBroadcastChannel } from '../dual-broadcast.js';

describe('DualBroadcastChannel', () => {
  let channel: DualBroadcastChannel;

  beforeEach(() => {
    channel = new DualBroadcastChannel('test');
  });

  afterEach(() => {
    channel.close();
  });

  it('should receive messages sent by itself', async () => {
    const message = { sender: 'test', content: 'Hello, world!' };
    const receivedMessages: object[] = [];
    channel.addEventListener('message', (event) => {
      receivedMessages.push(event.data);
    });

    channel.postMessage(message);

    await wait(100); // Wait for the message to be delivered
    expect(receivedMessages).toEqual([message]);
  });

  it('should not receive duplicate messages sent from other instances', async () => {
    const otherChannel = new BroadcastChannel('test');
    const message = { sender: 'other', content: 'Hello, world!' };
    const receivedMessages: object[] = [];
    channel.addEventListener('message', (event) => {
      receivedMessages.push(event.data);
    });

    otherChannel.postMessage(message);

    await wait(100); // Wait for the message to be delivered
    expect(receivedMessages).toEqual([message]);

    otherChannel.close();
  });
});
