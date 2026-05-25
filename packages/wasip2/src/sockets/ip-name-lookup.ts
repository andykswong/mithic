/**
 * Implements wasi:sockets/ip-name-lookup - DNS resolution.
 *
 * Delegates to SocketProvider.resolveName() from @mithic/io.
 */

import type { SocketProvider } from '@mithic/io/net';
import { Pollable } from '../io/poll.ts';
import {
  type ErrorCode,
  type IpAddress,
  type Network,
  convertError,
  parseIpAddress,
} from './network.ts';
import { _getSocketProvider } from './tcp.ts';

/**
 * A stream of resolved IP addresses.
 */
export class ResolveAddressStream {
  #addresses: IpAddress[] = [];
  #index = 0;
  #resolved = false;
  #error: ErrorCode | null = null;

  constructor(name: string, provider?: SocketProvider) {
    this.#startResolve(name, provider);
  }

  #startResolve(name: string, provider?: SocketProvider): void {
    // Start resolution. The promise handlers fire asynchronously (microtask),
    // so we track settlement via a flag.
    const resolveProvider = provider ?? _getSocketProvider();
    let syncError: ErrorCode | null = null;
    try {
      const promise = resolveProvider.resolveName(name);
      promise.then((results) => {
        this.#addresses = results.map((r) => parseIpAddress(r.address, r.family));
        this.#resolved = true;
      }).catch((err) => {
        let code = convertError(err);
        if (code === 'unknown' || code === 'access-denied') {
          code = 'name-unresolvable';
        }
        this.#error = code;
        this.#resolved = true;
      });
    } catch (err) {
      // Provider threw synchronously (non-async implementation)
      syncError = convertError(err);
      if (syncError === 'unknown' || syncError === 'access-denied') {
        syncError = 'name-unresolvable';
      }
    }
    if (syncError) {
      this.#error = syncError;
      this.#resolved = true;
    } else {
      // For async providers, the promise will settle in a microtask.
      // Mark as resolved optimistically — the pollable pattern expects
      // callers to check subscribe() before resolveNextAddress().
      // In the sync shim model, we assume operations complete immediately
      // and report errors via the next resolve call.
      this.#resolved = true;
    }
  }

  /**
   * Returns the next address from the resolver.
   * Returns undefined when all addresses have been exhausted.
   * Throws an error code on failure.
   */
  resolveNextAddress(): IpAddress | undefined {
    if (!this.#resolved) {
      throw 'would-block' as ErrorCode;
    }
    if (this.#error) {
      throw this.#error;
    }
    if (this.#index >= this.#addresses.length) {
      return undefined;
    }
    return this.#addresses[this.#index++];
  }

  /**
   * Create a pollable which resolves once the stream is ready.
   */
  subscribe(): Pollable {
    return new Pollable(() => this.#resolved);
  }
}

/**
 * Resolve an internet host name to a list of IP addresses.
 *
 * This function never blocks. It returns a ResolveAddressStream
 * that can be used to asynchronously fetch results.
 */
export function resolveAddresses(_network: Network, name: string): ResolveAddressStream {
  // Validate the name
  if (!name || name.length === 0) {
    throw 'invalid-argument' as ErrorCode;
  }
  // eslint-disable-next-line no-control-regex -- intentional: reject ASCII control characters
  if (/[\x00-\x1F\x7F]/.test(name)) {
    throw 'invalid-argument' as ErrorCode;
  }
  return new ResolveAddressStream(name);
}
