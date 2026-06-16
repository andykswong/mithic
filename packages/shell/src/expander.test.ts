/* eslint-disable @stylistic/quotes -- a test asserts single-quote literal handling and must embed `'` inside a double-quoted string */
import { expect, test } from 'vitest';
import { Expander } from './expander.ts';
import type { ShellEnv } from './expander.ts';

/** Build a minimal ShellEnv backed by a plain record, with optional hooks. */
function mkEnv(
  vars: Record<string, string> = {},
  hooks: Partial<ShellEnv> = {},
): ShellEnv {
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
    // expose backing store for assertions
    _env: env,
  } as ShellEnv & { _env: Record<string, string> };
}

const E = (vars?: Record<string, string>, hooks?: Partial<ShellEnv>) => new Expander(mkEnv(vars, hooks));

test('expands $VAR and ${VAR}', async () => {
  const e = E({ FOO: 'bar' });
  expect(await e.expandWord('$FOO')).toEqual(['bar']);
  expect(await e.expandWord('${FOO}x')).toEqual(['barx']);
});

test('unset variable expands to empty', async () => {
  const e = E({});
  expect(await e.expandWord('$NOPE')).toEqual(['']);
});

test('double-quoted preserves spaces, single-quoted is literal', async () => {
  const e = E({ X: 'a b' });
  expect(await e.expandWord('"$X"')).toEqual(['a b']);
  expect(await e.expandWord("'$X'")).toEqual(['$X']);
});

// ── special params ──────────────────────────────────────────────────────────

test('$? resolves the last status via getSpecial', async () => {
  const e = E({}, { getSpecial: (n) => (n === '?' ? '42' : undefined) });
  expect(await e.expandWord('$?')).toEqual(['42']);
});

test('$# and positional $1 resolve via getSpecial', async () => {
  const e = E({}, { getSpecial: (n) => ({ '#': '2', '1': 'first', '0': 'sh' }[n]) });
  expect(await e.expandWord('$#')).toEqual(['2']);
  expect(await e.expandWord('$1')).toEqual(['first']);
  expect(await e.expandWord('$0')).toEqual(['sh']);
});

// ── parameter expansion ${...} ──────────────────────────────────────────────

test('${VAR:-default}', async () => {
  expect(await E({}).expandWord('${UNSET:-fallback}')).toEqual(['fallback']);
  expect(await E({ V: 'hi' }).expandWord('${V:-fallback}')).toEqual(['hi']);
  expect(await E({ V: '' }).expandWord('${V:-fallback}')).toEqual(['fallback']);
});

test('${VAR:+alt}', async () => {
  expect(await E({ V: 'hi' }).expandWord('${V:+alt}')).toEqual(['alt']);
  expect(await E({}).expandWord('${UNSET:+alt}')).toEqual(['']);
});

test('${VAR:=default} assigns when unset', async () => {
  const env = mkEnv({}) as ShellEnv & { _env: Record<string, string> };
  const e = new Expander(env);
  expect(await e.expandWord('${V:=set}')).toEqual(['set']);
  expect(env._env.V).toBe('set');
});

test('${#VAR} length', async () => {
  expect(await E({ V: 'hello' }).expandWord('${#V}')).toEqual(['5']);
  expect(await E({ V: '' }).expandWord('${#V}')).toEqual(['0']);
});

test('${VAR#prefix} and ${VAR##prefix}', async () => {
  expect(await E({ x: 'hello_world' }).expandWord('${x#hel}')).toEqual(['lo_world']);
  expect(await E({ x: '/a/b/c/file.txt' }).expandWord('${x##*/}')).toEqual(['file.txt']);
});

test('${VAR%suffix} and ${VAR%%suffix}', async () => {
  expect(await E({ x: 'hello_world' }).expandWord('${x%orld}')).toEqual(['hello_w']);
  expect(await E({ x: 'a/b/c/file.txt' }).expandWord('${x%%/*}')).toEqual(['a']);
});

test('${VAR/pat/rep} and ${VAR//pat/rep}', async () => {
  expect(await E({ x: 'hello' }).expandWord('${x/l/L}')).toEqual(['heLlo']);
  expect(await E({ x: 'hello' }).expandWord('${x//l/L}')).toEqual(['heLLo']);
});

test('${VAR:offset:len} substring', async () => {
  expect(await E({ x: 'hello_world' }).expandWord('${x:6}')).toEqual(['world']);
  expect(await E({ x: 'hello_world' }).expandWord('${x:0:5}')).toEqual(['hello']);
  expect(await E({ x: 'hello_world' }).expandWord('${x:2:3}')).toEqual(['llo']);
});

// ── brace expansion ─────────────────────────────────────────────────────────

test('comma brace expansion', async () => {
  expect(await E({}).expandWord('{a,b,c}')).toEqual(['a', 'b', 'c']);
  expect(await E({}).expandWord('pre{x,y}post')).toEqual(['prexpost', 'preypost']);
});

test('numeric and alpha range brace expansion', async () => {
  expect(await E({}).expandWord('{1..5}')).toEqual(['1', '2', '3', '4', '5']);
  expect(await E({}).expandWord('{a..e}')).toEqual(['a', 'b', 'c', 'd', 'e']);
});

test('nested / cross-product brace expansion', async () => {
  expect(await E({}).expandWord('{a,b}{1,2}')).toEqual(['a1', 'a2', 'b1', 'b2']);
});

test('brace happens before var expansion', async () => {
  expect(await E({ V: 'x' }).expandWord('{$V,b}')).toEqual(['x', 'b']);
});

// ── arithmetic expansion ─────────────────────────────────────────────────────

test('$(( expr )) arithmetic', async () => {
  expect(await E({ n: '5' }).expandWord('$(( n * 2 + 1 ))')).toEqual(['11']);
});

// ── command substitution ─────────────────────────────────────────────────────

test('$(cmd) command substitution strips trailing newlines', async () => {
  const e = E({}, { runCommandSub: async (src) => (src === 'echo hi' ? 'hi\n\n' : '') });
  expect(await e.expandWord('$(echo hi)')).toEqual(['hi']);
});

test('backtick command substitution', async () => {
  const e = E({}, { runCommandSub: async () => 'world\n' });
  expect(await e.expandWord('`echo world`')).toEqual(['world']);
});

test('unquoted command sub is word-split', async () => {
  const e = E({}, { runCommandSub: async () => 'a b c\n' });
  expect(await e.expandWord('$(echo)')).toEqual(['a', 'b', 'c']);
});

test('quoted command sub is NOT word-split', async () => {
  const e = E({}, { runCommandSub: async () => 'a b c\n' });
  expect(await e.expandWord('"$(echo)"')).toEqual(['a b c']);
});

// ── $@ / $* / ${arr[@]} field semantics (SH-1) ───────────────────────────────

/** ShellEnv with positional params wired through getSpecial + getPositional. */
function mkPositional(pos: string[], hooks: Partial<ShellEnv> = {}): ShellEnv {
  return mkEnv({}, {
    getSpecial: (n) => {
      if (n === '@' || n === '*') return pos.join(' ');
      if (n === '#') return String(pos.length);
      if (/^[1-9][0-9]*$/.test(n)) return pos[parseInt(n, 10) - 1];
      return undefined;
    },
    getPositional: () => pos,
    ...hooks,
  });
}

test('"$@" expands to one field per positional (no splitting within)', async () => {
  const e = new Expander(mkPositional(['a', 'b c', 'd']));
  expect(await e.expandWord('"$@"')).toEqual(['a', 'b c', 'd']);
});

test('unquoted $@ field-splits each positional', async () => {
  const e = new Expander(mkPositional(['a', 'b c', 'd']));
  expect(await e.expandWord('$@')).toEqual(['a', 'b', 'c', 'd']);
});

test('"$*" joins all positionals into a single field (first char of IFS)', async () => {
  const e = new Expander(mkPositional(['a', 'b c', 'd']));
  expect(await e.expandWord('"$*"')).toEqual(['a b c d']);
});

test('"$@" with no positionals expands to zero fields', async () => {
  const e = new Expander(mkPositional([]));
  expect(await e.expandWord('"$@"')).toEqual([]);
});

test('"$@" with one positional yields one field', async () => {
  const e = new Expander(mkPositional(['only']));
  expect(await e.expandWord('"$@"')).toEqual(['only']);
});

test('"pre$@post" boundary: pre joins first, post joins last', async () => {
  const e = new Expander(mkPositional(['a', 'b', 'c']));
  expect(await e.expandWord('"pre$@post"')).toEqual(['prea', 'b', 'cpost']);
});

test('"pre$@post" with single positional joins both sides into one field', async () => {
  const e = new Expander(mkPositional(['x']));
  expect(await e.expandWord('"pre$@post"')).toEqual(['prexpost']);
});

test('"pre$@post" with no positionals yields the concatenated literal', async () => {
  const e = new Expander(mkPositional([]));
  expect(await e.expandWord('"pre$@post"')).toEqual(['prepost']);
});

test('"$@" via ${@} brace form preserves fields', async () => {
  const e = new Expander(mkPositional(['a', 'b c', 'd']));
  expect(await e.expandWord('"${@}"')).toEqual(['a', 'b c', 'd']);
});

test('"$*" via ${*} brace form joins into one field', async () => {
  const e = new Expander(mkPositional(['a', 'b c', 'd']));
  expect(await e.expandWord('"${*}"')).toEqual(['a b c d']);
});

test('"${arr[@]}" expands to one field per element (embedded spaces kept)', async () => {
  const e = E({}, { getArray: (n) => (n === 'a' ? ['1', '2 3', '4'] : undefined) });
  expect(await e.expandWord('"${a[@]}"')).toEqual(['1', '2 3', '4']);
});

test('unquoted ${arr[@]} field-splits each element', async () => {
  const e = E({}, { getArray: (n) => (n === 'a' ? ['1', '2 3', '4'] : undefined) });
  expect(await e.expandWord('${a[@]}')).toEqual(['1', '2', '3', '4']);
});

test('"${arr[*]}" joins all elements into one field', async () => {
  const e = E({}, { getArray: (n) => (n === 'a' ? ['1', '2 3', '4'] : undefined) });
  expect(await e.expandWord('"${a[*]}"')).toEqual(['1 2 3 4']);
});

test('"pre${arr[@]}post" boundary semantics', async () => {
  const e = E({}, { getArray: (n) => (n === 'a' ? ['1', '2', '3'] : undefined) });
  expect(await e.expandWord('"pre${a[@]}post"')).toEqual(['pre1', '2', '3post']);
});

// ── glob ──────────────────────────────────────────────────────────────────

test('glob * matches files in a directory', async () => {
  const e = E({}, {
    listDir: async (dir) => (dir === '/' || dir === '.' ? ['a.txt', 'b.txt', 'c.log'] : undefined),
  });
  expect(await e.expandWord('*.txt')).toEqual(['a.txt', 'b.txt']);
});

test('unmatched glob stays literal', async () => {
  const e = E({}, { listDir: async () => ['a.txt'] });
  expect(await e.expandWord('*.zzz')).toEqual(['*.zzz']);
});
