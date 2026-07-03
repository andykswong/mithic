import { expect, test, describe } from 'vitest';
import { statCommand, applyFormat, permString } from './stat.ts';
import { makeIO } from './_testio.ts';
import type { StatResult } from '../fs.ts';

describe('stat format', () => {
  const st: StatResult = {
    type: 'file', size: 42, mode: 0o644, linkCount: 1,
    mtime: new Date(1_700_000_000_000), atime: new Date(0), ctime: new Date(0),
  };
  const dirSt: StatResult = { ...st, type: 'directory', mode: 0o755 };
  test('%n %s %a %F', () => {
    expect(applyFormat('%n %s %a %F', '/x', st, true)).toBe('/x 42 644 regular file');
  });
  test('%Y epoch seconds', () => {
    expect(applyFormat('%Y', '/x', st, true)).toBe('1700000000');
  });
  test('%% literal', () => {
    expect(applyFormat('100%%', '/x', st, true)).toBe('100%');
  });
  test('\\n escape', () => {
    expect(applyFormat('%n\\n', '/x', st, true)).toBe('/x\n');
  });
  test('%A perm string, %f raw mode hex, %B/%o constants, %N quoted', () => {
    expect(applyFormat('%A', '/x', st, false)).toBe('-rw-r--r--');
    expect(applyFormat('%A', '/x', dirSt, false)).toBe('drwxr-xr-x');
    expect(applyFormat('%f', '/x', st, false)).toBe('81a4'); // S_IFREG | 0644
    expect(applyFormat('%f', '/x', dirSt, false)).toBe('41ed'); // S_IFDIR | 0755
    expect(applyFormat('%B', '/x', st, false)).toBe('512');
    expect(applyFormat('%o', '/x', st, false)).toBe('4096');
    expect(applyFormat('%N', '/x', st, false)).toBe('\'/x\'');
  });
  test('%U/%G are placeholders (no ownership model)', () => {
    expect(applyFormat('%U %G', '/x', st, false)).toBe('root root');
  });
  test('permString helper', () => {
    expect(permString('file', 0o600)).toBe('-rw-------');
  });
  test('unknown directive prints ? (GNU behavior)', () => {
    expect(applyFormat('%q', '/x', st, false)).toBe('?');
  });
});

describe('stat', () => {
  test('-c format on a file', async () => {
    const h = makeIO({ args: ['stat', '-c', '%n %s', '/f'], files: { '/f': 'hello' } });
    expect(await statCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/f 5\n');
  });

  test('%F reports directory', async () => {
    const h = makeIO({ args: ['stat', '-c', '%F', '/d'] });
    await h.fs.mkdir('/d');
    await statCommand(h.io);
    expect(h.out()).toBe('directory\n');
  });

  test('default format includes File:', async () => {
    const h = makeIO({ args: ['stat', '/f'], files: { '/f': 'x' } });
    expect(await statCommand(h.io)).toBe(0);
    expect(h.out()).toContain('File: /f');
  });

  test('missing file errors, path not doubled', async () => {
    const h = makeIO({ args: ['stat', '/missing'] });
    expect(await statCommand(h.io)).toBe(1);
    // errno-derived text, no `: missing` suffix (the "operand doubled" bug).
    expect(h.err()).toBe('stat: cannot stat \'/missing\': No such file or directory\n');
  });

  test('missing operand adds Try-help line', async () => {
    const h = makeIO({ args: ['stat'] });
    expect(await statCommand(h.io)).toBe(1);
    expect(h.err()).toBe('stat: missing operand\nTry \'stat --help\' for more information.\n');
  });

  test('-c %A perm string on a file', async () => {
    const h = makeIO({ args: ['stat', '-c', '%A', '/f'], files: { '/f': { content: 'x', mode: 0o644 } } });
    expect(await statCommand(h.io)).toBe(0);
    expect(h.out()).toBe('-rw-r--r--\n');
  });

  test('--printf adds no trailing newline and interprets escapes', async () => {
    const h = makeIO({ args: ['stat', '--printf', '%s\\n', '/f'], files: { '/f': 'hello' } });
    expect(await statCommand(h.io)).toBe(0);
    expect(h.out()).toBe('5\n'); // one \n from the escape, none appended
  });

  test('--printf with two operands does not append newlines', async () => {
    const h = makeIO({ args: ['stat', '--printf', '%s', '/a', '/b'], files: { '/a': 'x', '/b': 'yy' } });
    await statCommand(h.io);
    expect(h.out()).toBe('12'); // "1" + "2", concatenated
  });

  test('-t terse emits 16 space-separated fields', async () => {
    const h = makeIO({ args: ['stat', '-t', '/f'], files: { '/f': 'hello' } });
    expect(await statCommand(h.io)).toBe(0);
    const line = h.out().replace(/\n$/, '');
    expect(line.split(' ')).toHaveLength(16);
    expect(line.startsWith('/f 5 ')).toBe(true);
  });

  test('default format shows perm string alongside octal', async () => {
    const h = makeIO({ args: ['stat', '/f'], files: { '/f': { content: 'x', mode: 0o644 } } });
    await statCommand(h.io);
    expect(h.out()).toContain('(0644/-rw-r--r--)');
  });

  test('unknown option → exit 1 with Try-help line', async () => {
    const h = makeIO({ args: ['stat', '--bogus', '/f'], files: { '/f': 'x' } });
    expect(await statCommand(h.io)).toBe(1);
    expect(h.err()).toContain('unrecognized option \'--bogus\'');
  });
});
