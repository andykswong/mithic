/**
 * Blocking caller API used by WASM worker threads.
 *
 * Wraps `createBlockingCall` with a typed interface for making
 * synchronous I/O calls from within a worker.
 */

import type { MessagePort } from 'node:worker_threads';
import { createBlockingCall, type BlockingCallFn } from './sync-bridge.ts';

/** Blocking I/O interface for WASM worker threads. */
export class WorkerIo {
  private readonly call: BlockingCallFn;

  public constructor(port: MessagePort) {
    this.call = createBlockingCall(port);
  }

  /** Make a blocking I/O call. */
  public ioCall(call: number, id: number | null, payload?: unknown): unknown {
    return this.call(call, id, payload ?? null);
  }
}
