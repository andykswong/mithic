import { expect, test, describe } from 'vitest';
import { findCommand, globToRegExp, pathGlobToRegExp } from './find.ts';
import { makeIO, type SpawnRecord } from './_testio.ts';

describe('find glob', () => {
  test('* matches within a component', () => {
    expect(globToRegExp('*.txt').test('a.txt')).toBe(true);
    expect(globToRegExp('*.txt').test('a.md')).toBe(false);
  });
  test('? matches one char', () => {
    expect(globToRegExp('?.c').test('a.c')).toBe(true);
    expect(globToRegExp('?.c').test('ab.c')).toBe(false);
  });
  test('character class', () => {
    expect(globToRegExp('[ab].x').test('a.x')).toBe(true);
    expect(globToRegExp('[ab].x').test('c.x')).toBe(false);
  });
});

const files = { '/r/a.txt': '1', '/r/b.md': '2', '/r/sub/c.txt': '3', '/r/sub/deep/d.txt': '4' };

describe('find', () => {
  test('prints everything under the start path', async () => {
    const h = makeIO({ args: ['find', '/r'], files });
    expect(await findCommand(h.io)).toBe(0);
    const lines = h.out().trim().split('\n');
    expect(lines).toContain('/r');
    expect(lines).toContain('/r/a.txt');
    expect(lines).toContain('/r/sub/deep/d.txt');
  });

  test('-name filters by glob', async () => {
    const h = makeIO({ args: ['find', '/r', '-name', '*.txt'], files });
    await findCommand(h.io);
    const lines = h.out().trim().split('\n');
    expect(lines).toEqual(['/r/a.txt', '/r/sub/c.txt', '/r/sub/deep/d.txt']);
  });

  test('-type d lists only directories', async () => {
    const h = makeIO({ args: ['find', '/r', '-type', 'd'], files });
    await findCommand(h.io);
    const lines = h.out().trim().split('\n');
    expect(lines).toEqual(['/r', '/r/sub', '/r/sub/deep']);
  });

  test('-maxdepth limits descent', async () => {
    const h = makeIO({ args: ['find', '/r', '-maxdepth', '1'], files });
    await findCommand(h.io);
    expect(h.out()).not.toContain('/r/sub/c.txt');
    expect(h.out()).toContain('/r/a.txt');
  });

  test('-mindepth skips shallow entries', async () => {
    const h = makeIO({ args: ['find', '/r', '-mindepth', '2'], files });
    await findCommand(h.io);
    expect(h.out()).not.toContain('/r/a.txt');
    expect(h.out()).toContain('/r/sub/c.txt');
  });

  test('unknown predicate errors', async () => {
    const h = makeIO({ args: ['find', '/r', '-bogus'], files });
    expect(await findCommand(h.io)).toBe(1);
  });
});

// ── M21: -path / -iname cross-slash glob ────────────────────────────────────

describe('find -path glob (cross-slash)', () => {
  test('pathGlobToRegExp: * crosses / for whole-path matching', () => {
    // The whole-path glob `*` must match across `/`, unlike -name's per-component glob.
    expect(pathGlobToRegExp('/r/*/c.txt').test('/r/sub/c.txt')).toBe(true);
    expect(pathGlobToRegExp('*/d.txt').test('/r/sub/deep/d.txt')).toBe(true);
    expect(pathGlobToRegExp('/r/a.txt').test('/r/a.txt')).toBe(true);
  });

  test('-path matches deep paths with * crossing /', async () => {
    const h = makeIO({ args: ['find', '/r', '-path', '*sub*'], files });
    expect(await findCommand(h.io)).toBe(0);
    const lines = h.out().trim().split('\n').sort();
    expect(lines).toContain('/r/sub');
    expect(lines).toContain('/r/sub/c.txt');
    expect(lines).toContain('/r/sub/deep/d.txt');
    expect(lines).not.toContain('/r/a.txt');
  });

  test('-path /r/*/c.txt matches across a directory boundary', async () => {
    const h = makeIO({ args: ['find', '/r', '-path', '/r/*/c.txt'], files });
    await findCommand(h.io);
    expect(h.out().trim().split('\n')).toEqual(['/r/sub/c.txt']);
  });

  test('-iname is case-insensitive', async () => {
    const h = makeIO({ args: ['find', '/r', '-iname', '*.TXT'], files });
    await findCommand(h.io);
    const lines = h.out().trim().split('\n').sort();
    expect(lines).toEqual(['/r/a.txt', '/r/sub/c.txt', '/r/sub/deep/d.txt']);
  });
});

// ── M19: -exec ──────────────────────────────────────────────────────────────

describe('find -exec', () => {
  test('-exec cmd {} \\; spawns once per match with {} substituted', async () => {
    const spawns: SpawnRecord[] = [];
    const h = makeIO({
      args: ['find', '/r', '-name', '*.txt', '-exec', 'cat', '{}', ';'],
      files,
      onSpawn: (rec) => { spawns.push(rec); return { stdout: 'X\n' }; },
    });
    expect(await findCommand(h.io)).toBe(0);
    // One spawn per matching file, each with {} replaced by the path.
    const argvs = spawns.map((s) => s.stages[0].argv);
    expect(argvs).toEqual([
      ['cat', '/r/a.txt'],
      ['cat', '/r/sub/c.txt'],
      ['cat', '/r/sub/deep/d.txt'],
    ]);
    // Child stdout is forwarded to find's stdout (and paths are NOT printed).
    expect(h.out()).toBe('X\nX\nX\n');
  });

  test('-exec cmd {} + batches all matches into ONE spawn', async () => {
    const spawns: SpawnRecord[] = [];
    const h = makeIO({
      args: ['find', '/r', '-name', '*.txt', '-exec', 'echo', '{}', '+'],
      files,
      onSpawn: (rec) => { spawns.push(rec); return { stdout: '' }; },
    });
    expect(await findCommand(h.io)).toBe(0);
    expect(spawns).toHaveLength(1);
    expect(spawns[0].stages[0].argv).toEqual(['echo', '/r/a.txt', '/r/sub/c.txt', '/r/sub/deep/d.txt']);
  });

  test('-exec accepts \\; (escaped semicolon) terminator', async () => {
    const spawns: SpawnRecord[] = [];
    const h = makeIO({
      args: ['find', '/r', '-name', 'a.txt', '-exec', 'rm', '{}', '\\;'],
      files,
      onSpawn: (rec) => { spawns.push(rec); return {}; },
    });
    expect(await findCommand(h.io)).toBe(0);
    expect(spawns.map((s) => s.stages[0].argv)).toEqual([['rm', '/r/a.txt']]);
  });

  test('-exec returns non-zero when a child fails', async () => {
    const h = makeIO({
      args: ['find', '/r', '-name', 'a.txt', '-exec', 'false', '{}', ';'],
      files,
      onSpawn: () => ({ exitCodes: [1] }),
    });
    expect(await findCommand(h.io)).toBe(1);
  });
});

// ── B2.2: -size / -empty / -newer / -printf ─────────────────────────────────

describe('find -size / -empty / -newer / -printf', () => {
  const sized = {
    '/s/small': 'x'.repeat(100),       // 100 bytes
    '/s/big': 'y'.repeat(3000),        // ~3 KiB → >1k, >1 512-byte block? size in bytes
    '/s/empty': '',                    // 0 bytes
  };

  test('-size +1k matches files larger than 1024 bytes', async () => {
    const h = makeIO({ args: ['find', '/s', '-type', 'f', '-size', '+1k'], files: sized });
    expect(await findCommand(h.io)).toBe(0);
    expect(h.out().trim().split('\n')).toEqual(['/s/big']);
  });

  test('-size 0 matches empty files', async () => {
    const h = makeIO({ args: ['find', '/s', '-type', 'f', '-size', '0'], files: sized });
    await findCommand(h.io);
    expect(h.out().trim().split('\n')).toEqual(['/s/empty']);
  });

  test('-size 1k rounds the file size UP to the unit (GNU): a 100-byte file is 1k', async () => {
    // GNU find rounds a file's size UP to the next whole unit for every suffix
    // except `c` (bytes). So `-size 1k` matches any file in (0, 1024] bytes.
    const h = makeIO({ args: ['find', '/s', '-type', 'f', '-size', '1k'], files: sized });
    await findCommand(h.io);
    expect(h.out().trim().split('\n').sort()).toEqual(['/s/small']);
  });

  test('-size 100c uses EXACT bytes (no rounding)', async () => {
    const h = makeIO({ args: ['find', '/s', '-type', 'f', '-size', '100c'], files: sized });
    await findCommand(h.io);
    expect(h.out().trim().split('\n')).toEqual(['/s/small']);
  });

  test('-empty matches zero-size files and empty directories', async () => {
    const h = makeIO({
      args: ['find', '/s', '-empty'],
      files: { '/s/empty': '', '/s/full': 'data', '/s/emptydir/.keep': '' },
    });
    // /s/emptydir has a child so it is not empty; /s/empty is a zero-byte file.
    await findCommand(h.io);
    const lines = h.out().trim().split('\n');
    expect(lines).toContain('/s/empty');
    expect(lines).not.toContain('/s/full');
  });

  test('-newer ref matches files with mtime strictly newer than ref', async () => {
    const old = new Date('2020-01-01T00:00:00Z');
    const ref = new Date('2021-01-01T00:00:00Z');
    const recent = new Date('2022-01-01T00:00:00Z');
    const h = makeIO({
      args: ['find', '/n', '-type', 'f', '-newer', '/n/ref'],
      files: {
        '/n/old': { content: 'a', mtime: old },
        '/n/ref': { content: 'b', mtime: ref },
        '/n/new': { content: 'c', mtime: recent },
      },
    });
    expect(await findCommand(h.io)).toBe(0);
    expect(h.out().trim().split('\n')).toEqual(['/n/new']);
  });

  test('-printf renders %p %f %s %y with \\n', async () => {
    const h = makeIO({
      args: ['find', '/p', '-type', 'f', '-printf', '%p %f %s %y\\n'],
      files: { '/p/file': 'hello' }, // 5 bytes
    });
    await findCommand(h.io);
    expect(h.out()).toBe('/p/file file 5 f\n');
  });

  test('-printf %y is d for directories', async () => {
    const h = makeIO({
      args: ['find', '/p', '-type', 'd', '-printf', '%y %f\\n'],
      files: { '/p/sub/x': '1' },
    });
    await findCommand(h.io);
    const lines = h.out().trim().split('\n');
    expect(lines).toContain('d p');
    expect(lines).toContain('d sub');
  });
});
