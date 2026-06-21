import { describe, it, expect } from 'vitest';
import { DisabledSocketProvider } from './sockets.ts';

describe('DisabledSocketProvider', () => {
  it('createTcpSocket() throws with message about disabled', () => {
    const provider = new DisabledSocketProvider();
    expect(() => provider.createTcpSocket()).toThrow('disabled');
  });

  it('createUdpSocket() throws with message about disabled', () => {
    const provider = new DisabledSocketProvider();
    expect(() => provider.createUdpSocket()).toThrow('disabled');
  });

  it('resolveName() throws with message about disabled', () => {
    const provider = new DisabledSocketProvider();
    expect(() => provider.resolveName('example.com')).toThrow('disabled');
  });
});
