/**
 * Implements wasi:filesystem/preopens - pre-opened directory configuration.
 */

import { Descriptor, type FileData } from './types.ts';

let _fileData: FileData = { dir: {} };
let _preopens: [Descriptor, string][] = [[new Descriptor(_fileData), '/']];
let _rootPreopen: [Descriptor, string] | null = _preopens[0];

/**
 * Return the set of preopened directories, and their paths.
 */
export function getDirectories(): [Descriptor, string][] {
  return _preopens;
}

/**
 * Replace all preopens with the given set.
 */
export function _setPreopens(preopensConfig: Record<string, FileData>): void {
  _preopens = [];
  _rootPreopen = null;
  for (const [virtualPath, fileData] of Object.entries(preopensConfig)) {
    _addPreopen(virtualPath, fileData);
  }
}

/**
 * Add a single preopen mapping.
 */
export function _addPreopen(virtualPath: string, fileData: FileData): void {
  const descriptor = new Descriptor(fileData);
  _preopens.push([descriptor, virtualPath]);
  if (virtualPath === '/') {
    _rootPreopen = [descriptor, virtualPath];
    _fileData = fileData;
  }
}

/**
 * Clear all preopens, giving the guest no filesystem access.
 */
export function _clearPreopens(): void {
  _preopens = [];
  _rootPreopen = null;
}

/**
 * Set the root file data, resetting preopens to a single '/' preopen.
 */
export function _setFileData(fileData: FileData): void {
  _fileData = fileData;
  _preopens = [[new Descriptor(fileData), '/']];
  _rootPreopen = _preopens[0];
}

/**
 * Get the root file data.
 */
export function _getFileData(): FileData {
  return _fileData;
}
