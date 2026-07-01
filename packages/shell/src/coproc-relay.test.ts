/**
 * A2 (relay) — the shell KernelClient's `spawnCoproc` over the RELAY byte-channel.
 *
 * On a transferable backend `spawnCoproc` mints two `fs/pipe` channels and
 * transfers their ends into the child (`process/spawn` + `portFds`). On a relay
 * backend (QuickJS/ivm) no MessagePort can cross into the guest, so `fs/pipe`
 * returns integer fds with EMPTY ports and the kernel keeps the ends. The client
 * then takes the relay branch: it calls `process/coproc` (kernel mints the duplex
 * + wires the child + hands back `readfd`/`writefd`) and drives the shell-retained
 * ends by fd via `pipe/read`/`pipe/write`/`pipe/close`, adapting them to the same
 * `CoprocHandle` (`readLine`/`write`/`close`) the executor consumes.
 *
 * This exercises the real `makeKernelClient(...).spawnCoproc` relay branch against
 * a mock `Guest` that faithfully emulates the kernel's relay bridge semantics:
 * `process/coproc` mints an in-memory `cat` echo child; `pipe/*` operate the ends
 * (relay `pipe/read` returns `{ data: number[] }`, the wire shape QuickJS uses).
 */
import { expect, test } from 'vitest';
import type { Guest } from '@mithic/guest-runtime';
import { makeKernelClient } from './process.ts';

/** An in-memory byte pipe with a FIFO buffer + EOF flag + parked-reader wakeups. */
class MemPipe {
  chunks: number[][] = [];
  ended = false;
  waiters: Array<() => void> = [];
  write(bytes: number[]): void { this.chunks.push(bytes); this.wake(); }
  end(): void { this.ended = true; this.wake(); }
  wake(): void { for (const w of this.waiters.splice(0)) w(); }
  async read(len: number): Promise<number[]> {
    for (;;) {
      if (this.chunks.length > 0) {
        const head = this.chunks[0];
        if (len >= head.length) { this.chunks.shift(); return head; }
        this.chunks[0] = head.slice(len);
        return head.slice(0, len);
      }
      if (this.ended) return [];
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }
}

/**
 * Build a mock relay Guest whose `process/coproc` spawns an in-memory `cat` echo:
 * whatever the shell writes to `writefd` is echoed back on `readfd`. Relay fds are
 * allocated as integers; `pipe/*` operate the two `MemPipe`s.
 */
function makeRelayGuest(): Guest {
  const s2c = new MemPipe(); // shell → child (child stdin)
  const c2s = new MemPipe(); // child → shell (child stdout)
  const fds = new Map<number, { pipe: MemPipe; dir: 'read' | 'write' }>();
  let nextFd = 10;
  let childPid = 0;

  const enc = new TextEncoder();

  const syscall = async (call: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (call) {
      case 'process/coproc': {
        childPid = 4242;
        // Child = `cat`: pump s2c → c2s until s2c ends, then EOF c2s.
        void (async () => {
          for (;;) {
            const data = await s2c.read(65536);
            if (data.length === 0) break;
            c2s.write(data);
          }
          c2s.end();
        })();
        const readfd = nextFd++; // shell reads child stdout (c2s)
        const writefd = nextFd++; // shell writes child stdin (s2c)
        fds.set(readfd, { pipe: c2s, dir: 'read' });
        fds.set(writefd, { pipe: s2c, dir: 'write' });
        return { pid: childPid, readfd, writefd };
      }
      case 'pipe/write': {
        const e = fds.get(Number(args.fd));
        if (!e) throw Object.assign(new Error('EBADF'), { code: 'EBADF' });
        const raw = args.data;
        const bytes = raw instanceof Uint8Array ? Array.from(raw)
          : Array.isArray(raw) ? (raw as number[])
            : Array.from(enc.encode(String(raw)));
        e.pipe.write(bytes);
        return { written: bytes.length };
      }
      case 'pipe/read': {
        const e = fds.get(Number(args.fd));
        if (!e) throw Object.assign(new Error('EBADF'), { code: 'EBADF' });
        const data = await e.pipe.read(Number(args.len ?? 65536));
        return { data }; // relay wire shape: a plain number array
      }
      case 'pipe/close': {
        const e = fds.get(Number(args.fd));
        if (e && e.dir === 'write') e.pipe.end();
        fds.delete(Number(args.fd));
        return {};
      }
      case 'process/wait':
        return { code: 0 };
      default:
        throw new Error(`unexpected syscall ${call}`);
    }
  };

  // Relay `fs/pipe`: returns integer fds with EMPTY ports (the RelayBridge strips
  // ports). spawnCoproc's transferable probe sees empty ports → relay branch.
  const syscallPorts = async (call: string): Promise<{ result: unknown; ports: MessagePort[] }> => {
    if (call === 'fs/pipe') {
      const readfd = nextFd++;
      const writefd = nextFd++;
      // Register throwaway ends so a stray pipe/close is harmless.
      fds.set(readfd, { pipe: new MemPipe(), dir: 'read' });
      fds.set(writefd, { pipe: new MemPipe(), dir: 'write' });
      return { result: { readfd, writefd }, ports: [] };
    }
    throw new Error(`unexpected syscallPorts ${call}`);
  };

  return { pid: 1, args: [], env: {}, cwd: '/', syscall, syscallPorts } as unknown as Guest;
}

const T = 10000;

test('A2 relay: spawnCoproc drives a coproc duplex over pipe/read + pipe/write', async () => {
  const guest = makeRelayGuest();
  const client = makeKernelClient(guest, () => {});
  expect(client.spawnCoproc).toBeDefined();

  const handle = await client.spawnCoproc!({ code: 'cat', args: ['cat'] });
  expect(handle.pid).toBe(4242);

  await handle.write('hello\n');
  const line = await handle.readLine();
  expect(line).toBe('hello');

  await handle.write('world\n');
  expect(await handle.readLine()).toBe('world');

  handle.close();
}, T);

test('A2 relay: spawnCoproc readLine returns undefined once the child stdout EOFs', async () => {
  // Emulate a coproc child that echoes exactly ONE line then exits (EOFs its
  // stdout). The shell reads the line, then the next readLine sees EOF (undefined)
  // — the coproc read-loop termination the executor relies on.
  const c2s = new MemPipe();
  const s2c = new MemPipe();
  const fds = new Map<number, { pipe: MemPipe; dir: 'read' | 'write' }>();
  let nextFd = 10;
  const enc = new TextEncoder();
  const syscall = async (call: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (call) {
      case 'process/coproc': {
        void (async () => {
          const data = await s2c.read(65536);
          if (data.length > 0) c2s.write(data);
          c2s.end(); // one line then EOF
        })();
        const readfd = nextFd++; const writefd = nextFd++;
        fds.set(readfd, { pipe: c2s, dir: 'read' });
        fds.set(writefd, { pipe: s2c, dir: 'write' });
        return { pid: 7, readfd, writefd };
      }
      case 'pipe/write': {
        const e = fds.get(Number(args.fd))!;
        const bytes = Array.from(enc.encode(String(args.data instanceof Uint8Array ? new TextDecoder().decode(args.data) : args.data)));
        e.pipe.write(bytes); return { written: bytes.length };
      }
      case 'pipe/read': {
        const e = fds.get(Number(args.fd));
        if (!e) return { data: [] }; // a closed fd reads EOF (never EBADF-hangs)
        return { data: await e.pipe.read(Number(args.len ?? 65536)) };
      }
      case 'pipe/close': { const e = fds.get(Number(args.fd)); if (e && e.dir === 'write') e.pipe.end(); fds.delete(Number(args.fd)); return {}; }
      default: throw new Error(`unexpected ${call}`);
    }
  };
  // Relay `fs/pipe` probe: integer fds, EMPTY ports → spawnCoproc takes the relay branch.
  const syscallPorts = async (call: string): Promise<{ result: unknown; ports: MessagePort[] }> => {
    if (call === 'fs/pipe') { const r = nextFd++, w = nextFd++; fds.set(r, { pipe: new MemPipe(), dir: 'read' }); fds.set(w, { pipe: new MemPipe(), dir: 'write' }); return { result: { readfd: r, writefd: w }, ports: [] }; }
    throw new Error(`unexpected syscallPorts ${call}`);
  };
  const guest = { pid: 1, args: [], env: {}, cwd: '/', syscall, syscallPorts } as unknown as Guest;
  const client = makeKernelClient(guest, () => {});
  const handle = await client.spawnCoproc!({ code: 'cat', args: ['cat'] });
  await handle.write('one\n');
  expect(await handle.readLine()).toBe('one');
  expect(await handle.readLine()).toBeUndefined();
  handle.close();
}, T);
