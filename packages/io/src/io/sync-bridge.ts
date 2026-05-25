/**
 * Async-to-sync boundary using SharedArrayBuffer + Atomics.
 *
 * Provides a mechanism for WASM worker threads to make blocking I/O calls
 * that are fulfilled asynchronously by the I/O loop thread.
 */

import { receiveMessageOnPort, type MessagePort } from 'node:worker_threads';

/** A blocking call function used by the WASM worker thread. */
export type BlockingCallFn = (call: number, id: number | null, payload: unknown) => unknown;

/** An async call handler used by the I/O loop thread. */
export type CallHandler = (call: number, id: number | null, payload: unknown) => Promise<unknown>;

/** Message sent from the worker to the I/O loop. */
interface CallMessage {
  sharedBuffer: SharedArrayBuffer;
  call: number;
  id: number | null;
  payload: unknown;
}

/** Result message sent from the I/O loop back to the worker. */
interface ResultMessage {
  result?: unknown;
  error?: unknown;
}

/**
 * Creates a blocking call function for use by a WASM worker thread.
 *
 * Sends a call via postMessage, then blocks with `Atomics.wait` until the
 * I/O loop signals completion via `Atomics.notify`. Uses `receiveMessageOnPort`
 * to retrieve the result synchronously after waking.
 *
 * @param target - The MessagePort to communicate with the I/O loop.
 * @returns A blocking call function.
 */
export function createBlockingCall(target: MessagePort): BlockingCallFn {
  // Each call reuses a SharedArrayBuffer for the signal mechanism.
  // Index 0 of the Int32Array is the signal flag: 0 = waiting, incremented = done.
  const sharedBuffer = new SharedArrayBuffer(4);

  return (call: number, id: number | null, payload: unknown): unknown => {
    const view = new Int32Array(sharedBuffer);

    // Reset signal to 0 before sending
    Atomics.store(view, 0, 0);

    // Send the call to the I/O loop
    const message: CallMessage = { sharedBuffer, call, id, payload };
    target.postMessage(message);

    // Block until the I/O loop signals completion
    Atomics.wait(view, 0, 0);

    // Retrieve the result synchronously
    const received = receiveMessageOnPort(target);
    if (!received) {
      throw new Error('sync-bridge: no result message received after wake');
    }

    const result = received.message as ResultMessage;
    if ('error' in result) {
      throw result.error;
    }
    return result.result;
  };
}

/**
 * Sets up the I/O loop side of the blocking call bridge.
 *
 * Listens for incoming call messages on the given port, dispatches them to the
 * async handler, then signals completion and sends the result back.
 *
 * @param handler - Async function that processes I/O calls.
 * @param port - The MessagePort to listen on.
 */
export function handleBlockingCalls(handler: CallHandler, port: MessagePort): void {
  port.on('message', async (message: CallMessage) => {
    const { sharedBuffer, call, id, payload } = message;
    const view = new Int32Array(sharedBuffer);

    let result: ResultMessage;
    try {
      const value = await handler(call, id, payload);
      result = { result: value };
    } catch (error) {
      result = { error };
    }

    // Send the result back to the worker
    port.postMessage(result);

    // Signal the worker to wake up
    Atomics.add(view, 0, 1);
    Atomics.notify(view, 0);
  });
}
