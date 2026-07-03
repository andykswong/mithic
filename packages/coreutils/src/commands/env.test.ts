import { expect, test, describe } from 'vitest';
import { envCommand } from './env.ts';
import type { CommandIO } from '../harness.ts';

interface PipelineCall { path: string; argv: string[]; env: Record<string, string>; }

function makeIO(
  args: string[],
  env: Record<string, string> = {},
  pipeline?: {
    /** stdout bytes the mocked child returns. */ stdout?: string;
    /** child exit code. */ exitCode?: number;
    /** if set, the process/pipeline syscall rejects with this errno code. */ rejectCode?: string;
  },
) {
  const enc = new TextEncoder();
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
  const calls: PipelineCall[] = [];
  const syscall = async (call: string, a: Record<string, unknown>): Promise<unknown> => {
    if (call !== 'process/pipeline') throw new Error(`unexpected syscall ${call}`);
    const stage = (a.stages as PipelineCall[])[0];
    calls.push(stage);
    if (pipeline?.rejectCode) {
      throw Object.assign(new Error('command not found'), { code: pipeline.rejectCode });
    }
    return { exitCodes: [pipeline?.exitCode ?? 0], stdout: enc.encode(pipeline?.stdout ?? '') };
  };
  return {
    io: { args, env, cwd: '/', stdin, stdout, stderr, syscall } as CommandIO,
    out: () => decode(outChunks),
    err: () => decode(errChunks),
    calls: () => calls,
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

  test('command after assignments EXECs via process/pipeline with modified env', async () => {
    const h = makeIO(['env', 'FOO=bar', 'echo', 'hi'], { PATH: '/bin' }, { stdout: 'hi\n' });
    const code = await envCommand(h.io);
    expect(code).toBe(0);
    expect(h.out()).toBe('hi\n'); // child stdout forwarded
    const call = h.calls()[0];
    expect(call.path).toBe('echo');
    expect(call.argv).toEqual(['echo', 'hi']);
    expect(call.env.FOO).toBe('bar');
    expect(call.env.PATH).toBe('/bin');
  });

  test('-i FOO=bar CMD execs with a clean environment', async () => {
    const h = makeIO(['env', '-i', 'FOO=bar', 'printenv', 'FOO'], { SECRET: 'x' }, { stdout: 'bar\n' });
    const code = await envCommand(h.io);
    expect(code).toBe(0);
    expect(h.out()).toBe('bar\n');
    const call = h.calls()[0];
    expect(call.env).toEqual({ FOO: 'bar' }); // no inherited SECRET
  });

  test('child exit code is forwarded', async () => {
    const h = makeIO(['env', 'A=1', 'somecmd'], {}, { exitCode: 42 });
    expect(await envCommand(h.io)).toBe(42);
  });

  test('unresolved command → exit 127 with No such file diagnostic', async () => {
    const h = makeIO(['env', 'FOO=bar', 'nope'], {}, { rejectCode: 'ENOENT' });
    expect(await envCommand(h.io)).toBe(127);
    expect(h.err()).toContain('No such file or directory');
  });

  test('missing process capability (EPERM) → exit 126', async () => {
    const h = makeIO(['env', 'FOO=bar', 'echo'], {}, { rejectCode: 'EPERM' });
    expect(await envCommand(h.io)).toBe(126);
  });

  test('no command: just prints modified env (no pipeline call)', async () => {
    const h = makeIO(['env', 'FOO=bar'], {});
    expect(await envCommand(h.io)).toBe(0);
    expect(h.out()).toContain('FOO=bar');
    expect(h.calls().length).toBe(0);
  });
});
