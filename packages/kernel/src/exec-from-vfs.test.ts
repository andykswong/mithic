import { expect, test } from 'vitest';
import { Kernel } from './kernel.ts';
import { WorkerRuntime } from '@mithic/runtime/backends/worker';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';
import type { Capability } from '@mithic/protocol';
import { SECURITY_CAPABILITY_XATTR, encodeCapabilities } from '@mithic/protocol';

/**
 * Exec-from-VFS (RFC 0001 §4.2, Task S2): an absolute VFS path is no longer
 * forwarded to the launcher as a host-module specifier. The kernel reads the
 * file's bytes, requires the execute bit (`mode & 0o111`, else EACCES), strips a
 * leading `#!` line, and runs the result as guest source.
 */

// A `#!/bin/node` guest that echoes `hello from <argv0-basename>` to stdout.
const HELLO_SRC = `#!/bin/node
import { createGuest } from '@mithic/guest-runtime';
export default async (boot) => {
  const g = createGuest(boot);
  const name = (g.args[0] ?? '').split('/').pop();
  const w = g.stdout.getWriter();
  await w.write(new TextEncoder().encode('hello from ' + name));
  await w.close();
  g.exit(0);
};`;

async function makeKernel(): Promise<{ kernel: Kernel; vfs: FileSystemRouter }> {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs });
  return { kernel, vfs };
}

async function writeFile(vfs: FileSystemRouter, path: string, contents: string): Promise<void> {
  // Ensure the parent directory exists (mkdir is idempotent enough for /usr/bin).
  const dir = path.slice(0, path.lastIndexOf('/'));
  if (dir) {
    const parts = dir.split('/').filter(Boolean);
    let cur = '';
    for (const p of parts) {
      cur += '/' + p;
      try { await vfs.mkdir(cur); } catch { /* already exists */ }
    }
  }
  const fh = await vfs.open(path, { create: true, write: true, truncate: true });
  await vfs.write(fh, new TextEncoder().encode(contents), 0);
  await vfs.close(fh);
}

test('S2: spawning a +x VFS path sources the guest bytes and runs it', async () => {
  const { kernel, vfs } = await makeKernel();
  await writeFile(vfs, '/usr/bin/hello', HELLO_SRC);
  await vfs.chmod('/usr/bin/hello', 0o755);

  const { pid, stdout } = await kernel.spawn('/usr/bin/hello', {
    args: ['/usr/bin/hello'],
    captureStdout: true,
  });
  const { code } = await kernel.wait(pid);
  expect(code).toBe(0);
  expect(new TextDecoder().decode(await stdout!)).toBe('hello from hello');
}, 20000);

// A `#!/usr/bin/env node` guest: `env`'s first arg (`node`) is the real
// interpreter, so this must classify as a JS guest (Task 1) and run verbatim —
// NOT as an attempt to exec interpreter `/usr/bin/env`.
const ENV_NODE_SRC = `#!/usr/bin/env node
import { createGuest } from '@mithic/guest-runtime';
export default async (boot) => {
  const g = createGuest(boot);
  const w = g.stdout.getWriter();
  await w.write(new TextEncoder().encode('ok'));
  await w.close();
  g.exit(0);
};`;

test('S2: a #!/usr/bin/env node script runs as a JS guest (env arg honored)', async () => {
  const { kernel, vfs } = await makeKernel();
  await writeFile(vfs, '/usr/bin/envnode', ENV_NODE_SRC);
  await vfs.chmod('/usr/bin/envnode', 0o755);

  const { pid, stdout } = await kernel.spawn('/usr/bin/envnode', {
    args: ['/usr/bin/envnode'],
    captureStdout: true,
  });
  const { code } = await kernel.wait(pid);
  expect(code).toBe(0);
  expect(new TextDecoder().decode(await stdout!)).toBe('ok');
}, 20000);

test('S2: spawning a VFS path WITHOUT the execute bit fails EACCES', async () => {
  const { kernel, vfs } = await makeKernel();
  await writeFile(vfs, '/usr/bin/noexec', HELLO_SRC); // default mode 0o644, no +x

  await expect(
    kernel.spawn('/usr/bin/noexec', { args: ['/usr/bin/noexec'], captureStdout: true }),
  ).rejects.toMatchObject({ errno: 'EACCES' });
}, 20000);

test('S2: spawning a non-existent VFS path fails ENOENT', async () => {
  const { kernel } = await makeKernel();
  await expect(
    kernel.spawn('/usr/bin/ghost', { args: ['/usr/bin/ghost'], captureStdout: true }),
  ).rejects.toMatchObject({ errno: 'ENOENT' });
}, 20000);

test('S2: a guest sourced from VFS runs even when its file has no leading shebang', async () => {
  const { kernel, vfs } = await makeKernel();
  const noShebang = HELLO_SRC.slice(HELLO_SRC.indexOf('\n') + 1); // drop the `#!/bin/node` line
  await writeFile(vfs, '/usr/bin/plain', noShebang);
  await vfs.chmod('/usr/bin/plain', 0o755);

  const { pid, stdout } = await kernel.spawn('/usr/bin/plain', {
    args: ['/usr/bin/plain'],
    captureStdout: true,
  });
  const { code } = await kernel.wait(pid);
  expect(code).toBe(0);
  expect(new TextDecoder().decode(await stdout!)).toBe('hello from plain');
}, 20000);

test('S2: a non-path host-module string spawn is unchanged (inline source still runs)', async () => {
  const { kernel } = await makeKernel();
  const { pid, stdout } = await kernel.spawn(HELLO_SRC.slice(HELLO_SRC.indexOf('\n') + 1), {
    args: ['inline'],
    captureStdout: true,
  });
  const { code } = await kernel.wait(pid);
  expect(code).toBe(0);
  expect(new TextDecoder().decode(await stdout!)).toBe('hello from inline');
}, 20000);

/**
 * S3 (RFC 0001 §4.2/§4.8): a BARE NAME resolves via `$PATH` to a VFS file; the
 * shebang dispatches guest-vs-interpreter; the file's `security.capability`
 * xattr supplies the requested caps, NARROWED against the parent.
 */

// A guest that prints the FIRST capability type it holds (proves caps reached
// the child) by reading a granted file and echoing its bytes, or 'DENIED' if the
// read is refused. `g.args[1]` is the VFS path to read.
const READ_PROBE_SRC = `#!/bin/node
import { createGuest } from '@mithic/guest-runtime';
export default async (boot) => {
  const g = createGuest(boot);
  const w = g.stdout.getWriter();
  try {
    const o = await g.syscall('fs/open', { path: g.args[1], oflags: { read: true } });
    const data = await g.syscall('fs/read', { fd: o.fd, len: 4096 });
    await g.syscall('fs/close', { fd: o.fd });
    await w.write(new Uint8Array(data));
  } catch (e) {
    await w.write(new TextEncoder().encode('READ-DENIED:' + (e.code || e.errno || e.message)));
  }
  await w.close();
  g.exit(0);
};`;

// A guest that attempts a net/fetch and reports the errno (or 'OK').
const NET_PROBE_SRC = `#!/bin/node
import { createGuest } from '@mithic/guest-runtime';
export default async (boot) => {
  const g = createGuest(boot);
  const w = g.stdout.getWriter();
  let result = 'OK';
  try { await g.syscall('net/fetch', { method: 'GET', url: 'https://example.com/' }); }
  catch (e) { result = 'NET:' + (e.code || e.errno || e.message); }
  await w.write(new TextEncoder().encode(result));
  await w.close();
  g.exit(0);
};`;

async function setCaps(
  vfs: FileSystemRouter,
  path: string,
  caps: Capability[],
): Promise<void> {
  await vfs.setxattr(path, SECURITY_CAPABILITY_XATTR, encodeCapabilities(caps));
}

test('S3: a bare name resolves via $PATH to a +x VFS file and runs', async () => {
  const { kernel, vfs } = await makeKernel();
  await writeFile(vfs, '/usr/bin/greet', HELLO_SRC);
  await vfs.chmod('/usr/bin/greet', 0o755);

  const { pid, stdout } = await kernel.spawn('greet', {
    args: ['greet'],
    env: { PATH: '/usr/bin' },
    captureStdout: true,
  });
  const { code } = await kernel.wait(pid);
  expect(code).toBe(0);
  expect(new TextDecoder().decode(await stdout!)).toBe('hello from greet');
}, 20000);

test('S3: a bare name with no $PATH match is unresolved (treated as a host-module spec)', async () => {
  const { kernel } = await makeKernel();
  // No PATH set + no VFS file → the name is not a VFS path; it falls through to
  // the launcher as a module specifier, which cannot resolve → the process crashes.
  await expect(
    kernel.spawn('nonesuch', { args: ['nonesuch'], env: { PATH: '/usr/bin' }, captureStdout: true }),
  ).rejects.toBeDefined();
}, 20000);

test('S3: a bare name searches $PATH dirs in order, first match wins', async () => {
  const { kernel, vfs } = await makeKernel();
  await writeFile(vfs, '/sbin/greet', HELLO_SRC.replace('hello from', 'SBIN'));
  await vfs.chmod('/sbin/greet', 0o755);
  await writeFile(vfs, '/usr/bin/greet', HELLO_SRC.replace('hello from', 'USRBIN'));
  await vfs.chmod('/usr/bin/greet', 0o755);

  const { pid, stdout } = await kernel.spawn('greet', {
    args: ['greet'],
    env: { PATH: '/sbin:/usr/bin' },
    captureStdout: true,
  });
  await kernel.wait(pid);
  expect(new TextDecoder().decode(await stdout!)).toBe('SBIN greet');
}, 20000);

test('S3: caps come from the file xattr — the guest can read a granted path', async () => {
  const { kernel, vfs } = await makeKernel();
  await writeFile(vfs, '/in', 'granted-bytes');
  await writeFile(vfs, '/usr/bin/needsfs', READ_PROBE_SRC);
  await vfs.chmod('/usr/bin/needsfs', 0o755);
  await setCaps(vfs, '/usr/bin/needsfs', [{ type: 'fs', paths: ['/in'], operations: ['read'] }]);

  // ppid 0 (kernel spawn): the xattr caps are granted verbatim (no parent narrow).
  const { pid, stdout } = await kernel.spawn('/usr/bin/needsfs', {
    args: ['needsfs', '/in'],
    captureStdout: true,
  });
  await kernel.wait(pid);
  expect(new TextDecoder().decode(await stdout!)).toBe('granted-bytes');
}, 20000);

test('S3: a path the xattr does NOT grant is denied (default-deny outside the grant)', async () => {
  const { kernel, vfs } = await makeKernel();
  await writeFile(vfs, '/in', 'in-bytes');
  await writeFile(vfs, '/secret', 'secret-bytes');
  await writeFile(vfs, '/usr/bin/needsfs', READ_PROBE_SRC);
  await vfs.chmod('/usr/bin/needsfs', 0o755);
  await setCaps(vfs, '/usr/bin/needsfs', [{ type: 'fs', paths: ['/in'], operations: ['read'] }]);

  const { pid, stdout } = await kernel.spawn('/usr/bin/needsfs', {
    args: ['needsfs', '/secret'],
    captureStdout: true,
  });
  await kernel.wait(pid);
  expect(new TextDecoder().decode(await stdout!)).toContain('READ-DENIED');
}, 20000);

test('S3: a guest without a declared net cap is denied net/fetch (EACCES)', async () => {
  const { kernel, vfs } = await makeKernel();
  await writeFile(vfs, '/usr/bin/fetcher', NET_PROBE_SRC);
  await vfs.chmod('/usr/bin/fetcher', 0o755);
  // xattr grants fs only — no net.
  await setCaps(vfs, '/usr/bin/fetcher', [{ type: 'fs', paths: ['/'], operations: ['read'] }]);

  const { pid, stdout } = await kernel.spawn('/usr/bin/fetcher', {
    args: ['fetcher'],
    captureStdout: true,
  });
  await kernel.wait(pid);
  expect(new TextDecoder().decode(await stdout!)).toBe('NET:EACCES');
}, 20000);

test('S3: a file with NO xattr requests no caps (default-deny) — net is denied', async () => {
  const { kernel, vfs } = await makeKernel();
  await writeFile(vfs, '/usr/bin/fetcher', NET_PROBE_SRC);
  await vfs.chmod('/usr/bin/fetcher', 0o755);
  // No setCaps call: no security.capability xattr at all.

  const { pid, stdout } = await kernel.spawn('/usr/bin/fetcher', {
    args: ['fetcher'],
    captureStdout: true,
  });
  await kernel.wait(pid);
  expect(new TextDecoder().decode(await stdout!)).toBe('NET:EACCES');
}, 20000);

test('S3: a child cannot elevate beyond its parent — an xattr net request narrows away', async () => {
  const { kernel, vfs } = await makeKernel();
  // The utility's xattr REQUESTS net (and fs read), but the parent shell holds
  // only fs read + process. A child can only ever narrow → the net request must
  // be rejected at spawn time (capabilities.narrow throws on an excess request).
  await writeFile(vfs, '/usr/bin/overreach', NET_PROBE_SRC);
  await vfs.chmod('/usr/bin/overreach', 0o755);
  await setCaps(vfs, '/usr/bin/overreach', [
    { type: 'net', origins: ['https://example.com'] },
    { type: 'fs', paths: ['/'], operations: ['read'] },
  ]);

  // Drive the dispatcher with a parent pid that lacks net (holds fs read + process).
  const parentPid = kernel.processes.allocate(0);
  kernel.processes.markReady(parentPid);
  kernel.capabilities.grant(parentPid, [
    { type: 'process' },
    { type: 'fs', paths: ['/'], operations: ['read'] },
  ]);

  const { response } = await kernel.dispatcher.dispatch(parentPid, {
    id: 1,
    call: 'process/spawn',
    args: { path: '/usr/bin/overreach', argv: ['overreach'] },
  });
  // The spawn fails because the xattr-requested net cap exceeds the parent grant.
  expect(response.ok).toBe(false);
}, 20000);

// A guest that reads argv[1] and writes either its bytes or 'READ-DENIED:<code>'
// to argv[2] (a VFS path), so the outcome survives the child's exit for the test
// to read back (child-spawn stdout isn't captured through the dispatcher).
const READ_TO_FILE_SRC = `#!/bin/node
import { createGuest } from '@mithic/guest-runtime';
export default async (boot) => {
  const g = createGuest(boot);
  let outcome;
  try {
    const o = await g.syscall('fs/open', { path: g.args[1], oflags: { read: true } });
    const data = await g.syscall('fs/read', { fd: o.fd, len: 4096 });
    await g.syscall('fs/close', { fd: o.fd });
    outcome = new TextDecoder().decode(new Uint8Array(data));
  } catch (e) {
    outcome = 'READ-DENIED:' + (e.code || e.errno || e.message);
  }
  const w = await g.syscall('fs/open', { path: g.args[2], oflags: { write: true, create: true, truncate: true } });
  await g.syscall('fs/write', { fd: w.fd, data: new TextEncoder().encode(outcome) });
  await g.syscall('fs/close', { fd: w.fd });
  g.exit(0);
};`;

test('FIX-A: for a bare name in BOTH the registry and $PATH, the VFS file (and its xattr caps) WINS over resolveCommand', async () => {
  // RFC 0001 §4.2 mandates builtins → $PATH→VFS-file → host/special; the VFS file
  // REPLACES the per-command registry. The dispatcher's #resolveCode previously
  // inverted this (registry FIRST), so an installed utility whose name ALSO appears
  // in the registry resolved to the in-process sentinel — the kernel never read its
  // `security.capability` xattr and it ran with the PARENT's broad caps (D7/§4.8
  // silently defeated). This drives the SYSCALL spawn path a workflow shell uses.
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());

  await writeFile(vfs, '/secret', 'secret-bytes');
  await vfs.mkdir('/out').catch(() => {});
  // The installed utility: a +x VFS file whose xattr grants ONLY /secret-excluding
  // reads — fs:read on /in and fs:write on /out, NOT /secret.
  await writeFile(vfs, '/usr/bin/probe', READ_TO_FILE_SRC);
  await vfs.chmod('/usr/bin/probe', 0o755);
  await setCaps(vfs, '/usr/bin/probe', [
    { type: 'fs', paths: ['/in'], operations: ['read'] },
    { type: 'fs', paths: ['/out'], operations: ['read', 'write'] },
  ]);

  // `probe` ALSO exists in the registry, returning the SAME source inline (a
  // non-sentinel string → default launcher → runs verbatim with the PARENT-narrowed
  // caps, i.e. the broad '/' grant). If the registry won, the read of /secret would
  // SUCCEED; with PATH-first, the file's xattr (no /secret) governs → READ-DENIED.
  const kernel = new Kernel({
    runtime: new WorkerRuntime(),
    vfs,
    resolveCommand: (name) =>
      name === 'probe' ? READ_TO_FILE_SRC.slice(READ_TO_FILE_SRC.indexOf('\n') + 1) : undefined,
  });

  const parentPid = kernel.processes.allocate(0);
  kernel.processes.markReady(parentPid);
  // The PARENT holds fs:read+write on ALL of '/' — strictly broader than the xattr.
  kernel.capabilities.grant(parentPid, [
    { type: 'process' },
    { type: 'fs', paths: ['/'], operations: ['read', 'write', 'execute'] },
  ]);

  const { response } = await kernel.dispatcher.dispatch(parentPid, {
    id: 1,
    call: 'process/spawn',
    args: { path: 'probe', argv: ['probe', '/secret', '/out/result'], env: { PATH: '/usr/bin' } },
  });
  expect(response.ok).toBe(true);
  const childPid = (response as { result: { pid: number } }).result.pid;
  await kernel.wait(childPid);

  // The VFS file's xattr (no /secret) governs the child, NOT the parent's '/': the
  // read of /secret is DENIED even though the parent could read it.
  const fh = await vfs.open('/out/result', { read: true });
  const bytes = await vfs.read(fh, 0, 4096);
  await vfs.close(fh);
  expect(new TextDecoder().decode(bytes)).toContain('READ-DENIED');
}, 20000);

test('S3: a guest-issued process/spawn resolves a BARE NAME via $PATH (no resolveCommand needed)', async () => {
  // The bug Task V4 surfaced: the syscall spawn path returned ENOENT for a bare
  // name when `resolveCommand` (host/special + registered commands) missed —
  // even when the name resolved to a +x VFS file via $PATH. A workflow shell
  // (itself a guest) spawns its utility steps by BARE NAME through this very
  // syscall, so PATH→VFS resolution must happen here, not only in kernel.spawn.
  const { kernel, vfs } = await makeKernel(); // NB: no resolveCommand wired
  await writeFile(vfs, '/usr/bin/greet', HELLO_SRC);
  await vfs.chmod('/usr/bin/greet', 0o755);

  const parentPid = kernel.processes.allocate(0);
  kernel.processes.markReady(parentPid);
  kernel.capabilities.grant(parentPid, [
    { type: 'process' },
    { type: 'fs', paths: ['/'], operations: ['read', 'write', 'execute'] },
  ]);

  const { response } = await kernel.dispatcher.dispatch(parentPid, {
    id: 1,
    call: 'process/spawn',
    args: { path: 'greet', argv: ['greet'], env: { PATH: '/usr/bin' } },
  });
  expect(response.ok).toBe(true);
}, 20000);

test('S3: a guest-issued process/spawn of a bare name with NO $PATH match still fails ENOENT', async () => {
  const { kernel } = await makeKernel();
  const parentPid = kernel.processes.allocate(0);
  kernel.processes.markReady(parentPid);
  kernel.capabilities.grant(parentPid, [{ type: 'process' }, { type: 'fs', paths: ['/'], operations: ['read'] }]);

  const { response } = await kernel.dispatcher.dispatch(parentPid, {
    id: 1,
    call: 'process/spawn',
    args: { path: 'nope', argv: ['nope'], env: { PATH: '/usr/bin' } },
  });
  expect(response.ok).toBe(false);
  expect((response as { error?: { code?: string } }).error?.code).toBe('ENOENT');
}, 20000);

/**
 * FIX-B (SE-1/TC-2): the interpreter-chain re-resolution must be bounded
 * binfmt-style (Linux caps at BINPRM_MAX_RECURSION). A shebang CYCLE or a chain
 * deeper than the cap must yield a bounded ELOOP error, never unbounded
 * recursion (stack overflow / hang).
 */

// A real interpreter guest at an absolute path. `#!/bin/node` makes it a guest
// (the chain TERMINATES here); it echoes the script path it was handed.
const TERMINAL_INTERP = `#!/bin/node
import { createGuest } from '@mithic/guest-runtime';
export default async (boot) => {
  const g = createGuest(boot);
  const w = g.stdout.getWriter();
  await w.write(new TextEncoder().encode('ran ' + g.args[1]));
  await w.close();
  g.exit(0);
};`;

test('FIX-B: a 2-file shebang CYCLE yields a bounded ELOOP, not a hang', async () => {
  const { kernel, vfs } = await makeKernel();
  // /bin/a is an interpreter pointing at /bin/b; /bin/b points back at /bin/a.
  // Each re-resolution flips to the other → unbounded recursion without a guard.
  await writeFile(vfs, '/bin/a', '#!/bin/b\n');
  await vfs.chmod('/bin/a', 0o755);
  await writeFile(vfs, '/bin/b', '#!/bin/a\n');
  await vfs.chmod('/bin/b', 0o755);
  await writeFile(vfs, '/usr/bin/script', '#!/bin/a\nbody\n');
  await vfs.chmod('/usr/bin/script', 0o755);

  await expect(
    kernel.spawn('/usr/bin/script', { args: ['/usr/bin/script'], captureStdout: true }),
  ).rejects.toMatchObject({ errno: 'ELOOP' });
  // Tight timeout: a regression (no guard) blows the stack or hangs rather than
  // returning, so this test would FAIL instead of passing slowly.
}, 5000);

test('FIX-B: a legitimate 2-level interpreter chain (within the cap) still runs', async () => {
  const { kernel, vfs } = await makeKernel();
  // script → #!/bin/wrap → #!/bin/node (terminal). Two interpreter hops, well
  // under the cap, so the chain resolves and the terminal interpreter runs.
  await writeFile(vfs, '/bin/wrap', TERMINAL_INTERP);
  await vfs.chmod('/bin/wrap', 0o755);
  await writeFile(vfs, '/usr/bin/script', '#!/bin/wrap\nbody\n');
  await vfs.chmod('/usr/bin/script', 0o755);

  const { pid, stdout } = await kernel.spawn('/usr/bin/script', {
    args: ['/usr/bin/script'],
    captureStdout: true,
  });
  const { code } = await kernel.wait(pid);
  expect(code).toBe(0);
  expect(new TextDecoder().decode(await stdout!)).toBe('ran /usr/bin/script');
}, 20000);

test('FIX-B: the cap boundary — a chain AT the limit runs, one PAST it errors ELOOP', async () => {
  // Build a straight chain of interpreter hops: /bin/i0 → /bin/i1 → … each a
  // shebang pointing at the next, terminating at a real /bin/node guest. The
  // number of interpreter re-resolutions equals the chain length.
  const MAX_INTERPRETER_DEPTH = 8;

  async function runChain(hops: number): Promise<void> {
    const { kernel, vfs } = await makeKernel();
    // /bin/i{n} → /bin/i{n+1}; the last link is the terminal #!/bin/node guest.
    for (let i = 0; i < hops; i++) {
      const next = i === hops - 1 ? TERMINAL_INTERP : `#!/bin/i${i + 1}\n`;
      await writeFile(vfs, `/bin/i${i}`, next);
      await vfs.chmod(`/bin/i${i}`, 0o755);
    }
    await writeFile(vfs, '/usr/bin/script', '#!/bin/i0\nbody\n');
    await vfs.chmod('/usr/bin/script', 0o755);
    const { pid } = await kernel.spawn('/usr/bin/script', {
      args: ['/usr/bin/script'],
      captureStdout: true,
    });
    const { code } = await kernel.wait(pid);
    expect(code).toBe(0);
  }

  // The first re-resolution is the script's own #!/bin/i0 (hop 1); each /bin/i{n}
  // shebang adds another. A chain whose interpreter re-resolutions exactly reach
  // the cap must still run; one more hop must error ELOOP.
  await runChain(MAX_INTERPRETER_DEPTH - 1);

  const { kernel, vfs } = await makeKernel();
  const over = MAX_INTERPRETER_DEPTH + 2;
  for (let i = 0; i < over; i++) {
    const next = i === over - 1 ? TERMINAL_INTERP : `#!/bin/i${i + 1}\n`;
    await writeFile(vfs, `/bin/i${i}`, next);
    await vfs.chmod(`/bin/i${i}`, 0o755);
  }
  await writeFile(vfs, '/usr/bin/script', '#!/bin/i0\nbody\n');
  await vfs.chmod('/usr/bin/script', 0o755);
  await expect(
    kernel.spawn('/usr/bin/script', { args: ['/usr/bin/script'], captureStdout: true }),
  ).rejects.toMatchObject({ errno: 'ELOOP' });
}, 20000);

test('S3: a #!/bin/bash file classifies as an interpreter dispatch (re-resolved against $PATH)', async () => {
  const { kernel, vfs } = await makeKernel();
  // Provide a tiny `bash` interpreter guest at /bin/bash that echoes the script
  // path it was handed (argv[1]) — proving the interpreter re-resolution + the
  // script-path-prepended argv. (Real /bin/bash → @mithic/shell wiring is Phase V.)
  const FAKE_BASH = `#!/bin/node
import { createGuest } from '@mithic/guest-runtime';
export default async (boot) => {
  const g = createGuest(boot);
  const w = g.stdout.getWriter();
  await w.write(new TextEncoder().encode('bash ran ' + g.args[1]));
  await w.close();
  g.exit(0);
};`;
  await writeFile(vfs, '/bin/bash', FAKE_BASH);
  await vfs.chmod('/bin/bash', 0o755);
  await writeFile(vfs, '/usr/bin/workflow', '#!/bin/bash\nset -e\necho hi\n');
  await vfs.chmod('/usr/bin/workflow', 0o755);

  const { pid, stdout } = await kernel.spawn('workflow', {
    args: ['workflow'],
    env: { PATH: '/usr/bin:/bin' },
    captureStdout: true,
  });
  await kernel.wait(pid);
  expect(new TextDecoder().decode(await stdout!)).toBe('bash ran /usr/bin/workflow');
}, 20000);
