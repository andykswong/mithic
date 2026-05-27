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
import { Descriptor } from './filesystem/types.ts';
import { InputStream, OutputStream, type InputStreamHandler, type OutputStreamHandler } from './io/streams.ts';
import type { InputStdioConfig, OutputStdioConfig } from './cli/stdio.ts';
import { outgoingRequestHandle } from './http/types.ts';
import type { OutgoingRequest, RequestOptions, FutureIncomingResponse } from './http/types.ts';
import type { SyncSocketProvider, SyncHttpClient } from '@mithic/io/net';
import type {
  WasiEnvironment,
  WasiPreopens,
  WasiStdin,
  WasiStdout,
  WasiStderr,
  WasiOutgoingHandler,
  WasiSockets,
} from './interfaces.ts';
import { TerminalInput, TerminalOutput } from './cli/terminal.ts';

export type { WasiEnvironment, WasiPreopens, WasiStdin, WasiStdout, WasiStderr, WasiOutgoingHandler, WasiSockets };
export type { InputStdioConfig, OutputStdioConfig };

export interface WASIShimConfig {
  sandbox?: {
    preopens?: Record<string, Descriptor>;
    env?: Record<string, string>;
    args?: string[];
    cwd?: string;
    stdin?: InputStream | InputStreamHandler | InputStdioConfig;
    stdout?: OutputStream | OutputStreamHandler | OutputStdioConfig;
    stderr?: OutputStream | OutputStreamHandler | OutputStdioConfig;
    sockets?: SyncSocketProvider;
    httpClient?: SyncHttpClient;
  };
}

export type WASIImportObject = { [key: string]: object };

export class WASIShim {
  #environment: WasiEnvironment | null = null;
  #preopens: WasiPreopens | null = null;
  #stdinStream: InputStream | null = null;
  #stdoutStream: OutputStream | null = null;
  #stderrStream: OutputStream | null = null;
  #terminalStdin: object | null = null;
  #terminalStdout: object | null = null;
  #terminalStderr: object | null = null;
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
      this.#stdinStream = toInputStream(sandbox.stdin);
      this.#terminalStdin = createIsolatedTerminalStdin(this.#stdinStream.isatty);
    }

    if (sandbox.stdout) {
      this.#stdoutStream = toOutputStream(sandbox.stdout);
      this.#terminalStdout = createIsolatedTerminalStdout(this.#stdoutStream.isatty);
    }

    if (sandbox.stderr) {
      this.#stderrStream = toOutputStream(sandbox.stderr);
      this.#terminalStderr = createIsolatedTerminalStderr(this.#stderrStream.isatty);
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

  [Symbol.dispose](): void {
    this.#stdinStream?.[Symbol.dispose]();
    this.#stdoutStream?.[Symbol.dispose]();
    this.#stderrStream?.[Symbol.dispose]();
  }

  getImportObject(): WASIImportObject {
    return {
      'wasi:cli/environment': this.#environment ?? cli.environment,
      'wasi:cli/exit': cli.exit,
      'wasi:cli/stdin': this.#stdinStream ? { InputStream, getStdin: () => this.#stdinStream!.borrow() } : cli.stdin,
      'wasi:cli/stdout': this.#stdoutStream ? { OutputStream, getStdout: () => this.#stdoutStream!.borrow() } : cli.stdout,
      'wasi:cli/stderr': this.#stderrStream ? { OutputStream, getStderr: () => this.#stderrStream!.borrow() } : cli.stderr,
      'wasi:cli/terminal-input': cli.terminalInput,
      'wasi:cli/terminal-output': cli.terminalOutput,
      'wasi:cli/terminal-stdin': this.#terminalStdin ?? cli.terminalStdin,
      'wasi:cli/terminal-stdout': this.#terminalStdout ?? cli.terminalStdout,
      'wasi:cli/terminal-stderr': this.#terminalStderr ?? cli.terminalStderr,
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

function createIsolatedPreopens(preopensConfig: Record<string, Descriptor>): WasiPreopens {
  const entries: [Descriptor, string][] = Object.entries(preopensConfig).map(
    ([virtualPath, descriptor]) => [descriptor, virtualPath],
  );

  return {
    Descriptor,
    getDirectories() { return entries; },
  };
}

function createIsolatedTerminalStdin(isatty: boolean) {
  return {
    TerminalInput,
    getTerminalStdin: () => isatty ? new TerminalInput() : undefined,
  };
}

function createIsolatedTerminalStdout(isatty: boolean) {
  return {
    TerminalOutput,
    getTerminalStdout: () => isatty ? new TerminalOutput() : undefined,
  };
}

function createIsolatedTerminalStderr(isatty: boolean) {
  return {
    TerminalOutput,
    getTerminalStderr: () => isatty ? new TerminalOutput() : undefined,
  };
}

function toInputStream(value: InputStream | InputStreamHandler | InputStdioConfig): InputStream {
  if (value instanceof InputStream) return value;
  if ('handler' in value) return new InputStream((value as InputStdioConfig).handler, (value as InputStdioConfig).subscribe, (value as InputStdioConfig).isatty);
  return new InputStream(value as InputStreamHandler);
}

function toOutputStream(value: OutputStream | OutputStreamHandler | OutputStdioConfig): OutputStream {
  if (value instanceof OutputStream) return value;
  if ('handler' in value) return new OutputStream((value as OutputStdioConfig).handler, (value as OutputStdioConfig).subscribe, (value as OutputStdioConfig).isatty);
  return new OutputStream(value as OutputStreamHandler);
}
