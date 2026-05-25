import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WASIProcess } from './instantiation.ts';
import { ProcessTable } from './table.ts';
import { Process } from './types.ts';
import type { CommandHandler } from './commands.ts';

describe('WASIProcess', () => {
  it('constructs with default config', () => {
    const wp = new WASIProcess();
    assert.ok(wp.table instanceof ProcessTable);
  });

  it('constructs with custom ProcessTable', () => {
    const table = new ProcessTable();
    const wp = new WASIProcess({ processTable: table });
    assert.strictEqual(wp.table, table);
  });

  it('getImportObject returns mithic:process/spawn with spawn function', () => {
    const wp = new WASIProcess();
    const imports = wp.getImportObject();
    assert.ok('mithic:process/spawn' in imports);
    assert.equal(typeof imports['mithic:process/spawn'].spawn, 'function');
  });

  it('spawn via getImportObject creates a Process', () => {
    const handler: CommandHandler = async () => ({ exitCode: 0 });
    const wp = new WASIProcess({ commandResolver: (file) => file === 'echo' ? handler : undefined });
    const { spawn } = wp.getImportObject()['mithic:process/spawn'];
    const proc = spawn('echo', ['hi']);
    assert.ok(proc instanceof Process);
    assert.equal(proc.pid, 1);
  });

  it('spawn via getImportObject throws not-found for unknown command', () => {
    const wp = new WASIProcess({ commandResolver: () => undefined });
    const { spawn } = wp.getImportObject()['mithic:process/spawn'];
    assert.throws(() => spawn('nonexistent', []), (err) => err === 'not-found');
  });

  it('two WASIProcess instances are isolated (separate tables)', () => {
    const handler: CommandHandler = async () => ({ exitCode: 0 });
    const wp1 = new WASIProcess({ commandResolver: () => handler });
    const wp2 = new WASIProcess({ commandResolver: () => handler });

    const { spawn: spawn1 } = wp1.getImportObject()['mithic:process/spawn'];
    const { spawn: spawn2 } = wp2.getImportObject()['mithic:process/spawn'];

    spawn1('a', []);
    spawn1('b', []);
    spawn2('c', []);

    assert.equal(wp1.table.size, 2);
    assert.equal(wp2.table.size, 1);
  });

  it('two WASIProcess instances have independent command resolvers', () => {
    const handler1: CommandHandler = async () => ({ exitCode: 1 });
    const handler2: CommandHandler = async () => ({ exitCode: 2 });

    const wp1 = new WASIProcess({ commandResolver: (f) => f === 'cmd1' ? handler1 : undefined });
    const wp2 = new WASIProcess({ commandResolver: (f) => f === 'cmd2' ? handler2 : undefined });

    const { spawn: spawn1 } = wp1.getImportObject()['mithic:process/spawn'];
    const { spawn: spawn2 } = wp2.getImportObject()['mithic:process/spawn'];

    // wp1 can resolve cmd1 but not cmd2
    assert.doesNotThrow(() => spawn1('cmd1', []));
    assert.throws(() => spawn1('cmd2', []), (err) => err === 'not-found');

    // wp2 can resolve cmd2 but not cmd1
    assert.doesNotThrow(() => spawn2('cmd2', []));
    assert.throws(() => spawn2('cmd1', []), (err) => err === 'not-found');
  });

  it('spawned process wait resolves with handler result', async () => {
    const handler: CommandHandler = async (_args, ctx) => {
      ctx.writeStdout(new Uint8Array([72, 105]));
      return { exitCode: 0 };
    };
    const wp = new WASIProcess({ commandResolver: () => handler });
    const { spawn } = wp.getImportObject()['mithic:process/spawn'];
    const proc = spawn('test', []);
    const result = await proc.wait();
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.stdout, new Uint8Array([72, 105]));
  });
});
