import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ProcessTable } from './table.ts';
import { spawn, spawnProcess, _setProcessTable, _setCommandResolver } from './spawn.ts';
import { Process } from './types.ts';
import { InputStream, OutputStream } from '@mithic/wasip2/io/streams';
import type { CommandHandler } from './commands.ts';
import { WASIProcess } from './instantiation.ts';

describe('spawn', () => {
  let table: ProcessTable;

  beforeEach(() => {
    table = new ProcessTable();
    _setProcessTable(table);
  });

  it('spawn with registered command handler returns Process with correct pid', () => {
    const handler: CommandHandler = async () => ({ exitCode: 0 });
    _setCommandResolver((file) => file === 'echo' ? handler : undefined);
    const proc = spawn('echo', ['hello']);
    assert.ok(proc instanceof Process);
    assert.equal(proc.pid, 1);
  });

  it('Process.stdout() returns InputStream, Process.stdin() returns OutputStream', () => {
    const handler: CommandHandler = async () => ({ exitCode: 0 });
    _setCommandResolver(() => handler);
    const proc = spawn('test', []);
    assert.ok(proc.stdout() instanceof InputStream);
    assert.ok(proc.stderr() instanceof InputStream);
    assert.ok(proc.stdin() instanceof OutputStream);
  });

  it('host writes to Process.stdin(), command handler receives it via readStdin', async () => {
    const received: Uint8Array[] = [];
    const handler: CommandHandler = async (_args, ctx) => {
      // Give time for stdin write to buffer
      await new Promise(r => setTimeout(r, 5));
      const data = ctx.readStdin(1024);
      if (data) received.push(data);
      return { exitCode: 0 };
    };
    _setCommandResolver(() => handler);
    const proc = spawn('cat', []);
    proc.stdin().write(new Uint8Array([1, 2, 3]));
    await proc.wait();
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], new Uint8Array([1, 2, 3]));
  });

  it('command handler writes to stdout, host reads from Process.stdout()', async () => {
    const handler: CommandHandler = async (_args, ctx) => {
      ctx.writeStdout(new Uint8Array([65, 66, 67]));
      return { exitCode: 0 };
    };
    _setCommandResolver(() => handler);
    const proc = spawn('abc', []);
    await proc.wait();
    // After completion, stdout buffer should have the data
    const data = proc.stdout().read(1024n);
    assert.deepEqual(data, new Uint8Array([65, 66, 67]));
  });

  it('Process.wait() resolves with exit result', async () => {
    const handler: CommandHandler = async (_args, ctx) => {
      ctx.writeStdout(new Uint8Array([72, 105]));
      ctx.writeStderr(new Uint8Array([69, 114, 114]));
      return { exitCode: 42 };
    };
    _setCommandResolver(() => handler);
    const proc = spawn('test', []);
    const result = await proc.wait();
    assert.equal(result.exitCode, 42);
    assert.deepEqual(result.stdout, new Uint8Array([72, 105]));
    assert.deepEqual(result.stderr, new Uint8Array([69, 114, 114]));
  });

  it('Process.kill(sigterm) resolves wait with 128+15', async () => {
    const handler: CommandHandler = async () => {
      // Simulate long-running process
      await new Promise(r => setTimeout(r, 10000));
      return { exitCode: 0 };
    };
    _setCommandResolver(() => handler);
    const proc = spawn('sleep', ['100']);
    proc.kill('sigterm');
    const result = await proc.wait();
    assert.equal(result.exitCode, 128 + 15);
  });

  it('Process.kill(sigkill) resolves wait with 128+9', async () => {
    const handler: CommandHandler = async () => {
      await new Promise(r => setTimeout(r, 10000));
      return { exitCode: 0 };
    };
    _setCommandResolver(() => handler);
    const proc = spawn('sleep', ['100']);
    proc.kill('sigkill');
    const result = await proc.wait();
    assert.equal(result.exitCode, 128 + 9);
  });

  it('spawn with unknown command throws not-found', () => {
    _setCommandResolver(() => undefined);
    assert.throws(() => spawn('nonexistent', []), (err) => err === 'not-found');
  });

  it('handler error produces exit code 1 with error message in stderr', async () => {
    const handler: CommandHandler = async () => {
      throw new Error('something went wrong');
    };
    _setCommandResolver(() => handler);
    const proc = spawn('fail', []);
    const result = await proc.wait();
    assert.equal(result.exitCode, 1);
    const errMsg = new TextDecoder().decode(result.stderr);
    assert.ok(errMsg.includes('something went wrong'));
  });

  it('process is removed from table after completion', async () => {
    const handler: CommandHandler = async () => ({ exitCode: 0 });
    _setCommandResolver(() => handler);
    const proc = spawn('echo', []);
    assert.equal(table.size, 1);
    await proc.wait();
    // Allow microtask to run for cleanup
    await new Promise(r => setTimeout(r, 10));
    assert.equal(table.size, 0);
  });

  it('spawn passes cwd and env to command context', async () => {
    let capturedCwd = '';
    let capturedEnv: Record<string, string> = {};
    const handler: CommandHandler = async (_args, ctx) => {
      capturedCwd = ctx.cwd;
      capturedEnv = ctx.env;
      return { exitCode: 0 };
    };
    _setCommandResolver(() => handler);
    spawn('test', [], { cwd: '/home', env: { FOO: 'bar' } });
    await new Promise(r => setTimeout(r, 10));
    assert.equal(capturedCwd, '/home');
    assert.deepEqual(capturedEnv, { FOO: 'bar' });
  });
});

describe('spawnProcess (pure function)', () => {
  it('spawns a process using provided table and resolver', async () => {
    const table = new ProcessTable();
    const handler: CommandHandler = async (_args, ctx) => {
      ctx.writeStdout(new Uint8Array([1, 2, 3]));
      return { exitCode: 0 };
    };
    const resolver = (file: string) => file === 'test' ? handler : undefined;
    const proc = spawnProcess(table, resolver, 'test', []);
    assert.ok(proc instanceof Process);
    assert.equal(proc.pid, 1);
    assert.equal(table.size, 1);
    const result = await proc.wait();
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.stdout, new Uint8Array([1, 2, 3]));
  });

  it('throws not-found when resolver returns undefined', () => {
    const table = new ProcessTable();
    const resolver = () => undefined;
    assert.throws(() => spawnProcess(table, resolver, 'missing', []), (err) => err === 'not-found');
  });
});

describe('WASIProcess', () => {
  it('getImportObject().spawn works with configured resolver', async () => {
    const handler: CommandHandler = async (_args, ctx) => {
      ctx.writeStdout(new Uint8Array([10, 20]));
      return { exitCode: 0 };
    };
    const wasiProc = new WASIProcess({
      commandResolver: (file) => file === 'hello' ? handler : undefined,
    });
    const imports = wasiProc.getImportObject();
    const proc = imports['mithic:process/spawn'].spawn('hello', []);
    assert.ok(proc instanceof Process);
    const result = await proc.wait();
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.stdout, new Uint8Array([10, 20]));
  });

  it('two WASIProcess instances are isolated', async () => {
    const handler1: CommandHandler = async (_args, ctx) => {
      ctx.writeStdout(new Uint8Array([1]));
      return { exitCode: 0 };
    };
    const handler2: CommandHandler = async (_args, ctx) => {
      ctx.writeStdout(new Uint8Array([2]));
      return { exitCode: 0 };
    };
    const wasiProc1 = new WASIProcess({
      commandResolver: (file) => file === 'cmd' ? handler1 : undefined,
    });
    const wasiProc2 = new WASIProcess({
      commandResolver: (file) => file === 'cmd' ? handler2 : undefined,
    });

    const proc1 = wasiProc1.getImportObject()['mithic:process/spawn'].spawn('cmd', []);
    const proc2 = wasiProc2.getImportObject()['mithic:process/spawn'].spawn('cmd', []);

    const result1 = await proc1.wait();
    const result2 = await proc2.wait();

    assert.deepEqual(result1.stdout, new Uint8Array([1]));
    assert.deepEqual(result2.stdout, new Uint8Array([2]));

    // Each has its own table
    assert.equal(wasiProc1.table.size, 0); // cleaned up after completion
    assert.equal(wasiProc2.table.size, 0);
  });

  it('uses custom process table when provided', () => {
    const customTable = new ProcessTable();
    const handler: CommandHandler = async () => ({ exitCode: 0 });
    const wasiProc = new WASIProcess({
      commandResolver: () => handler,
      processTable: customTable,
    });
    assert.strictEqual(wasiProc.table, customTable);
    wasiProc.getImportObject()['mithic:process/spawn'].spawn('cmd', []);
    assert.equal(customTable.size, 1);
  });

  it('throws not-found for unresolved command', () => {
    const wasiProc = new WASIProcess();
    const imports = wasiProc.getImportObject();
    assert.throws(
      () => imports['mithic:process/spawn'].spawn('anything', []),
      (err) => err === 'not-found',
    );
  });
});
