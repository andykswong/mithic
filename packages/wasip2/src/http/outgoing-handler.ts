/**
 * Implements wasi:http/outgoing-handler.
 *
 * The handle() function takes an OutgoingRequest, converts it to a fetch call,
 * and returns a FutureIncomingResponse that resolves when the response arrives.
 */

import { outgoingRequestHandle } from './types.ts';
import type { OutgoingRequest, RequestOptions, FutureIncomingResponse } from './types.ts';

/**
 * Send an outgoing HTTP request and return a future for the response.
 *
 * This delegates to the outgoing request handle logic, which constructs
 * a URL from scheme + authority + pathWithQuery, gathers body data, and calls
 * globalThis.fetch.
 */
export function handle(request: OutgoingRequest, options?: RequestOptions): FutureIncomingResponse {
  return outgoingRequestHandle(request, options);
}
