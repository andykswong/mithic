/**
 * coproc on the RELAY (non-transferable) path (§4.8 / A2).
 *
 * On a transferable backend the shell's `coproc` mints two `fs/pipe` channels and
 * transfers their ends into the child as its stdin/stdout (port-injecting spawn).
 * A relay backend (QuickJS/ivm) cannot transfer MessagePorts, so instead the
 * kernel keeps ALL pipe ends: the `process/coproc` syscall mints a bidirectional
 * pipe pair, wires the CHILD's stdin/stdout to the kernel-held ends, and hands the
 * PARENT two relay fd NUMBERS (`readfd` = read child stdout, `writefd` = write
 * child stdin). The parent drives them by fd via `pipe/write`/`pipe/read`/`pipe/close`
 * — the same byte-relay used for `fs/pipe`.
 *
 * These tests drive the REAL Kernel relay path (real `SyscallDispatcher`,
 * `RelayBridge` RelayEnds, capability checks, and fd allocation) through a
 * lightweight relay launcher whose guests are plain async JS "programs" servicing
 * their syscalls via `RelayContext.onSyscall`. That deliberately avoids nesting a
 * second WASM/isolate interpreter inside the parent's suspended syscall — a
 * pre-existing limitation of BOTH QuickJS and ivm relay backends (a relay guest
 * cannot spawn a relay child from within a suspended syscall: QuickJS aborts with
 * `list_empty(&rt->gc_obj_list)`, ivm hangs). The child EXECUTION substrate is
 * orthogonal to the coproc PIPE wiring under test here — the launcher stubs the
 * former and exercises the latter for real.
 */
import { expect, test } from 'vitest';
import { Kernel } from './kernel.ts';
import type { RelayContext, RelayLauncher } from './kernel.ts';
import type { ProcessHandle, Runtime, RuntimeCapabilities, SpawnOptions } from '@mithic/runtime';

/**
 * A guest "program" façade mirroring the real relay launchers' `onSyscall`: fd-1/
 * fd-2 writes route to the relay context's stdout/stderr capture (or, in coproc
 * mode, the kernel forwards fd 1 to the shell's coproc read end); everything else
 * is KERNEL-routed via `ctx.onSyscall`. `sys(call,args)` unwraps to the result or
 * throws the errno, matching a real guest's `__mithic_syscall`.
 */
interface ProgramApi {
  sys(call: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  stdout(bytes: number[] | Uint8Array): void;
}

/** A guest "program": drives its own syscalls via the program API, then exits. */
type Program = (api: ProgramApi) => Promise<void>;

/**
 * A minimal non-transferable Runtime + relay launcher pair. The launcher looks up
 * a {@link Program} by the resolved `ctx.code` string and runs it fire-and-forget;
 * the program services `pipe/read`/`pipe/write`/`process/coproc`/... via the REAL
 * kernel (`ctx.onSyscall`), and writes stdout via `ctx.writeStdout`. `directPipes`
 * is false so the Kernel takes the relay path and wires `coprocChild`.
 */
class ProgramRuntime implements Runtime {
  readonly capabilities: RuntimeCapabilities = {
    gui: false, transferable: false, directPipes: false, deterministic: true,
    memoryLimit: false, cpuLimit: false, parallelism: false, interruptible: false,
  };
  #nextId = 1;
  #exits = new Map<number, { promise: Promise<{ code: number }>; resolve: (r: { code: number }) => void }>();
  spawn(_code: string | URL, _options: SpawnOptions): Promise<ProcessHandle> {
    const id = this.#nextId++;
    let resolve!: (r: { code: number }) => void;
    const promise = new Promise<{ code: number }>((r) => { resolve = r; });
    this.#exits.set(id, { promise, resolve });
    return Promise.resolve({ id });
  }
  settleExit(id: number, code: number): void { this.#exits.get(id)?.resolve({ code }); }
  waitExit(handle: ProcessHandle): Promise<{ code: number }> {
    return this.#exits.get(handle.id)?.promise ?? Promise.resolve({ code: 0 });
  }
  kill(): void {}
  postMessage(): void {}
  onMessage(): void {}
  isAlive(): boolean { return true; }
  dispose(): void {}
}

class ProgramLauncher implements RelayLauncher {
  #rt: ProgramRuntime;
  #programs: Map<string, Program>;
  constructor(rt: ProgramRuntime, programs: Map<string, Program>) { this.#rt = rt; this.#programs = programs; }
  async launchRelay(_runtime: Runtime, ctx: RelayContext): Promise<ProcessHandle> {
    const handle = await this.#rt.spawn(ctx.code, { init: ctx.init });
    const prog = this.#programs.get(String(ctx.code));
    // Mirror the real relay launchers: fd-1/fd-2 writes short-circuit to the
    // relay context (the kernel routes them to stdout capture, or — coproc mode —
    // to the shell's read end). Everything else is KERNEL-routed.
    const api: ProgramApi = {
      stdout: (bytes) => ctx.writeStdout(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)),
      sys: async (call, args) => {
        if (call === 'pipe/write' && (Number(args.fd) === 1 || Number(args.fd) === 2)) {
          const raw = args.data;
          const chunk = raw instanceof Uint8Array ? raw : Array.isArray(raw) ? new Uint8Array(raw as number[]) : new Uint8Array(0);
          if (Number(args.fd) === 1) ctx.writeStdout(chunk); else ctx.writeStderr(chunk);
          return { written: chunk.byteLength };
        }
        const res = await ctx.onSyscall(call, args);
        if (res.ok) return res.result as Record<string, unknown>;
        throw Object.assign(new Error(res.error.message), { code: res.error.code });
      },
    };
    void (async () => {
      let code = 0;
      try { if (prog) await prog(api); } catch { code = 1; }
      ctx.closeStdout();
      ctx.closeStderr();
      ctx.notifyExit(code);
      this.#rt.settleExit(handle.id, code);
    })();
    return handle;
  }
}

/** Decode a relay `pipe/read` result (`{ data: number[] }`) to a string. */
function decode(result: { data?: number[] }): string {
  return String.fromCharCode(...(result.data ?? []));
}
const bytesOf = (s: string): number[] => Array.from(new TextEncoder().encode(s));

const T = 15000;

function bootKernel(programs: Map<string, Program>, resolveCommand?: (n: string) => string | undefined): Kernel {
  const rt = new ProgramRuntime();
  return new Kernel({
    runtime: rt,
    // The relay coproc path never touches the VFS for these programs; a stub VFS is
    // enough (fs syscalls are unused here).
    vfs: {} as never,
    relayLauncher: new ProgramLauncher(rt, programs),
    resolveCommand: resolveCommand ? (name) => resolveCommand(name) : undefined,
  });
}

test('A2 relay: process/coproc round-trips a line through a relay child', async () => {
  const programs = new Map<string, Program>();
  // `cat`: echo fd-0 → fd-1 until stdin EOF.
  const CAT = 'CAT';
  programs.set(CAT, async (api) => {
    for (;;) {
      const r = await api.sys('pipe/read', { fd: 0, len: 4096 });
      const data = (r as { data: number[] }).data;
      if (data.length === 0) break;
      await api.sys('pipe/write', { fd: 1, data });
    }
  });
  // shell surrogate: start `cat` as a coproc, write a line, read it back to stdout.
  const SHELL = 'SHELL';
  programs.set(SHELL, async (api) => {
    const c = await api.sys('process/coproc', { path: 'cat', argv: ['cat'] });
    const { readfd, writefd } = c as { pid: number; readfd: number; writefd: number };
    await api.sys('pipe/write', { fd: writefd, data: bytesOf('hello\n') });
    let out = '';
    for (;;) {
      const s = decode(await api.sys('pipe/read', { fd: readfd, len: 4096 }));
      if (s.length === 0) break;
      out += s;
      if (out.includes('\n')) break;
    }
    await api.sys('pipe/close', { fd: writefd });
    await api.sys('pipe/close', { fd: readfd });
    api.stdout(bytesOf(out));
  });

  const kernel = bootKernel(programs, (n) => (n === 'cat' ? CAT : undefined));
  const { pid, stdout } = await kernel.spawn(SHELL, {
    args: ['sh'], capabilities: [{ type: 'process' }], captureStdout: true,
  });
  const result = await kernel.wait(pid);
  expect(result.code).toBe(0);
  expect(new TextDecoder().decode(await stdout!)).toBe('hello\n');
}, T);

test('A2 relay: the coproc read fd EOFs when the child exits', async () => {
  const programs = new Map<string, Program>();
  const ECHO1 = 'ECHO1';
  // echo exactly one line then exit (its stdout EOFs).
  programs.set(ECHO1, async (api) => {
    const data = (await api.sys('pipe/read', { fd: 0, len: 4096 }) as { data: number[] }).data;
    if (data.length > 0) await api.sys('pipe/write', { fd: 1, data });
  });
  const SHELL = 'SHELL';
  programs.set(SHELL, async (api) => {
    const c = await api.sys('process/coproc', { path: 'echo1', argv: ['echo1'] });
    const { readfd, writefd } = c as { readfd: number; writefd: number };
    await api.sys('pipe/write', { fd: writefd, data: bytesOf('line\n') });
    let out = '';
    let sawEof = false;
    for (;;) {
      const s = decode(await api.sys('pipe/read', { fd: readfd, len: 4096 }));
      if (s.length === 0) { sawEof = true; break; }
      out += s;
    }
    api.stdout(bytesOf(out + (sawEof ? '[EOF]' : '[no-eof]')));
  });

  const kernel = bootKernel(programs, (n) => (n === 'echo1' ? ECHO1 : undefined));
  const { pid, stdout } = await kernel.spawn(SHELL, {
    args: ['sh'], capabilities: [{ type: 'process' }], captureStdout: true,
  });
  await kernel.wait(pid);
  expect(new TextDecoder().decode(await stdout!)).toBe('line\n[EOF]');
}, T);

test('A2 relay: coproc child pid is a real positive pid distinct from the parent', async () => {
  const programs = new Map<string, Program>();
  programs.set('CAT', async () => { /* the child need not do anything for pid check */ });
  const SHELL = 'SHELL';
  programs.set(SHELL, async (api) => {
    const c = await api.sys('process/coproc', { path: 'cat', argv: ['cat'] });
    const { pid } = c as { pid: number };
    const me = await api.sys('process/getpid', {});
    const mine = (me as { pid: number }).pid;
    api.stdout(bytesOf(pid > 0 && pid !== mine ? 'pid-ok' : 'pid-bad:' + pid));
  });
  const kernel = bootKernel(programs, (n) => (n === 'cat' ? 'CAT' : undefined));
  const { pid, stdout } = await kernel.spawn(SHELL, {
    args: ['sh'], capabilities: [{ type: 'process' }], captureStdout: true,
  });
  await kernel.wait(pid);
  expect(new TextDecoder().decode(await stdout!)).toBe('pid-ok');
}, T);

test('A2 relay: process/coproc without a process capability is denied (EPERM)', async () => {
  const programs = new Map<string, Program>();
  programs.set('CAT', async () => {});
  const SHELL = 'SHELL';
  programs.set(SHELL, async (api) => {
    try { await api.sys('process/coproc', { path: 'cat', argv: ['cat'] }); api.stdout(bytesOf('NO_ERROR')); }
    catch (e) { api.stdout(bytesOf(String((e as { code?: string }).code ?? e))); }
  });
  const kernel = bootKernel(programs, (n) => (n === 'cat' ? 'CAT' : undefined));
  const { pid, stdout } = await kernel.spawn(SHELL, {
    args: ['sh'], capabilities: [], captureStdout: true, // no process cap
  });
  await kernel.wait(pid);
  expect(new TextDecoder().decode(await stdout!)).toBe('EPERM');
}, T);

test('A2 relay: process/coproc with an unresolvable command is ENOENT', async () => {
  const programs = new Map<string, Program>();
  const SHELL = 'SHELL';
  programs.set(SHELL, async (api) => {
    try { await api.sys('process/coproc', { path: 'nope', argv: ['nope'] }); api.stdout(bytesOf('NO_ERROR')); }
    catch (e) { api.stdout(bytesOf(String((e as { code?: string }).code ?? e))); }
  });
  const kernel = bootKernel(programs, () => undefined);
  const { pid, stdout } = await kernel.spawn(SHELL, {
    args: ['sh'], capabilities: [{ type: 'process' }], captureStdout: true,
  });
  await kernel.wait(pid);
  expect(new TextDecoder().decode(await stdout!)).toBe('ENOENT');
}, T);
