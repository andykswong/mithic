import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DisabledSocketProvider } from './sockets.ts';

describe('DisabledSocketProvider', () => {
  it('createTcpSocket() throws with message about disabled', () => {
    const provider = new DisabledSocketProvider();
    assert.throws(
      () => provider.createTcpSocket(),
      (err: unknown) => err instanceof Error && err.message.includes('disabled')
    );
  });

  it('createUdpSocket() throws with message about disabled', () => {
    const provider = new DisabledSocketProvider();
    assert.throws(
      () => provider.createUdpSocket(),
      (err: unknown) => err instanceof Error && err.message.includes('disabled')
    );
  });

  it('resolveName() throws with message about disabled', () => {
    const provider = new DisabledSocketProvider();
    assert.throws(
      () => provider.resolveName('example.com'),
      (err: unknown) => err instanceof Error && err.message.includes('disabled')
    );
  });
});
