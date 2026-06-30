import { expect, test, describe } from 'vitest';
import { whichCommand } from './which.ts';
import { makeIO } from './_testio.ts';

describe('which', () => {
  test('prints the first PATH match for an executable', async () => {
    const h = makeIO({
      args: ['which', 'foo'],
      env: { PATH: '/usr/bin:/bin' },
      files: { '/usr/bin/foo': { content: '#!', mode: 0o755 } },
    });
    expect(await whichCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/usr/bin/foo\n');
  });

  test('searches PATH in order, taking the first match', async () => {
    const h = makeIO({
      args: ['which', 'foo'],
      env: { PATH: '/usr/bin:/bin' },
      files: {
        '/usr/bin/foo': { content: 'x', mode: 0o755 },
        '/bin/foo': { content: 'y', mode: 0o755 },
      },
    });
    await whichCommand(h.io);
    expect(h.out()).toBe('/usr/bin/foo\n');
  });

  test('non-executable file is not a match', async () => {
    const h = makeIO({
      args: ['which', 'foo'],
      env: { PATH: '/usr/bin' },
      files: { '/usr/bin/foo': { content: 'x', mode: 0o644 } },
    });
    expect(await whichCommand(h.io)).toBe(1);
    expect(h.out()).toBe('');
  });

  test('missing name exits 1', async () => {
    const h = makeIO({ args: ['which', 'nope'], env: { PATH: '/usr/bin' } });
    expect(await whichCommand(h.io)).toBe(1);
    expect(h.out()).toBe('');
  });

  test('-a lists every match across PATH', async () => {
    const h = makeIO({
      args: ['which', '-a', 'foo'],
      env: { PATH: '/usr/bin:/bin' },
      files: {
        '/usr/bin/foo': { content: 'x', mode: 0o755 },
        '/bin/foo': { content: 'y', mode: 0o755 },
      },
    });
    expect(await whichCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/usr/bin/foo\n/bin/foo\n');
  });

  test('multiple names: exit 1 if any not found', async () => {
    const h = makeIO({
      args: ['which', 'foo', 'bar'],
      env: { PATH: '/usr/bin' },
      files: { '/usr/bin/foo': { content: 'x', mode: 0o755 } },
    });
    expect(await whichCommand(h.io)).toBe(1);
    expect(h.out()).toBe('/usr/bin/foo\n');
  });

  test('a NAME containing a slash is checked directly, bypassing PATH', async () => {
    const h = makeIO({
      args: ['which', '/opt/bin/tool'],
      env: { PATH: '/usr/bin' }, // PATH does not contain /opt/bin
      files: { '/opt/bin/tool': { content: 'x', mode: 0o755 } },
    });
    expect(await whichCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/opt/bin/tool\n');
  });

  test('a slash NAME that is not executable is not a match (exit 1)', async () => {
    const h = makeIO({
      args: ['which', './rel/tool'],
      cwd: '/work',
      env: { PATH: '/usr/bin' },
      files: { '/work/rel/tool': { content: 'x', mode: 0o644 } }, // not executable
    });
    expect(await whichCommand(h.io)).toBe(1);
    expect(h.out()).toBe('');
  });
});
