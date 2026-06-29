/* eslint-disable @typescript-eslint/no-explicit-any -- the comparison harness drives a minimal mock kernel */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { Executor } from '../executor.ts';

// NODE-ONLY harness. `node:child_process` / `node:fs` are imported here and MUST
// NOT reach a browser bundle. This module is imported only by *.comparison.test.ts,
// which is matched by the vitest `node` project (packages/shell/src/**/*.test.ts)
// and never by the browser project (which matches *.browser.test.ts only).
//
// This is shell-LANGUAGE comparison (builtins, parameter expansion, arithmetic,
// control flow, POSIX mode) — NOT spawned-command comparison. The mock kernel's
// spawn/wait are stubs that always exit children 0, so every comparison case MUST
// be builtin/expansion-only (echo, printf, param expansion, arithmetic, loops,
// brace expansion). External commands (ls/grep/etc.) would hit the stub and never
// match bash. Command-level (coreutils) comparison is a separate future harness.
//
// FIXTURE PROVENANCE: the committed fixtures/*.json were recorded against the
// /bin/bash on the recording host. The local dev machine is macOS bash 3.2, which
// LACKS bash-4+ features (`${s^^}`, mapfile, read -a, associative arrays). Fixtures
// SHOULD be (re)recorded on the CI bash version (newer) via RECORD_FIXTURES=1, and
// any bash-4+ case MUST be recorded on a bash-4+ host (see BASH4 note below).

const RECORD = process.env.RECORD_FIXTURES === '1';
const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

interface Fixture {
  src: string;
  stdout: string;
  stderr: string;
  code: number;
}

/** Run `src` through mithic's Executor (mock kernel) → captured {stdout, code}. */
async function runMithic(src: string, posix = false): Promise<{ stdout: string; code: number }> {
  let out = '';
  // Minimal mock kernel: no external spawns — comparison cases must be builtin-only.
  const k = {
    async spawn() { return { pid: 1 }; },
    async wait(p: number) { return { pid: p, code: 0 }; },
  };
  const ex = new Executor(k as any, { cwd: '/', env: {} } as any, {
    onStdout: (s: string) => { out += s; },
    onStderr: () => {},
    resolve: (n: string) => n,
  });
  if (posix) ex.setOption('posix', true);
  const code = await ex.exec(src);
  return { stdout: out, code: code ?? 0 };
}

/** Record one fixture by shelling out to real /bin/bash. Node-only; gated by RECORD. */
function recordWithBash(file: string, src: string, posix: boolean): void {
  if (!existsSync(FIX_DIR)) mkdirSync(FIX_DIR, { recursive: true });
  const args = posix ? ['--posix', '-c', src] : ['-c', src];
  let stdout = '';
  let stderr = '';
  let code = 0;
  try {
    stdout = execFileSync('/bin/bash', args, { encoding: 'utf8' });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    stdout = err.stdout ?? '';
    stderr = err.stderr ?? '';
    code = err.status ?? 1;
  }
  const fixture: Fixture = { src, stdout, stderr, code };
  writeFileSync(file, JSON.stringify(fixture, null, 2) + '\n');
}

/**
 * Assert mithic's output for `src` matches a golden /bin/bash fixture.
 * RECORD_FIXTURES=1 (re)records the fixture from real bash; otherwise replays.
 * Compares STDOUT only (the mock kernel always exits children 0, so exit-code
 * comparison is opt-in and not done here). Cases MUST be builtin/expansion-only.
 */
export async function compareWithBash(
  name: string,
  src: string,
  opts: { posix?: boolean } = {},
): Promise<void> {
  const file = join(FIX_DIR, `${name}.json`);
  if (RECORD) {
    recordWithBash(file, src, opts.posix ?? false);
    return;
  }
  const golden = JSON.parse(readFileSync(file, 'utf8')) as Fixture;
  const got = await runMithic(src, opts.posix);
  expect(got.stdout, `stdout mismatch for "${name}" (src: ${src})`).toBe(golden.stdout);
}

/**
 * Like compareWithBash, but for cases that exercise bash-4+ features (e.g. case
 * modification `${s^^}`). On the local macOS bash 3.2 these produce a "bad
 * substitution" error, so RECORD_FIXTURES=1 here is REFUSED unless RECORD_BASH4=1
 * is also set (signalling a bash-4+ host). The committed fixtures for these cases
 * are hand-recorded from known bash-5 output; do NOT let a 3.2 recording overwrite
 * them with wrong golden output. Replay still asserts mithic matches the golden.
 */
export async function compareWithBash4(
  name: string,
  src: string,
  opts: { posix?: boolean } = {},
): Promise<void> {
  const file = join(FIX_DIR, `${name}.json`);
  if (RECORD) {
    if (process.env.RECORD_BASH4 !== '1') {
      // Refuse to record on the (likely bash 3.2) default host — would encode
      // a "bad substitution" error as golden. Re-record on bash 4+ with
      // RECORD_FIXTURES=1 RECORD_BASH4=1.
      return;
    }
    recordWithBash(file, src, opts.posix ?? false);
    return;
  }
  const golden = JSON.parse(readFileSync(file, 'utf8')) as Fixture;
  const got = await runMithic(src, opts.posix);
  expect(got.stdout, `stdout mismatch for "${name}" (src: ${src})`).toBe(golden.stdout);
}
