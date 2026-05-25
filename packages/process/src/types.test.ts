import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Process, SIGNAL_NUMBER, type ProcessHandler, type ExecResult, type Signal } from './types.ts';
import { InputStream, OutputStream, type InputStreamHandler, type OutputStreamHandler } from '@mithic/wasip2/io/streams';

describe('Process', () => {
  function createMockHandler(result: ExecResult = { stdout: new Uint8Array(), stderr: new Uint8Array(), exitCode: 0 }) {
    const handler = {
      killed: null as Signal | null,
      stdinHandler: {
        write() {},
        flush() {},
      } as OutputStreamHandler,
      stdoutHandler: {
        read() { return undefined; },
        blockingRead() { throw { tag: 'closed' }; },
      } as InputStreamHandler,
      stderrHandler: {
        read() { return undefined; },
        blockingRead() { throw { tag: 'closed' }; },
      } as InputStreamHandler,
      onKill(signal: Signal) { handler.killed = signal; },
      wait() { return Promise.resolve(result); },
    };
    return handler;
  }

  it('constructor creates Process with correct pid', () => {
    const handler = createMockHandler();
    const proc = new Process(42, handler);
    assert.equal(proc.pid, 42);
  });

  it('stdin() returns an OutputStream', () => {
    const handler = createMockHandler();
    const proc = new Process(1, handler);
    assert.ok(proc.stdin() instanceof OutputStream);
  });

  it('stdout() returns an InputStream', () => {
    const handler = createMockHandler();
    const proc = new Process(1, handler);
    assert.ok(proc.stdout() instanceof InputStream);
  });

  it('stderr() returns an InputStream', () => {
    const handler = createMockHandler();
    const proc = new Process(1, handler);
    assert.ok(proc.stderr() instanceof InputStream);
  });

  it('stdin() write delegates to stdinHandler', () => {
    const written: Uint8Array[] = [];
    const handler = createMockHandler();
    handler.stdinHandler = {
      write(data: Uint8Array) { written.push(new Uint8Array(data)); },
      flush() {},
    } as OutputStreamHandler;
    const proc = new Process(1, handler);
    proc.stdin().write(new Uint8Array([1, 2, 3]));
    assert.equal(written.length, 1);
    assert.deepEqual(written[0], new Uint8Array([1, 2, 3]));
  });

  it('stdout() read delegates to stdoutHandler', () => {
    const handler = createMockHandler();
    handler.stdoutHandler = {
      read(len: number) { return new Uint8Array([65, 66]).slice(0, len); },
      blockingRead(len: number) { return new Uint8Array([65, 66]).slice(0, len); },
    };
    const proc = new Process(1, handler);
    const data = proc.stdout().read(2n);
    assert.deepEqual(data, new Uint8Array([65, 66]));
  });

  it('wait() resolves with handler result', async () => {
    const expected: ExecResult = { stdout: new Uint8Array([1]), stderr: new Uint8Array([2]), exitCode: 7 };
    const handler = createMockHandler(expected);
    const proc = new Process(1, handler);
    const result = await proc.wait();
    assert.deepEqual(result, expected);
  });

  it('kill() calls onKill with signal', () => {
    const handler = createMockHandler();
    const proc = new Process(1, handler);
    proc.kill('sigint');
    assert.equal(handler.killed, 'sigint');
  });

  it('kill() defaults to sigterm', () => {
    const handler = createMockHandler();
    const proc = new Process(1, handler);
    proc.kill();
    assert.equal(handler.killed, 'sigterm');
  });

  it('kill() with no onKill handler does not throw', () => {
    const handler = createMockHandler();
    delete (handler as Partial<ProcessHandler>).onKill;
    const proc = new Process(1, handler);
    assert.doesNotThrow(() => proc.kill('sigkill'));
  });
});

describe('SIGNAL_NUMBER', () => {
  it('maps sigterm to 15', () => { assert.equal(SIGNAL_NUMBER.sigterm, 15); });
  it('maps sigkill to 9', () => { assert.equal(SIGNAL_NUMBER.sigkill, 9); });
  it('maps sigint to 2', () => { assert.equal(SIGNAL_NUMBER.sigint, 2); });
  it('maps signull to 0', () => { assert.equal(SIGNAL_NUMBER.signull, 0); });
});
