/**
 * HTTP server bridge for wasi:http/incoming-handler.
 *
 * When a WASM component exports incoming-handler, the host uses an HttpServer
 * (from @mithic/io) to route incoming HTTP requests to the component's handler.
 * This module provides `createWasiRequestHandler()` which adapts io's
 * IncomingHttpHandler interface to the WASI incoming-handler protocol.
 *
 * Server instantiation and wiring is done outside this library by the host.
 */

import type { IncomingHttpHandler, HttpRequest, HttpResponse } from '@mithic/io/net';
export type { IncomingHttpHandler };

import { handle as incomingHandle } from './incoming-handler.ts';
import {
  Fields,
  incomingRequestCreate,
  responseOutparamCreate,
  responseOutparamGet,
  outgoingBodyData,
} from './types.ts';
import type { Method, Scheme } from './types.ts';

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/**
 * Create an IncomingHttpHandler (from @mithic/io) that bridges generic HTTP
 * requests to the WASI incoming-handler interface.
 *
 * Usage:
 *   const handler = createWasiRequestHandler();
 *   httpServer.listen(handler); // httpServer from @mithic/io
 */
export function createWasiRequestHandler(): IncomingHttpHandler {
  return async (request: HttpRequest): Promise<HttpResponse> => {
    const parsedUrl = parseUrl(request.url);

    const wasiMethod = parseMethod(request.method);
    const scheme = parseScheme(parsedUrl.protocol);
    const authority = parsedUrl.host || undefined;
    const pathWithQuery = parsedUrl.pathname + (parsedUrl.search || '');

    const headerEntries: [string, Uint8Array][] = request.headers.map(
      ([k, v]) => [k, utf8Encoder.encode(v)],
    );
    const wasiHeaders = Fields.fromList(headerEntries);

    const wasiRequest = incomingRequestCreate(
      wasiMethod,
      pathWithQuery,
      wasiHeaders,
      request.body,
      scheme,
      authority,
    );

    const responseOutparam = responseOutparamCreate();
    incomingHandle(wasiRequest, responseOutparam);

    const result = responseOutparamGet(responseOutparam);
    if (!result) {
      return { status: 500, headers: [], body: utf8Encoder.encode('No response set') };
    }

    if (result.tag === 'err') {
      return { status: 500, headers: [], body: utf8Encoder.encode('Handler returned error') };
    }

    const outgoingResponse = result.val;
    const status = outgoingResponse.statusCode();
    const respHeaders: [string, string][] = outgoingResponse.headers().entries().map(
      ([k, v]: [string, Uint8Array]) => [k, utf8Decoder.decode(v)],
    );

    let respBody: Uint8Array | undefined;
    try {
      const outBody = outgoingResponse.body();
      respBody = outgoingBodyData(outBody) ?? undefined;
    } catch {
      // Body may not have been requested
    }

    return { status, headers: respHeaders, body: respBody };
  };
}

function parseUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    return new URL(url, 'http://localhost');
  }
}

function parseMethod(method: string): Method {
  switch (method.toLowerCase()) {
    case 'get': return { tag: 'get' };
    case 'head': return { tag: 'head' };
    case 'post': return { tag: 'post' };
    case 'put': return { tag: 'put' };
    case 'delete': return { tag: 'delete' };
    case 'connect': return { tag: 'connect' };
    case 'options': return { tag: 'options' };
    case 'trace': return { tag: 'trace' };
    case 'patch': return { tag: 'patch' };
    default: return { tag: 'other', val: method };
  }
}

function parseScheme(protocol: string): Scheme {
  const clean = protocol.replace(':', '').toLowerCase();
  switch (clean) {
    case 'http': return { tag: 'HTTP' };
    case 'https': return { tag: 'HTTPS' };
    default: return { tag: 'other', val: clean };
  }
}
