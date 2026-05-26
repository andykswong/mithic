/**
 * Shell worker — runs JustBashShell in a Web Worker with blocking stdin via SharedArrayBuffer.
 *
 * Receives stdin signal/data SABs from the main thread, then enters a read-eval-print loop:
 *   1. Prompt the user (post 'prompt' message)
 *   2. Block on stdin (Atomics.wait)
 *   3. Execute the command via JustBashShell
 *   4. Post stdout/stderr results back to main thread
 */

import { FileSystemRouter } from '@mithic/io/vfs';
import { MemoryFsProvider } from '@mithic/io/vfs';
import { SimpleProcessManager } from '@mithic/process/impl/simple';
import { JustBashShell } from '@mithic/just-bash';
import type { CommandHandler, CommandContext } from '@mithic/process/impl/simple';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// --- Wait for init message with SharedArrayBuffer handles ---
const initPromise = new Promise<{ signal: SharedArrayBuffer; data: SharedArrayBuffer }>((resolve) => {
  globalThis.onmessage = (e: MessageEvent) => {
    if (e.data?.type === 'init') {
      resolve({ signal: e.data.signal, data: e.data.data });
    }
  };
});

const { signal, data } = await initPromise;
const signalView = new Int32Array(signal);
const dataView = new Uint8Array(data);

// --- Setup VFS with in-memory filesystem ---
const router = new FileSystemRouter();
const memFs = new MemoryFsProvider();
await router.mount('/', memFs);

// Create some initial directories
await router.mkdir('/home');
await router.mkdir('/tmp');
await router.mkdir('/bin');

// --- Setup ProcessManager with built-in commands ---
function createBuiltinResolver(): (file: string) => CommandHandler | undefined {
  const builtins = new Map<string, CommandHandler>();

  builtins.set('echo', async (args: string[], ctx: CommandContext): Promise<number> => {
    const output = args.join(' ') + '\n';
    ctx.stdout.write(encoder.encode(output));
    return 0;
  });

  builtins.set('cat', async (args: string[], ctx: CommandContext): Promise<number> => {
    if (args.length === 0) {
      // Read from stdin until closed
      try {
        while (true) {
          const chunk = ctx.stdin.blockingRead(65536n);
          ctx.stdout.write(chunk);
        }
      } catch (e: unknown) {
        if (typeof e === 'object' && e !== null && 'tag' in e && (e as { tag: string }).tag === 'closed') {
          return 0;
        }
        throw e;
      }
    }
    // Read files
    for (const file of args) {
      try {
        const content = await router.stat(file.startsWith('/') ? file : `/home/${file}`);
        const handle = await router.open(file.startsWith('/') ? file : `/home/${file}`, { read: true });
        const bytes = await router.read(handle, 0, Number(content.size));
        await router.close(handle);
        ctx.stdout.write(bytes);
      } catch {
        ctx.stderr.write(encoder.encode(`cat: ${file}: No such file or directory\n`));
        return 1;
      }
    }
    return 0;
  });

  builtins.set('ls', async (args: string[], ctx: CommandContext): Promise<number> => {
    const path = args[0] || '/home';
    const resolved = path.startsWith('/') ? path : `/home/${path}`;
    try {
      const entries = await router.readdir(resolved);
      const names = entries.map(e => e.name).join('  ');
      if (names) ctx.stdout.write(encoder.encode(names + '\n'));
      return 0;
    } catch {
      ctx.stderr.write(encoder.encode(`ls: cannot access '${path}': No such file or directory\n`));
      return 1;
    }
  });

  builtins.set('pwd', async (_args: string[], ctx: CommandContext): Promise<number> => {
    ctx.stdout.write(encoder.encode('/home\n'));
    return 0;
  });

  builtins.set('mkdir', async (args: string[], ctx: CommandContext): Promise<number> => {
    for (const dir of args) {
      const resolved = dir.startsWith('/') ? dir : `/home/${dir}`;
      try {
        await router.mkdir(resolved);
      } catch {
        ctx.stderr.write(encoder.encode(`mkdir: cannot create directory '${dir}'\n`));
        return 1;
      }
    }
    return 0;
  });

  builtins.set('touch', async (args: string[], ctx: CommandContext): Promise<number> => {
    for (const file of args) {
      const resolved = file.startsWith('/') ? file : `/home/${file}`;
      try {
        const handle = await router.open(resolved, { create: true, write: true });
        await router.close(handle);
      } catch {
        ctx.stderr.write(encoder.encode(`touch: cannot create '${file}'\n`));
        return 1;
      }
    }
    return 0;
  });

  builtins.set('tee', async (args: string[], ctx: CommandContext): Promise<number> => {
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const chunk = ctx.stdin.blockingRead(65536n);
        chunks.push(chunk);
        ctx.stdout.write(chunk);
      }
    } catch (e: unknown) {
      if (!(typeof e === 'object' && e !== null && 'tag' in e && (e as { tag: string }).tag === 'closed')) {
        throw e;
      }
    }
    // Write collected input to files
    const allData = concat(chunks);
    for (const file of args) {
      const resolved = file.startsWith('/') ? file : `/home/${file}`;
      const handle = await router.open(resolved, { create: true, write: true, truncate: true });
      await router.write(handle, allData, 0);
      await router.close(handle);
    }
    return 0;
  });

  return (file: string) => builtins.get(file);
}

const manager = new SimpleProcessManager({
  commandResolver: createBuiltinResolver(),
});

// --- Setup Shell ---
const shell = new JustBashShell({
  processManager: manager,
  vfsRouter: router,
  cwd: '/home',
  env: { HOME: '/home', PATH: '/bin', USER: 'user', TERM: 'xterm-256color' },
});

// --- REPL loop ---
function readLine(): string {
  // Block until main thread signals data is available
  while (Atomics.load(signalView, 0) === 0) {
    Atomics.wait(signalView, 0, 0);
  }
  if (Atomics.load(signalView, 0) === 2) {
    throw new Error('stdin closed');
  }
  const byteLen = Atomics.load(signalView, 1);
  const bytes = new Uint8Array(byteLen);
  bytes.set(dataView.subarray(0, byteLen));
  // Reset signal
  Atomics.store(signalView, 0, 0);
  Atomics.store(signalView, 1, 0);
  return decoder.decode(bytes);
}

function postOutput(type: 'stdout' | 'stderr' | 'prompt', value: string): void {
  globalThis.postMessage({ type, value });
}

postOutput('stdout', 'mithic shell v0.1.0\nType "help" for available commands.\n\n');
postOutput('prompt', '$ ');

while (true) {
  const line = readLine().trim();
  if (!line) {
    postOutput('prompt', '$ ');
    continue;
  }

  if (line === 'help') {
    postOutput('stdout', 'Available commands: echo, cat, ls, pwd, mkdir, touch, tee\n');
    postOutput('stdout', 'Pipelines supported: echo hello | cat\n');
    postOutput('prompt', '$ ');
    continue;
  }

  try {
    const result = await shell.exec(line);
    const stdout = decoder.decode(result.stdout);
    const stderr = decoder.decode(result.stderr);
    if (stdout) postOutput('stdout', stdout);
    if (stderr) postOutput('stderr', stderr);
  } catch (e) {
    postOutput('stderr', `error: ${String(e)}\n`);
  }

  postOutput('prompt', '$ ');
}

// --- Utility ---
function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!;
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
