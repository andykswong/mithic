import { expect, test, describe } from 'vitest';
import { yesCommand } from './yes.ts';
import type { CommandIO } from '../harness.ts';

function makeIO(args: string[], maxBytes = 100) {
  // Simulate a consumer that closes after `maxBytes` received (broken pipe)
  const stdin = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
  const outChunks: Uint8Array[] = [];
  let received = 0;
  const stdout = new WritableStream<Uint8Array>({
    write(c, ctrl) {
      received += c.byteLength;
      outChunks.push(c);
      if (received >= maxBytes) {
        // Signal broken pipe by aborting the stream
        ctrl.error(new Error('broken pipe'));
      }
    },
  });
  const errChunks: Uint8Array[] = [];
  const stderr = new WritableStream<Uint8Array>({ write(c) { errChunks.push(c); } });
  const decode = (chunks: Uint8Array[]): string => {
    let t = 0; for (const c of chunks) t += c.byteLength;
    const b = new Uint8Array(t); let o = 0;
    for (const c of chunks) { b.set(c, o); o += c.byteLength; }
    return new TextDecoder().decode(b);
  };
  return {
    io: { args, env: {}, cwd: '/', stdin, stdout, stderr, syscall: async () => ({}) } as CommandIO,
    out: () => decode(outChunks),
    err: () => decode(errChunks),
  };
}

describe('yes', () => {
  test('default output is "y\\n" repeated', async () => {
    const h = makeIO(['yes'], 10);
    const code = await yesCommand(h.io);
    expect(code).toBe(0);
    // All output should be "y\n" repeated
    const out = h.out();
    expect(out.startsWith('y\n')).toBe(true);
    for (let i = 0; i < out.length; i += 2) {
      if (i + 1 < out.length) {
        expect(out[i]).toBe('y');
        expect(out[i + 1]).toBe('\n');
      }
    }
  });

  test('custom argument', async () => {
    const h = makeIO(['yes', 'hello'], 30);
    await yesCommand(h.io);
    const out = h.out();
    expect(out.startsWith('hello\n')).toBe(true);
  });

  test('stops on broken pipe (does not spin)', async () => {
    // With a very small cap, yes should stop without timing out
    const h = makeIO(['yes'], 5);
    const start = Date.now();
    await yesCommand(h.io);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
