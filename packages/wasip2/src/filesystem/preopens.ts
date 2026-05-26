/**
 * Implements wasi:filesystem/preopens - pre-opened directory configuration.
 */

import { Descriptor } from './types.ts';
import { MemoryFsProvider } from '@mithic/io/vfs';
import { SyncFsDescriptorHandler } from './sync-fs-handler.ts';

let _preopens: [Descriptor, string][] = [
  [new Descriptor(new SyncFsDescriptorHandler(new MemoryFsProvider(), '/')), '/'],
];

/**
 * Return the set of preopened directories, and their paths.
 */
export function getDirectories(): [Descriptor, string][] {
  return _preopens;
}

/**
 * Replace all preopens with the given set.
 */
export function _setPreopens(preopensConfig: Record<string, Descriptor>): void {
  _preopens = [];
  for (const [virtualPath, descriptor] of Object.entries(preopensConfig)) {
    _preopens.push([descriptor, virtualPath]);
  }
}

/**
 * Add a single preopen mapping.
 */
export function _addPreopen(virtualPath: string, descriptor: Descriptor): void {
  _preopens.push([descriptor, virtualPath]);
}

/**
 * Clear all preopens, giving the guest no filesystem access.
 */
export function _clearPreopens(): void {
  _preopens = [];
}
