import { expect, test, describe } from 'vitest';
import { lsCommand, columns, commaList, indent, permString, humanSize } from './ls.ts';
import { makeIO } from './_testio.ts';

describe('ls helpers', () => {
  test('permString', () => {
    expect(permString('file', 0o644)).toBe('-rw-r--r--');
    expect(permString('directory', 0o755)).toBe('drwxr-xr-x');
    expect(permString('symlink', 0o777)).toBe('lrwxrwxrwx');
  });
  test('humanSize', () => {
    expect(humanSize(512)).toBe('512');
    expect(humanSize(1536)).toBe('1.5K');
    expect(humanSize(1048576)).toBe('1.0M');
  });
  test('columns (vertical) newline-terminates and lays entries down', () => {
    const c = columns(['a', 'b'], false);
    expect(c).toBe('a  b\n');
  });
  test('columns (horizontal) lays entries across', () => {
    // Short names fit on one line; 2-space inter-column gap.
    expect(columns(['a', 'b', 'c'], true)).toBe('a  b  c\n');
  });
  test('commaList joins with ", "', () => {
    expect(commaList(['a', 'b', 'c'])).toBe('a, b, c\n');
  });
  test('indent matches GNU tab-stop rule (2-space gap uses spaces not tab)', () => {
    // from=47 to=49 → no tab (to/8 == (from+1)/8), two spaces.
    expect(indent(47, 49)).toBe('  ');
    // from=1 to=12 → tab to 8 then spaces to 12.
    expect(indent(1, 12)).toBe('\t    ');
  });
});

describe('ls', () => {
  test('lists directory entries sorted', async () => {
    const h = makeIO({ args: ['ls', '-1', '/d'], files: { '/d/b': '1', '/d/a': '2' } });
    expect(await lsCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nb\n');
  });

  test('hides dotfiles by default, -a shows them', async () => {
    const h1 = makeIO({ args: ['ls', '-1', '/d'], files: { '/d/.hidden': 'x', '/d/visible': 'y' } });
    await lsCommand(h1.io);
    expect(h1.out()).toBe('visible\n');

    const h2 = makeIO({ args: ['ls', '-1', '-a', '/d'], files: { '/d/.hidden': 'x', '/d/visible': 'y' } });
    await lsCommand(h2.io);
    expect(h2.out().split('\n')).toContain('.hidden');
    expect(h2.out().split('\n')).toContain('.');
  });

  test('-l long format shows total header, perms and size', async () => {
    const h = makeIO({ args: ['ls', '-l', '/d'], files: { '/d/f': { content: 'hello', mode: 0o644 } } });
    await lsCommand(h.io);
    expect(h.out().split('\n')[0]).toMatch(/^total \d+$/); // GNU total header
    expect(h.out()).toContain('-rw-r--r--');
    expect(h.out()).toContain(' 5 ');
  });

  test('-l emits GNU-shaped fields incl. owner/group and a Mon DD HH:MM date', async () => {
    const h = makeIO({ args: ['ls', '-l', '/d'], files: { '/d/f': { content: 'hello', mode: 0o644 } } });
    await lsCommand(h.io);
    const line = h.out().trim().split('\n').find((l) => l.includes('-rw-r--r--'))!;
    const fields = line.trim().split(/\s+/);
    // mode links owner group size Mon DD HH:MM name → date is 3 tokens → 9 total.
    expect(fields).toHaveLength(9);
    expect(fields[0]).toBe('-rw-r--r--');
    expect(fields[2]).toBe('root'); // owner placeholder
    expect(fields[3]).toBe('root'); // group placeholder
    expect(fields[4]).toBe('5');    // size
    expect(fields[8]).toBe('f');    // name
    expect(fields[7]).toMatch(/^\d\d:\d\d$/); // HH:MM
  });

  test('-d lists directory itself', async () => {
    const h = makeIO({ args: ['ls', '-d', '/d'], files: { '/d/x': 'x' } });
    await lsCommand(h.io);
    expect(h.out()).toBe('/d\n');
  });

  test('-r reverses order', async () => {
    const h = makeIO({ args: ['ls', '-1', '-r', '/d'], files: { '/d/a': '1', '/d/b': '2' } });
    await lsCommand(h.io);
    expect(h.out()).toBe('b\na\n');
  });

  test('-S sorts by size descending', async () => {
    const h = makeIO({ args: ['ls', '-1', '-S', '/d'], files: { '/d/small': 'x', '/d/big': 'xxxxx' } });
    await lsCommand(h.io);
    expect(h.out()).toBe('big\nsmall\n');
  });

  test('-R recurses with headers', async () => {
    const h = makeIO({ args: ['ls', '-1', '-R', '/d'], files: { '/d/a': '1', '/d/sub/b': '2' } });
    await lsCommand(h.io);
    expect(h.out()).toContain('/d/sub:');
    expect(h.out()).toContain('b');
  });

  test('lists a single file operand', async () => {
    const h = makeIO({ args: ['ls', '-1', '/f'], files: { '/f': 'x' } });
    await lsCommand(h.io);
    expect(h.out()).toBe('/f\n');
  });

  test('missing target errors with exit 2 (GNU serious error)', async () => {
    const h = makeIO({ args: ['ls', '/nope'] });
    expect(await lsCommand(h.io)).toBe(2);
    expect(h.err()).toContain('cannot access \'/nope\': No such file or directory');
  });

  // ── layout: default one-per-line to a pipe (isatty false) ──────────────────

  test('default is one-per-line to a non-tty (pipe)', async () => {
    // makeIO does not wire isatty → io.isatty?.(1) ?? false → pipe layout.
    const h = makeIO({ args: ['ls', '/d'], files: { '/d/f': '1', '/d/g': '2', '/d/sub/b': 'x' } });
    expect(await lsCommand(h.io)).toBe(0);
    expect(h.out()).toBe('f\ng\nsub\n');
  });

  test('default is multi-column (down) to a TTY', async () => {
    const h = makeIO({ args: ['ls', '/d'], files: { '/d/f': '1', '/d/g': '2', '/d/sub/b': 'x' } });
    (h.io as { isatty?: (fd: number) => boolean }).isatty = () => true;
    await lsCommand(h.io);
    // Short names fit one line, 2-space gaps.
    expect(h.out()).toBe('f  g  sub\n');
  });

  test('-m comma-separated list', async () => {
    const h = makeIO({ args: ['ls', '-m', '/d'], files: { '/d/f': '1', '/d/g': '2', '/d/sub/b': 'x' } });
    await lsCommand(h.io);
    expect(h.out()).toBe('f, g, sub\n');
  });

  test('-x lays entries across (rows first)', async () => {
    const h = makeIO({ args: ['ls', '-x', '/d'], files: { '/d/a': '1', '/d/b': '2', '/d/c': '3' } });
    await lsCommand(h.io);
    expect(h.out()).toBe('a  b  c\n');
  });

  test('-C forces multi-column even to a pipe', async () => {
    const h = makeIO({ args: ['ls', '-C', '/d'], files: { '/d/a': '1', '/d/b': '2', '/d/c': '3' } });
    await lsCommand(h.io);
    expect(h.out()).toBe('a  b  c\n');
  });

  test('unknown long flag → exit 2 with GNU diagnostic', async () => {
    const h = makeIO({ args: ['ls', '--bogus', '/d'], files: { '/d/f': '1' } });
    expect(await lsCommand(h.io)).toBe(2);
    expect(h.err()).toContain('unrecognized option \'--bogus\'');
    expect(h.out()).toBe('');
  });

  test('unknown short flag → exit 2', async () => {
    const h = makeIO({ args: ['ls', '-W', '/d'], files: { '/d/f': '1' } });
    // -W is genuinely undeclared; declared no-op flags do not error.
    expect(await lsCommand(h.io)).toBe(2);
    expect(h.err()).toContain('invalid option -- \'W\'');
  });

  test('-i prints an inode column (synthetic; layout only)', async () => {
    const h = makeIO({ args: ['ls', '-1', '-i', '/d'], files: { '/d/a': '1' } });
    await lsCommand(h.io);
    // <inode> a — synthetic inode (VFS carries none), so match the shape not value.
    expect(h.out()).toMatch(/^\d+ a\n$/);
  });

  // ── B2.3: -F classify indicators ───────────────────────────────────────────

  test('-F appends / to dirs, * to executables, nothing to regular files', async () => {
    const h = makeIO({
      args: ['ls', '-1', '-F', '/d'],
      files: {
        '/d/sub/keep': 'x',                       // makes /d/sub a directory
        '/d/prog': { content: '#!', mode: 0o755 }, // executable
        '/d/file': { content: 'x', mode: 0o644 },  // regular
      },
    });
    expect(await lsCommand(h.io)).toBe(0);
    expect(h.out()).toBe('file\nprog*\nsub/\n');
  });

  test('-F classifies symlinks with @', async () => {
    const h = makeIO({
      args: ['ls', '-1', '-F', '/d'],
      files: { '/d/target': 'x' },
    });
    await h.fs.symlink('/d/target', '/d/link');
    await lsCommand(h.io);
    expect(h.out()).toContain('link@');
  });
});
