/**
 * wasi:http/incoming-handler - Export interface for HTTP server components.
 *
 * This is an EXPORT interface: the guest component provides it and the host calls it.
 * The host framework registers a handler via _setIncomingHandler(), then calls handle()
 * when an HTTP request arrives.
 */

import type { IncomingRequest, ResponseOutparam } from './types.ts';

type IncomingHandlerFn = (request: IncomingRequest, responseOut: ResponseOutparam) => void;

let _handler: IncomingHandlerFn | null = null;

/**
 * Register the guest's incoming handler function.
 * Called by the host framework to wire up the component's exported handler.
 */
export function _setIncomingHandler(fn: IncomingHandlerFn): void {
  _handler = fn;
}

/**
 * Get the currently registered handler (for testing/introspection).
 */
export function _getIncomingHandler(): IncomingHandlerFn | null {
  return _handler;
}

/**
 * The exported handle function. Called by the host when an HTTP request arrives.
 * Invokes the registered handler with the request and response outparam.
 */
export function handle(request: IncomingRequest, responseOut: ResponseOutparam): void {
  if (!_handler) {
    throw new Error('wasi:http/incoming-handler: no handler registered (call _setIncomingHandler first)');
  }
  _handler(request, responseOut);
}
