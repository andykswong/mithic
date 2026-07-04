import { expect, test, describe } from 'vitest';
import { exprCommand } from './expr.ts';
import type { CommandIO } from '../harness.ts';

function makeIO(args: string[]) {
  const stdin = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
  const outChunks: Uint8Array[] = [];
  const errChunks: Uint8Array[] = [];
  const stdout = new WritableStream<Uint8Array>({ write(c) { outChunks.push(c); } });
  const stderr = new WritableStream<Uint8Array>({ write(c) { errChunks.push(c); } });
  const decode = (chunks: Uint8Array[]): string => {
    let t = 0; for (const c of chunks) t += c.byteLength;
    const b = new Uint8Array(t); let o = 0;
    for (const c of chunks) { b.set(c, o); o += c.byteLength; }
    return new TextDecoder().decode(b);
  };
  return {
    io: { args, env: {}, cwd: '/', stdin, stdout, stderr, syscall: async () => ({}) } as CommandIO,
    out: () => decode(outChunks).trim(),
    err: () => decode(errChunks),
  };
}

describe('expr arithmetic', () => {
  test('addition', async () => {
    const h = makeIO(['expr', '3', '+', '4']);
    expect(await exprCommand(h.io)).toBe(0);
    expect(h.out()).toBe('7');
  });
  test('subtraction', async () => {
    const h = makeIO(['expr', '10', '-', '3']);
    expect(h.out()).toBe(''); // not yet called
    await exprCommand(h.io);
    expect(h.out()).toBe('7');
  });
  test('multiplication', async () => {
    const h = makeIO(['expr', '6', '*', '7']);
    await exprCommand(h.io);
    expect(h.out()).toBe('42');
  });
  test('integer division', async () => {
    const h = makeIO(['expr', '10', '/', '3']);
    await exprCommand(h.io);
    expect(h.out()).toBe('3');
  });
  test('modulo', async () => {
    const h = makeIO(['expr', '10', '%', '3']);
    await exprCommand(h.io);
    expect(h.out()).toBe('1');
  });
  test('division by zero exits 2', async () => {
    const h = makeIO(['expr', '1', '/', '0']);
    expect(await exprCommand(h.io)).toBe(2);
  });
});

describe('expr comparison', () => {
  test('equal true', async () => {
    const h = makeIO(['expr', '5', '=', '5']);
    await exprCommand(h.io);
    expect(h.out()).toBe('1');
  });
  test('not-equal', async () => {
    const h = makeIO(['expr', '5', '!=', '4']);
    await exprCommand(h.io);
    expect(h.out()).toBe('1');
  });
  test('less than', async () => {
    const h = makeIO(['expr', '3', '<', '5']);
    await exprCommand(h.io);
    expect(h.out()).toBe('1');
  });
  test('false comparison returns 0', async () => {
    const h = makeIO(['expr', '5', '<', '3']);
    const code = await exprCommand(h.io);
    expect(h.out()).toBe('0');
    expect(code).toBe(1); // exit 1 when result is 0
  });
});

describe('expr logic', () => {
  test('| returns left if non-zero', async () => {
    const h = makeIO(['expr', '5', '|', '0']);
    await exprCommand(h.io);
    expect(h.out()).toBe('5');
  });
  test('| returns right if left is zero', async () => {
    const h = makeIO(['expr', '0', '|', '9']);
    await exprCommand(h.io);
    expect(h.out()).toBe('9');
  });
  test('& returns left if both non-zero', async () => {
    const h = makeIO(['expr', '3', '&', '4']);
    await exprCommand(h.io);
    expect(h.out()).toBe('3');
  });
  test('& returns 0 if either is 0', async () => {
    const h = makeIO(['expr', '0', '&', '4']);
    await exprCommand(h.io);
    expect(h.out()).toBe('0');
  });
});

describe('expr string ops', () => {
  test('length', async () => {
    const h = makeIO(['expr', 'length', 'hello']);
    await exprCommand(h.io);
    expect(h.out()).toBe('5');
  });
  test('substr', async () => {
    const h = makeIO(['expr', 'substr', 'hello', '2', '3']);
    await exprCommand(h.io);
    expect(h.out()).toBe('ell');
  });
  test('index', async () => {
    const h = makeIO(['expr', 'index', 'abcde', 'ce']);
    await exprCommand(h.io);
    expect(h.out()).toBe('3'); // first char from 'ce' found at position 3
  });
});

describe('expr errors', () => {
  test('no operand exits 2', async () => {
    const h = makeIO(['expr']);
    expect(await exprCommand(h.io)).toBe(2);
  });
});

describe('expr GNU-parity gap fixes', () => {
  test('float arithmetic is a non-integer error (exit 2), not truncated', async () => {
    const h = makeIO(['expr', '1.5', '+', '2']);
    expect(await exprCommand(h.io)).toBe(2);
    expect(h.err()).toContain('non-integer argument');
  });

  test('non-numeric arithmetic operand is a non-integer error (exit 2)', async () => {
    const h = makeIO(['expr', 'abc', '+', '2']);
    expect(await exprCommand(h.io)).toBe(2);
    expect(h.err()).toContain('non-integer argument');
  });

  test('float on the right side of arithmetic errors too', async () => {
    const h = makeIO(['expr', '3', '+', '1.5']);
    expect(await exprCommand(h.io)).toBe(2);
  });

  test('multiplication by non-integer errors', async () => {
    const h = makeIO(['expr', '2', '*', 'x']);
    expect(await exprCommand(h.io)).toBe(2);
    expect(h.err()).toContain('non-integer argument');
  });

  test('missing operand after operator is a syntax error (exit 2)', async () => {
    const h = makeIO(['expr', '1', '+']);
    expect(await exprCommand(h.io)).toBe(2);
    expect(h.err()).toContain('missing argument after');
  });

  test('missing operand after comparison operator (exit 2)', async () => {
    const h = makeIO(['expr', '5', '<']);
    expect(await exprCommand(h.io)).toBe(2);
    expect(h.err()).toContain('missing argument after');
  });

  test('substr POS < 1 → empty string, exit 1', async () => {
    const h = makeIO(['expr', 'substr', 'hello', '0', '3']);
    expect(await exprCommand(h.io)).toBe(1);
    expect(h.out()).toBe('');
  });

  test('substr negative POS → empty string, exit 1', async () => {
    const h = makeIO(['expr', 'substr', 'hello', '-1', '3']);
    expect(await exprCommand(h.io)).toBe(1);
    expect(h.out()).toBe('');
  });

  test('substr LEN <= 0 → empty string, exit 1', async () => {
    const h = makeIO(['expr', 'substr', 'hello', '2', '0']);
    expect(await exprCommand(h.io)).toBe(1);
    expect(h.out()).toBe('');
  });

  test('substr POS beyond end → empty string, exit 1', async () => {
    const h = makeIO(['expr', 'substr', 'hello', '10', '3']);
    expect(await exprCommand(h.io)).toBe(1);
    expect(h.out()).toBe('');
  });

  test('substr LEN past end clamps to available', async () => {
    const h = makeIO(['expr', 'substr', 'hello', '2', '100']);
    await exprCommand(h.io);
    expect(h.out()).toBe('ello');
  });

  test('leading + quote operator: + hello → hello', async () => {
    const h = makeIO(['expr', '+', 'hello']);
    expect(await exprCommand(h.io)).toBe(0);
    expect(h.out()).toBe('hello');
  });

  test('lone + is a syntax error (exit 2)', async () => {
    const h = makeIO(['expr', '+']);
    expect(await exprCommand(h.io)).toBe(2);
    expect(h.err()).toContain('missing argument after');
  });

  test('3 + + 4 → + quotes the 4 (=7)', async () => {
    const h = makeIO(['expr', '3', '+', '+', '4']);
    expect(await exprCommand(h.io)).toBe(0);
    expect(h.out()).toBe('7');
  });
});

describe('expr : (anchored regex match) operator', () => {
  test('STRING : REGEX returns the match length (no capture)', async () => {
    const h = makeIO(['expr', 'abcdef', ':', 'abc']);
    expect(await exprCommand(h.io)).toBe(0);
    expect(h.out()).toBe('3');
  });

  test('no match returns 0 with exit 1', async () => {
    const h = makeIO(['expr', 'abcdef', ':', 'xyz']);
    expect(await exprCommand(h.io)).toBe(1);
    expect(h.out()).toBe('0');
  });

  test('is anchored at the start (leading ^)', async () => {
    const h = makeIO(['expr', 'xabc', ':', 'abc']);
    expect(await exprCommand(h.io)).toBe(1);
    expect(h.out()).toBe('0');
  });

  test('regex metacharacter . matches any char', async () => {
    const h = makeIO(['expr', 'abcdef', ':', 'a.c']);
    expect(await exprCommand(h.io)).toBe(0);
    expect(h.out()).toBe('3');
  });

  test('BRE \\(...\\) capture group returns the captured substring', async () => {
    const h = makeIO(['expr', 'foobar', ':', 'foo\\(bar\\)']);
    expect(await exprCommand(h.io)).toBe(0);
    expect(h.out()).toBe('bar');
  });

  test('capture group with no match returns empty string, exit 1', async () => {
    const h = makeIO(['expr', 'foobar', ':', 'xxx\\(bar\\)']);
    expect(await exprCommand(h.io)).toBe(1);
    expect(h.out()).toBe('');
  });

  test('date-style capture: leading digits', async () => {
    const h = makeIO(['expr', '2021-01-15', ':', '\\([0-9]*\\)']);
    expect(await exprCommand(h.io)).toBe(0);
    expect(h.out()).toBe('2021');
  });

  test('BRE \\+ is one-or-more (a bare + is literal)', async () => {
    const one = makeIO(['expr', 'aaa', ':', 'a\\+']);
    await exprCommand(one.io);
    expect(one.out()).toBe('3');
    const lit = makeIO(['expr', 'a+b', ':', 'a+b']);
    await exprCommand(lit.io);
    expect(lit.out()).toBe('3'); // bare + is a literal char
  });

  test(': binds tighter than * (3 * abcdef : ... = 9)', async () => {
    const h = makeIO(['expr', '3', '*', 'abcdef', ':', '...']);
    expect(await exprCommand(h.io)).toBe(0);
    expect(h.out()).toBe('9');
  });

  test(': works inside parentheses in a compound expression', async () => {
    const h = makeIO(['expr', '(', 'abcdef', ':', 'abc', ')', '+', '1']);
    expect(await exprCommand(h.io)).toBe(0);
    expect(h.out()).toBe('4');
  });
});

describe('expr big-integer arithmetic (BigInt, exact past 2^53)', () => {
  test('multiplication past 2^53 is exact (no scientific notation)', async () => {
    const h = makeIO(['expr', '99999999999', '*', '99999999999']);
    expect(await exprCommand(h.io)).toBe(0);
    expect(h.out()).toBe('9999999999800000000001');
  });

  test('a 63-bit operand is preserved exactly', async () => {
    const h = makeIO(['expr', '9223372036854775807', '+', '0']);
    expect(await exprCommand(h.io)).toBe(0);
    expect(h.out()).toBe('9223372036854775807');
  });

  test('2^53 + 1 does not double-round', async () => {
    const h = makeIO(['expr', '9007199254740993', '+', '1']);
    await exprCommand(h.io);
    expect(h.out()).toBe('9007199254740994');
  });

  test('huge addition stays exact', async () => {
    const h = makeIO(['expr', '99999999999999999999', '+', '1']);
    await exprCommand(h.io);
    expect(h.out()).toBe('100000000000000000000');
  });

  test('division/modulo truncate toward zero like C (negative operands)', async () => {
    const neg = makeIO(['expr', '-7', '/', '2']);
    await exprCommand(neg.io);
    expect(neg.out()).toBe('-3'); // trunc toward zero, not floor
    const mod = makeIO(['expr', '-7', '%', '3']);
    await exprCommand(mod.io);
    expect(mod.out()).toBe('-1');
  });

  test('big-integer comparison is exact (past double precision)', async () => {
    const h = makeIO(['expr', '99999999999999999999', '>', '99999999999999999998']);
    expect(await exprCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1');
  });

  test('float comparison is string-wise (GNU: only integers compare numerically)', async () => {
    // 2.5 < 10.5 numerically is true, but GNU compares these as STRINGS ("2" > "1")
    // so the result is 0.
    const h = makeIO(['expr', '2.5', '<', '10.5']);
    expect(await exprCommand(h.io)).toBe(1);
    expect(h.out()).toBe('0');
  });
});

describe('expr M3: leading + is not part of an integer (GNU form is -?[0-9]+)', () => {
  test('+5 + 1 is a non-integer arithmetic error (exit 2)', async () => {
    const h = makeIO(['expr', '+5', '+', '1']);
    expect(await exprCommand(h.io)).toBe(2);
    expect(h.err()).toContain('non-integer argument');
  });

  test('+0 = 0 compares string-wise → 0, exit 1', async () => {
    const h = makeIO(['expr', '+0', '=', '0']);
    expect(await exprCommand(h.io)).toBe(1);
    expect(h.out()).toBe('0');
  });

  test('5 = +5 compares string-wise → 0, exit 1', async () => {
    const h = makeIO(['expr', '5', '=', '+5']);
    expect(await exprCommand(h.io)).toBe(1);
    expect(h.out()).toBe('0');
  });

  test('+10 < +9 is byte-wise → 1, exit 0', async () => {
    const h = makeIO(['expr', '+10', '<', '+9']);
    expect(await exprCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1');
  });

  test('negative integers still work (-5 + 1 = -4)', async () => {
    const h = makeIO(['expr', '-5', '+', '1']);
    expect(await exprCommand(h.io)).toBe(0);
    expect(h.out()).toBe('-4');
  });

  test('leading-zero integers still numeric (007 + 1 = 8)', async () => {
    const h = makeIO(['expr', '007', '+', '1']);
    expect(await exprCommand(h.io)).toBe(0);
    expect(h.out()).toBe('8');
  });
});

describe('expr M4: POSIX character classes in the : (BRE) operator', () => {
  test('[[:alpha:]]* matches letters', async () => {
    const h = makeIO(['expr', 'abcABC', ':', '[[:alpha:]]*']);
    expect(await exprCommand(h.io)).toBe(0);
    expect(h.out()).toBe('6');
  });

  test('[[:digit:]]* matches only leading digits', async () => {
    const h = makeIO(['expr', '123abc', ':', '[[:digit:]]*']);
    expect(await exprCommand(h.io)).toBe(0);
    expect(h.out()).toBe('3');
  });

  test('[[:alnum:]]* stops at a space', async () => {
    const h = makeIO(['expr', 'a1 b', ':', '[[:alnum:]]*']);
    expect(await exprCommand(h.io)).toBe(0);
    expect(h.out()).toBe('2');
  });

  test('[[:space:]] matches whitespace', async () => {
    const h = makeIO(['expr', '  x', ':', '[[:space:]]*']);
    expect(await exprCommand(h.io)).toBe(0);
    expect(h.out()).toBe('2');
  });

  test('negated class [^[:digit:]]* works', async () => {
    const h = makeIO(['expr', 'abc123', ':', '[^[:digit:]]*']);
    expect(await exprCommand(h.io)).toBe(0);
    expect(h.out()).toBe('3');
  });

  test('ordinary range [a-z]* still works alongside classes', async () => {
    const h = makeIO(['expr', 'abcABC', ':', '[a-z]*']);
    expect(await exprCommand(h.io)).toBe(0);
    expect(h.out()).toBe('3');
  });
});

describe('expr L3: backslash before an ordinary char in a BRE is a literal', () => {
  test('a\\tb matches literal "atb" (\\t == literal t)', async () => {
    const h = makeIO(['expr', 'atb', ':', 'a\\tb']);
    expect(await exprCommand(h.io)).toBe(0);
    expect(h.out()).toBe('3');
  });

  test('a\\tb does NOT match a real tab', async () => {
    const h = makeIO(['expr', 'a\tb', ':', 'a\\tb']);
    expect(await exprCommand(h.io)).toBe(1);
    expect(h.out()).toBe('0');
  });

  test('BRE metacharacter escapes still work (\\. is a literal dot)', async () => {
    const lit = makeIO(['expr', 'a.b', ':', 'a\\.b']);
    await exprCommand(lit.io);
    expect(lit.out()).toBe('3');
    const noMatch = makeIO(['expr', 'axb', ':', 'a\\.b']);
    expect(await exprCommand(noMatch.io)).toBe(1);
    expect(noMatch.out()).toBe('0');
  });
});

describe('expr D5: glibc-BRE regex operators \\w \\W \\s \\S \\b \\B (not literals)', () => {
  test('\\w matches a word char', async () => {
    const h = makeIO(['expr', '_', ':', '\\w']);
    expect(await exprCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1');
  });

  test('\\w* counts leading word chars', async () => {
    const h = makeIO(['expr', 'abc', ':', '\\w*']);
    expect(await exprCommand(h.io)).toBe(0);
    expect(h.out()).toBe('3');
  });

  test('\\s matches whitespace', async () => {
    const h = makeIO(['expr', ' x', ':', '\\s']);
    expect(await exprCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1');
  });

  test('\\S matches a non-space char', async () => {
    const h = makeIO(['expr', 'abc', ':', '\\S*']);
    expect(await exprCommand(h.io)).toBe(0);
    expect(h.out()).toBe('3');
  });

  test('\\W matches a non-word char (WWW is a word → no match)', async () => {
    const h = makeIO(['expr', 'WWW', ':', '\\W']);
    expect(await exprCommand(h.io)).toBe(1);
    expect(h.out()).toBe('0');
  });

  test('\\B (non-boundary) does not match at the start of a word', async () => {
    const h = makeIO(['expr', 'BBB', ':', '\\B']);
    expect(await exprCommand(h.io)).toBe(1);
    expect(h.out()).toBe('0');
  });

  test('\\d stays a LITERAL "d" (glibc BRE, not a digit class)', async () => {
    const lit = makeIO(['expr', 'd', ':', '\\d']);
    expect(await exprCommand(lit.io)).toBe(0);
    expect(lit.out()).toBe('1');
    const noMatch = makeIO(['expr', '5', ':', '\\d']);
    expect(await exprCommand(noMatch.io)).toBe(1);
    expect(noMatch.out()).toBe('0');
  });
});
