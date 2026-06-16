import { expect, test } from 'vitest';
import { runScript } from './index.ts';

test('echo hello | cat produces hello through the real shell', async () => {
  const out = await runScript('echo hello | cat');
  expect(out.stdout.trim()).toBe('hello');
  expect(out.code).toBe(0);
}, 20000);

test('variable assignment and expansion', async () => {
  const out = await runScript('FOO=world; echo $FOO');
  expect(out.stdout.trim()).toBe('world');
}, 20000);

// ── External-command spawning (process/spawn family) ────────────────────────
//
// These prove the NO_SPAWN limitation is FIXED: a NON-builtin command runs as a
// forked CHILD process via process/spawn, and a pipeline of two external
// commands runs through process/pipeline (NOT the in-process builtin path).

// An external `xcat`: copies stdin → stdout (so it's NOT a shell builtin).
const XCAT = `import { createGuest } from '@mithic/guest-runtime';
  export default async (boot) => {
    const g = createGuest(boot);
    let s = ''; const rd = g.stdin.getReader();
    for (;;) { const { value, done } = await rd.read(); if (done) break; s += new TextDecoder().decode(value); }
    const w = g.stdout.getWriter(); await w.write(new TextEncoder().encode(s)); await w.close();
    g.exit(0);
  };`;

// An external `xupper`: uppercases stdin → stdout.
const XUPPER = `import { createGuest } from '@mithic/guest-runtime';
  export default async (boot) => {
    const g = createGuest(boot);
    let s = ''; const rd = g.stdin.getReader();
    for (;;) { const { value, done } = await rd.read(); if (done) break; s += new TextDecoder().decode(value); }
    const w = g.stdout.getWriter(); await w.write(new TextEncoder().encode(s.toUpperCase())); await w.close();
    g.exit(0);
  };`;

// An external `xargs-echo`: writes its argv[1..] joined by spaces (a producer).
const XECHO = `import { createGuest } from '@mithic/guest-runtime';
  export default async (boot) => {
    const g = createGuest(boot);
    const w = g.stdout.getWriter(); await w.write(new TextEncoder().encode(g.args.slice(1).join(' '))); await w.close();
    g.exit(0);
  };`;

test('a single EXTERNAL command spawns a child and its stdout reaches the shell', async () => {
  const out = await runScript('xecho spawned output', { commands: { xecho: XECHO } });
  expect(out.stdout).toBe('spawned output');
  expect(out.code).toBe(0);
}, 20000);

test('external | external pipeline runs through process/spawn (not builtins)', async () => {
  // `xecho` and `xupper` are external (non-builtin) — this pipeline can ONLY run
  // by forking children through the kernel's process syscalls.
  const out = await runScript('xecho hello world | xupper', {
    commands: { xecho: XECHO, xupper: XUPPER },
  });
  expect(out.stdout).toBe('HELLO WORLD');
  expect(out.code).toBe(0);
}, 20000);

test('three-stage external pipeline: xecho | xcat | xupper', async () => {
  const out = await runScript('xecho mixed case | xcat | xupper', {
    commands: { xecho: XECHO, xcat: XCAT, xupper: XUPPER },
  });
  expect(out.stdout).toBe('MIXED CASE');
  expect(out.code).toBe(0);
}, 20000);

test('an unknown external command reports command-not-found behavior', async () => {
  // No commands registered: `nope` resolves to nothing → kernel ENOENT.
  const out = await runScript('nope', { commands: {} });
  // The pipeline/spawn surfaces a non-zero status for an unresolved command.
  expect(out.code).not.toBe(0);
}, 20000);
