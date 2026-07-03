import { expect, test, describe } from 'vitest';
import { revCommand } from './rev.ts';
import { makeIO } from './_test-io.ts';

describe('rev', () => {
  test('reverses each line', async () => {
    const h = makeIO({ args: ['rev'], stdinText: 'hello\nworld\n' });
    expect(await revCommand(h.io)).toBe(0);
    expect(h.out()).toBe('olleh\ndlrow\n');
  });

  test('adds a trailing newline to an unterminated final line (BSD parity)', async () => {
    const h = makeIO({ args: ['rev'], stdinText: 'abc' });
    expect(await revCommand(h.io)).toBe(0);
    expect(h.out()).toBe('cba\n');
  });

  test('adds a trailing newline for a multi-line unterminated input', async () => {
    const h = makeIO({ args: ['rev'], stdinText: 'abc\ndef' });
    expect(await revCommand(h.io)).toBe(0);
    expect(h.out()).toBe('cba\nfed\n');
  });

  test('adds a trailing newline for an unterminated file', async () => {
    const h = makeIO({ args: ['rev', '/f'], files: { '/f': 'cat' } });
    expect(await revCommand(h.io)).toBe(0);
    expect(h.out()).toBe('tac\n');
  });

  test('reverses file content', async () => {
    const h = makeIO({ args: ['rev', '/a'], files: { '/a': 'cat\n' } });
    expect(await revCommand(h.io)).toBe(0);
    expect(h.out()).toBe('tac\n');
  });

  test('empty input yields nothing', async () => {
    const h = makeIO({ args: ['rev'], stdinText: '' });
    expect(await revCommand(h.io)).toBe(0);
    expect(h.out()).toBe('');
  });

  test('handles unicode by code point', async () => {
    const h = makeIO({ args: ['rev'], stdinText: 'café\n' });
    expect(await revCommand(h.io)).toBe(0);
    expect(h.out()).toBe('éfac\n');
  });

  test('missing file errors and exits 1 with BSD-style message', async () => {
    const h = makeIO({ args: ['rev', '/missing'] });
    expect(await revCommand(h.io)).toBe(1);
    expect(h.err()).toBe('rev: /missing: No such file or directory\n');
  });
});
