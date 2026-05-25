/**
 * Full implementation of wasi:http/types.
 * Based on jco's browser HTTP implementation, adapted to use our InputStream/OutputStream/Pollable.
 */

import { InputStream, OutputStream } from '../io/streams.ts';
import { Pollable } from '../io/poll.ts';
import type { HttpClient, HttpResponse } from '@mithic/io/net';
import { FetchHttpClient } from '@mithic/io/net';

let _defaultHttpClient: HttpClient = new FetchHttpClient();

export function _setHttpClient(client: HttpClient): void {
  _defaultHttpClient = client;
}

export function _getHttpClient(): HttpClient {
  return _defaultHttpClient;
}

const utf8Decoder = new TextDecoder();
const utf8Encoder = new TextEncoder();
const forbiddenHeaders = new Set(['connection', 'keep-alive', 'host']);
const DEFAULT_HTTP_TIMEOUT_NS = 600_000_000_000n;

// RFC 9110 compliant header validation
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const FIELD_VALUE_RE = /^[\t\x20-\x7E\x80-\xFF]*$/;

/**
 * Module-level symbol used for internal state access across classes within this module.
 * Not exported, so external consumers cannot access internal state.
 */
const INTERNAL = Symbol('http.internal');

interface FieldsInternal {
  immutable: boolean;
  entries: [FieldName, FieldValue][];
  table: Map<string, [FieldName, FieldValue][]>;
}

interface OutgoingBodyInternal {
  chunks: Uint8Array[];
  outputStream: OutputStream | null;
  finished: boolean;
}

interface OutgoingRequestInternal {
  method: Method;
  scheme: Scheme | undefined;
  pathWithQuery: string | undefined;
  authority: string | undefined;
  headers: Fields;
  body: OutgoingBody;
  bodyRequested: boolean;
}

interface IncomingBodyInternal {
  stream: InputStream | null | undefined;
  finished: boolean;
}

interface IncomingResponseInternal {
  status: StatusCode;
  headers: Fields | undefined;
  body: IncomingBody | undefined;
}

interface FutureTrailersInternal {
  requested: boolean;
}

interface FutureIncomingResponseInternal {
  result: FutureResult | undefined;
  resolved: boolean;
  promise: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | undefined;
}

function validateHeaderName(name: string): void {
  if (!TOKEN_RE.test(name)) {
    throw { tag: 'invalid-syntax' } as HeaderError;
  }
}

function validateHeaderValue(value: Uint8Array | string): void {
  const str = typeof value === 'string' ? value : utf8Decoder.decode(value);
  if (!FIELD_VALUE_RE.test(str)) {
    throw { tag: 'invalid-syntax' } as HeaderError;
  }
}

// --- Type definitions ---

export type Method =
  | { tag: 'get' }
  | { tag: 'head' }
  | { tag: 'post' }
  | { tag: 'put' }
  | { tag: 'delete' }
  | { tag: 'connect' }
  | { tag: 'options' }
  | { tag: 'trace' }
  | { tag: 'patch' }
  | { tag: 'other'; val: string };

export type Scheme =
  | { tag: 'HTTP' }
  | { tag: 'HTTPS' }
  | { tag: 'other'; val: string };

export type ErrorCode =
  | { tag: 'DNS-timeout' }
  | { tag: 'DNS-error'; val?: { rcode?: string; infoCode?: number } }
  | { tag: 'destination-not-found' }
  | { tag: 'destination-unavailable' }
  | { tag: 'destination-IP-prohibited' }
  | { tag: 'destination-IP-unroutable' }
  | { tag: 'connection-refused' }
  | { tag: 'connection-terminated' }
  | { tag: 'connection-timeout' }
  | { tag: 'connection-read-timeout' }
  | { tag: 'connection-write-timeout' }
  | { tag: 'connection-limit-reached' }
  | { tag: 'TLS-protocol-error' }
  | { tag: 'TLS-certificate-error' }
  | { tag: 'TLS-alert-received'; val?: { alertId?: number; alertMessage?: string } }
  | { tag: 'HTTP-request-denied' }
  | { tag: 'HTTP-request-length-required' }
  | { tag: 'HTTP-request-body-size'; val?: bigint }
  | { tag: 'HTTP-request-method-invalid' }
  | { tag: 'HTTP-request-URI-invalid' }
  | { tag: 'HTTP-request-URI-too-long' }
  | { tag: 'HTTP-request-header-section-size'; val?: number }
  | { tag: 'HTTP-request-header-size'; val?: { fieldName?: string; fieldSize?: number } }
  | { tag: 'HTTP-request-trailer-section-size'; val?: number }
  | { tag: 'HTTP-request-trailer-size'; val: { fieldName?: string; fieldSize?: number } }
  | { tag: 'HTTP-response-incomplete' }
  | { tag: 'HTTP-response-header-section-size'; val?: number }
  | { tag: 'HTTP-response-header-size'; val: { fieldName?: string; fieldSize?: number } }
  | { tag: 'HTTP-response-body-size'; val?: bigint }
  | { tag: 'HTTP-response-trailer-section-size'; val?: number }
  | { tag: 'HTTP-response-trailer-size'; val: { fieldName?: string; fieldSize?: number } }
  | { tag: 'HTTP-response-transfer-coding'; val?: string }
  | { tag: 'HTTP-response-content-coding'; val?: string }
  | { tag: 'HTTP-response-timeout' }
  | { tag: 'HTTP-upgrade-failed' }
  | { tag: 'HTTP-protocol-error' }
  | { tag: 'loop-detected' }
  | { tag: 'configuration-error' }
  | { tag: 'internal-error'; val?: string };

export type HeaderError =
  | { tag: 'invalid-syntax' }
  | { tag: 'forbidden' }
  | { tag: 'immutable' };

export type FieldName = string;
export type FieldValue = Uint8Array;
export type StatusCode = number;

// --- Module-level factory/accessor functions ---

/** Lock fields to become immutable. */
function fieldsLock(fields: Fields): Fields {
  (fields as unknown as Record<symbol, FieldsInternal>)[INTERNAL].immutable = true;
  return fields;
}

/** Create Fields from pre-validated entries (no validation performed). */
function fieldsFromEntriesChecked(entries: [FieldName, FieldValue][]): Fields {
  const fields = new Fields();
  const internal = (fields as unknown as Record<symbol, FieldsInternal>)[INTERNAL];
  internal.entries = entries;
  for (const entry of entries) {
    const lowercase = entry[0].toLowerCase();
    const existing = internal.table.get(lowercase);
    if (existing) {
      existing.push(entry);
    } else {
      internal.table.set(lowercase, [entry]);
    }
  }
  return fields;
}

/** Create a new OutgoingBody with output stream. */
function outgoingBodyCreate(): OutgoingBody {
  const body = new OutgoingBody(INTERNAL);
  const internal = (body as unknown as Record<symbol, OutgoingBodyInternal>)[INTERNAL];
  const chunks = internal.chunks;
  internal.outputStream = new OutputStream({
    write(buf: Uint8Array) {
      chunks.push(new Uint8Array(buf));
    },
    flush() {},
  });
  return body;
}

/** Get collected body data from an OutgoingBody. */
function outgoingBodyData(body: OutgoingBody): Uint8Array | null {
  const internal = (body as unknown as Record<symbol, OutgoingBodyInternal>)[INTERNAL];
  if (internal.chunks.length === 0) {
    return null;
  }
  let totalLen = 0;
  for (const chunk of internal.chunks) {
    totalLen += chunk.byteLength;
  }
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of internal.chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** Create a FutureTrailers instance. */
function futureTrailersCreate(): FutureTrailers {
  return new FutureTrailers(INTERNAL);
}


/** Create IncomingBody from a Uint8Array (for sync/non-streaming responses). */
function incomingBodyCreateFromBuffer(data: Uint8Array | undefined): IncomingBody {
  const incomingBody = new IncomingBody(INTERNAL);
  const internal = (incomingBody as unknown as Record<symbol, IncomingBodyInternal>)[INTERNAL];
  const bodyBuffer = data ?? new Uint8Array(0);
  let offset = 0;

  internal.stream = new InputStream({
    read(len: number): Uint8Array | undefined {
      if (offset >= bodyBuffer.byteLength) {
        throw { tag: 'closed' };
      }
      const available = bodyBuffer.byteLength - offset;
      const toRead = Math.min(len, available);
      const slice = bodyBuffer.slice(offset, offset + toRead);
      offset += toRead;
      return slice;
    },
    blockingRead(len: number): Uint8Array {
      if (offset >= bodyBuffer.byteLength) {
        throw { tag: 'closed' };
      }
      const available = bodyBuffer.byteLength - offset;
      const toRead = Math.min(len, available);
      const slice = bodyBuffer.slice(offset, offset + toRead);
      offset += toRead;
      return slice;
    },
    subscribe(): Pollable {
      return new Pollable(() => true);
    },
  });

  return incomingBody;
}

/** Create IncomingResponse from an HttpResponse (from @mithic/io HttpClient). */
function incomingResponseCreateFromClientResponse(clientResponse: HttpResponse): IncomingResponse {
  const res = new IncomingResponse(INTERNAL);
  const internal = (res as unknown as Record<symbol, IncomingResponseInternal>)[INTERNAL];
  internal.status = clientResponse.status;

  const headerEntries: [FieldName, FieldValue][] = clientResponse.headers.map(
    ([key, value]) => [key, utf8Encoder.encode(value)],
  );
  internal.headers = fieldsLock(fieldsFromEntriesChecked(headerEntries));

  internal.body = incomingBodyCreateFromBuffer(clientResponse.body);
  return res;
}

/** Create IncomingResponse from a buffered response (status, headers, body). */
function incomingResponseCreateFromBuffered(
  status: number,
  headers: [string, string][],
  body?: Uint8Array,
): IncomingResponse {
  const res = new IncomingResponse(INTERNAL);
  const internal = (res as unknown as Record<symbol, IncomingResponseInternal>)[INTERNAL];
  internal.status = status;

  const headerEntries: [FieldName, FieldValue][] = headers.map(([k, v]) => [k, utf8Encoder.encode(v)]);
  internal.headers = fieldsLock(fieldsFromEntriesChecked(headerEntries));
  internal.body = incomingBodyCreateFromBuffer(body);
  return res;
}

/** Create a FutureIncomingResponse that sends the request via the pluggable HttpClient. */
function futureIncomingResponseCreate(
  url: string,
  method: string,
  headers: [string, string][],
  bodyData: Uint8Array | null,
  timeoutMs: number,
  httpClient?: HttpClient,
): FutureIncomingResponse {
  const future = new FutureIncomingResponse(INTERNAL);
  const internal = (future as unknown as Record<symbol, FutureIncomingResponseInternal>)[INTERNAL];

  const controller = new AbortController();
  if (timeoutMs < Infinity) {
    internal.timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  const client = httpClient ?? _getHttpClient();
  internal.promise = client.send({
    method,
    url,
    headers,
    body: (bodyData && method !== 'GET' && method !== 'HEAD') ? bodyData : undefined,
  }).then(
    (response) => {
      if (internal.timer) { clearTimeout(internal.timer); internal.timer = undefined; }
      internal.result = {
        tag: 'ok',
        val: {
          tag: 'ok',
          val: incomingResponseCreateFromClientResponse(response),
        },
      };
      internal.resolved = true;
    },
    (err: Error) => {
      if (internal.timer) { clearTimeout(internal.timer); internal.timer = undefined; }
      internal.result = {
        tag: 'ok',
        val: {
          tag: 'err',
          val: mapFetchError(err),
        },
      };
      internal.resolved = true;
    },
  );

  return future;
}

/** Create already-resolved FutureIncomingResponse from a result value. */
function futureIncomingResponseCreateResolved(result: FutureResult): FutureIncomingResponse {
  const future = new FutureIncomingResponse(INTERNAL);
  const internal = (future as unknown as Record<symbol, FutureIncomingResponseInternal>)[INTERNAL];
  internal.result = result;
  internal.resolved = true;
  return future;
}

// --- Fields ---

export class Fields {
  [INTERNAL]: FieldsInternal = {
    immutable: false,
    entries: [],
    table: new Map(),
  };

  constructor() {}

  static fromList(entries: [FieldName, FieldValue][]): Fields {
    const fields = new Fields();
    const internal = fields[INTERNAL];
    for (const [key, value] of entries) {
      validateHeaderName(key);
      validateHeaderValue(value);
      const lowercased = key.toLowerCase();
      if (forbiddenHeaders.has(lowercased)) {
        throw { tag: 'forbidden' } as HeaderError;
      }
      const entry: [FieldName, FieldValue] = [key, value];
      internal.entries.push(entry);
      const tableEntries = internal.table.get(lowercased);
      if (tableEntries) {
        tableEntries.push(entry);
      } else {
        internal.table.set(lowercased, [entry]);
      }
    }
    return fields;
  }

  get(name: FieldName): FieldValue[] {
    const tableEntries = this[INTERNAL].table.get(name.toLowerCase());
    if (!tableEntries) {
      return [];
    }
    return tableEntries.map(([, v]) => v);
  }

  has(name: FieldName): boolean {
    return this[INTERNAL].table.has(name.toLowerCase());
  }

  set(name: FieldName, values: FieldValue[]): void {
    const internal = this[INTERNAL];
    if (internal.immutable) {
      throw { tag: 'immutable' } as HeaderError;
    }
    validateHeaderName(name);
    for (const value of values) {
      validateHeaderValue(value);
    }
    const lowercased = name.toLowerCase();
    if (forbiddenHeaders.has(lowercased)) {
      throw { tag: 'forbidden' } as HeaderError;
    }
    const tableEntries = internal.table.get(lowercased);
    if (tableEntries) {
      internal.entries = internal.entries.filter((entry) => !tableEntries.includes(entry));
      tableEntries.splice(0, tableEntries.length);
    } else {
      internal.table.set(lowercased, []);
    }
    const newTableEntries = internal.table.get(lowercased)!;
    for (const value of values) {
      const entry: [FieldName, FieldValue] = [name, value];
      internal.entries.push(entry);
      newTableEntries.push(entry);
    }
  }

  delete(name: FieldName): void {
    const internal = this[INTERNAL];
    if (internal.immutable) {
      throw { tag: 'immutable' } as HeaderError;
    }
    const lowercased = name.toLowerCase();
    const tableEntries = internal.table.get(lowercased);
    if (tableEntries) {
      internal.entries = internal.entries.filter((entry) => !tableEntries.includes(entry));
      internal.table.delete(lowercased);
    }
  }

  append(name: FieldName, value: FieldValue): void {
    const internal = this[INTERNAL];
    if (internal.immutable) {
      throw { tag: 'immutable' } as HeaderError;
    }
    validateHeaderName(name);
    validateHeaderValue(value);
    const lowercased = name.toLowerCase();
    if (forbiddenHeaders.has(lowercased)) {
      throw { tag: 'forbidden' } as HeaderError;
    }
    const entry: [FieldName, FieldValue] = [name, value];
    internal.entries.push(entry);
    const tableEntries = internal.table.get(lowercased);
    if (tableEntries) {
      tableEntries.push(entry);
    } else {
      internal.table.set(lowercased, [entry]);
    }
  }

  entries(): [FieldName, FieldValue][] {
    return this[INTERNAL].entries;
  }

  clone(): Fields {
    return fieldsFromEntriesChecked(this[INTERNAL].entries.map(([k, v]) => [k, new Uint8Array(v)]));
  }

  [Symbol.dispose](): void {}
}

// --- RequestOptions ---

export class RequestOptions {
  #connectTimeout: bigint | undefined = undefined;
  #firstByteTimeout: bigint | undefined = undefined;
  #betweenBytesTimeout: bigint | undefined = undefined;

  constructor() {}

  connectTimeout(): bigint | undefined {
    return this.#connectTimeout;
  }

  setConnectTimeout(duration: bigint | undefined): void {
    if (duration !== undefined && duration < 0n) {
      throw new Error('duration must not be negative');
    }
    this.#connectTimeout = duration;
  }

  firstByteTimeout(): bigint | undefined {
    return this.#firstByteTimeout;
  }

  setFirstByteTimeout(duration: bigint | undefined): void {
    if (duration !== undefined && duration < 0n) {
      throw new Error('duration must not be negative');
    }
    this.#firstByteTimeout = duration;
  }

  betweenBytesTimeout(): bigint | undefined {
    return this.#betweenBytesTimeout;
  }

  setBetweenBytesTimeout(duration: bigint | undefined): void {
    if (duration !== undefined && duration < 0n) {
      throw new Error('duration must not be negative');
    }
    this.#betweenBytesTimeout = duration;
  }
}

// --- OutgoingBody ---

export class OutgoingBody {
  [INTERNAL]: OutgoingBodyInternal;

  /** @internal - Use module-level outgoingBodyCreate() instead. */
  constructor(token: symbol) {
    if (token !== INTERNAL) {
      throw new Error('OutgoingBody cannot be constructed directly');
    }
    this[INTERNAL] = {
      chunks: [],
      outputStream: null,
      finished: false,
    };
  }

  write(): OutputStream {
    const internal = this[INTERNAL];
    const outputStream = internal.outputStream;
    if (outputStream === null) {
      throw new Error('output stream already taken or not available');
    }
    internal.outputStream = null;
    return outputStream;
  }

  static finish(body: OutgoingBody, trailers?: Fields): void {
    if (trailers) {
      throw { tag: 'internal-error', val: 'trailers unsupported' } as ErrorCode;
    }
    const internal = body[INTERNAL];
    if (internal.finished) {
      throw { tag: 'internal-error', val: 'body already finished' } as ErrorCode;
    }
    internal.finished = true;
  }

  [Symbol.dispose](): void {}
}

// --- OutgoingRequest ---

export class OutgoingRequest {
  [INTERNAL]: OutgoingRequestInternal;

  constructor(headers: Fields) {
    fieldsLock(headers);
    this[INTERNAL] = {
      method: { tag: 'get' },
      scheme: undefined,
      pathWithQuery: undefined,
      authority: undefined,
      headers,
      body: outgoingBodyCreate(),
      bodyRequested: false,
    };
  }

  body(): OutgoingBody {
    const internal = this[INTERNAL];
    if (internal.bodyRequested) {
      throw new Error('Body already requested');
    }
    internal.bodyRequested = true;
    return internal.body;
  }

  method(): Method {
    return this[INTERNAL].method;
  }

  setMethod(method: Method): void {
    if (method.tag === 'other' && !method.val.match(/^[a-zA-Z-]+$/)) {
      throw { tag: 'HTTP-request-method-invalid' } as ErrorCode;
    }
    this[INTERNAL].method = method;
  }

  pathWithQuery(): string | undefined {
    return this[INTERNAL].pathWithQuery;
  }

  setPathWithQuery(pathWithQuery: string | undefined): void {
    if (pathWithQuery && !pathWithQuery.match(/^[a-zA-Z0-9.\-_~!$&'()*+,;=:@%?/]+$/)) {
      throw { tag: 'HTTP-request-URI-invalid' } as ErrorCode;
    }
    this[INTERNAL].pathWithQuery = pathWithQuery;
  }

  scheme(): Scheme | undefined {
    return this[INTERNAL].scheme;
  }

  setScheme(scheme: Scheme | undefined): void {
    if (scheme?.tag === 'other' && !scheme.val.match(/^[a-zA-Z]+$/)) {
      throw { tag: 'HTTP-request-URI-invalid' } as ErrorCode;
    }
    this[INTERNAL].scheme = scheme;
  }

  authority(): string | undefined {
    return this[INTERNAL].authority;
  }

  setAuthority(authority: string | undefined): void {
    if (authority) {
      const parts = authority.split(':');
      const host = parts[0];
      const port = parts[1];
      const extra = parts.slice(2);
      if (port !== undefined) {
        const portNum = Number(port);
        if (extra.length || portNum.toString() !== port || portNum > 65535) {
          throw { tag: 'HTTP-request-URI-invalid' } as ErrorCode;
        }
      }
      if (!host.match(/^[a-zA-Z0-9-.]+$/)) {
        throw { tag: 'HTTP-request-URI-invalid' } as ErrorCode;
      }
    }
    this[INTERNAL].authority = authority;
  }

  headers(): Fields {
    return this[INTERNAL].headers;
  }

  [Symbol.dispose](): void {}
}

// --- IncomingBody ---

export class IncomingBody {
  [INTERNAL]: IncomingBodyInternal;

  /** @internal - Use module-level factory functions instead. */
  constructor(token: symbol) {
    if (token !== INTERNAL) {
      throw new Error('IncomingBody cannot be constructed directly');
    }
    this[INTERNAL] = {
      stream: undefined,
      finished: false,
    };
  }

  stream(): InputStream {
    const internal = this[INTERNAL];
    if (!internal.stream) {
      throw new Error('stream already taken or not available');
    }
    const stream = internal.stream;
    internal.stream = null;
    return stream;
  }

  static finish(incomingBody: IncomingBody): FutureTrailers {
    const internal = incomingBody[INTERNAL];
    if (internal.finished) {
      throw new Error('incoming body already finished');
    }
    internal.finished = true;
    return futureTrailersCreate();
  }

  [Symbol.dispose](): void {}
}

// --- IncomingResponse ---

export class IncomingResponse {
  [INTERNAL]: IncomingResponseInternal;

  /** @internal - Use module-level factory functions instead. */
  constructor(token: symbol) {
    if (token !== INTERNAL) {
      throw new Error('IncomingResponse cannot be constructed directly');
    }
    this[INTERNAL] = {
      status: 0,
      headers: undefined,
      body: undefined,
    };
  }

  status(): StatusCode {
    return this[INTERNAL].status;
  }

  headers(): Fields {
    return this[INTERNAL].headers!;
  }

  consume(): IncomingBody {
    const internal = this[INTERNAL];
    if (internal.body === undefined) {
      throw new Error('body already consumed');
    }
    const body = internal.body;
    internal.body = undefined;
    return body;
  }

  [Symbol.dispose](): void {}
}

// --- FutureTrailers ---

export class FutureTrailers {
  [INTERNAL]: FutureTrailersInternal;

  /** @internal - Use module-level futureTrailersCreate() instead. */
  constructor(token: symbol) {
    if (token !== INTERNAL) {
      throw new Error('FutureTrailers cannot be constructed directly');
    }
    this[INTERNAL] = {
      requested: false,
    };
  }

  subscribe(): Pollable {
    return new Pollable(() => true);
  }

  get(): { tag: 'ok'; val: { tag: 'ok'; val: undefined } } | { tag: 'err' } {
    const internal = this[INTERNAL];
    if (internal.requested) {
      return { tag: 'err' };
    }
    internal.requested = true;
    return {
      tag: 'ok',
      val: {
        tag: 'ok',
        val: undefined,
      },
    };
  }
}

// --- FutureIncomingResponse ---

type FutureResult =
  | { tag: 'ok'; val: { tag: 'ok'; val: IncomingResponse } }
  | { tag: 'ok'; val: { tag: 'err'; val: ErrorCode } }
  | { tag: 'err' };

export class FutureIncomingResponse {
  [INTERNAL]: FutureIncomingResponseInternal;

  /** @internal - Use module-level factory functions instead. */
  constructor(token: symbol) {
    if (token !== INTERNAL) {
      throw new Error('FutureIncomingResponse cannot be constructed directly');
    }
    this[INTERNAL] = {
      result: undefined,
      resolved: false,
      promise: null,
      timer: undefined,
    };
  }

  subscribe(): Pollable {
    return new Pollable(() => this[INTERNAL].resolved);
  }

  get(): FutureResult | undefined {
    const internal = this[INTERNAL];
    if (!internal.resolved) {
      return undefined;
    }
    const result = internal.result;
    // After first successful get, subsequent calls return error per spec
    internal.result = { tag: 'err' };
    return result;
  }

  [Symbol.dispose](): void {
    const internal = this[INTERNAL];
    if (internal.timer) { clearTimeout(internal.timer); internal.timer = undefined; }
    internal.promise = null;
  }
}

// --- IncomingRequest (server-side) ---

interface IncomingRequestInternal {
  method: Method;
  pathWithQuery: string | undefined;
  scheme: Scheme | undefined;
  authority: string | undefined;
  headers: Fields;
  body: IncomingBody | undefined;
}

export class IncomingRequest {
  [INTERNAL]: IncomingRequestInternal;

  /** @internal - Use module-level incomingRequestCreate() instead. */
  constructor(token: symbol) {
    if (token !== INTERNAL) {
      throw new Error('IncomingRequest cannot be constructed directly');
    }
    this[INTERNAL] = {
      method: { tag: 'get' },
      pathWithQuery: undefined,
      scheme: undefined,
      authority: undefined,
      headers: new Fields(),
      body: undefined,
    };
  }

  method(): Method {
    return this[INTERNAL].method;
  }

  pathWithQuery(): string | undefined {
    return this[INTERNAL].pathWithQuery;
  }

  scheme(): Scheme | undefined {
    return this[INTERNAL].scheme;
  }

  authority(): string | undefined {
    return this[INTERNAL].authority;
  }

  headers(): Fields {
    return this[INTERNAL].headers;
  }

  consume(): IncomingBody {
    const internal = this[INTERNAL];
    if (internal.body === undefined) {
      throw new Error('body already consumed');
    }
    const body = internal.body;
    internal.body = undefined;
    return body;
  }

  [Symbol.dispose](): void {}
}

/**
 * Create an IncomingRequest from its constituent parts.
 * Used by the host (HTTP server) to construct requests for the guest handler.
 */
export function incomingRequestCreate(
  method: Method,
  pathWithQuery: string | undefined,
  headers: Fields,
  body?: Uint8Array,
  scheme?: Scheme,
  authority?: string,
): IncomingRequest {
  const req = new IncomingRequest(INTERNAL);
  const internal = req[INTERNAL];
  internal.method = method;
  internal.pathWithQuery = pathWithQuery;
  internal.scheme = scheme;
  internal.authority = authority;
  internal.headers = fieldsLock(headers);
  internal.body = incomingBodyCreateFromBuffer(body);
  return req;
}

// --- OutgoingResponse (server-side, minimal) ---

export class OutgoingResponse {
  #headers: Fields;
  #statusCode: StatusCode = 200;
  #body: OutgoingBody | undefined;
  #bodyRequested = false;

  constructor(headers: Fields) {
    fieldsLock(headers);
    this.#headers = headers;
    this.#body = outgoingBodyCreate();
  }

  statusCode(): StatusCode {
    return this.#statusCode;
  }

  setStatusCode(statusCode: StatusCode): void {
    if (statusCode < 100 || statusCode > 999) {
      throw new Error('invalid status code');
    }
    this.#statusCode = statusCode;
  }

  headers(): Fields {
    return this.#headers;
  }

  body(): OutgoingBody {
    if (this.#bodyRequested) {
      throw new Error('Body already requested');
    }
    this.#bodyRequested = true;
    return this.#body!;
  }
}

// --- ResponseOutparam (server-side) ---

type ResponseOutparamResult =
  | { tag: 'ok'; val: OutgoingResponse }
  | { tag: 'err'; val: ErrorCode };

interface ResponseOutparamInternal {
  result: ResponseOutparamResult | undefined;
}

export class ResponseOutparam {
  [INTERNAL]: ResponseOutparamInternal;

  /** @internal - Use module-level responseOutparamCreate() instead. */
  constructor(token: symbol) {
    if (token !== INTERNAL) {
      throw new Error('ResponseOutparam cannot be constructed directly');
    }
    this[INTERNAL] = {
      result: undefined,
    };
  }

  /**
   * Set the response on this outparam. Called by the guest to provide the response.
   */
  static set(param: ResponseOutparam, response: { tag: 'ok'; val: OutgoingResponse } | { tag: 'err'; val: ErrorCode }): void {
    (param as unknown as Record<symbol, ResponseOutparamInternal>)[INTERNAL].result = response;
  }
}

/**
 * Create a ResponseOutparam that the host passes to the guest handler.
 */
export function responseOutparamCreate(): ResponseOutparam {
  return new ResponseOutparam(INTERNAL);
}

/**
 * Retrieve the result set on a ResponseOutparam by the guest handler.
 */
export function responseOutparamGet(param: ResponseOutparam): ResponseOutparamResult | undefined {
  return (param as unknown as Record<symbol, ResponseOutparamInternal>)[INTERNAL].result;
}

// --- Helper functions ---

function schemeString(scheme: Scheme | undefined): string {
  if (!scheme) {
    return 'https:';
  }
  switch (scheme.tag) {
    case 'HTTP':
      return 'http:';
    case 'HTTPS':
      return 'https:';
    case 'other':
      return scheme.val.toLowerCase() + ':';
  }
}

function mapFetchError(err: Error): ErrorCode {
  if (err.name === 'AbortError') {
    return { tag: 'connection-timeout' };
  }
  if (err.name === 'TypeError') {
    return { tag: 'connection-refused' };
  }
  return { tag: 'internal-error', val: err.message };
}

export function httpErrorCode(err: unknown): ErrorCode | undefined {
  if (err && typeof err === 'object' && 'payload' in err) {
    return (err as { payload: ErrorCode }).payload;
  }
  if (err && typeof err === 'object' && 'tag' in err) {
    return err as ErrorCode;
  }
  if (err instanceof Error) {
    return { tag: 'internal-error', val: err.message };
  }
  return undefined;
}

// --- Exported handler function for outgoing-handler ---

/** Execute an outgoing request - called by outgoing-handler. Accepts optional client for instance isolation. */
export function outgoingRequestHandle(request: OutgoingRequest, options?: RequestOptions, client?: HttpClient): FutureIncomingResponse {
  const internal = request[INTERNAL];
  const scheme = schemeString(internal.scheme);
  const method = (internal.method as { val?: string }).val || internal.method.tag;

  if (!internal.pathWithQuery) {
    throw { tag: 'HTTP-request-URI-invalid' } as ErrorCode;
  }

  const url = `${scheme}//${internal.authority || ''}${internal.pathWithQuery}`;

  const headers: [string, string][] = [];
  for (const [key, value] of internal.headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (!forbiddenHeaders.has(lowerKey)) {
      headers.push([key, utf8Decoder.decode(value)]);
    }
  }

  const bodyData = outgoingBodyData(internal.body);

  let timeoutMs = Number(DEFAULT_HTTP_TIMEOUT_NS / 1_000_000n);
  if (options) {
    const ct = options.connectTimeout() ?? DEFAULT_HTTP_TIMEOUT_NS;
    const fbt = options.firstByteTimeout() ?? DEFAULT_HTTP_TIMEOUT_NS;
    const minTimeout = ct < fbt ? ct : fbt;
    timeoutMs = Number(minTimeout / 1_000_000n);
  }

  return futureIncomingResponseCreate(url, method.toUpperCase(), headers, bodyData, timeoutMs, client);
}

/** Create already-resolved future from a result value - for outgoing-handler. */
export { futureIncomingResponseCreateResolved, incomingResponseCreateFromBuffered, outgoingBodyData };
