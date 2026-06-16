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
