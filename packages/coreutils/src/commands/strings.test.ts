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
});
