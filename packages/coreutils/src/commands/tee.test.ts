import { expect, test, describe } from 'vitest';
import { teeCommand } from './tee.ts';
import { makeIO } from './_test-io.ts';

describe('tee', () => {
  test('copies stdin to stdout and to a file', async () => {
    const h = makeIO({ args: ['tee', '/out.txt'], stdinText: 'hello\n' });
    expect(await teeCommand(h.io)).toBe(0);
    expect(h.out()).toBe('hello\n');
    expect(h.file('/out.txt')).toBe('hello\n');
  });

  test('writes to multiple files', async () => {
    const h = makeIO({ args: ['tee', '/a', '/b'], stdinText: 'data\n' });
    expect(await teeCommand(h.io)).toBe(0);
    expect(h.file('/a')).toBe('data\n');
    expect(h.file('/b')).toBe('data\n');
    expect(h.out()).toBe('data\n');
  });

  test('truncates existing file by default', async () => {
    const h = makeIO({ args: ['tee', '/a'], stdinText: 'new\n', files: { '/a': 'old content\n' } });
    expect(await teeCommand(h.io)).toBe(0);
    expect(h.file('/a')).toBe('new\n');
  });

  test('-a appends', async () => {
    const h = makeIO({ args: ['tee', '-a', '/a'], stdinText: 'more\n', files: { '/a': 'first\n' } });
    expect(await teeCommand(h.io)).toBe(0);
    expect(h.file('/a')).toBe('first\nmore\n');
  });

  test('no file args just passes stdin through', async () => {
    const h = makeIO({ args: ['tee'], stdinText: 'passthrough\n' });
    expect(await teeCommand(h.io)).toBe(0);
    expect(h.out()).toBe('passthrough\n');
  });
});
