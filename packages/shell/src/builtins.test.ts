/* eslint-disable @typescript-eslint/no-explicit-any -- builtin tests use an ad-hoc ctx shape */
import { expect, test } from 'vitest';
import { BUILTINS, runBuiltin } from './builtins.ts';

test('cd updates cwd; pwd reports it', async () => {
  const ctx: any = { cwd: '/', env: {}, stdout: [] as string[], write: (s: string) => ctx.stdout.push(s) };
  await runBuiltin('cd', ['/tmp'], ctx);
  expect(ctx.cwd).toBe('/tmp');
  await runBuiltin('pwd', [], ctx);
  expect(ctx.stdout.join('')).toContain('/tmp');
});

test('export sets an env var', async () => {
  const ctx: any = { cwd: '/', env: {}, write: () => {} };
  await runBuiltin('export', ['FOO=bar'], ctx);
  expect(ctx.env.FOO).toBe('bar');
});

test('echo writes args; true/false set exit code', async () => {
  const ctx: any = { cwd: '/', env: {}, out: '', write: (s: string) => (ctx.out += s) };
  await runBuiltin('echo', ['hello', 'world'], ctx);
  expect(ctx.out).toBe('hello world\n');
  expect(await runBuiltin('true', [], ctx)).toBe(0);
  expect(await runBuiltin('false', [], ctx)).toBe(1);
});

test('BUILTINS lists the documented set', () => {
  for (const b of ['cd', 'pwd', 'export', 'unset', 'echo', 'true', 'false', 'exit', 'test', 'eval']) {
    expect(BUILTINS).toContain(b);
  }
});

// ── echo -e escapes (octal/hex/\e) routed through interpretEscapes ───────────

/** Run echo and return what it wrote to stdout. */
async function echo(...args: string[]): Promise<string> {
  let out = '';
  const ctx: any = { cwd: '/', env: {}, write: (s: string) => (out += s) };
  await runBuiltin('echo', args, ctx);
  return out;
}

test('echo -e interprets octal \\033 / \\007 (ANSI + BEL)', async () => {
  expect(await echo('-e', '\\033[1;35mX\\033[0m')).toBe('\x1b[1;35mX\x1b[0m\n');
  expect(await echo('-e', '\\007')).toBe('\x07\n');
});

test('echo -e interprets \\e as ESC', async () => {
  expect(await echo('-e', '\\e[0m')).toBe('\x1b[0m\n');
});

test('echo -e interprets \\xHH hex', async () => {
  expect(await echo('-e', '\\x41')).toBe('A\n');
});

test('echo -e still handles \\n \\t \\\\ and -n suppresses newline', async () => {
  expect(await echo('-e', 'a\\tb\\nc')).toBe('a\tb\nc\n');
  expect(await echo('-e', 'x\\\\y')).toBe('x\\y\n');
  expect(await echo('-ne', 'no-newline')).toBe('no-newline');
});

test('echo WITHOUT -e prints escapes literally', async () => {
  expect(await echo('\\033[1;35mX')).toBe('\\033[1;35mX\n');
  expect(await echo('a\\tb')).toBe('a\\tb\n');
});

// ── printf (SH-3) ────────────────────────────────────────────────────────────

/** Run printf and return what it wrote to STDOUT (diagnostics go to a separate sink). */
async function printf(...args: string[]): Promise<string> {
  let out = '';
  const ctx: any = { cwd: '/', env: {}, write: (s: string) => (out += s), writeErr: () => {} };
  await runBuiltin('printf', args, ctx);
  return out;
}

test('printf basic %s %d %% and \\n escapes', async () => {
  expect(await printf('%s=%d%%\n', 'x', '5')).toBe('x=5%\n');
});

test('printf format-string RECYCLING over extra args', async () => {
  expect(await printf('%s\n', 'a', 'b', 'c')).toBe('a\nb\nc\n');
  expect(await printf('%s-%s ', 'a', 'b', 'c', 'd')).toBe('a-b c-d ');
});

test('printf missing args treat %s as empty and %d as 0', async () => {
  expect(await printf('[%s][%d]')).toBe('[][0]');
});

test('printf width and left-justify for %s', async () => {
  expect(await printf('[%5s]', 'ab')).toBe('[   ab]');
  expect(await printf('[%-5s]', 'ab')).toBe('[ab   ]');
});

test('printf precision truncates %s', async () => {
  expect(await printf('[%.3s]', 'abcdef')).toBe('[abc]');
});

test('printf %d width, zero-pad, and sign', async () => {
  expect(await printf('[%5d]', '42')).toBe('[   42]');
  expect(await printf('[%05d]', '42')).toBe('[00042]');
  expect(await printf('[%-5d]', '42')).toBe('[42   ]');
  expect(await printf('[%+d]', '42')).toBe('[+42]');
});

test('printf %x %X %o hex/octal', async () => {
  expect(await printf('%x', '255')).toBe('ff');
  expect(await printf('%X', '255')).toBe('FF');
  expect(await printf('%o', '8')).toBe('10');
  expect(await printf('[%04x]', '255')).toBe('[00ff]');
});

test('printf %f %e %g floats with precision', async () => {
  expect(await printf('%.2f', '3.14159')).toBe('3.14');
  expect(await printf('%.0f', '2.7')).toBe('3');
  expect(await printf('%f', '1')).toBe('1.000000');
  expect(await printf('%e', '12345')).toBe('1.234500e+04');
});

test('printf %.*f with a negative dynamic precision is unset (default 6), not a crash', async () => {
  expect(await printf('%.*f\n', '-1', '3.14159')).toBe('3.141590\n');
});

test('printf %.*f with a valid dynamic precision applies it', async () => {
  expect(await printf('%.*f\n', '2', '3.14159')).toBe('3.14\n');
});

test('printf %.*s/%.*d negative dynamic precision is safe (treated as unset)', async () => {
  expect(await printf('[%.*s]', '-1', 'abcdef')).toBe('[abcdef]');
  expect(await printf('[%.*d]', '-1', '42')).toBe('[42]');
});

test('printf %c prints first char of string arg', async () => {
  expect(await printf('%c', 'hello')).toBe('h');
});

test('printf %b interprets backslash escapes in the ARG', async () => {
  expect(await printf('%b', 'a\\tb')).toBe('a\tb');
});

test('printf interprets \\xNN and \\0nn in the FORMAT', async () => {
  expect(await printf('\\x41\\x42')).toBe('AB');
  expect(await printf('\\101')).toBe('A'); // octal 101 = 'A'
});

test('printf integer arg accepts hex 0x and char code \'c', async () => {
  expect(await printf('%d', '0xff')).toBe('255');
  expect(await printf('%d', '\'A')).toBe('65');
});

test('printf %i is an alias for %d', async () => {
  expect(await printf('%i', '7')).toBe('7');
});

test('printf %q backslash-escapes shell-special chars', async () => {
  expect(await printf('%q\n', 'a b')).toBe('a\\ b\n');
});

test('printf %q leaves a safe word bare', async () => {
  expect(await printf('%q', 'hello')).toBe('hello');
});

test('printf %q uses ANSI-C $\'…\' for control chars', async () => {
  expect(await printf('%q', 'a\nb')).toBe('$\'a\\nb\'');
});

test('printf %q honors width (right-justified)', async () => {
  // `a b` → `a\ b` (4 chars) → %6q right-pads to 6.
  expect(await printf('[%6q]', 'a b')).toBe('[  a\\ b]');
});

test('printf %q empty string', async () => {
  expect(await printf('%q', '')).toBe('\'\'');
});

// ── printf round-half-to-EVEN (banker's rounding), matching C/bash ───────────
// JS toFixed/toExponential round exact ties half-AWAY-from-zero; bash/C round
// exact ties to the nearest EVEN digit. Only exact-half values differ; every
// other value is unchanged. Verified byte-exact against bash 5.3.15.

test('printf %.0f rounds exact .5 ties to even (2.5→2, 3.5→4, 0.5→0, 1.5→2)', async () => {
  expect(await printf('%.0f', '2.5')).toBe('2');
  expect(await printf('%.0f', '3.5')).toBe('4');
  expect(await printf('%.0f', '0.5')).toBe('0');
  expect(await printf('%.0f', '1.5')).toBe('2');
  expect(await printf('%.0f', '4.5')).toBe('4');
});

test('printf %.0f ties-to-even honors sign (-1.5→-2, -2.5→-2, -0.5→-0)', async () => {
  expect(await printf('%.0f', '-1.5')).toBe('-2');
  expect(await printf('%.0f', '-2.5')).toBe('-2');
  expect(await printf('%.0f', '-0.5')).toBe('-0');
});

test('printf %.1f rounds using the EXACT double, not the decimal literal', async () => {
  // 2.25 is exactly representable → tie → down to even 2.2; 2.35 as a double is
  // slightly > 2.35 → up to 2.4 (both match bash, neither is a naive .5 rule).
  expect(await printf('%.1f', '2.25')).toBe('2.2');
  expect(await printf('%.1f', '2.35')).toBe('2.4');
  expect(await printf('%.1f', '0.45')).toBe('0.5');
});

test('printf %.2f ties-to-even (0.125→0.12, 0.135→0.14)', async () => {
  expect(await printf('%.2f', '0.125')).toBe('0.12');
  expect(await printf('%.2f', '0.135')).toBe('0.14');
});

test('printf %e rounds ties to even (2.5→2e+00, 1.25→1.2e+00, 1.35→1.4e+00)', async () => {
  expect(await printf('%.0e', '2.5')).toBe('2e+00');
  expect(await printf('%.0e', '1.5')).toBe('2e+00');
  expect(await printf('%.1e', '1.25')).toBe('1.2e+00');
  expect(await printf('%.1e', '1.35')).toBe('1.4e+00');
});

test('printf %g rounds ties to even (%.2g 1.25→1.2, 1.35→1.4)', async () => {
  expect(await printf('%.2g', '1.25')).toBe('1.2');
  expect(await printf('%.2g', '1.35')).toBe('1.4');
  expect(await printf('%.2g', '12500')).toBe('1.2e+04');
});

test('printf non-tie float values are unchanged by ties-to-even', async () => {
  expect(await printf('%.2f', '3.14159')).toBe('3.14');
  expect(await printf('%.0f', '2.7')).toBe('3');
  expect(await printf('%e', '12345')).toBe('1.234500e+04');
  expect(await printf('%.4e', '0.00001')).toBe('1.0000e-05');
});

// ── printf %# alt-flag: force a decimal point on %f/%e (bash) ─────────────────

test('printf %#.0f forces a trailing decimal point', async () => {
  expect(await printf('%#.0f', '3')).toBe('3.');
});

test('printf %#.0e forces a trailing decimal point in the mantissa', async () => {
  expect(await printf('%#.0e', '3')).toBe('3.e+00');
});

test('printf %#g keeps trailing zeros (already correct) and %g still trims', async () => {
  expect(await printf('%#g', '3')).toBe('3.00000');
  expect(await printf('%g', '3')).toBe('3');
});

test('printf %#g forces a trailing point on integer-valued output', async () => {
  expect(await printf('%#g', '100000')).toBe('100000.');
  expect(await printf('%#.3g', '100')).toBe('100.');
  expect(await printf('%#.1g', '5')).toBe('5.');
  expect(await printf('%#g', '200000')).toBe('200000.');
  expect(await printf('%#.1g', '1e20')).toBe('1.e+20');
  expect(await printf('%#G', '100000')).toBe('100000.');
});

test('printf hex-integer and hex-float args to a float conversion (C strtold)', async () => {
  expect(await printf('%f', '0x10')).toBe('16.000000');
  expect(await printf('%f', '0xff')).toBe('255.000000');
  expect(await printf('%f', '0x1.8p3')).toBe('12.000000'); // 1.5 * 2^3
  expect(await printf('%g', '0x1p4')).toBe('16');
});

test('printf inf/nan literal float args are formatted (not "invalid number")', async () => {
  expect(await printf('%f', 'inf')).toBe('inf');
  expect(await printf('%f', '-inf')).toBe('-inf');
  expect(await printf('%f', 'nan')).toBe('nan');
  expect(await printf('%f', '-nan')).toBe('nan'); // nan has no sign
  expect(await printf('%f', 'infinity')).toBe('inf');
  expect(await printf('%f', 'INF')).toBe('inf'); // case-insensitive parse
  expect(await printf('%e', 'inf')).toBe('inf');
  expect(await printf('%g', 'nan')).toBe('nan');
});

test('printf inf/nan uppercase for %F/%E/%G; sign + width honored, zero-fill ignored', async () => {
  expect(await printf('%F', 'inf')).toBe('INF');
  expect(await printf('%E', 'nan')).toBe('NAN');
  expect(await printf('%G', '-inf')).toBe('-INF');
  expect(await printf('%+f', 'inf')).toBe('+inf');
  expect(await printf('% f', 'inf')).toBe(' inf');
  expect(await printf('[%10f]', 'inf')).toBe('[       inf]');
  expect(await printf('[%-10f]', 'inf')).toBe('[inf       ]');
  expect(await printf('[%010f]', 'inf')).toBe('[       inf]'); // NOT zero-filled
});

test('printf %F finite value is %f with the same body', async () => {
  expect(await printf('%F', '3')).toBe('3.000000');
  expect(await printf('%.2F', '3.14159')).toBe('3.14');
});

test('printf %S / %C alias %s / %c (wide-string/char variants)', async () => {
  expect(await printf('%S', 'foo')).toBe('foo');
  expect(await printf('%.2S', 'hello')).toBe('he');
  expect(await printf('[%5S]', 'hi')).toBe('[   hi]');
  expect(await printf('%C', 'foo')).toBe('f');
});

test('printf %a / %A C99 hex float', async () => {
  expect(await printf('%a', '1.5')).toBe('0x1.8p+0');
  expect(await printf('%a', '1.0')).toBe('0x1p+0');
  expect(await printf('%a', '0.5')).toBe('0x1p-1');
  expect(await printf('%a', '0')).toBe('0x0p+0');
  expect(await printf('%a', '255')).toBe('0x1.fep+7');
  expect(await printf('%a', '0.1')).toBe('0x1.999999999999ap-4');
  expect(await printf('%A', '1.5')).toBe('0X1.8P+0');
  // precision = fixed number of hex fraction digits (rounded half-to-even)
  expect(await printf('%.2a', '1.5')).toBe('0x1.80p+0');
  expect(await printf('%.0a', '1.5')).toBe('0x1p+0');
  // inf/nan share the float path
  expect(await printf('%a', 'inf')).toBe('inf');
  expect(await printf('%A', 'nan')).toBe('NAN');
});

test('printf %a zero-fill pads between 0x and mantissa; %#a forces a point; %+ honored', async () => {
  expect(await printf('%010a', '1.5')).toBe('0x001.8p+0');
  expect(await printf('[%-10a]', '1.5')).toBe('[0x1.8p+0  ]');
  expect(await printf('%#a', '1')).toBe('0x1.p+0');
  expect(await printf('%#.0a', '1')).toBe('0x1.p+0');
  expect(await printf('%+010a', '1.5')).toBe('+0x01.8p+0');
});

test('printf %a NORMALIZES subnormals to a leading 1 (not 0x0.…)', async () => {
  expect(await printf('%a', '5e-324')).toBe('0x1p-1074'); // smallest subnormal
  expect(await printf('%a', '2.5e-323')).toBe('0x1.4p-1072');
});

test('printf float ERANGE: overflow → inf and subnormal underflow → exit 1 + Result too large', async () => {
  let err = '';
  const ctx: any = { cwd: '/', env: {}, write: () => {}, writeErr: (s: string) => (err += s) };
  expect(await runBuiltin('printf', ['%f', '1e400'], ctx)).toBe(1);
  expect(err).toMatch(/Result too large/);
  err = '';
  const ctx2: any = { cwd: '/', env: {}, write: () => {}, writeErr: (s: string) => (err += s) };
  expect(await runBuiltin('printf', ['%g', '5e-324'], ctx2)).toBe(1);
  expect(err).toMatch(/Result too large/);
});

test('printf float rejects an incomplete hex prefix and trailing content', async () => {
  let err = '';
  const ctx: any = { cwd: '/', env: {}, write: () => {}, writeErr: (s: string) => (err += s) };
  expect(await runBuiltin('printf', ['%f', '0x.'], ctx)).toBe(1);
  expect(err).toMatch(/invalid hex number/);
  err = '';
  const ctx2: any = { cwd: '/', env: {}, write: () => {}, writeErr: (s: string) => (err += s) };
  expect(await runBuiltin('printf', ['%f', '1.5 '], ctx2)).toBe(1);
  expect(err).toMatch(/invalid number/);
});

test('printf float keeps a normal magnitude with NO error (no false ERANGE)', async () => {
  let err = '';
  const ctx: any = { cwd: '/', env: {}, write: () => {}, writeErr: (s: string) => (err += s) };
  expect(await runBuiltin('printf', ['%f', '1.5'], ctx)).toBe(0);
  expect(await runBuiltin('printf', ['%e', '1e300'], ctx)).toBe(0);
  expect(await runBuiltin('printf', ['%f', '0'], ctx)).toBe(0);
  expect(err).toBe('');
});

test('printf %n consumes no arg and emits nothing (exit 0)', async () => {
  let out = ''; let err = '';
  const ctx: any = { cwd: '/', env: {}, write: (s: string) => (out += s), writeErr: (s: string) => (err += s) };
  const code = await runBuiltin('printf', ['a%nb'], ctx);
  expect(out).toBe('ab');
  expect(err).toBe('');
  expect(code).toBe(0);
});

test('printf infinite RESULT from a huge magnitude prints inf, not JS Infinity', async () => {
  expect(await printf('%f', '1e309')).toBe('inf');
  expect(await printf('%g', '1e400')).toBe('inf');
  expect(await printf('%e', '-1e400')).toBe('-inf');
});

// ── printf invalid / missing format character → exit 1 + diagnostic ──────────

test('printf bare trailing % is "missing format character" (exit 1, prints prefix)', async () => {
  let out = ''; let err = '';
  const ctx: any = { cwd: '/', env: {}, write: (s: string) => (out += s), writeErr: (s: string) => (err += s) };
  const code = await runBuiltin('printf', ['a%'], ctx);
  expect(out).toBe('a');
  expect(err).toMatch(/missing format character/);
  expect(code).toBe(1);
});

test('printf a lone length-modifier with no conversion is "missing format character"', async () => {
  // `z` is a C length modifier (like `l`/`ll`/`L`): consumed then a conversion is
  // expected. `%z` at end of format = whole `%z` is the "missing" spec.
  let out = ''; let err = '';
  const ctx: any = { cwd: '/', env: {}, write: (s: string) => (out += s), writeErr: (s: string) => (err += s) };
  const code = await runBuiltin('printf', ['a%z'], ctx);
  expect(out).toBe('a');
  expect(err).toMatch(/`%z': missing format character/);
  expect(code).toBe(1);
});

test('printf length modifiers l/ll/z/j/L/hh are consumed and ignored before a conversion', async () => {
  expect(await printf('%ld', '5')).toBe('5');
  expect(await printf('%lld', '5')).toBe('5');
  expect(await printf('%zd', '5')).toBe('5');
  expect(await printf('%jd', '5')).toBe('5');
  expect(await printf('%Lf', '2.5')).toBe('2.500000');
  expect(await printf('%lx', '255')).toBe('ff');
  // `%zb` = z-modifier + %b conversion (of an empty arg)
  expect(await printf('a%zb')).toBe('a');
});

test('printf an INVALID conversion char stops output + errors (X%dY%zZ → invalid `Z`)', async () => {
  // `z` is a modifier, `Z` is not a valid conversion → "invalid format character",
  // and (like bash) all further output stops after the last good directive.
  let out = ''; let err = '';
  const ctx: any = { cwd: '/', env: {}, write: (s: string) => (out += s), writeErr: (s: string) => (err += s) };
  const code = await runBuiltin('printf', ['X%dY%zZ', '5'], ctx);
  expect(out).toBe('X5Y');
  expect(err).toMatch(/`Z': invalid format character/);
  expect(code).toBe(1);
});

// ── A2: readonly enforcement on a getopts variable ──────────────────────────

test('getopts into a readonly variable is rejected (status 1, no write)', async () => {
  let err = '';
  const ctx: any = {
    cwd: '/', env: { OPTIND: '1' }, write: () => {}, writeErr: (s: string) => (err += s),
    state: { positional: ['-a'], isReadonly: (n: string) => n === 'opt' },
  };
  const code = await runBuiltin('getopts', ['ab', 'opt'], ctx);
  expect(code).toBe(1);
  expect(err).toMatch(/readonly variable/);
  expect(ctx.env.opt).toBeUndefined();
});

test('getopts into a writable variable still parses normally', async () => {
  const ctx: any = {
    cwd: '/', env: { OPTIND: '1' }, write: () => {},
    state: { positional: ['-a'], isReadonly: () => false },
  };
  const code = await runBuiltin('getopts', ['ab', 'opt'], ctx);
  expect(code).toBe(0);
  expect(ctx.env.opt).toBe('a');
});

// ── A5: hash builtin (sandbox-inert) ─────────────────────────────────────────

test('hash with no args succeeds (empty table)', async () => {
  let out = ''; let err = '';
  const ctx: any = { cwd: '/', env: {}, write: (s: string) => (out += s), writeErr: (s: string) => (err += s) };
  expect(await runBuiltin('hash', [], ctx)).toBe(0);
  expect(out).toBe('');
  expect(err).toBe('');
});

test('hash -r succeeds (clear is a no-op in the sandbox)', async () => {
  const ctx: any = { cwd: '/', env: {}, write: () => {} };
  expect(await runBuiltin('hash', ['-r'], ctx)).toBe(0);
});

test('hash NAME succeeds', async () => {
  const ctx: any = { cwd: '/', env: {}, write: () => {} };
  expect(await runBuiltin('hash', ['ls'], ctx)).toBe(0);
});

test('hash with an unknown flag fails with status 2 + usage', async () => {
  let err = '';
  const ctx: any = { cwd: '/', env: {}, write: () => {}, writeErr: (s: string) => (err += s) };
  expect(await runBuiltin('hash', ['-z'], ctx)).toBe(2);
  expect(err).toMatch(/invalid option/);
});

test('hash accepts clustered valid flags (-lr, -dt)', async () => {
  const ctx: any = { cwd: '/', env: {}, write: () => {}, writeErr: () => {} };
  expect(await runBuiltin('hash', ['-lr'], ctx)).toBe(0);
  expect(await runBuiltin('hash', ['-dt'], ctx)).toBe(0);
});

test('hash rejects a cluster containing an invalid flag (-lx → 2)', async () => {
  let err = '';
  const ctx: any = { cwd: '/', env: {}, write: () => {}, writeErr: (s: string) => (err += s) };
  expect(await runBuiltin('hash', ['-lx'], ctx)).toBe(2);
  expect(err).toMatch(/invalid option/);
});

test('hash is listed in BUILTINS', () => {
  expect(BUILTINS).toContain('hash');
});

// ── A6: compgen / complete / compopt ─────────────────────────────────────────

test('compgen -W filters a wordlist by prefix', async () => {
  let out = '';
  const ctx: any = { cwd: '/', env: {}, write: (s: string) => (out += s) };
  expect(await runBuiltin('compgen', ['-W', 'foo foobar baz', 'fo'], ctx)).toBe(0);
  expect(out).toBe('foo\nfoobar\n');
});

test('compgen -W with no matches exits 1', async () => {
  let out = '';
  const ctx: any = { cwd: '/', env: {}, write: (s: string) => (out += s) };
  expect(await runBuiltin('compgen', ['-W', 'foo bar', 'zzz'], ctx)).toBe(1);
  expect(out).toBe('');
});

test('compgen -W with an empty prefix prints all words', async () => {
  let out = '';
  const ctx: any = { cwd: '/', env: {}, write: (s: string) => (out += s) };
  expect(await runBuiltin('compgen', ['-W', 'a b c'], ctx)).toBe(0);
  expect(out).toBe('a\nb\nc\n');
});

test('compgen -W honors a -- separator for the prefix operand', async () => {
  let out = '';
  const ctx: any = { cwd: '/', env: {}, write: (s: string) => (out += s) };
  expect(await runBuiltin('compgen', ['-W', 'a ab', '--', 'a'], ctx)).toBe(0);
  expect(out).toBe('a\nab\n');
});

test('compgen -W with -- and a dash-prefixed prefix filters by that prefix', async () => {
  let out = '';
  const ctx: any = { cwd: '/', env: {}, write: (s: string) => (out += s) };
  // After `--`, a leading-dash token is the literal prefix, not an option.
  expect(await runBuiltin('compgen', ['-W', '-a -b xx', '--', '-a'], ctx)).toBe(0);
  expect(out).toBe('-a\n');
});

test('compgen -A function (no sandbox source) exits 1', async () => {
  let out = '';
  const ctx: any = { cwd: '/', env: {}, write: (s: string) => (out += s) };
  expect(await runBuiltin('compgen', ['-A', 'function'], ctx)).toBe(1);
  expect(out).toBe('');
});

test('complete and compopt are accepted (exit 0, no output)', async () => {
  let out = '';
  const ctx: any = { cwd: '/', env: {}, write: (s: string) => (out += s) };
  expect(await runBuiltin('complete', ['-W', 'a b', 'mycmd'], ctx)).toBe(0);
  expect(await runBuiltin('compopt', ['-o', 'nospace'], ctx)).toBe(0);
  expect(out).toBe('');
});

test('compgen/complete/compopt are listed in BUILTINS', () => {
  expect(BUILTINS).toContain('compgen');
  expect(BUILTINS).toContain('complete');
  expect(BUILTINS).toContain('compopt');
});

// ── WP-F: printf invalid-number diagnostics, dynamic width, %b \c, 32-bit note ─

/** Run printf capturing stdout, stderr, and exit status. */
async function printfR(...args: string[]): Promise<{ out: string; err: string; code: number }> {
  let out = '', err = '';
  const ctx: any = { cwd: '/', env: {}, write: (s: string) => (out += s), writeErr: (s: string) => (err += s) };
  const code = await runBuiltin('printf', args, ctx);
  return { out, err, code: code ?? 0 };
}

test('printf invalid number → value 0/leading digits + exit 1', async () => {
  const bad = await printfR('%d\n', 'abc');
  expect(bad.out).toBe('0\n');
  expect(bad.code).toBe(1);
  expect(bad.err).toMatch(/invalid number/);
  const partial = await printfR('%d\n', '12abc');
  expect(partial.out).toBe('12\n');
  expect(partial.code).toBe(1);
  // A clean number (leading whitespace allowed) is rc 0, no stderr.
  const ok = await printfR('%d\n', '  5');
  expect(ok.out).toBe('5\n');
  expect(ok.code).toBe(0);
  expect(ok.err).toBe('');
});

test('printf %*d negative dynamic width left-justifies', async () => {
  expect(await printf('[%*d]\n', '-5', '42')).toBe('[42   ]\n');
  expect(await printf('[%*d]\n', '5', '42')).toBe('[   42]\n');
});

test('printf %b \\c stops all further output', async () => {
  expect(await printf('%b', 'a\\cb')).toBe('a');
  expect(await printf('pre %b post\n', 'x\\cy')).toBe('pre x');
});

test('printf %.*f negative precision is unset (default 6)', async () => {
  expect(await printf('%.*f\n', '-1', '3.14159')).toBe('3.141590\n');
});

// printf uses 64-bit intmax_t/uintmax_t (BigInt), matching bash. Negatives to an
// unsigned/hex/octal conversion reinterpret at 64-bit width; a signed value out of
// [-2^63, 2^63-1] saturates and is a HARD ERROR (exit 1) but still prints the value.
test('printf %x/%X/%u/%o of -1 is 64-bit (bash intmax_t parity)', async () => {
  expect(await printf('%x\n', '-1')).toBe('ffffffffffffffff\n');
  expect(await printf('%X\n', '-1')).toBe('FFFFFFFFFFFFFFFF\n');
  expect(await printf('%u\n', '-1')).toBe('18446744073709551615\n');
  expect(await printf('%o\n', '-1')).toBe('1777777777777777777777\n');
});

test('printf %d of INTMAX_MAX/MIN is exact (no double-precision loss)', async () => {
  expect(await printf('%d\n', '9223372036854775807')).toBe('9223372036854775807\n');
  expect(await printf('%i\n', '-9223372036854775808')).toBe('-9223372036854775808\n');
});

test('printf %u unsigned wrap of small negatives has no error', async () => {
  const r = await printfR('%u\n', '-2');
  expect(r.out).toBe('18446744073709551614\n');
  expect(r.err).toBe('');
  expect(r.code).toBe(0);
  // A 64-bit hex literal fits uintmax exactly, no error.
  const h = await printfR('%u\n', '0xffffffffffffffff');
  expect(h.out).toBe('18446744073709551615\n');
  expect(h.err).toBe('');
  expect(h.code).toBe(0);
  // The low bound for unsigned convs is -(2^64-1): still in range, wraps to 1.
  const lo = await printfR('%u\n', '-18446744073709551615');
  expect(lo.out).toBe('1\n');
  expect(lo.err).toBe('');
  expect(lo.code).toBe(0);
});

test('printf out-of-range "Result too large" is an ERROR (exit 1) but prints saturated value', async () => {
  const over = await printfR('%d\n', '9223372036854775808'); // INTMAX_MAX + 1
  expect(over.out).toBe('9223372036854775807\n');
  expect(over.err).toMatch(/Result too large/);
  expect(over.code).toBe(1);
  // A too-large hex literal to a SIGNED conversion saturates to INTMAX_MAX, exit 1.
  const hx = await printfR('%d\n', '0xffffffffffffffff');
  expect(hx.out).toBe('9223372036854775807\n');
  expect(hx.code).toBe(1);
});

test('printf octal/hex parsing + invalid-octal/hex diagnostics (bash parity)', async () => {
  expect(await printf('%d\n', '010')).toBe('8\n');      // valid octal
  expect(await printf('%d\n', '007')).toBe('7\n');
  expect(await printf('%x\n', '0x1f')).toBe('1f\n');
  expect(await printf('%d\n', '\'A')).toBe('65\n');      // char-code, unclamped
  // 08/09/0778 are invalid octal → error, keep the leading valid-octal run.
  const o8 = await printfR('%d\n', '09');
  expect(o8.out).toBe('0\n'); expect(o8.code).toBe(1); expect(o8.err).toMatch(/invalid octal number/);
  const o778 = await printfR('%d\n', '0778');
  expect(o778.out).toBe('63\n'); expect(o778.code).toBe(1); // 0o77 = 63
  // partial hex keeps the parsed hex digits (0x1g → 1), error.
  const hg = await printfR('%d\n', '0x1g');
  expect(hg.out).toBe('1\n'); expect(hg.code).toBe(1); expect(hg.err).toMatch(/invalid hex number/);
});

test('printf invalid number exits 1 and keeps leading digits', async () => {
  const bad = await printfR('%d\n', 'abc');
  expect(bad.out).toBe('0\n');
  expect(bad.code).toBe(1);
  expect(bad.err).toMatch(/invalid number/);
  const partial = await printfR('%d\n', '12abc');
  expect(partial.out).toBe('12\n');
  expect(partial.code).toBe(1);
});

test('printf skips LEADING whitespace only; trailing content is invalid', async () => {
  expect(await printf('%d\n', ' 42')).toBe('42\n'); // leading ws OK
  const tw = await printfR('%d\n', '42 ');           // trailing ws → invalid, keeps 42
  expect(tw.out).toBe('42\n'); expect(tw.code).toBe(1); expect(tw.err).toMatch(/invalid number/);
});

test('printf %u/%x/%o underflow beyond -(2^64-1) saturates to UINTMAX_MAX (exit 1)', async () => {
  const u = await printfR('%u\n', '-18446744073709551616'); // -(2^64), just below range
  expect(u.out).toBe('18446744073709551615\n');
  expect(u.code).toBe(1);
  expect(u.err).toMatch(/Result too large/);
});

test('printf signed invalid hex/octal reports generic "invalid number" (bash)', async () => {
  const h = await printfR('%d\n', '-0x1g');
  expect(h.out).toBe('-1\n'); expect(h.code).toBe(1);
  expect(h.err).toMatch(/invalid number/); expect(h.err).not.toMatch(/hex/);
  const o = await printfR('%d\n', '-0778');
  expect(o.out).toBe('-63\n'); expect(o.code).toBe(1);
  expect(o.err).not.toMatch(/octal/);
});

test('printf %c of an empty argument emits a NUL byte', async () => {
  expect(await printf('[%c]', '')).toBe('[\0]');
});
