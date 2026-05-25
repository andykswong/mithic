/**
 * The async I/O loop.
 *
 * Runs on the I/O loop thread (main thread in browser, configurable in Node.js).
 * Receives blocking calls from WASM worker threads and dispatches them to
 * registered handlers.
 */

import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { handleBlockingCalls, type CallHandler } from './sync-bridge.ts';

/** Options for creating an {@link IoLoop}. */
export interface IoLoopOptions {
  /** Async handler that processes I/O calls. */
  onCall: CallHandler;
}

/** The async I/O loop that manages worker connections and dispatches calls. */
export class IoLoop {
  private readonly onCall: CallHandler;
  private readonly workers = new Map<MessagePort, MessagePort>();

  public constructor(options: IoLoopOptions) {
    this.onCall = options.onCall;
  }

  /**
   * Start listening for calls from a specific WASM worker.
   * Returns a port for the worker to use for making blocking calls.
   */
  public addWorker(): MessagePort {
    const { port1, port2 } = new MessageChannel();

    // port1 stays with the I/O loop, port2 goes to the worker
    handleBlockingCalls(this.onCall, port1);
    this.workers.set(port2, port1);

    return port2;
  }

  /** Remove a worker connection and close its ports. */
  public removeWorker(port: MessagePort): void {
    const loopPort = this.workers.get(port);
    if (loopPort) {
      loopPort.close();
      port.close();
      this.workers.delete(port);
    }
  }

  /** Dispose the I/O loop, closing all worker connections. */
  public dispose(): void {
    for (const [workerPort, loopPort] of this.workers) {
      loopPort.close();
      workerPort.close();
    }
    this.workers.clear();
  }
}
