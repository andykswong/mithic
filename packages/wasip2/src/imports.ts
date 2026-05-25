/**
 * Complete WASI Preview 2 import map.
 * Maps WASI interface names to their implementations.
 */
import * as cli from './cli/index.ts';
import * as clocks from './clocks/index.ts';
import * as filesystem from './filesystem/index.ts';
import * as io from './io/index.ts';
import * as http from './http/index.ts';
import * as random from './random/index.ts';
import * as sockets from './sockets/index.ts';

export const imports = {
  'wasi:cli/environment': cli.environment,
  'wasi:cli/exit': cli.exit,
  'wasi:cli/stdin': cli.stdin,
  'wasi:cli/stdout': cli.stdout,
  'wasi:cli/stderr': cli.stderr,
  'wasi:cli/terminal-input': cli.terminalInput,
  'wasi:cli/terminal-output': cli.terminalOutput,
  'wasi:cli/terminal-stdin': cli.terminalStdin,
  'wasi:cli/terminal-stdout': cli.terminalStdout,
  'wasi:cli/terminal-stderr': cli.terminalStderr,
  'wasi:clocks/monotonic-clock': clocks.monotonicClock,
  'wasi:clocks/wall-clock': clocks.wallClock,
  'wasi:filesystem/preopens': filesystem.preopens,
  'wasi:filesystem/types': filesystem.types,
  'wasi:io/error': io.error,
  'wasi:io/poll': io.poll,
  'wasi:io/streams': io.streams,
  'wasi:http/types': http.types,
  'wasi:http/outgoing-handler': http.outgoingHandler,
  'wasi:random/random': random.random,
  'wasi:random/insecure': random.insecure,
  'wasi:random/insecure-seed': random.insecureSeed,
  'wasi:sockets/network': sockets.network,
  'wasi:sockets/instance-network': sockets.instanceNetwork,
  'wasi:sockets/tcp': sockets.tcp,
  'wasi:sockets/tcp-create-socket': sockets.tcpCreateSocket,
  'wasi:sockets/udp': sockets.udp,
  'wasi:sockets/udp-create-socket': sockets.udpCreateSocket,
  'wasi:sockets/ip-name-lookup': sockets.ipNameLookup,
} as const;
