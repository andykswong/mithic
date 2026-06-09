/**
 * Implements wasi:sockets/network - Network resource, error codes, and IP address types.
 */

export type ErrorCode =
  | 'unknown'
  | 'access-denied'
  | 'not-supported'
  | 'invalid-argument'
  | 'out-of-memory'
  | 'timeout'
  | 'concurrency-conflict'
  | 'not-in-progress'
  | 'would-block'
  | 'invalid-state'
  | 'new-socket-limit'
  | 'address-not-bindable'
  | 'address-in-use'
  | 'remote-unreachable'
  | 'connection-refused'
  | 'connection-reset'
  | 'connection-aborted'
  | 'datagram-too-large'
  | 'name-unresolvable'
  | 'temporary-resolver-failure'
  | 'permanent-resolver-failure';

export type IpAddressFamily = 'ipv4' | 'ipv6';

export type Ipv4Address = [number, number, number, number];
export type Ipv6Address = [number, number, number, number, number, number, number, number];

export type IpAddress =
  | { tag: 'ipv4'; val: Ipv4Address }
  | { tag: 'ipv6'; val: Ipv6Address };

export type IpSocketAddress =
  | { tag: 'ipv4'; val: { port: number; address: Ipv4Address } }
  | { tag: 'ipv6'; val: { port: number; flowInfo: number; address: Ipv6Address; scopeId: number } };

/** An opaque resource that represents access to (a subset of) the network. */
export class Network {}

/**
 * Convert an error from SocketProvider into a WASI error code.
 */
export function convertError(err: unknown): ErrorCode {
  if (typeof err === 'string') {
    // Already an error code string
    const validCodes: ErrorCode[] = [
      'unknown', 'access-denied', 'not-supported', 'invalid-argument',
      'out-of-memory', 'timeout', 'concurrency-conflict', 'not-in-progress',
      'would-block', 'invalid-state', 'new-socket-limit', 'address-not-bindable',
      'address-in-use', 'remote-unreachable', 'connection-refused', 'connection-reset',
      'connection-aborted', 'datagram-too-large', 'name-unresolvable',
      'temporary-resolver-failure', 'permanent-resolver-failure',
    ];
    if (validCodes.includes(err as ErrorCode)) {
      return err as ErrorCode;
    }
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('disabled') || msg.includes('access')) return 'access-denied';
    if (msg.includes('refused')) return 'connection-refused';
    if (msg.includes('reset')) return 'connection-reset';
    if (msg.includes('aborted')) return 'connection-aborted';
    if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
    if (msg.includes('unreachable')) return 'remote-unreachable';
    if (msg.includes('in use') || msg.includes('address already')) return 'address-in-use';
    if (msg.includes('not supported')) return 'not-supported';
  }
  return 'unknown';
}

/**
 * Serialize an IpSocketAddress to a host:port string representation.
 */
export function serializeAddress(addr: IpSocketAddress): { host: string; port: number } {
  if (addr.tag === 'ipv4') {
    return {
      host: addr.val.address.join('.'),
      port: addr.val.port,
    };
  } else {
    return {
      host: addr.val.address.map(s => s.toString(16)).join(':'),
      port: addr.val.port,
    };
  }
}

/**
 * Parse a host string into an IpAddress.
 */
export function parseIpAddress(host: string, family: 'ipv4' | 'ipv6'): IpAddress {
  if (family === 'ipv4') {
    const parts = host.split('.').map(Number) as [number, number, number, number];
    return { tag: 'ipv4', val: parts };
  } else {
    return { tag: 'ipv6', val: parseIpv6(host) };
  }
}

function parseIpv6(host: string): Ipv6Address {
  const doubleColonIdx = host.indexOf('::');
  if (doubleColonIdx === -1) {
    const parts = host.split(':').map(s => parseInt(s, 16) || 0);
    while (parts.length < 8) parts.push(0);
    return parts.slice(0, 8) as unknown as Ipv6Address;
  }
  const before = doubleColonIdx === 0 ? [] : host.slice(0, doubleColonIdx).split(':').map(s => parseInt(s, 16) || 0);
  const after = doubleColonIdx === host.length - 2 ? [] : host.slice(doubleColonIdx + 2).split(':').map(s => parseInt(s, 16) || 0);
  const zerosNeeded = 8 - before.length - after.length;
  const parts = [...before, ...Array(zerosNeeded).fill(0), ...after];
  return parts.slice(0, 8) as unknown as Ipv6Address;
}

/**
 * Create a zero IpSocketAddress for the given family.
 */
export function zeroAddress(family: IpAddressFamily): IpSocketAddress {
  if (family === 'ipv4') {
    return { tag: 'ipv4', val: { port: 0, address: [0, 0, 0, 0] } };
  }
  return { tag: 'ipv6', val: { port: 0, flowInfo: 0, address: [0, 0, 0, 0, 0, 0, 0, 0], scopeId: 0 } };
}
