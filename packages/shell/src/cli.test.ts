import { expect, test } from 'vitest';
import { parseCliArgs, VERSION, HELP } from './cli.ts';

test('-c executes a command string', () => {
  const r = parseCliArgs(['-c', 'echo hello'], 'sh');
  expect(r.commandString).toBe('echo hello');
  expect(r.fromStdin).toBe(false);
});

test('-c sets positional params from remaining args ($0 override + $1..)', () => {
  const r = parseCliArgs(['-c', 'echo $1 $2', 'myname', 'hello', 'world'], 'sh');
  expect(r.commandString).toBe('echo $1 $2');
  expect(r.name).toBe('myname');
  expect(r.positional).toEqual(['hello', 'world']);
});

test('-c with no argument is an error', () => {
  const r = parseCliArgs(['-c'], 'sh');
  expect(r.error).toMatch(/-c.*requires an argument/);
});

test('script file + args become positionals', () => {
  const r = parseCliArgs(['/tmp/script.sh', 'a', 'b'], 'bash');
  expect(r.scriptFile).toBe('/tmp/script.sh');
  expect(r.positional).toEqual(['a', 'b']);
});

test('no -c/file reads from stdin', () => {
  const r = parseCliArgs([], 'bash');
  expect(r.fromStdin).toBe(true);
});

test('-s reads from stdin', () => {
  const r = parseCliArgs(['-s'], 'bash');
  expect(r.fromStdin).toBe(true);
});

test('-e -u -x flags enable options', () => {
  const r = parseCliArgs(['-e', '-u', '-x', '-c', 'true'], 'bash');
  expect(r.options).toEqual(['errexit', 'nounset', 'xtrace']);
});

test('clustered -eux flags', () => {
  const r = parseCliArgs(['-eux', '-c', 'true'], 'bash');
  expect(r.options).toEqual(['errexit', 'nounset', 'xtrace']);
});

test('--posix enables POSIX mode', () => {
  const r = parseCliArgs(['--posix', '-c', 'true'], 'bash');
  expect(r.posix).toBe(true);
});

test('invocation as sh enables POSIX mode', () => {
  const r = parseCliArgs(['-c', 'true'], 'sh');
  expect(r.posix).toBe(true);
});

test('invocation as bash does not enable POSIX mode', () => {
  const r = parseCliArgs(['-c', 'true'], 'bash');
  expect(r.posix).toBe(false);
});

test('POSIXLY_CORRECT env enables POSIX mode', () => {
  const r = parseCliArgs(['-c', 'true'], 'bash', { POSIXLY_CORRECT: '1' });
  expect(r.posix).toBe(true);
});

test('--version action', () => {
  const r = parseCliArgs(['--version'], 'sh');
  expect(r.action).toBe('version');
  expect(VERSION).toContain('0.1');
});

test('--help action', () => {
  const r = parseCliArgs(['--help'], 'sh');
  expect(r.action).toBe('help');
  expect(HELP).toContain('-c');
});

test('-- ends option parsing', () => {
  const r = parseCliArgs(['--', '-e', 'arg'], 'bash');
  // After --, -e is the script file (not a flag).
  expect(r.scriptFile).toBe('-e');
  expect(r.positional).toEqual(['arg']);
  expect(r.options).toEqual([]);
});

test('invalid option is an error', () => {
  const r = parseCliArgs(['-Z'], 'bash');
  expect(r.error).toMatch(/-Z.*invalid option/);
});

test('argv0 basename is used as $0 name', () => {
  const r = parseCliArgs(['-c', 'true'], '/usr/bin/bash');
  expect(r.name).toBe('bash');
});
