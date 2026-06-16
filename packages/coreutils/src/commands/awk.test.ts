import { expect, test, describe } from 'vitest';
import { awkCommand } from './awk.ts';
import { makeIO } from './_test-io.ts';

describe('awk command — CLI wiring', () => {
  test('program over stdin: print a field', async () => {
    const h = makeIO({ args: ['awk', '{ print $2 }'], stdinText: 'a b c\nd e f\n' });
    expect(await awkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('b\ne\n');
  });

  test('BEGIN sum END', async () => {
    const h = makeIO({ args: ['awk', 'BEGIN{s=0}{s+=$1}END{print s}'], stdinText: '1\n2\n3\n' });
    expect(await awkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('6\n');
  });

  test('-F sets the field separator', async () => {
    const h = makeIO({ args: ['awk', '-F', ',', '{ print $3 }'], stdinText: 'a,b,c\n' });
    expect(await awkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('c\n');
  });

  test('-F with attached value', async () => {
    const h = makeIO({ args: ['awk', '-F:', '{ print $1 }'], stdinText: 'root:x:0\n' });
    expect(await awkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('root\n');
  });

  test('-F with tab escape', async () => {
    const h = makeIO({ args: ['awk', '-F\\t', '{ print $2 }'], stdinText: 'a\tb\tc\n' });
    expect(await awkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('b\n');
  });

  test('-v assignment', async () => {
    const h = makeIO({ args: ['awk', '-v', 'name=bob', 'BEGIN{ print name }'] });
    expect(await awkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('bob\n');
  });

  test('multiple -v', async () => {
    const h = makeIO({ args: ['awk', '-v', 'a=1', '-v', 'b=2', 'BEGIN{ print a+b }'] });
    expect(await awkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('3\n');
  });

  test('reads a file operand', async () => {
    const h = makeIO({ args: ['awk', '{ print $1 }', '/data.txt'], files: { '/data.txt': 'x y\nz w\n' } });
    expect(await awkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('x\nz\n');
  });

  test('multiple files with FNR vs NR', async () => {
    const h = makeIO({
      args: ['awk', '{ print FILENAME, FNR, NR }', '/a', '/b'],
      files: { '/a': 'one\n', '/b': 'two\n' },
    });
    expect(await awkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/a 1 1\n/b 1 2\n');
  });

  test('-f reads program from a file', async () => {
    const h = makeIO({
      args: ['awk', '-f', '/prog.awk', '/in.txt'],
      files: { '/prog.awk': '{ print NF }', '/in.txt': 'a b c\n' },
    });
    expect(await awkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('3\n');
  });

  test('print > file writes to the VFS', async () => {
    const h = makeIO({ args: ['awk', '{ print $1 > "/out.txt" }'], stdinText: 'a\nb\n' });
    expect(await awkCommand(h.io)).toBe(0);
    expect(h.file('/out.txt')).toBe('a\nb\n');
  });

  test('getline < file reads from the VFS', async () => {
    const h = makeIO({
      args: ['awk', 'BEGIN{ while ((getline line < "/f.txt") > 0) print "got " line }'],
      files: { '/f.txt': 'x\ny\n' },
    });
    expect(await awkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('got x\ngot y\n');
  });

  test('syntax error reports to stderr and exits 2', async () => {
    const h = makeIO({ args: ['awk', '{ print ( }'], stdinText: 'x\n' });
    expect(await awkCommand(h.io)).toBe(2);
    expect(h.err()).toContain('awk:');
  });

  test('error prefix is not doubled', async () => {
    const h = makeIO({ args: ['awk', '{ print ( }'], stdinText: 'x\n' });
    await awkCommand(h.io);
    expect(h.err()).not.toContain('awk: awk:');
  });

  test('runtime error prefix is not doubled', async () => {
    const h = makeIO({ args: ['awk', 'BEGIN{ print 1/0 }'] });
    await awkCommand(h.io);
    expect(h.err()).not.toContain('awk: awk:');
    expect(h.err()).toContain('awk:');
  });

  test('missing program reports usage', async () => {
    const h = makeIO({ args: ['awk'] });
    // With no program and no -f, but stdin empty → usage error.
    const code = await awkCommand(h.io);
    expect(code).toBe(2);
    expect(h.err()).toContain('usage');
  });

  test('printf field formatting end to end', async () => {
    const h = makeIO({ args: ['awk', '{ printf "%-5s|%3d\\n", $1, $2 }'], stdinText: 'hi 7\n' });
    expect(await awkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('hi   |  7\n');
  });
});
