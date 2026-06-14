import { describe, it, before } from 'node:test';
import assert from 'node:assert';

import { installPolyfill, createInstantiateCore } from '@mithic/wasm-transpile';
import type { ComponentExit } from '@mithic/wasip2/cli/exit';
import type { InputStreamHandler, OutputStreamHandler } from '@mithic/io/io';
import type { HttpClient, HttpRequest, HttpResponse } from '@mithic/io/net';
import { WASIShim } from '@mithic/wasip2/instantiation';
import { Descriptor } from '@mithic/wasip2/filesystem/types';
import { FsDescriptorHandler } from '@mithic/wasip2/filesystem/fs-handler';
import { MemoryFsProvider, FileSystemRouter } from '@mithic/io/vfs';

const polyfill = installPolyfill();
const variant = polyfill.installed ? 'asyncify' : 'jspi';

const curlEntry = await (variant === 'asyncify'
  ? import('@mithic/curl/component/asyncify')
  : import('@mithic/curl/component/jspi'));

const instantiateCore = createInstantiateCore({ asyncify: polyfill.installed });

type ComponentEntry = { instantiate: (...args: unknown[]) => Promise<{ run: { run: () => Promise<number> } }>; modules: Record<string, string> };

function compileModules(modules: Record<string, string>) {
  return async (path: string) => {
    const uri = modules[path];
    const response = await fetch(uri);
    return WebAssembly.compile(await response.arrayBuffer());
  };
}

function createInputHandler(data: Uint8Array): InputStreamHandler {
  let offset = 0;
  return {
    read(len: number) {
      if (offset >= data.length) return undefined;
      const chunk = data.subarray(offset, offset + len);
      offset += chunk.length;
      return chunk.length > 0 ? chunk : undefined;
    },
    blockingRead(len: number) {
      if (offset >= data.length) return new Uint8Array(0);
      const chunk = data.subarray(offset, offset + len);
      offset += chunk.length;
      return chunk;
    },
  };
}

function createOutputHandler(chunks: Uint8Array[]): OutputStreamHandler {
  return {
    checkWrite() { return 65536; },
    write(data: Uint8Array) { chunks.push(new Uint8Array(data)); },
    flush() {},
  };
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLen = arrays.reduce((acc, a) => acc + a.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const arr of arrays) { result.set(arr, offset); offset += arr.length; }
  return result;
}

class MockHttpClient implements HttpClient {
  private handler: (req: HttpRequest) => HttpResponse;
  constructor(handler: (req: HttpRequest) => HttpResponse) {
    this.handler = handler;
  }
  send(request: HttpRequest): HttpResponse {
    return this.handler(request);
  }
}

async function runCurl(args: string[], httpHandler: (req: HttpRequest) => HttpResponse): Promise<{ stdout: string; stderr: string; exit: number }> {
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];

  const memFs = new MemoryFsProvider();
  memFs.mkdir('/tmp');
  const vfs = new FileSystemRouter();
  await vfs.mount('/', memFs);

  const httpClient = new MockHttpClient(httpHandler);

  const shim = new WASIShim({
    async: true,
    sandbox: {
      preopens: { '/': new Descriptor(new FsDescriptorHandler(vfs, '/')) },
      env: {},
      args: ['curl', ...args],
      cwd: '/tmp',
      stdin: createInputHandler(new Uint8Array(0)),
      stdout: createOutputHandler(stdoutChunks),
      stderr: createOutputHandler(stderrChunks),
      httpClient,
    },
  });

  let exit = 0;
  try {
    const entry = curlEntry as unknown as ComponentEntry;
    const instance = await entry.instantiate(
      compileModules(entry.modules),
      shim.getImportObject(),
      instantiateCore,
    );
    exit = (await instance.run.run()) ?? 0;
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'exitError' in e) {
      exit = (e as ComponentExit).code ?? 1;
    } else {
      throw e;
    }
  } finally {
    shim[Symbol.dispose]();
  }

  // Allow microtasks from async WASM exit to settle
  await new Promise(resolve => setTimeout(resolve, 0));

  const stdout = new TextDecoder().decode(concatUint8Arrays(stdoutChunks));
  const stderr = new TextDecoder().decode(concatUint8Arrays(stderrChunks));
  return { stdout, stderr, exit };
}

before(() => {
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', () => {});
});

describe('curl - Basic GET', () => {
  it('makes a GET request and outputs body to stdout', async () => {
    const { stdout, exit } = await runCurl(['http://example.com/hello'], (req) => {
      assert.strictEqual(req.method, 'GET');
      assert.strictEqual(req.url, 'http://example.com/hello');
      return { status: 200, headers: [], body: new TextEncoder().encode('Hello World') };
    });
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout, 'Hello World');
  });
});

describe('curl - HTTP methods', () => {
  it('-X POST changes method', async () => {
    const { exit } = await runCurl(['-X', 'POST', 'http://example.com/api'], (req) => {
      assert.strictEqual(req.method, 'POST');
      return { status: 200, headers: [], body: new Uint8Array(0) };
    });
    assert.strictEqual(exit, 0);
  });

  it('-d implies POST', async () => {
    const { exit } = await runCurl(['-d', 'key=value', 'http://example.com/api'], (req) => {
      assert.strictEqual(req.method, 'POST');
      const body = new TextDecoder().decode(req.body);
      assert.strictEqual(body, 'key=value');
      return { status: 200, headers: [], body: new Uint8Array(0) };
    });
    assert.strictEqual(exit, 0);
  });
});

describe('curl - Headers', () => {
  it('-H adds headers', async () => {
    const { exit } = await runCurl(
      ['-H', 'Content-Type: application/json', '-H', 'Authorization: Bearer token', 'http://example.com/api'],
      (req) => {
        const contentType = req.headers.find(([k]) => k === 'content-type');
        const auth = req.headers.find(([k]) => k === 'authorization');
        assert.ok(contentType, 'content-type header should be set');
        assert.strictEqual(contentType![1], 'application/json');
        assert.ok(auth, 'authorization header should be set');
        assert.strictEqual(auth![1], 'Bearer token');
        return { status: 200, headers: [], body: new Uint8Array(0) };
      },
    );
    assert.strictEqual(exit, 0);
  });
});

describe('curl - Include headers', () => {
  it('-i prepends response headers to output', async () => {
    const { stdout, exit } = await runCurl(['-i', 'http://example.com/'], (req) => {
      return {
        status: 200,
        headers: [['content-type', 'text/html'], ['x-custom', 'test']],
        body: new TextEncoder().encode('body'),
      };
    });
    assert.strictEqual(exit, 0);
    assert.ok(stdout.includes('HTTP/1.1 200'));
    assert.ok(stdout.includes('content-type: text/html'));
    assert.ok(stdout.includes('body'));
  });
});

describe('curl - Silent mode', () => {
  it('-s suppresses error output', async () => {
    const { stderr, exit } = await runCurl(['-sf', 'http://example.com/error'], (req) => {
      return { status: 500, headers: [], body: new Uint8Array(0) };
    });
    assert.ok(exit !== 0, 'expected non-zero exit');
    assert.strictEqual(stderr, '');
  });
});

describe('curl - Fail on error', () => {
  it('-f exits non-zero on 4xx', async () => {
    const { exit } = await runCurl(['-f', 'http://example.com/notfound'], (req) => {
      return { status: 404, headers: [], body: new TextEncoder().encode('Not Found') };
    });
    assert.ok(exit !== 0, `expected non-zero exit code, got ${exit}`);
  });

  it('-f exits non-zero on 5xx', async () => {
    const { exit } = await runCurl(['-f', 'http://example.com/error'], (req) => {
      return { status: 500, headers: [], body: new TextEncoder().encode('Server Error') };
    });
    assert.ok(exit !== 0, `expected non-zero exit code, got ${exit}`);
  });

  it('no -f does not fail on 4xx', async () => {
    const { stdout, exit } = await runCurl(['http://example.com/notfound'], (req) => {
      return { status: 404, headers: [], body: new TextEncoder().encode('Not Found') };
    });
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout, 'Not Found');
  });
});

describe('curl - Output to file', () => {
  it('-o writes body to file', async () => {
    const { stdout, exit } = await runCurl(['-o', '/tmp/out', 'http://example.com/file'], (req) => {
      return { status: 200, headers: [], body: new TextEncoder().encode('file content') };
    });
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout, '');
  });
});

describe('curl - Verbose', () => {
  it('-v shows request and response headers on stderr', async () => {
    const { stderr, exit } = await runCurl(['-v', 'http://example.com/api'], (req) => {
      return { status: 200, headers: [['x-resp', 'val']], body: new TextEncoder().encode('ok') };
    });
    assert.strictEqual(exit, 0);
    assert.ok(stderr.includes('> GET'));
    assert.ok(stderr.includes('< HTTP/1.1 200'));
  });
});

describe('curl - Write-out', () => {
  it('-w outputs formatted string after body', async () => {
    const { stdout, exit } = await runCurl(['-w', '%{http_code}', 'http://example.com/'], (req) => {
      return { status: 201, headers: [], body: new TextEncoder().encode('created') };
    });
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout, 'created201');
  });
});

describe('curl - Connect timeout', () => {
  it('--connect-timeout sets timeout', async () => {
    const { exit } = await runCurl(['--connect-timeout', '5', 'http://example.com/'], (req) => {
      assert.ok(req.timeoutMs !== undefined);
      assert.strictEqual(req.timeoutMs, 5000);
      return { status: 200, headers: [], body: new Uint8Array(0) };
    });
    assert.strictEqual(exit, 0);
  });
});

describe('curl - Follow redirects', () => {
  it('-L follows Location header', async () => {
    let callCount = 0;
    const { stdout, exit } = await runCurl(['-L', 'http://example.com/redirect'], (req) => {
      callCount++;
      if (callCount === 1) {
        assert.strictEqual(req.url, 'http://example.com/redirect');
        return { status: 302, headers: [['location', 'http://example.com/final']], body: new Uint8Array(0) };
      }
      assert.strictEqual(req.url, 'http://example.com/final');
      return { status: 200, headers: [], body: new TextEncoder().encode('final') };
    });
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout, 'final');
    assert.strictEqual(callCount, 2);
  });
});

describe('curl - Combined flags', () => {
  it('handles multiple flags combined', async () => {
    const { stdout, exit } = await runCurl(
      ['-sf', '-H', 'Auth: Bearer token', '-X', 'POST', '-d', '{}', 'http://example.com/api'],
      (req) => {
        assert.strictEqual(req.method, 'POST');
        const auth = req.headers.find(([k]) => k === 'auth');
        assert.ok(auth);
        assert.strictEqual(auth![1], 'Bearer token');
        const body = new TextDecoder().decode(req.body);
        assert.strictEqual(body, '{}');
        return { status: 200, headers: [], body: new TextEncoder().encode('{"ok":true}') };
      },
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout, '{"ok":true}');
  });
});

describe('curl - HEAD request', () => {
  it('-I sends HEAD and outputs only headers', async () => {
    const { stdout, exit } = await runCurl(['-I', 'http://example.com/'], (req) => {
      assert.strictEqual(req.method, 'HEAD');
      return {
        status: 200,
        headers: [['content-type', 'text/html'], ['content-length', '1234']],
        body: new TextEncoder().encode('should not appear'),
      };
    });
    assert.strictEqual(exit, 0);
    assert.ok(stdout.includes('HTTP/1.1 200'));
    assert.ok(stdout.includes('content-type: text/html'));
    assert.ok(!stdout.includes('should not appear'));
  });
});

describe('curl - Help', () => {
  it('-h shows help and exits 0', async () => {
    const { stdout, exit } = await runCurl(['-h'], () => {
      throw new Error('should not make a request');
    });
    assert.strictEqual(exit, 0);
    assert.ok(stdout.includes('Usage: curl'));
    assert.ok(stdout.includes('--request'));
  });

  it('--help shows help', async () => {
    const { stdout, exit } = await runCurl(['--help'], () => {
      throw new Error('should not make a request');
    });
    assert.strictEqual(exit, 0);
    assert.ok(stdout.includes('Usage: curl'));
  });
});

describe('curl - User-Agent', () => {
  it('-A sets user-agent header', async () => {
    const { exit } = await runCurl(['-A', 'mithic/1.0', 'http://example.com/'], (req) => {
      const ua = req.headers.find(([k]) => k === 'user-agent');
      assert.ok(ua, 'user-agent header should be set');
      assert.strictEqual(ua![1], 'mithic/1.0');
      return { status: 200, headers: [], body: new Uint8Array(0) };
    });
    assert.strictEqual(exit, 0);
  });
});

describe('curl - Max time', () => {
  it('-m sets total timeout', async () => {
    const { exit } = await runCurl(['-m', '30', 'http://example.com/'], (req) => {
      assert.strictEqual(req.timeoutMs, 30000);
      return { status: 200, headers: [], body: new Uint8Array(0) };
    });
    assert.strictEqual(exit, 0);
  });
});

describe('curl - Data raw', () => {
  it('--data-raw sends body and implies POST', async () => {
    const { exit } = await runCurl(['--data-raw', '{"key":"val"}', 'http://example.com/api'], (req) => {
      assert.strictEqual(req.method, 'POST');
      const body = new TextDecoder().decode(req.body);
      assert.strictEqual(body, '{"key":"val"}');
      return { status: 200, headers: [], body: new Uint8Array(0) };
    });
    assert.strictEqual(exit, 0);
  });
});
