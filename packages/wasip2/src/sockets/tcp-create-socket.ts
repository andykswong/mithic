/**
 * Implements wasi:sockets/tcp-create-socket - TCP socket factory.
 */

import type { IpAddressFamily } from './network.ts';
import { TcpSocket } from './tcp.ts';

/**
 * Create a new TCP socket.
 *
 * The socket starts in the 'initial' state, unable to communicate
 * until bind/connect is called.
 */
export function createTcpSocket(addressFamily: IpAddressFamily): TcpSocket {
  return new TcpSocket(addressFamily);
}
