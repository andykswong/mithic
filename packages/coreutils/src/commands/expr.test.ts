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
