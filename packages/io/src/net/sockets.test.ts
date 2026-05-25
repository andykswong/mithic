import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DisabledSocketProvider } from './sockets.ts';

describe('DisabledSocketProvider', () => {
  it('createTcpSocket() rejects with message about disabled', async () => {
    const provider = new DisabledSocketProvider();
    await assert.rejects(
      () => provider.createTcpSocket(),
      (err: unknown) => err instanceof Error && err.message.includes('disabled')
    );
  });

  it('createUdpSocket() rejects with message about disabled', async () => {
    const provider = new DisabledSocketProvider();
    await assert.rejects(
      () => provider.createUdpSocket(),
      (err: unknown) => err instanceof Error && err.message.includes('disabled')
    );
  });

  it('resolveName() rejects with message about disabled', async () => {
    const provider = new DisabledSocketProvider();
    await assert.rejects(
      () => provider.resolveName('example.com'),
      (err: unknown) => err instanceof Error && err.message.includes('disabled')
    );
  });
});
