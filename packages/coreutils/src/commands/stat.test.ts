import { expect, test, describe } from 'vitest';
import { statCommand, applyFormat } from './stat.ts';
import { makeIO } from './_testio.ts';
import type { StatResult } from '../fs.ts';

describe('stat format', () => {
  const st: StatResult = {
    type: 'file', size: 42, mode: 0o644, linkCount: 1,
    mtime: new Date(1_700_000_000_000), atime: new Date(0), ctime: new Date(0),
  };
  test('%n %s %a %F', () => {
    expect(applyFormat('%n %s %a %F', '/x', st)).toBe('/x 42 644 regular file');
  });
  test('%Y epoch seconds', () => {
    expect(applyFormat('%Y', '/x', st)).toBe('1700000000');
  });
  test('%% literal', () => {
    expect(applyFormat('100%%', '/x', st)).toBe('100%');
  });
  test('\\n escape', () => {
    expect(applyFormat('%n\\n', '/x', st)).toBe('/x\n');
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

  test('missing file errors', async () => {
    const h = makeIO({ args: ['stat', '/missing'] });
    expect(await statCommand(h.io)).toBe(1);
    expect(h.err()).toContain('cannot stat');
  });
});
