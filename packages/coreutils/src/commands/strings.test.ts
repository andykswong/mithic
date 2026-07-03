import { expect, test, describe } from 'vitest';
import { stringsCommand } from './strings.ts';
import { makeIO } from './_testio.ts';

const bytes = (...b: number[]): Uint8Array => new Uint8Array(b);
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

describe('strings', () => {
  test('prints printable runs of >= 4 (default) bytes', async () => {
    // \0\0 hello \1 world \0
    const buf = bytes(0, 0, ...ascii('hello'), 1, ...ascii('world'), 0);
    const h = makeIO({ args: ['strings', '/in'], files: { '/in': buf } });
    expect(await stringsCommand(h.io)).toBe(0);
    expect(h.out()).toBe('hello\nworld\n');
  });

  test('-n 6 only prints runs >= 6', async () => {
    const buf = bytes(...ascii('hello'), 0, ...ascii('worldly'), 0);
    const h = makeIO({ args: ['strings', '-n', '6', '/in'], files: { '/in': buf } });
    await stringsCommand(h.io);
    expect(h.out()).toBe('worldly\n');
  });

  test('runs shorter than the minimum are dropped', async () => {
    const buf = bytes(...ascii('abc'), 0, ...ascii('abcd'));
    const h = makeIO({ args: ['strings', '/in'], files: { '/in': buf } });
    await stringsCommand(h.io);
    expect(h.out()).toBe('abcd\n');
  });

  test('treats a trailing run with no terminator as a string', async () => {
    const buf = bytes(0, ...ascii('tail'));
    const h = makeIO({ args: ['strings', '/in'], files: { '/in': buf } });
    await stringsCommand(h.io);
    expect(h.out()).toBe('tail\n');
  });

  test('reads stdin when no file operand', async () => {
    const h = makeIO({ args: ['strings'], stdinText: 'plainascii' });
    await stringsCommand(h.io);
    expect(h.out()).toBe('plainascii\n');
  });

  // ── BSD parity: -t d|o|x offset prefixes, -o, -number ──

  test('-t d prints the decimal byte offset before each run', async () => {
    // \0\0 hello(@2) \0 world(@8)
    const buf = bytes(0, 0, ...ascii('hello'), 0, ...ascii('world'));
    const h = makeIO({ args: ['strings', '-t', 'd', '/in'], files: { '/in': buf } });
    await stringsCommand(h.io);
    expect(h.out()).toBe('2 hello\n8 world\n');
  });

  test('-t x prints the hex offset (lowercase, no padding)', async () => {
    const buf = bytes(...new Array(20).fill(0), ...ascii('hello'));
    const h = makeIO({ args: ['strings', '-t', 'x', '/in'], files: { '/in': buf } });
    await stringsCommand(h.io);
    expect(h.out()).toBe('14 hello\n'); // offset 20 == 0x14
  });

  test('-t o prints the octal offset', async () => {
    const buf = bytes(...new Array(20).fill(0), ...ascii('hello'));
    const h = makeIO({ args: ['strings', '-t', 'o', '/in'], files: { '/in': buf } });
    await stringsCommand(h.io);
    expect(h.out()).toBe('24 hello\n'); // offset 20 == 024 octal
  });

  test('-o prints a decimal offset right-justified in a 7-wide field (BSD)', async () => {
    const buf = bytes(0, 0, ...ascii('hello'));
    const h = makeIO({ args: ['strings', '-o', '/in'], files: { '/in': buf } });
    await stringsCommand(h.io);
    expect(h.out()).toBe('      2 hello\n');
  });

  test('a bare -N is shorthand for -n N', async () => {
    const buf = bytes(...ascii('abc'), 0, ...ascii('abcd'));
    const h = makeIO({ args: ['strings', '-3', '/in'], files: { '/in': buf } });
    await stringsCommand(h.io);
    expect(h.out()).toBe('abc\nabcd\n');
  });

  test('-a is accepted (scan all, the default)', async () => {
    const buf = bytes(0, ...ascii('hello'));
    const h = makeIO({ args: ['strings', '-a', '/in'], files: { '/in': buf } });
    expect(await stringsCommand(h.io)).toBe(0);
    expect(h.out()).toBe('hello\n');
  });

  test('an unknown option errors and exits 1', async () => {
    const h = makeIO({ args: ['strings', '-Z', '/in'], files: { '/in': bytes(...ascii('hello')) } });
    expect(await stringsCommand(h.io)).toBe(1);
    expect(h.err()).toContain('invalid option -- \'Z\'');
  });
});
