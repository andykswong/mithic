import type { Asyncify } from './state.ts';

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Registry mapping export functions to their owning Asyncify instance.
 * Populated by createInstantiateCore when asyncified modules are instantiated.
 * Consumed by the `promising` polyfill to find the correct state machine.
 */
export const asyncifyRegistry = new WeakMap<object, Asyncify>();

export class Suspending {
  readonly __asyncify_fn: AnyFn;
  constructor(fn: AnyFn) {
    this.__asyncify_fn = fn;
  }
}

export interface PolyfillHandle {
  installed: boolean;
  overrodeNative: boolean;
}

export interface PolyfillOptions {
  overrideNative?: boolean;
}

/**
 * Install JSPI polyfill that delegates to per-module Asyncify instances
 * via the asyncifyRegistry. Call once at startup — works for any number
 * of concurrent components.
 *
 * By default, does NOT override native JSPI if present. Set `overrideNative: true`
 * to force the asyncify polyfill even when the engine supports JSPI natively.
 */
export function installPolyfill(opts?: PolyfillOptions): PolyfillHandle {
  const overrideNative = opts?.overrideNative ?? false;
  const hasNativeSuspending = 'Suspending' in WebAssembly;
  const hasNativePromising = 'promising' in WebAssembly;

  if (!overrideNative && hasNativeSuspending && hasNativePromising) {
    return { installed: false, overrodeNative: false };
  }

  Object.defineProperty(WebAssembly, 'Suspending', {
    value: Suspending,
    writable: true,
    configurable: true,
  });

  Object.defineProperty(WebAssembly, 'promising', {
    value: (fn: AnyFn): AnyFn => {
      const asyncify = asyncifyRegistry.get(fn as object);
      if (asyncify) return asyncify.wrapExportFn(fn);
      return fn;
    },
    writable: true,
    configurable: true,
  });

  return {
    installed: true,
    overrodeNative: hasNativeSuspending || hasNativePromising,
  };
}
