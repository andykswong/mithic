/**
 * WASIShim - configurable WASI Preview 2 shim for WebAssembly component instantiation.
 *
 * Each WASIShim instance is self-contained: it creates isolated environment, preopens,
 * and stdio objects. Multiple instances do NOT share state and can run concurrently.
 *
 * Usage:
 *   const shim = new WASIShim({ sandbox: { env: { HOME: '/tmp' }, args: ['myapp'] } });
 *   const component = await instantiate(null, shim.getImportObject());
 */
import * as cli from './cli/index.ts';
import * as clocks from './clocks/index.ts';
import * as filesystem from './filesystem/index.ts';
import * as io from './io/index.ts';
import * as http from './http/index.ts';
import * as random from './random/index.ts';
import * as sockets from './sockets/index.ts';
import { Descriptor, type FileData } from './filesystem/types.ts';
import { InputStream, OutputStream, type InputStreamHandler, type OutputStreamHandler } from './io/streams.ts';
import { outgoingRequestHandle } from './http/types.ts';
import type { OutgoingRequest, RequestOptions, FutureIncomingResponse } from './http/types.ts';
import type { SocketProvider } from '@mithic/io/net';
import type { HttpClient } from '@mithic/io/net';
import type {
  WasiEnvironment,
  WasiPreopens,
  WasiStdin,
  WasiStdout,
  WasiStderr,
  WasiOutgoingHandler,
  WasiSockets,
} from './interfaces.ts';

export type { WasiEnvironment, WasiPreopens, WasiStdin, WasiStdout, WasiStderr, WasiOutgoingHandler, WasiSockets };

export interface WASIShimConfig {
  sandbox?: {
    preopens?: Record<string, FileData>;
    env?: Record<string, string>;
    args?: string[];
    cwd?: string;
    stdin?: InputStreamHandler;
    stdout?: OutputStreamHandler;
    stderr?: OutputStreamHandler;
    sockets?: SocketProvider;
    httpClient?: HttpClient;
  };
}

export type WASIImportObject = { [key: string]: object };

export class WASIShim {
  #environment: WasiEnvironment | null = null;
  #preopens: WasiPreopens | null = null;
  #stdin: WasiStdin | null = null;
  #stdout: WasiStdout | null = null;
  #stderr: WasiStderr | null = null;
  #sockets: WasiSockets | null = null;
  #httpOutgoingHandler: WasiOutgoingHandler | null = null;

  constructor(config?: WASIShimConfig) {
    const sandbox = config?.sandbox;
    if (!sandbox) return;

    if (sandbox.env !== undefined || sandbox.args !== undefined || sandbox.cwd !== undefined) {
      this.#environment = createIsolatedEnvironment(sandbox.env, sandbox.args, sandbox.cwd);
    }

    if (sandbox.preopens !== undefined) {
      this.#preopens = createIsolatedPreopens(sandbox.preopens);
    }

    if (sandbox.stdin) {
      const stream = new InputStream(sandbox.stdin);
      this.#stdin = { InputStream, getStdin: () => stream };
    }

    if (sandbox.stdout) {
      const stream = new OutputStream(sandbox.stdout);
      this.#stdout = { OutputStream, getStdout: () => stream };
    }

    if (sandbox.stderr) {
      const stream = new OutputStream(sandbox.stderr);
      this.#stderr = { OutputStream, getStderr: () => stream };
    }

    if (sandbox.sockets) {
      this.#sockets = sockets._createIsolatedSockets(sandbox.sockets);
    }

    if (sandbox.httpClient) {
      const client = sandbox.httpClient;
      this.#httpOutgoingHandler = {
        handle: (request: OutgoingRequest, options?: RequestOptions): FutureIncomingResponse =>
          outgoingRequestHandle(request, options, client),
      };
    }
  }

  getImportObject(): WASIImportObject {
    return {
      'wasi:cli/environment': this.#environment ?? cli.environment,
      'wasi:cli/exit': cli.exit,
      'wasi:cli/stdin': this.#stdin ?? cli.stdin,
      'wasi:cli/stdout': this.#stdout ?? cli.stdout,
      'wasi:cli/stderr': this.#stderr ?? cli.stderr,
      'wasi:cli/terminal-input': cli.terminalInput,
      'wasi:cli/terminal-output': cli.terminalOutput,
      'wasi:cli/terminal-stdin': cli.terminalStdin,
      'wasi:cli/terminal-stdout': cli.terminalStdout,
      'wasi:cli/terminal-stderr': cli.terminalStderr,
      'wasi:clocks/monotonic-clock': clocks.monotonicClock,
      'wasi:clocks/wall-clock': clocks.wallClock,
      'wasi:filesystem/preopens': this.#preopens ?? filesystem.preopens,
      'wasi:filesystem/types': filesystem.types,
      'wasi:io/error': io.error,
      'wasi:io/poll': io.poll,
      'wasi:io/streams': io.streams,
      'wasi:http/types': http.types,
      'wasi:http/outgoing-handler': this.#httpOutgoingHandler ?? http.outgoingHandler,
      'wasi:random/random': random.random,
      'wasi:random/insecure': random.insecure,
      'wasi:random/insecure-seed': random.insecureSeed,
      'wasi:sockets/network': this.#sockets?.network ?? sockets.network,
      'wasi:sockets/instance-network': this.#sockets?.instanceNetwork ?? sockets.instanceNetwork,
      'wasi:sockets/tcp': this.#sockets?.tcp ?? sockets.tcp,
      'wasi:sockets/tcp-create-socket': this.#sockets?.tcpCreateSocket ?? sockets.tcpCreateSocket,
      'wasi:sockets/udp': this.#sockets?.udp ?? sockets.udp,
      'wasi:sockets/udp-create-socket': this.#sockets?.udpCreateSocket ?? sockets.udpCreateSocket,
      'wasi:sockets/ip-name-lookup': this.#sockets?.ipNameLookup ?? sockets.ipNameLookup,
    };
  }
}

function createIsolatedEnvironment(
  env?: Record<string, string>,
  args?: string[],
  cwd?: string,
): WasiEnvironment {
  const envEntries: [string, string][] = env ? Object.entries(env) : [];
  const argsArray = args ?? [];
  const cwdValue = cwd ?? '/';

  return {
    getEnvironment() { return envEntries; },
    getArguments() { return argsArray; },
    initialCwd() { return cwdValue; },
  };
}

function createIsolatedPreopens(preopensConfig: Record<string, FileData>): WasiPreopens {
  const entries: [Descriptor, string][] = [];

  for (const [virtualPath, fileData] of Object.entries(preopensConfig)) {
    entries.push([new Descriptor(fileData), virtualPath]);
  }

  return {
    Descriptor,
    getDirectories() { return entries; },
  };
}
