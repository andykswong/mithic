/**
 * Implements wasi:sockets/instance-network - default network handle factory.
 */

import { Network } from './network.ts';

/** Get a handle to the default network. */
export function instanceNetwork(): Network {
  return new Network();
}
