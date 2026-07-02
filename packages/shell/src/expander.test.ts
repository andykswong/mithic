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

test('${ref:=x} default-assign through a nameref writes the target, not the ref name', async () => {
  // A faithful nameref env: get/has/set all dereference `ref` → `target`,
  // mirroring the real Environment (which derefs centrally in set()).
  const vars: Record<string, string> = {};
  const deref = (n: string) => (n === 'ref' ? 'target' : n);
  const env = {
    get: (n: string) => vars[deref(n)],
    set: (n: string, v: string) => { vars[deref(n)] = v; },
    has: (n: string) => deref(n) in vars,
    getSpecial: () => undefined,
    runCommandSub: async () => '',
    listDir: async () => undefined,
    statPath: async () => undefined,
    resolveNameref: (n: string) => (n === 'ref' ? 'target' : undefined),
  } as unknown as ShellEnv;
  const e = new Expander(env);
  expect(await e.expandWord('${ref:=hi}')).toEqual(['hi']);
  expect(vars.target).toBe('hi');
  expect(vars.ref).toBeUndefined();
});

test('${var:=x} on a readonly var warns, does NOT write, but still yields the word', async () => {
  const warnings: string[] = [];
  const env = mkEnv({}, {
    isReadonly: (n) => n === 'V',
    warn: (m) => { warnings.push(m); },
  }) as ShellEnv & { _env: Record<string, string> };
  const e = new Expander(env);
  expect(await e.expandWord('${V:=hi}')).toEqual(['hi']);
  expect(env._env.V).toBeUndefined(); // not written
  expect(warnings.join('\n')).toMatch(/V: readonly variable/);
});

test('${var=x} (no-colon) on a readonly var warns, skips write, yields the word', async () => {
  const warnings: string[] = [];
  const env = mkEnv({}, {
    isReadonly: (n) => n === 'V',
    warn: (m) => { warnings.push(m); },
  }) as ShellEnv & { _env: Record<string, string> };
  const e = new Expander(env);
  expect(await e.expandWord('${V=hi}')).toEqual(['hi']);
  expect(env._env.V).toBeUndefined();
  expect(warnings.join('\n')).toMatch(/V: readonly variable/);
});

test('${var:=x} default-assign still writes a non-readonly var', async () => {
  const warnings: string[] = [];
  const env = mkEnv({}, {
    isReadonly: () => false,
    warn: (m) => { warnings.push(m); },
  }) as ShellEnv & { _env: Record<string, string> };
  const e = new Expander(env);
  expect(await e.expandWord('${V:=hi}')).toEqual(['hi']);
  expect(env._env.V).toBe('hi');
  expect(warnings).toEqual([]);
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

test('${#@} and ${#*} return positional count, not joined-string length (SH-2)', async () => {
  const e = new Expander(mkPositional(['a', 'bb', 'ccc'])); // joined length would be 8
  expect(await e.expandWord('${#@}')).toEqual(['3']);
  expect(await e.expandWord('${#*}')).toEqual(['3']);
});

test('${#arr[@]} and ${#arr[*]} return element count', async () => {
  const e = E({}, { getArray: (n) => (n === 'a' ? ['1', '2 3', '4'] : undefined) });
  expect(await e.expandWord('${#a[@]}')).toEqual(['3']);
  expect(await e.expandWord('${#a[*]}')).toEqual(['3']);
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

// ── ${var@Q} parameter transform (quote for re-input) ────────────────────────

test('${var@Q} quotes the value for safe re-input', async () => {
  const e = E({ x: 'a b' });
  expect(await e.expandWord('"${x@Q}"')).toEqual(["'a b'"]);
});

test('${var@Q} single-quotes even a safe word (bash 5: printf %q leaves bare, @Q quotes)', async () => {
  const e = E({ x: 'abc.txt' });
  expect(await e.expandWord('${x@Q}')).toEqual(["'abc.txt'"]);
});

test('${var@Q} does not break ${arr[@]} expansion', async () => {
  const e = E({}, { getArray: (n) => (n === 'a' ? ['1', '2 3', '4'] : undefined) });
  expect(await e.expandWord('"${a[@]}"')).toEqual(['1', '2 3', '4']);
});

test('${var@U} uppercases all characters', async () => {
  const e = E({ x: 'abc' });
  expect(await e.expandWord('${x@U}')).toEqual(['ABC']);
});

test('${var@u} uppercases the first character only', async () => {
  const e = E({ x: 'abc' });
  expect(await e.expandWord('${x@u}')).toEqual(['Abc']);
});

test('${var@L} lowercases all characters', async () => {
  const e = E({ x: 'ABC' });
  expect(await e.expandWord('${x@L}')).toEqual(['abc']);
});

test('${var@E} expands ANSI-C backslash escapes', async () => {
  const e = E({ x: 'a\\tb' });
  expect(await e.expandWord('"${x@E}"')).toEqual(['a\tb']);
});

// ── ${var@A} declare-statement reconstruction (bash-5 format) ────────────────

test('${var@A} reconstructs a scalar declare (bash-5 double-quoted value)', async () => {
  const e = E({ x: 'hello world' });
  expect(await e.expandWord('"${x@A}"')).toEqual(['declare -- x="hello world"']);
});

test('${var@A} double-quotes even a safe scalar value (matches bash-5)', async () => {
  const e = E({ x: 'plain' });
  expect(await e.expandWord('"${x@A}"')).toEqual(['declare -- x="plain"']);
});

test('${var@A} on a readonly scalar adds -r', async () => {
  const e = E({ x: 'v' }, { attrFlags: (n) => (n === 'x' ? 'r' : '') });
  expect(await e.expandWord('"${x@A}"')).toEqual(['declare -r x="v"']);
});

test('${arr[@]@A} reconstructs an indexed-array declare', async () => {
  // The WHOLE-array reconstruction needs the explicit [@] subscript; a BARE
  // ${arr@A} is element [0] (bash: $arr == ${arr[0]}), tested separately below.
  const e = E({}, { getArray: (n) => (n === 'arr' ? ['a', 'b c'] : undefined) });
  expect(await e.expandWord('"${arr[@]@A}"')).toEqual(['declare -a arr=([0]="a" [1]="b c")']);
});

test('${arr[@]@A} on a readonly indexed array combines flags as -ar', async () => {
  const e = E({}, {
    getArray: (n) => (n === 'arr' ? ['a'] : undefined),
    attrFlags: (n) => (n === 'arr' ? 'ar' : ''),
  });
  expect(await e.expandWord('"${arr[@]@A}"')).toEqual(['declare -ar arr=([0]="a")']);
});

test('${map[@]@A} reconstructs an assoc-array declare', async () => {
  const e = E({}, {
    getAssoc: (n) => (n === 'map' ? new Map([['k', 'v'], ['x', 'y z']]) : undefined),
  });
  expect(await e.expandWord('"${map[@]@A}"')).toEqual(['declare -A map=([k]="v" [x]="y z")']);
});

test('a BARE array-name transform operates on element [0] (bash: $a == ${a[0]})', async () => {
  const arr = ['a', 'b c'];
  const e = E({}, {
    getArray: (n) => (n === 'arr' ? arr : undefined),
    attrFlags: (n) => (n === 'arr' ? 'a' : ''),
  });
  expect(await e.expandWord('"${arr@A}"')).toEqual(["declare -a arr='a'"]); // element 0, @Q-quoted
  expect(await e.expandWord('${arr@Q}')).toEqual(["'a'"]);
  expect(await e.expandWord('${arr@K}')).toEqual(["'a'"]);
});

test('${ref@A} reconstructs a nameref declare', async () => {
  const e = E({ ref: 'ignored' }, {
    attrFlags: (n) => (n === 'ref' ? 'n' : ''),
    resolveNameref: (n) => (n === 'ref' ? 'target' : undefined),
  } as Partial<ShellEnv>);
  expect(await e.expandWord('${ref@A}')).toEqual(['declare', '-n', 'ref=target']);
});

test('${var@A} of an unset variable is empty', async () => {
  const e = E({});
  expect(await e.expandWord('${nope@A}')).toEqual(['']);
});

test('${arr[@]@A} double-quote-escapes special chars in array elements', async () => {
  const e = E({}, { getArray: (n) => (n === 'arr' ? ['a"b', 'c\\d', 'e$f'] : undefined) });
  expect(await e.expandWord('"${arr[@]@A}"')).toEqual([
    'declare -a arr=([0]="a\\"b" [1]="c\\\\d" [2]="e\\$f")',
  ]);
});

// ── ${var@P} prompt-string expansion ─────────────────────────────────────────

test('${var@P} expands prompt escapes (\\u@\\h)', async () => {
  const e = E({ ps: '\\u@\\h', USER: 'ada', HOSTNAME: 'box.example.com' });
  expect(await e.expandWord('${ps@P}')).toEqual(['ada@box']);
});

test('${var@P} expands \\w with HOME collapsed to ~', async () => {
  const e = E({ ps: '\\w', HOME: '/home/ada' }, { cwd: '/home/ada/work' });
  expect(await e.expandWord('${ps@P}')).toEqual(['~/work']);
});

// ── ${var@K} / ${var@k} associative key-value formatting ─────────────────────

test('${map[@]@K} produces key-value pairs (value always quoted, safe key bare)', async () => {
  const e = E({}, {
    getAssoc: (n) => (n === 'map' ? new Map([['k1', 'v1'], ['k 2', 'v 2']]) : undefined),
  });
  // Safe key `k1` stays bare; key `k 2` (has a space) is double-quoted; values always quoted.
  expect(await e.expandWord('"${map[@]@K}"')).toEqual(['k1 "v1" "k 2" "v 2"']);
});

test('${map[@]@k} produces unquoted key-value words', async () => {
  const e = E({}, {
    getAssoc: (n) => (n === 'map' ? new Map([['k1', 'v1'], ['k2', 'v2']]) : undefined),
  });
  expect(await e.expandWord('${map[@]@k}')).toEqual(['k1', 'v1', 'k2', 'v2']);
});

test('${arr[@]@K} on an indexed array pairs indices with values', async () => {
  const e = E({}, { getArray: (n) => (n === 'arr' ? ['a', 'b c'] : undefined) });
  expect(await e.expandWord('"${arr[@]@K}"')).toEqual(['0 "a" 1 "b c"']);
});

test('${var@a} returns attribute flags (readonly → r)', async () => {
  const e = E({ x: 'v' }, { attrFlags: (n) => (n === 'x' ? 'r' : '') });
  expect(await e.expandWord('${x@a}')).toEqual(['r']);
});

test('${var@a} of a plain scalar is empty', async () => {
  const e = E({ y: 'v' }, { attrFlags: () => '' });
  expect(await e.expandWord('${y@a}')).toEqual(['']);
});

test('${var@a} without an attrFlags hook is empty', async () => {
  const e = E({ z: 'v' });
  expect(await e.expandWord('${z@a}')).toEqual(['']);
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
