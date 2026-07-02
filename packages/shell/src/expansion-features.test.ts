import { expect, test } from 'vitest';
import { Expander, parseIfs, splitOnIfs } from './expander.ts';
import type { ShellEnv } from './expander.ts';

function mkEnv(vars: Record<string, string> = {}, hooks: Partial<ShellEnv> = {}): ShellEnv {
  const env = { ...vars };
  return {
    get: (n) => env[n],
    set: (n, v) => { env[n] = v; },
    has: (n) => n in env,
    getSpecial: () => undefined,
    runCommandSub: async () => '',
    listDir: async () => undefined,
    statPath: async () => undefined,
    ...hooks,
  } as ShellEnv;
}
const E = (vars?: Record<string, string>, hooks?: Partial<ShellEnv>) => new Expander(mkEnv(vars, hooks));

// ── H7: case modification ${x^^} ${x,,} ${x^} ${x,} ─────────────────────────

test('${x^^} uppercases all (quoted, single field)', async () => {
  const e = E({ x: 'heLLo World' });
  expect(await e.expandWord('"${x^^}"')).toEqual(['HELLO WORLD']);
});

test('${x,,} lowercases all (quoted, single field)', async () => {
  const e = E({ x: 'heLLo World' });
  expect(await e.expandWord('"${x,,}"')).toEqual(['hello world']);
});

test('${x^} uppercases first char', async () => {
  const e = E({ x: 'hello' });
  expect(await e.expandWord('${x^}')).toEqual(['Hello']);
});

test('${x,} lowercases first char', async () => {
  const e = E({ x: 'HELLO' });
  expect(await e.expandWord('${x,}')).toEqual(['hELLO']);
});

test('${x^^pattern} uppercases only matching chars', async () => {
  const e = E({ x: 'hello' });
  expect(await e.expandWord('${x^^l}')).toEqual(['heLLo']);
});

// ── H7: brace expansion must NOT consume parameter-expansion commas ─────────

test('${x,,} is NOT split into spurious fields by brace expansion', async () => {
  const e = E({ x: 'heLLoWorld' });
  // The bug produced spurious `$` fields; correct: a single lowercased field.
  expect(await e.expandWord('${x,,}')).toEqual(['helloworld']);
});

test('${x^^} survives brace expansion intact', async () => {
  const e = E({ x: 'abc' });
  expect(await e.expandWord('${x^^}')).toEqual(['ABC']);
});

test('real brace expansion still works alongside param expansion', async () => {
  const e = E({ x: 'v' });
  expect(await e.expandWord('{a,b}')).toEqual(['a', 'b']);
  expect(await e.expandWord('pre${x}{1,2}')).toEqual(['prev1', 'prev2']);
});

// ── H6: tilde expansion ──────────────────────────────────────────────────────

test('~ alone expands to $HOME', async () => {
  const e = E({ HOME: '/home/me' });
  expect(await e.expandWord('~')).toEqual(['/home/me']);
});

test('~/foo expands to $HOME/foo', async () => {
  const e = E({ HOME: '/home/me' });
  expect(await e.expandWord('~/foo')).toEqual(['/home/me/foo']);
});

test('~ only expands at word start, unquoted', async () => {
  const e = E({ HOME: '/home/me' });
  expect(await e.expandWord('a~')).toEqual(['a~']);
  expect(await e.expandWord('"~"')).toEqual(['~']);
});

test('~user form is left literal when no user db', async () => {
  const e = E({ HOME: '/home/me' });
  expect(await e.expandWord('~root/x')).toEqual(['~root/x']);
});

test('tilde expands in expandToString (redirect/assignment targets)', async () => {
  const e = E({ HOME: '/home/me' });
  expect(await e.expandToString('~/out.txt')).toBe('/home/me/out.txt');
});

// ── WP-A: param-expansion gaps (suffix-repl, indirection+op, array/pos slice) ─

test('${v/%pat/repl} anchored-suffix replacement', async () => {
  expect(await E({ v: 'report.txt' }).expandWord('${v/%.txt/.md}')).toEqual(['report.md']);
  expect(await E({ v: 'abc' }).expandWord('${v/%c/X}')).toEqual(['abX']);
  // /# prefix and plain / still work
  expect(await E({ v: 'abc' }).expandWord('${v/#a/X}')).toEqual(['Xbc']);
  expect(await E({ v: 'abcabc' }).expandWord('${v/a/-}')).toEqual(['-bcabc']);
  // a % that is NOT the anchor flag is a literal pattern char
  expect(await E({ v: 'a%b' }).expandWord('${v/\\%/-}')).toEqual(['a-b']);
});

test('${!ref} indirection honors trailing operators', async () => {
  const vars = { x: 'hello', y: 'x' };
  expect(await E(vars).expandWord('${!y:-def}')).toEqual(['hello']);
  expect(await E(vars).expandWord('${!y#he}')).toEqual(['llo']);
  expect(await E(vars).expandWord('${!y%lo}')).toEqual(['hel']);
  expect(await E(vars).expandWord('"${!y:1:2}"')).toEqual(['el']);
  expect(await E(vars).expandWord('${!y}')).toEqual(['hello']);
  // ref points at an unset var: :- default applies
  expect(await E({ y: 'x' }).expandWord('${!y:-D}')).toEqual(['D']);
});

test('${arr[@]:off:len} element slicing + negative index', async () => {
  const arr = ['x', 'y', 'z'];
  const hooks = { getArray: (n: string) => (n === 'a' ? arr : undefined) } as any;
  expect(await E({}, hooks).expandWord('${a[@]:1:2}')).toEqual(['y', 'z']);
  expect(await E({}, hooks).expandWord('${a[@]:1}')).toEqual(['y', 'z']);
  expect(await E({}, hooks).expandWord('"${a[*]:1:2}"')).toEqual(['y z']);
  const arr5 = ['a', 'b', 'c', 'd', 'e'];
  const h5 = { getArray: (n: string) => (n === 'a' ? arr5 : undefined) } as any;
  expect(await E({}, h5).expandWord('${a[@]: -2}')).toEqual(['d', 'e']);
  expect(await E({}, h5).expandWord('${a[-1]}')).toEqual(['e']);
  expect(await E({}, h5).expandWord('${a[-2]}')).toEqual(['d']);
});

test('${@:off:len} slices the positional array (not the joined string)', async () => {
  const hooks = { getPositional: () => ['a', 'b', 'c', 'd', 'e'], getSpecial: (n: string) => (n === '0' ? 'sh' : undefined) } as any;
  expect(await E({}, hooks).expandWord('${@:2:3}')).toEqual(['b', 'c', 'd']);
  expect(await E({}, hooks).expandWord('${@:1:2}')).toEqual(['a', 'b']);
  expect(await E({}, hooks).expandWord('"${*:2:3}"')).toEqual(['b c d']);
  expect(await E({}, hooks).expandWord('${@:2}')).toEqual(['b', 'c', 'd', 'e']);
});

test('${v:off:len} evaluates offset/length arithmetically', async () => {
  expect(await E({ v: 'hello', i: '2' }).expandWord('${v:i}')).toEqual(['llo']);
  expect(await E({ v: 'hello' }).expandWord('${v:1+1}')).toEqual(['llo']);
  expect(await E({ v: 'hello', n: '3' }).expandWord('${v:0:n}')).toEqual(['hel']);
  expect(await E({ v: 'hello' }).expandWord('${v:(-3)}')).toEqual(['llo']);
  // out-of-range negative offset yields empty (not the whole string)
  expect(await E({ v: 'hi' }).expandWord('"${v: -10}"')).toEqual(['']);
});

// ── WP-B: IFS word splitting ─────────────────────────────────────────────────

test('custom non-whitespace IFS splits unquoted expansions', async () => {
  expect(await E({ a: 'x,y,z', IFS: ',' }).expandWord('$a')).toEqual(['x', 'y', 'z']);
});

test('IFS non-whitespace produces empty fields; whitespace collapses', async () => {
  // leading empty, a, empty, b — trailing empty dropped
  expect(await E({ s: ':a::b:', IFS: ':' }).expandWord('$s')).toEqual(['', 'a', '', 'b']);
  expect(await E({ s: 'x  y   z' }).expandWord('$s')).toEqual(['x', 'y', 'z']); // default IFS
});

test('empty IFS disables splitting (one field)', async () => {
  expect(await E({ s: 'x y z', IFS: '' }).expandWord('$s')).toEqual(['x y z']);
});

test('mixed whitespace+non-whitespace IFS merges adjacent delimiters', async () => {
  // the space before `:` merges into the `:` delimiter → 2 fields
  expect(await E({ s: 'a :b', IFS: ' :' }).expandWord('$s')).toEqual(['a', 'b']);
});

test('parseIfs + splitOnIfs helpers', () => {
  expect(parseIfs(undefined)).toEqual({ ws: ' \t\n', nonWs: '' });
  expect(parseIfs(':')).toEqual({ ws: '', nonWs: ':' });
  expect(splitOnIfs('x:y:z', parseIfs(':'))).toEqual(['x', 'y', 'z']);
  expect(splitOnIfs('a::b', parseIfs(':'))).toEqual(['a', '', 'b']);
  expect(splitOnIfs('  a  b  ', parseIfs(undefined))).toEqual(['a', 'b']);
});
