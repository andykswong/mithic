import { expect, test, describe } from 'vitest';
import { envCommand } from './env.ts';
import type { CommandIO } from '../harness.ts';

function makeIO(args: string[], env: Record<string, string> = {}) {
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
    io: { args, env, cwd: '/', stdin, stdout, stderr, syscall: async () => ({}) } as CommandIO,
    out: () => decode(outChunks),
    err: () => decode(errChunks),
  };
}

describe('env command', () => {
  test('print all environment variables', async () => {
    const h = makeIO(['env'], { FOO: 'bar', BAZ: 'qux' });
    const code = await envCommand(h.io);
    expect(code).toBe(0);
    const out = h.out();
    expect(out).toContain('FOO=bar');
    expect(out).toContain('BAZ=qux');
  });

  test('VAR=val assignments override env', async () => {
    const h = makeIO(['env', 'FOO=newval'], { FOO: 'oldval' });
    await envCommand(h.io);
    expect(h.out()).toContain('FOO=newval');
    expect(h.out()).not.toContain('FOO=oldval');
  });

  test('-u removes variable', async () => {
    const h = makeIO(['env', '-u', 'REMOVE', 'FOO=bar'], { REMOVE: 'gone', FOO: 'old' });
    await envCommand(h.io);
    expect(h.out()).not.toContain('REMOVE=');
    expect(h.out()).toContain('FOO=bar');
  });

  test('-i starts with empty env', async () => {
    const h = makeIO(['env', '-i', 'NEW=val'], { EXISTING: 'something' });
    await envCommand(h.io);
    expect(h.out()).not.toContain('EXISTING=');
    expect(h.out()).toContain('NEW=val');
  });

  test('command name after assignments warns on stderr', async () => {
    const h = makeIO(['env', 'FOO=bar', 'somecommand'], {});
    await envCommand(h.io);
    expect(h.err()).toContain('exec not supported');
  });
});
