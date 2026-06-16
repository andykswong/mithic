import { expect, test, describe } from 'vitest';
import { chmodCommand, applySymbolic, parseOctal } from './chmod.ts';
import { makeIO } from './_testio.ts';

describe('chmod symbolic parser', () => {
  test('u+x adds owner execute', () => {
    expect(applySymbolic('u+x', 0o644)).toBe(0o744);
  });
  test('go-w removes group/other write', () => {
    expect(applySymbolic('go-w', 0o666)).toBe(0o644);
  });
  test('a=r sets all to read-only', () => {
    expect(applySymbolic('a=r', 0o777)).toBe(0o444);
  });
  test('comma-separated clauses', () => {
    expect(applySymbolic('u+x,g-r', 0o644)).toBe(0o704);
  });
  test('invalid spec returns undefined', () => {
    expect(applySymbolic('q+z', 0o644)).toBeUndefined();
  });
  test('parseOctal', () => {
    expect(parseOctal('755')).toBe(0o755);
    expect(parseOctal('0644')).toBe(0o644);
    expect(parseOctal('zzz')).toBeUndefined();
  });
});

describe('chmod', () => {
  test('octal mode', async () => {
    const h = makeIO({ args: ['chmod', '600', '/f'], files: { '/f': 'x' } });
    expect(await chmodCommand(h.io)).toBe(0);
    expect((await h.fs.stat('/f')).mode & 0o777).toBe(0o600);
  });

  test('symbolic mode', async () => {
    const h = makeIO({ args: ['chmod', 'u+x', '/f'], files: { '/f': { content: 'x', mode: 0o644 } } });
    expect(await chmodCommand(h.io)).toBe(0);
    expect((await h.fs.stat('/f')).mode & 0o777).toBe(0o744);
  });

  test('-R recurses', async () => {
    const h = makeIO({ args: ['chmod', '-R', '700', '/d'], files: { '/d/a': 'a', '/d/sub/b': 'b' } });
    expect(await chmodCommand(h.io)).toBe(0);
    expect((await h.fs.stat('/d/a')).mode & 0o777).toBe(0o700);
    expect((await h.fs.stat('/d/sub/b')).mode & 0o777).toBe(0o700);
  });

  test('missing operand', async () => {
    const h = makeIO({ args: ['chmod', '755'] });
    expect(await chmodCommand(h.io)).toBe(1);
  });

  test('nonexistent file errors', async () => {
    const h = makeIO({ args: ['chmod', '755', '/missing'] });
    expect(await chmodCommand(h.io)).toBe(1);
    expect(h.err()).toContain('cannot access');
  });
});
