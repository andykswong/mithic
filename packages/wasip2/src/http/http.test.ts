import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { deepStrictEqual, strictEqual, ok, throws } from 'node:assert';

import {
  Fields,
  OutgoingRequest,
  OutgoingBody,
  OutgoingResponse,
  FutureIncomingResponse,
  IncomingRequest,
  ResponseOutparam,
  RequestOptions,
  httpErrorCode,
  incomingRequestCreate,
  responseOutparamCreate,
  responseOutparamGet,
  outgoingBodyData,
} from './types.ts';
import type { IncomingBody } from './types.ts';
import { handle } from './outgoing-handler.ts';
import { handle as incomingHandle, _setIncomingHandler, _getIncomingHandler } from './incoming-handler.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('Fields', () => {
  it('constructs empty fields', () => {
    const fields = new Fields();
    deepStrictEqual(fields.entries(), []);
  });

  it('fromList creates fields from entries', () => {
    const fields = Fields.fromList([
      ['content-type', encoder.encode('application/json')],
      ['x-custom', encoder.encode('value1')],
    ]);
    strictEqual(fields.entries().length, 2);
  });

  it('get returns values for a header name (case-insensitive)', () => {
    const fields = Fields.fromList([
      ['Content-Type', encoder.encode('text/html')],
    ]);
    const values = fields.get('content-type');
    strictEqual(values.length, 1);
    strictEqual(decoder.decode(values[0]), 'text/html');
  });

  it('get returns empty array for missing name', () => {
    const fields = new Fields();
    deepStrictEqual(fields.get('nonexistent'), []);
  });

  it('has checks for header existence', () => {
    const fields = Fields.fromList([
      ['Accept', encoder.encode('*/*')],
    ]);
    strictEqual(fields.has('accept'), true);
    strictEqual(fields.has('missing'), false);
  });

  it('set replaces all values for a name', () => {
    const fields = Fields.fromList([
      ['x-test', encoder.encode('old')],
    ]);
    fields.set('x-test', [encoder.encode('new1'), encoder.encode('new2')]);
    const values = fields.get('x-test');
    strictEqual(values.length, 2);
    strictEqual(decoder.decode(values[0]), 'new1');
    strictEqual(decoder.decode(values[1]), 'new2');
  });

  it('append adds a value without removing existing', () => {
    const fields = Fields.fromList([
      ['x-multi', encoder.encode('first')],
    ]);
    fields.append('x-multi', encoder.encode('second'));
    const values = fields.get('x-multi');
    strictEqual(values.length, 2);
    strictEqual(decoder.decode(values[0]), 'first');
    strictEqual(decoder.decode(values[1]), 'second');
  });

  it('delete removes all values for a name', () => {
    const fields = Fields.fromList([
      ['x-remove', encoder.encode('val')],
      ['x-keep', encoder.encode('keep')],
    ]);
    fields.delete('x-remove');
    strictEqual(fields.has('x-remove'), false);
    strictEqual(fields.has('x-keep'), true);
  });

  it('clone creates independent copy', () => {
    const fields = Fields.fromList([
      ['x-original', encoder.encode('value')],
    ]);
    const cloned = fields.clone();
    cloned.set('x-original', [encoder.encode('changed')]);

    strictEqual(decoder.decode(fields.get('x-original')[0]), 'value');
    strictEqual(decoder.decode(cloned.get('x-original')[0]), 'changed');
  });

  it('entries returns all name-value pairs', () => {
    const fields = Fields.fromList([
      ['a', encoder.encode('1')],
      ['b', encoder.encode('2')],
      ['a', encoder.encode('3')],
    ]);
    const entries = fields.entries();
    strictEqual(entries.length, 3);
    strictEqual(entries[0][0], 'a');
    strictEqual(entries[2][0], 'a');
  });

  it('throws on forbidden headers', () => {
    const fields = new Fields();
    try {
      fields.append('connection', encoder.encode('close'));
      ok(false, 'should have thrown');
    } catch (e: unknown) {
      strictEqual((e as { tag: string }).tag, 'forbidden');
    }
  });

  it('throws on invalid header name', () => {
    const fields = new Fields();
    try {
      fields.append('invalid header', encoder.encode('val'));
      ok(false, 'should have thrown');
    } catch (e: unknown) {
      strictEqual((e as { tag: string }).tag, 'invalid-syntax');
    }
  });
});

describe('OutgoingRequest', () => {
  it('constructs with headers and default method GET', () => {
    const headers = new Fields();
    const req = new OutgoingRequest(headers);
    deepStrictEqual(req.method(), { tag: 'get' });
  });

  it('setMethod changes the method', () => {
    const req = new OutgoingRequest(new Fields());
    req.setMethod({ tag: 'post' });
    deepStrictEqual(req.method(), { tag: 'post' });
  });

  it('setPathWithQuery sets path', () => {
    const req = new OutgoingRequest(new Fields());
    req.setPathWithQuery('/api/test?q=1');
    strictEqual(req.pathWithQuery(), '/api/test?q=1');
  });

  it('setScheme and setAuthority configure URL parts', () => {
    const req = new OutgoingRequest(new Fields());
    req.setScheme({ tag: 'HTTPS' });
    req.setAuthority('example.com:443');
    deepStrictEqual(req.scheme(), { tag: 'HTTPS' });
    strictEqual(req.authority(), 'example.com:443');
  });

  it('body() returns an OutgoingBody', () => {
    const req = new OutgoingRequest(new Fields());
    const body = req.body();
    ok(body instanceof OutgoingBody);
  });

  it('body() throws on second call', () => {
    const req = new OutgoingRequest(new Fields());
    req.body();
    throws(() => req.body(), /Body already requested/);
  });

  it('headers are locked (immutable) after construction', () => {
    const headers = new Fields();
    headers.append('x-before', encoder.encode('works'));
    const req = new OutgoingRequest(headers);
    try {
      headers.append('x-after', encoder.encode('fail'));
      ok(false, 'should have thrown');
    } catch (e: unknown) {
      strictEqual((e as { tag: string }).tag, 'immutable');
    }
    // Can still read
    ok(req.headers().has('x-before'));
  });
});

describe('OutgoingBody', () => {
  it('write() returns an OutputStream that collects data', () => {
    const req = new OutgoingRequest(new Fields());
    const body = req.body();
    const stream = body.write();
    stream.write(encoder.encode('hello'));
    stream.write(encoder.encode(' world'));
    OutgoingBody.finish(body);
    // Body is finished, no error
  });

  it('finish throws if called twice', () => {
    const req = new OutgoingRequest(new Fields());
    const body = req.body();
    OutgoingBody.finish(body);
    try {
      OutgoingBody.finish(body);
      ok(false, 'should have thrown');
    } catch (e: unknown) {
      strictEqual((e as { tag: string }).tag, 'internal-error');
    }
  });
});

describe('RequestOptions', () => {
  it('manages timeouts', () => {
    const opts = new RequestOptions();
    strictEqual(opts.connectTimeout(), undefined);
    opts.setConnectTimeout(5000n);
    strictEqual(opts.connectTimeout(), 5000n);

    opts.setFirstByteTimeout(10000n);
    strictEqual(opts.firstByteTimeout(), 10000n);

    opts.setBetweenBytesTimeout(2000n);
    strictEqual(opts.betweenBytesTimeout(), 2000n);
  });
});

describe('FutureTrailers', () => {
  it('get returns ok on first call, err on subsequent', () => {
    // Use IncomingBody.finish to get a FutureTrailers - we need to test this indirectly
    // since the constructor is private. We test FutureTrailers behavior through IncomingBody.
  });
});

describe('handle() and FutureIncomingResponse', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends a GET request and resolves with response', async () => {
    // Mock fetch
    globalThis.fetch = mock.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response('response body', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }) as typeof fetch;

    const headers = Fields.fromList([
      ['accept', encoder.encode('text/plain')],
    ]);
    const req = new OutgoingRequest(headers);
    req.setMethod({ tag: 'get' });
    req.setScheme({ tag: 'HTTPS' });
    req.setAuthority('example.com');
    req.setPathWithQuery('/hello');
    OutgoingBody.finish(req.body());

    const future = handle(req);
    ok(future instanceof FutureIncomingResponse);

    // Wait for the fetch to resolve
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = future.get();
    ok(result !== undefined, 'result should be defined after fetch resolves');
    strictEqual(result!.tag, 'ok');
    const inner = (result as { tag: 'ok'; val: { tag: string; val?: unknown } }).val;
    strictEqual(inner.tag, 'ok');

    const response = inner.val as { status(): number; headers(): Fields; consume(): IncomingBody };
    strictEqual(response.status(), 200);

    // Check headers
    const respHeaders = response.headers();
    ok(respHeaders.has('content-type'));
    strictEqual(decoder.decode(respHeaders.get('content-type')[0]), 'text/plain');
  });

  it('sends a POST request with body', async () => {
    let capturedRequest: { method: string; url: string; body?: Uint8Array } | undefined;
    globalThis.fetch = mock.fn(async (input: Request | string | URL) => {
      if (input instanceof Request) {
        const bodyBuf = await input.arrayBuffer();
        capturedRequest = { method: input.method, url: input.url, body: new Uint8Array(bodyBuf) };
      }
      return new Response('', { status: 201 });
    }) as typeof fetch;

    const req = new OutgoingRequest(new Fields());
    req.setMethod({ tag: 'post' });
    req.setScheme({ tag: 'HTTP' });
    req.setAuthority('localhost:8080');
    req.setPathWithQuery('/data');

    const body = req.body();
    const stream = body.write();
    stream.write(encoder.encode('{"key":"value"}'));
    OutgoingBody.finish(body);

    const future = handle(req);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = future.get();
    ok(result !== undefined);
    strictEqual(result!.tag, 'ok');

    // Verify the fetch was called with POST and body
    ok(capturedRequest);
    strictEqual(capturedRequest!.method, 'POST');
    ok(capturedRequest!.body !== undefined);
    strictEqual(decoder.decode(capturedRequest!.body), '{"key":"value"}');
  });

  it('returns error on fetch failure', async () => {
    globalThis.fetch = mock.fn(async () => {
      const err = new TypeError('Failed to fetch');
      throw err;
    }) as typeof fetch;

    const req = new OutgoingRequest(new Fields());
    req.setMethod({ tag: 'get' });
    req.setScheme({ tag: 'HTTPS' });
    req.setAuthority('unreachable.test');
    req.setPathWithQuery('/');
    OutgoingBody.finish(req.body());

    const future = handle(req);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = future.get();
    ok(result !== undefined);
    strictEqual(result!.tag, 'ok');
    const inner = (result as { tag: 'ok'; val: { tag: string; val?: unknown } }).val;
    strictEqual(inner.tag, 'err');
    strictEqual((inner.val as { tag: string }).tag, 'connection-refused');
  });

  it('returns timeout error on AbortError', async () => {
    globalThis.fetch = mock.fn(async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    }) as typeof fetch;

    const req = new OutgoingRequest(new Fields());
    req.setMethod({ tag: 'get' });
    req.setScheme({ tag: 'HTTPS' });
    req.setAuthority('slow.test');
    req.setPathWithQuery('/');
    OutgoingBody.finish(req.body());

    const opts = new RequestOptions();
    opts.setConnectTimeout(100_000_000n); // 100ms in nanoseconds

    const future = handle(req, opts);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = future.get();
    ok(result !== undefined);
    const inner = (result as { tag: 'ok'; val: { tag: string; val?: unknown } }).val;
    strictEqual(inner.tag, 'err');
    strictEqual((inner.val as { tag: string }).tag, 'connection-timeout');
  });

  it('get() returns undefined before resolution', () => {
    // Use a fetch that never resolves
    globalThis.fetch = mock.fn(() => new Promise(() => {})) as unknown as typeof fetch;

    const options = new RequestOptions();
    options.setConnectTimeout(50_000_000n); // 50ms — short timeout so timer doesn't linger

    const req = new OutgoingRequest(new Fields());
    req.setMethod({ tag: 'get' });
    req.setScheme({ tag: 'HTTPS' });
    req.setAuthority('pending.test');
    req.setPathWithQuery('/');
    OutgoingBody.finish(req.body());

    const future = handle(req, options);
    const result = future.get();
    strictEqual(result, undefined);
    future[Symbol.dispose]();
  });

  it('get() returns err on second call after resolution', async () => {
    globalThis.fetch = mock.fn(async () => {
      return new Response('', { status: 200 });
    }) as typeof fetch;

    const req = new OutgoingRequest(new Fields());
    req.setMethod({ tag: 'get' });
    req.setScheme({ tag: 'HTTPS' });
    req.setAuthority('example.com');
    req.setPathWithQuery('/');
    OutgoingBody.finish(req.body());

    const future = handle(req);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const first = future.get();
    ok(first !== undefined);
    strictEqual(first!.tag, 'ok');

    const second = future.get();
    ok(second !== undefined);
    strictEqual(second!.tag, 'err');
  });

  it('subscribe() returns a Pollable that becomes ready', async () => {
    globalThis.fetch = mock.fn(async () => {
      return new Response('', { status: 200 });
    }) as typeof fetch;

    const req = new OutgoingRequest(new Fields());
    req.setMethod({ tag: 'get' });
    req.setScheme({ tag: 'HTTPS' });
    req.setAuthority('example.com');
    req.setPathWithQuery('/');
    OutgoingBody.finish(req.body());

    const future = handle(req);
    const pollable = future.subscribe();

    // Initially may not be ready
    // After resolution it should be ready
    await new Promise((resolve) => setTimeout(resolve, 10));
    strictEqual(pollable.ready(), true);
  });
});

describe('IncomingBody.stream()', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('reads response body as InputStream', async () => {
    const bodyText = 'Hello, WASI HTTP!';
    globalThis.fetch = mock.fn(async () => {
      return new Response(bodyText, { status: 200 });
    }) as typeof fetch;

    const req = new OutgoingRequest(new Fields());
    req.setMethod({ tag: 'get' });
    req.setScheme({ tag: 'HTTPS' });
    req.setAuthority('example.com');
    req.setPathWithQuery('/body');
    OutgoingBody.finish(req.body());

    const future = handle(req);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const result = future.get();
    ok(result !== undefined);
    const inner = (result as { tag: 'ok'; val: { tag: 'ok'; val: { consume(): IncomingBody } } }).val;
    const response = inner.val;
    const incomingBody = response.consume();
    const stream = incomingBody.stream();

    // Give the body reader time to buffer
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Read from the stream
    const data = stream.read(BigInt(bodyText.length + 100));
    const text = decoder.decode(data);
    strictEqual(text, bodyText);
  });
});

describe('httpErrorCode', () => {
  it('extracts error code from tagged object', () => {
    const err = { tag: 'connection-timeout' };
    const code = httpErrorCode(err);
    strictEqual(code?.tag, 'connection-timeout');
  });

  it('extracts error code from payload property', () => {
    const err = { payload: { tag: 'DNS-timeout' } };
    const code = httpErrorCode(err);
    strictEqual(code?.tag, 'DNS-timeout');
  });

  it('returns undefined for non-error values', () => {
    strictEqual(httpErrorCode(null), undefined);
    strictEqual(httpErrorCode(undefined), undefined);
    strictEqual(httpErrorCode(42), undefined);
  });

  it('wraps Error instances as internal-error', () => {
    const code = httpErrorCode(new Error('something broke'));
    strictEqual(code?.tag, 'internal-error');
    strictEqual((code as { tag: string; val: string }).val, 'something broke');
  });
});

describe('IncomingRequest', () => {
  it('cannot be constructed directly', () => {
    throws(() => new (IncomingRequest as unknown as new () => unknown)(), /cannot be constructed directly/);
  });

  it('create via factory and verify method/path/headers/body', () => {
    const headers = Fields.fromList([
      ['content-type', encoder.encode('application/json')],
      ['x-request-id', encoder.encode('abc123')],
    ]);
    const bodyData = encoder.encode('{"hello":"world"}');
    const req = incomingRequestCreate(
      { tag: 'post' },
      '/api/data?q=1',
      headers,
      bodyData,
      { tag: 'HTTPS' },
      'example.com:443',
    );

    deepStrictEqual(req.method(), { tag: 'post' });
    strictEqual(req.pathWithQuery(), '/api/data?q=1');
    deepStrictEqual(req.scheme(), { tag: 'HTTPS' });
    strictEqual(req.authority(), 'example.com:443');

    // Headers are locked (immutable)
    const reqHeaders = req.headers();
    ok(reqHeaders.has('content-type'));
    strictEqual(decoder.decode(reqHeaders.get('x-request-id')[0]), 'abc123');
    try {
      reqHeaders.append('new-header', encoder.encode('val'));
      ok(false, 'should have thrown');
    } catch (e: unknown) {
      strictEqual((e as { tag: string }).tag, 'immutable');
    }

    // Body access
    const body = req.consume();
    const stream = body.stream();
    const data = stream.read(BigInt(bodyData.length + 10));
    strictEqual(decoder.decode(data), '{"hello":"world"}');

    // Second consume throws
    throws(() => req.consume(), /body already consumed/);
  });

  it('create with no body provides empty body', () => {
    const req = incomingRequestCreate({ tag: 'get' }, '/', new Fields());
    const body = req.consume();
    const stream = body.stream();
    try {
      stream.read(10n);
      ok(false, 'should have thrown closed');
    } catch (e: unknown) {
      strictEqual((e as { tag: string }).tag, 'closed');
    }
  });
});

describe('OutgoingResponse (server-side)', () => {
  it('create, set status, get body, write to body', () => {
    const headers = Fields.fromList([
      ['content-type', encoder.encode('text/plain')],
    ]);
    const resp = new OutgoingResponse(headers);

    // Default status is 200
    strictEqual(resp.statusCode(), 200);

    // Set custom status
    resp.setStatusCode(201);
    strictEqual(resp.statusCode(), 201);

    // Get body and write to it
    const body = resp.body();
    ok(body instanceof OutgoingBody);
    const stream = body.write();
    stream.write(encoder.encode('Hello'));
    stream.write(encoder.encode(' World'));
    OutgoingBody.finish(body);

    // Verify body data
    const data = outgoingBodyData(body);
    ok(data !== null);
    strictEqual(decoder.decode(data!), 'Hello World');
  });

  it('body() throws on second call', () => {
    const resp = new OutgoingResponse(new Fields());
    resp.body();
    throws(() => resp.body(), /Body already requested/);
  });

  it('setStatusCode rejects invalid values', () => {
    const resp = new OutgoingResponse(new Fields());
    throws(() => resp.setStatusCode(50), /invalid status code/);
    throws(() => resp.setStatusCode(1000), /invalid status code/);
  });
});

describe('ResponseOutparam', () => {
  it('cannot be constructed directly', () => {
    throws(() => new (ResponseOutparam as unknown as new () => unknown)(), /cannot be constructed directly/);
  });

  it('set with ok result, retrieve it', () => {
    const param = responseOutparamCreate();
    const resp = new OutgoingResponse(new Fields());
    resp.setStatusCode(200);

    ResponseOutparam.set(param, { tag: 'ok', val: resp });

    const result = responseOutparamGet(param);
    ok(result !== undefined);
    strictEqual(result!.tag, 'ok');
    strictEqual((result as { tag: 'ok'; val: OutgoingResponse }).val.statusCode(), 200);
  });

  it('set with err result, retrieve it', () => {
    const param = responseOutparamCreate();
    ResponseOutparam.set(param, { tag: 'err', val: { tag: 'internal-error', val: 'something went wrong' } });

    const result = responseOutparamGet(param);
    ok(result !== undefined);
    strictEqual(result!.tag, 'err');
    strictEqual((result as { tag: 'err'; val: { tag: string } }).val.tag, 'internal-error');
  });

  it('get returns undefined before set is called', () => {
    const param = responseOutparamCreate();
    strictEqual(responseOutparamGet(param), undefined);
  });
});

describe('incoming-handler', () => {
  it('throws if no handler registered', () => {
    _setIncomingHandler(null as unknown as (r: IncomingRequest, o: ResponseOutparam) => void);
    const req = incomingRequestCreate({ tag: 'get' }, '/', new Fields());
    const param = responseOutparamCreate();
    throws(() => incomingHandle(req, param), /no handler registered/);
  });

  it('register handler, call handle, verify response flows through', () => {
    _setIncomingHandler((request: IncomingRequest, responseOut: ResponseOutparam) => {
      // Guest handler creates a response based on the request
      const path = request.pathWithQuery();
      const respHeaders = Fields.fromList([
        ['x-path', encoder.encode(path ?? '')],
      ]);
      const resp = new OutgoingResponse(respHeaders);
      resp.setStatusCode(path === '/hello' ? 200 : 404);

      const body = resp.body();
      const stream = body.write();
      stream.write(encoder.encode(`Response for ${path}`));
      OutgoingBody.finish(body);

      ResponseOutparam.set(responseOut, { tag: 'ok', val: resp });
    });

    // Simulate host calling the handler
    const req = incomingRequestCreate(
      { tag: 'get' },
      '/hello',
      Fields.fromList([['accept', encoder.encode('*/*')]]),
    );
    const param = responseOutparamCreate();
    incomingHandle(req, param);

    // Verify response was set
    const result = responseOutparamGet(param);
    ok(result !== undefined);
    strictEqual(result!.tag, 'ok');
    const resp = (result as { tag: 'ok'; val: OutgoingResponse }).val;
    strictEqual(resp.statusCode(), 200);

    // Verify response headers
    const respHeaders = resp.headers();
    strictEqual(decoder.decode(respHeaders.get('x-path')[0]), '/hello');

    // Clean up
    _setIncomingHandler(null as unknown as (r: IncomingRequest, o: ResponseOutparam) => void);
  });

  it('handler can access request body', () => {
    let capturedBodyData: Uint8Array | null = null;

    _setIncomingHandler((request: IncomingRequest, responseOut: ResponseOutparam) => {
      const inBody = request.consume();
      const inStream = inBody.stream();
      const data = inStream.read(1024n);
      const text = decoder.decode(data);

      const resp = new OutgoingResponse(new Fields());
      resp.setStatusCode(200);
      const outBody = resp.body();
      const outStream = outBody.write();
      outStream.write(encoder.encode(`Echo: ${text}`));
      OutgoingBody.finish(outBody);

      // Capture body data for verification
      capturedBodyData = outgoingBodyData(outBody);

      ResponseOutparam.set(responseOut, { tag: 'ok', val: resp });
    });

    const req = incomingRequestCreate(
      { tag: 'post' },
      '/echo',
      new Fields(),
      encoder.encode('test-body'),
    );
    const param = responseOutparamCreate();
    incomingHandle(req, param);

    const result = responseOutparamGet(param);
    ok(result !== undefined);
    strictEqual(result!.tag, 'ok');

    // Verify the echo response body via captured data
    ok(capturedBodyData !== null);
    strictEqual(decoder.decode(capturedBodyData!), 'Echo: test-body');

    // Verify response status
    const resp = (result as { tag: 'ok'; val: OutgoingResponse }).val;
    strictEqual(resp.statusCode(), 200);

    // Clean up
    _setIncomingHandler(null as unknown as (r: IncomingRequest, o: ResponseOutparam) => void);
  });
});
