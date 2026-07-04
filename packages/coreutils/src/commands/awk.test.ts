import { expect, test, describe } from 'vitest';
import { awkCommand } from './awk.ts';
import { makeIO } from './_test-io.ts';
import type { TestHarness } from './_test-io.ts';

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

  test('print > "/dev/stdout" writes to stdout, not the VFS', async () => {
    const h = makeIO({ args: ['awk', 'BEGIN{ print "a" > "/dev/stdout" }'] });
    expect(await awkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\n');
    expect(h.err()).toBe('');
    expect(h.file('/dev/stdout')).toBeUndefined();
  });

  test('print > "/dev/stderr" writes to stderr, not the VFS', async () => {
    const h = makeIO({ args: ['awk', 'BEGIN{ print "e" > "/dev/stderr" }'] });
    expect(await awkCommand(h.io)).toBe(0);
    expect(h.err()).toBe('e\n');
    expect(h.out()).toBe('');
    expect(h.file('/dev/stderr')).toBeUndefined();
  });

  test('/dev/stdout interleaves with normal print and accumulates on repeat', async () => {
    const h = makeIO({ args: ['awk', 'BEGIN{ print "one"; print "two" > "/dev/stdout"; print "three" >> "/dev/stdout" }'] });
    expect(await awkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('one\ntwo\nthree\n');
  });

  test('printf > "/dev/stdout" writes to stdout', async () => {
    const h = makeIO({ args: ['awk', 'BEGIN{ printf "%s\\n", "z" > "/dev/stdout" }'] });
    expect(await awkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('z\n');
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

  // CR2: substr arity is checked at parse time; gawk exits 1 (not 2) for it.
  test('substr with too many args → exit 1, gawk diagnostic', async () => {
    const h = makeIO({ args: ['awk', 'BEGIN{ print substr("x",1,2,3) }'] });
    expect(await awkCommand(h.io)).toBe(1);
    expect(h.err()).toContain('4 is invalid as number of arguments for substr');
  });

  test('substr with too few args → exit 1 (no raw JS undefined crash)', async () => {
    const h = makeIO({ args: ['awk', 'BEGIN{ print substr("hello") }'] });
    expect(await awkCommand(h.io)).toBe(1);
    expect(h.err()).toContain('1 is invalid as number of arguments for substr');
    expect(h.err()).not.toContain('Cannot read properties');
  });

  // CR2: BEGIN $0 is the empty string, not undefined.
  test('BEGIN bare print emits an empty line', async () => {
    const h = makeIO({ args: ['awk', 'BEGIN{ print }'] });
    expect(await awkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('\n');
  });

  test('BEGIN print length does not crash and prints 0', async () => {
    const h = makeIO({ args: ['awk', 'BEGIN{ print length }'] });
    expect(await awkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('0\n');
    expect(h.err()).toBe('');
  });

  test('printf field formatting end to end', async () => {
    const h = makeIO({ args: ['awk', '{ printf "%-5s|%3d\\n", $1, $2 }'], stdinText: 'hi 7\n' });
    expect(await awkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('hi   |  7\n');
  });
});

describe('awk command — input gating (gawk parity: BEGIN-only reads nothing)', () => {
  // A stdin that never closes: if awk reads it, readAllText hangs forever. Wrap
  // the run in a timeout race so a regressed (input-reading) BEGIN-only program
  // FAILS FAST instead of hanging the suite.
  function makeIOWithOpenStdin(args: string[]): TestHarness {
    const h = makeIO({ args });
    const openStdin = new ReadableStream<Uint8Array>({ start() { /* never enqueues, never closes */ } });
    return { ...h, io: { ...h.io, stdin: openStdin } };
  }

  function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
    ]);
  }

  test('BEGIN-only completes promptly even with an unclosed stdin', async () => {
    const h = makeIOWithOpenStdin(['awk', 'BEGIN{ print 1 }']);
    const code = await withTimeout(awkCommand(h.io), 2000);
    expect(code).toBe(0);
    expect(h.out()).toBe('1\n');
  });

  test('BEGIN-only does not open (nor error on) file operands', async () => {
    // gawk: `awk 'BEGIN{print "hi"}' somefile` never touches somefile.
    const h = makeIO({ args: ['awk', 'BEGIN{ print "hi" }', '/nonexistent/file123'] });
    expect(await awkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('hi\n');
    expect(h.err()).toBe('');
  });

  test('BEGIN + main rule reads stdin', async () => {
    const h = makeIO({ args: ['awk', 'BEGIN{ print "b" } { print "line:"$0 }'], stdinText: 'x\ny\n' });
    expect(await awkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('b\nline:x\nline:y\n');
  });

  test('main-only reads stdin', async () => {
    const h = makeIO({ args: ['awk', '{ print NR": "$0 }'], stdinText: 'a\nb\n' });
    expect(await awkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1: a\n2: b\n');
  });

  test('BEGIN + END reads stdin so END sees NR', async () => {
    const h = makeIO({ args: ['awk', 'BEGIN{ print "start" } END{ print "count="NR }'], stdinText: 'a\nb\nc\n' });
    expect(await awkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('start\ncount=3\n');
  });

  test('END-only reads stdin (END alone still consumes input)', async () => {
    const h = makeIO({ args: ['awk', 'END{ print NR }'], stdinText: 'a\nb\n' });
    expect(await awkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('2\n');
  });

  test('BEGIN-only can still read files via getline < file', async () => {
    const h = makeIO({
      args: ['awk', 'BEGIN{ while ((getline line < "/f.txt") > 0) print "got " line }'],
      files: { '/f.txt': 'x\ny\n' },
    });
    expect(await awkCommand(h.io)).toBe(0);
    expect(h.out()).toBe('got x\ngot y\n');
  });
});
