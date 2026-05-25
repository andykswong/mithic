/**
 * Implements wasi:sockets/udp-create-socket - UDP socket factory.
 */

import type { IpAddressFamily } from './network.ts';
import { UdpSocket } from './udp.ts';

/**
 * Create a new UDP socket.
 *
 * The socket starts in the 'initial' state, unable to communicate
 * until bind is called.
 */
export function createUdpSocket(addressFamily: IpAddressFamily): UdpSocket {
  return new UdpSocket(addressFamily);
}
