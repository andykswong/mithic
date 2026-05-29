import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { InputStream, OutputStream } from '@mithic/wasip2/io/streams';
import { spawn, _setProcessManager, _getProcessManager } from './manager.ts';
import { Process, type ProcessManager } from './types.ts';
import { SimpleProcessManager, type CommandHandler } from './impl/simple.ts';
import { createPipe } from './utils.ts';

describe('manager (global WIT-level functions)', () => {
  beforeEach(() => {
    _setProcessManager(new SimpleProcessManager());
  });

  it('_getProcessManager returns a ProcessManager', () => {
    const mgr = _getProcessManager();
    assert.ok(mgr);
    assert.equal(typeof mgr.spawn, 'function');
    assert.equal(typeof mgr.createPipe, 'function');
  });

  it('_setProcessManager replaces the global manager', () => {
    const custom = new SimpleProcessManager({
      commandResolver: () => async () => 42,
    });
    _setProcessManager(custom);
    assert.strictEqual(_getProcessManager(), custom);
  });

  it('spawn delegates to global ProcessManager', () => {
    const handler: CommandHandler = async () => 0;
    _setProcessManager(new SimpleProcessManager({ commandResolver: () => handler }));
    const proc = spawn('test', []);
    assert.ok(proc instanceof Process);
    assert.equal(proc.pid(),1);
  });

  it('spawn throws not-found when command not resolved', () => {
    _setProcessManager(new SimpleProcessManager({ commandResolver: () => undefined }));
    assert.throws(() => spawn('missing', []), (err: unknown) => err instanceof Error && (err as Error & { payload: { tag: string } }).payload.tag === 'not-found');
  });

  it('createPipe returns linked InputStream and OutputStream', () => {
    const { input, output } = createPipe();
    assert.ok(input instanceof InputStream);
    assert.ok(output instanceof OutputStream);
    output.write(new Uint8Array([7, 8, 9]));
    const data = input.read(3n);
    assert.deepEqual(data, new Uint8Array([7, 8, 9]));
  });

  it('spawn with pre-wired streams works via global manager', async () => {
    const handler: CommandHandler = async (_args, ctx) => {
      ctx.stdout.write(new Uint8Array([99]));
      return 0;
    };
    _setProcessManager(new SimpleProcessManager({ commandResolver: () => handler }));
    const pipe = createPipe();
    const proc = spawn('test', [], { stdout: pipe.output });
    await proc.wait();
    const data = pipe.input.read(1n);
    assert.deepEqual(data, new Uint8Array([99]));
  });

  it('accepts any ProcessManager implementation', () => {
    let called = false;
    const custom: ProcessManager = {
      spawn() {
        called = true;
        return new Process(50, { wait: () => Promise.resolve(0) });
      },
      createPipe() {
        return createPipe();
      },
      dupOutputStream(stream: OutputStream) {
        return stream.dup();
      },
      signal() {},
      get hasForeground() { return false; },
    };
    _setProcessManager(custom);
    const proc = spawn('anything', []);
    assert.ok(called);
    assert.equal(proc.pid(),50);
  });
});
