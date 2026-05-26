import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WASIShim } from './instantiation.ts';
import { imports } from './imports.ts';
import { Descriptor } from './filesystem/types.ts';
import { SyncFsDescriptorHandler } from './filesystem/sync-fs-handler.ts';
import { MemoryFsProvider } from '@mithic/io/vfs';
import { InputStream, OutputStream } from './io/streams.ts';
import type { SyncSocketProvider, IoTcpSocket, IoUdpSocket } from './sockets/index.ts';
import type { IpAddress } from '@mithic/io/net';
import { TcpSocket } from './sockets/tcp.ts';

const EXPECTED_KEYS = [
  'wasi:cli/environment',
  'wasi:cli/exit',
  'wasi:cli/stdin',
  'wasi:cli/stdout',
  'wasi:cli/stderr',
  'wasi:cli/terminal-input',
  'wasi:cli/terminal-output',
  'wasi:cli/terminal-stdin',
  'wasi:cli/terminal-stdout',
  'wasi:cli/terminal-stderr',
  'wasi:clocks/monotonic-clock',
  'wasi:clocks/wall-clock',
  'wasi:filesystem/preopens',
  'wasi:filesystem/types',
  'wasi:io/error',
  'wasi:io/poll',
  'wasi:io/streams',
  'wasi:http/types',
  'wasi:http/outgoing-handler',
  'wasi:random/random',
  'wasi:random/insecure',
  'wasi:random/insecure-seed',
  'wasi:sockets/network',
  'wasi:sockets/instance-network',
  'wasi:sockets/tcp',
  'wasi:sockets/tcp-create-socket',
  'wasi:sockets/udp',
  'wasi:sockets/udp-create-socket',
  'wasi:sockets/ip-name-lookup',
];

describe('WASIShim', () => {
  it('getImportObject() returns all expected WASI interface keys with no config', () => {
    const shim = new WASIShim();
    const obj = shim.getImportObject();
    for (const key of EXPECTED_KEYS) {
      assert.ok(key in obj, `Missing key: ${key}`);
      assert.ok(
        typeof obj[key] === 'object' && obj[key] !== null,
        `Value for ${key} should be a non-null object`
      );
    }
  });

  it('getImportObject keys match WASI P2 interface names exactly', () => {
    const shim = new WASIShim();
    const obj = shim.getImportObject();
    const keys = Object.keys(obj).sort();
    const expected = [...EXPECTED_KEYS].sort();
    assert.deepEqual(keys, expected);
  });

  it('all expected interface keys are present in the static imports object', () => {
    for (const key of EXPECTED_KEYS) {
      assert.ok(key in imports, `Missing key in imports: ${key}`);
    }
  });

  it('configures env and args via sandbox option', () => {
    const shim = new WASIShim({
      sandbox: {
        env: { FOO: 'bar', BAZ: 'qux' },
        args: ['myapp', '--verbose'],
      },
    });
    const obj = shim.getImportObject();
    const env = obj['wasi:cli/environment'] as {
      getEnvironment: () => [string, string][];
      getArguments: () => string[];
    };
    const envEntries = env.getEnvironment();
    assert.deepEqual(envEntries, [['FOO', 'bar'], ['BAZ', 'qux']]);
    const args = env.getArguments();
    assert.deepEqual(args, ['myapp', '--verbose']);
  });

  it('configures stdout via sandbox option', () => {
    const written: Uint8Array[] = [];
    const shim = new WASIShim({
      sandbox: {
        stdout: {
          write(data: Uint8Array) {
            written.push(new Uint8Array(data));
          },
        },
      },
    });
    const obj = shim.getImportObject();
    const stdoutInterface = obj['wasi:cli/stdout'] as {
      getStdout: () => { write(data: Uint8Array): void } | undefined;
    };
    const stream = stdoutInterface.getStdout();
    assert.ok(stream !== undefined, 'stdout handler should be set');
    stream.write(new Uint8Array([72, 101, 108, 108, 111]));
    assert.equal(written.length, 1);
    assert.deepEqual(written[0], new Uint8Array([72, 101, 108, 108, 111]));
  });

  it('configures cwd via sandbox option', () => {
    const shim = new WASIShim({
      sandbox: {
        cwd: '/custom/path',
      },
    });
    const obj = shim.getImportObject();
    const env = obj['wasi:cli/environment'] as {
      initialCwd: () => string;
    };
    assert.equal(env.initialCwd(), '/custom/path');
  });

  it('two WASIShim instances with different env do not interfere (isolation)', () => {
    const shim1 = new WASIShim({
      sandbox: { env: { A: '1' }, args: ['app1'] },
    });
    const shim2 = new WASIShim({
      sandbox: { env: { B: '2' }, args: ['app2'] },
    });

    const obj1 = shim1.getImportObject();
    const obj2 = shim2.getImportObject();

    const env1 = obj1['wasi:cli/environment'] as {
      getEnvironment: () => [string, string][];
      getArguments: () => string[];
    };
    const env2 = obj2['wasi:cli/environment'] as {
      getEnvironment: () => [string, string][];
      getArguments: () => string[];
    };

    assert.deepEqual(env1.getEnvironment(), [['A', '1']]);
    assert.deepEqual(env2.getEnvironment(), [['B', '2']]);
    assert.deepEqual(env1.getArguments(), ['app1']);
    assert.deepEqual(env2.getArguments(), ['app2']);
  });

  it('two WASIShim instances with different preopens do not interfere', () => {
    const descA = new Descriptor(new SyncFsDescriptorHandler(new MemoryFsProvider({ files: { '/a.txt': 'content-a' } }), '/'));
    const descB = new Descriptor(new SyncFsDescriptorHandler(new MemoryFsProvider({ files: { '/b.txt': 'content-b' } }), '/'));

    const shim1 = new WASIShim({
      sandbox: { preopens: { '/': descA } },
    });
    const shim2 = new WASIShim({
      sandbox: { preopens: { '/': descB } },
    });

    const obj1 = shim1.getImportObject();
    const obj2 = shim2.getImportObject();

    const preopens1 = obj1['wasi:filesystem/preopens'] as {
      getDirectories: () => [Descriptor, string][];
    };
    const preopens2 = obj2['wasi:filesystem/preopens'] as {
      getDirectories: () => [Descriptor, string][];
    };

    const dirs1 = preopens1.getDirectories();
    const dirs2 = preopens2.getDirectories();

    assert.equal(dirs1.length, 1);
    assert.equal(dirs2.length, 1);

    // Verify they have different content
    const desc1 = dirs1[0][0];
    const desc2 = dirs2[0][0];

    const stream1 = desc1.readDirectory();
    const entry1 = stream1.readDirectoryEntry();
    assert.equal(entry1!.name, 'a.txt');

    const stream2 = desc2.readDirectory();
    const entry2 = stream2.readDirectoryEntry();
    assert.equal(entry2!.name, 'b.txt');
  });

  it('WASIShim with preopens — getDirectories returns correct descriptors', () => {
    const testDesc = new Descriptor(new SyncFsDescriptorHandler(
      new MemoryFsProvider({ files: { '/hello.txt': 'Hello World', '/docs/readme.txt': 'Read me' } }), '/'
    ));

    const shim = new WASIShim({
      sandbox: { preopens: { '/': testDesc } },
    });

    const obj = shim.getImportObject();
    const preopens = obj['wasi:filesystem/preopens'] as {
      getDirectories: () => [Descriptor, string][];
    };

    const dirs = preopens.getDirectories();
    assert.equal(dirs.length, 1);
    assert.equal(dirs[0][1], '/');

    const rootDesc = dirs[0][0];
    assert.ok(rootDesc instanceof Descriptor);
    assert.equal(rootDesc.getType(), 'directory');

    // Verify we can read directory contents
    const dirStream = rootDesc.readDirectory();
    const entries = [];
    let entry = dirStream.readDirectoryEntry();
    while (entry !== null) {
      entries.push(entry);
      entry = dirStream.readDirectoryEntry();
    }
    assert.equal(entries.length, 2);
  });

  it('WASIShim with no sandbox — uses global defaults', () => {
    const shim = new WASIShim();
    const obj = shim.getImportObject();

    // Environment should be the global module-level objects
    const env = obj['wasi:cli/environment'] as Record<string, unknown>;
    assert.ok('getEnvironment' in env);
    assert.ok('getArguments' in env);
    assert.ok('initialCwd' in env);
  });

  it('WASIShim with empty sandbox object — uses global defaults', () => {
    const shim = new WASIShim({ sandbox: {} });
    const obj = shim.getImportObject();

    // Should still have all keys
    for (const key of EXPECTED_KEYS) {
      assert.ok(key in obj, `Missing key: ${key}`);
    }
  });

  it('configures stdin via sandbox option', () => {
    const testData = new Uint8Array([10, 20, 30]);
    const shim = new WASIShim({
      sandbox: {
        stdin: {
          read(len: number) {
            return testData.slice(0, len);
          },
          blockingRead(len: number) {
            return testData.slice(0, len);
          },
        },
      },
    });
    const obj = shim.getImportObject();
    const stdinInterface = obj['wasi:cli/stdin'] as {
      getStdin: () => InputStream;
    };
    const stream = stdinInterface.getStdin();
    assert.ok(stream instanceof InputStream);
    const data = stream.read(2n);
    assert.deepEqual(data, new Uint8Array([10, 20]));
  });

  it('configures stderr via sandbox option', () => {
    const written: Uint8Array[] = [];
    const shim = new WASIShim({
      sandbox: {
        stderr: {
          write(data: Uint8Array) {
            written.push(new Uint8Array(data));
          },
        },
      },
    });
    const obj = shim.getImportObject();
    const stderrInterface = obj['wasi:cli/stderr'] as {
      getStderr: () => OutputStream;
    };
    const stream = stderrInterface.getStderr();
    assert.ok(stream instanceof OutputStream);
    stream.write(new Uint8Array([65, 66]));
    assert.equal(written.length, 1);
    assert.deepEqual(written[0], new Uint8Array([65, 66]));
  });

  it('configures stdin with StdioConfig (handler + isatty)', () => {
    const shim = new WASIShim({
      sandbox: {
        stdin: {
          handler: { blockingRead() { return new Uint8Array([42]); } },
          isatty: true,
        },
      },
    });
    const obj = shim.getImportObject();

    const stdinInterface = obj['wasi:cli/stdin'] as { getStdin: () => InputStream };
    const stream = stdinInterface.getStdin();
    assert.deepEqual(stream.blockingRead(1n), new Uint8Array([42]));

    const termStdin = obj['wasi:cli/terminal-stdin'] as { getTerminalStdin: () => unknown };
    assert.ok(termStdin.getTerminalStdin() !== undefined);
  });

  it('terminal returns undefined when isatty is false', () => {
    const shim = new WASIShim({
      sandbox: {
        stdin: { blockingRead() { return new Uint8Array(0); } },
      },
    });
    const obj = shim.getImportObject();
    const termStdin = obj['wasi:cli/terminal-stdin'] as { getTerminalStdin: () => unknown };
    assert.equal(termStdin.getTerminalStdin(), undefined);
  });

  it('two WASIShim instances with different isatty do not interfere', () => {
    const shim1 = new WASIShim({
      sandbox: { stdout: { handler: { write() {} }, isatty: true } },
    });
    const shim2 = new WASIShim({
      sandbox: { stdout: { handler: { write() {} }, isatty: false } },
    });

    const term1 = (shim1.getImportObject()['wasi:cli/terminal-stdout'] as { getTerminalStdout: () => unknown }).getTerminalStdout();
    const term2 = (shim2.getImportObject()['wasi:cli/terminal-stdout'] as { getTerminalStdout: () => unknown }).getTerminalStdout();

    assert.ok(term1 !== undefined);
    assert.equal(term2, undefined);
  });

  it('two WASIShim instances with different socket providers do not interfere', () => {
    // Create two mock socket providers that track calls
    const calls1: string[] = [];
    const calls2: string[] = [];

    function makeMockProvider(calls: string[]): SyncSocketProvider {
      return {
        createTcpSocket(): IoTcpSocket {
          calls.push('createTcpSocket');
          throw new Error('mock tcp');
        },
        createUdpSocket(): IoUdpSocket {
          calls.push('createUdpSocket');
          throw new Error('mock udp');
        },
        resolveName(name: string): IpAddress[] {
          calls.push(`resolveName:${name}`);
          return [{ family: 'ipv4', address: '127.0.0.1' }];
        },
      };
    }

    const provider1 = makeMockProvider(calls1);
    const provider2 = makeMockProvider(calls2);

    const shim1 = new WASIShim({ sandbox: { sockets: provider1 } });
    const shim2 = new WASIShim({ sandbox: { sockets: provider2 } });

    const obj1 = shim1.getImportObject();
    const obj2 = shim2.getImportObject();

    // Verify they have different tcp-create-socket factories
    const tcpCreate1 = obj1['wasi:sockets/tcp-create-socket'] as { createTcpSocket: (f: string) => TcpSocket };
    const tcpCreate2 = obj2['wasi:sockets/tcp-create-socket'] as { createTcpSocket: (f: string) => TcpSocket };

    // Both should create sockets
    const sock1 = tcpCreate1.createTcpSocket('ipv4');
    const sock2 = tcpCreate2.createTcpSocket('ipv4');

    assert.ok(sock1 instanceof TcpSocket);
    assert.ok(sock2 instanceof TcpSocket);

    // Sockets are distinct instances
    assert.notStrictEqual(sock1, sock2);

    // Factories are distinct (isolated per WASIShim)
    assert.notStrictEqual(tcpCreate1, tcpCreate2);
    assert.notStrictEqual(
      obj1['wasi:sockets/instance-network'],
      obj2['wasi:sockets/instance-network'],
    );
  });
});
