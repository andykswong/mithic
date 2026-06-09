/**
 * Implements wasi:sockets/ip-name-lookup - DNS resolution.
 *
 * Delegates to SocketProvider.resolveName() from @mithic/io.
 */

import type { MaybePromise } from '@mithic/io';
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

function isIPv4Literal(name: string): boolean {
  const parts = name.split('.');
  if (parts.length !== 4) return false;
  return parts.every(p => { const n = Number(p); return Number.isInteger(n) && n >= 0 && n <= 255; });
}

function isIPv6Literal(name: string): boolean {
  if (!name.includes(':')) return false;
  const stripped = name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name;
  const parts = stripped.split(':');
  if (parts.length < 2 || parts.length > 8) return false;
  return parts.every(p => p === '' || /^[0-9a-fA-F]{1,4}$/.test(p));
}

/**
 * A stream of resolved IP addresses.
 * Generic over Sync: when the provider is sync, subscribe() returns a Pollable<true>
 * (always immediately ready). When async, subscribe() returns a Pollable<Sync> whose
 * blockReady awaits the resolution Promise.
 */
export class ResolveAddressStream<Sync extends boolean = boolean> {
  #addresses: IpAddress[] = [];
  #index = 0;
  #resolved = false;
  #error: ErrorCode | null = null;
  #resolvePromise: Promise<void> | undefined;

  constructor(name: string, provider?: SocketProvider<Sync>) {
    this.#startResolve(name, provider);
  }

  #startResolve(name: string, provider?: SocketProvider<Sync>): void {
    if (isIPv4Literal(name)) {
      this.#addresses = [parseIpAddress(name, 'ipv4')];
      this.#resolved = true;
      return;
    }
    if (isIPv6Literal(name)) {
      const stripped = name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name;
      this.#addresses = [parseIpAddress(stripped, 'ipv6')];
      this.#resolved = true;
      return;
    }

    const resolveProvider = provider ?? _getSocketProvider();
    try {
      const results = resolveProvider.resolveName(name);
      if (results instanceof Promise) {
        this.#resolvePromise = results.then(addrs => {
          this.#addresses = addrs.map((r) => parseIpAddress(r.address, r.family));
          this.#resolved = true;
        }).catch(err => {
          let code = convertError(err);
          if (code === 'unknown' || code === 'access-denied') {
            code = 'name-unresolvable';
          }
          this.#error = code;
          this.#resolved = true;
        });
        return;
      }
      this.#addresses = results.map((r) => parseIpAddress(r.address, r.family));
      this.#resolved = true;
    } catch (err) {
      let code = convertError(err);
      if (code === 'unknown' || code === 'access-denied') {
        code = 'name-unresolvable';
      }
      this.#error = code;
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
  subscribe(): Pollable<Sync> {
    const resolvePromise = this.#resolvePromise;
    return new Pollable<Sync>(
      () => this.#resolved,
      resolvePromise
        ? (() => resolvePromise) as () => MaybePromise<void, Sync>
        : undefined,
    );
  }
}

/**
 * Resolve an internet host name to a list of IP addresses.
 *
 * This function never blocks. It returns a ResolveAddressStream
 * that can be used to asynchronously fetch results.
 */
export function resolveAddresses(_network: Network, name: string): ResolveAddressStream<boolean> {
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
