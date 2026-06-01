/**
 * mithic:process/manager — module-level WIT-aligned exports.
 * Delegates to a globally configured ProcessManager instance (lazily initialized).
 */

import type { InputStream, OutputStream } from '@mithic/wasip2/io/streams';
import type { Process, SpawnOptions, ProcessManager, PipeOptions } from './types.ts';
import { SimpleProcessManager } from './manager/simple.ts';

let _manager: ProcessManager | undefined;

function getOrCreateManager(): ProcessManager {
  if (!_manager) {
    _manager = new SimpleProcessManager();
  }
  return _manager;
}

/** Set the global ProcessManager instance. */
export function _setProcessManager(manager: ProcessManager): void {
  _manager = manager;
}

/** Get the global ProcessManager instance (lazily creates a SimpleProcessManager). */
export function _getProcessManager(): ProcessManager {
  return getOrCreateManager();
}

/** Spawn a child process (delegates to global ProcessManager). */
export function spawn(file: string, args: string[], options?: SpawnOptions): Process {
  return getOrCreateManager().spawn(file, args, options);
}

/** Create an anonymous pipe (delegates to global ProcessManager). */
export function createPipe(options?: PipeOptions): [InputStream, OutputStream] {
  const { input, output } = getOrCreateManager().createPipe(options);
  return [input, output];
}

/** Duplicate an output-stream (delegates to global ProcessManager). */
export function dupOutputStream(stream: OutputStream): OutputStream {
  return getOrCreateManager().dupOutputStream(stream);
}
