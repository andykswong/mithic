import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WASIProcess } from './instantiation.ts';
import { Process } from './types.ts';
import { SimpleProcessManager } from './manager/simple.ts';
import type { CommandHandler } from './manager/simple.ts';

describe('WASIProcess', () => {
  it('constructs with default config (uses SimpleProcessManager)', () => {
    const wp = new WASIProcess();
    assert.ok(wp.manager);
  });

  it('getImportObject returns mithic:process/types and mithic:process/manager', () => {
    const wp = new WASIProcess();
    const imports = wp.getImportObject();
    assert.ok('mithic:process/types' in imports);
    assert.ok('mithic:process/manager' in imports);
    assert.equal(imports['mithic:process/types'].Process, Process);
    assert.equal(typeof imports['mithic:process/manager'].spawn, 'function');
    assert.equal(typeof imports['mithic:process/manager'].createPipe, 'function');
  });

  it('spawn via getImportObject creates a Process', () => {
    const handler: CommandHandler = async () => 0;
    const wp = new WASIProcess({ commandResolver: (file) => file === 'echo' ? handler : undefined });
    const { spawn } = wp.getImportObject()['mithic:process/manager'];
    const proc = spawn('echo', ['hi']);
    assert.ok(proc instanceof Process);
    assert.equal(proc.pid(), 1);
  });

  it('spawn via getImportObject throws not-found for unknown command', () => {
    const wp = new WASIProcess({ commandResolver: () => undefined });
    const { spawn } = wp.getImportObject()['mithic:process/manager'];
    assert.throws(() => spawn('nonexistent', []), (err: unknown) => err instanceof Error && (err as Error & { payload: { tag: string } }).payload.tag === 'not-found');
  });

  it('accepts custom ProcessManager', () => {
    const customManager = new SimpleProcessManager({
      commandResolver: () => async () => 42,
    });
    const wp = new WASIProcess({ manager: customManager });
    assert.strictEqual(wp.manager, customManager);
  });

  it('two WASIProcess instances are isolated (separate managers)', () => {
    const handler: CommandHandler = async () => 0;
    const wp1 = new WASIProcess({ commandResolver: () => handler });
    const wp2 = new WASIProcess({ commandResolver: () => handler });

    const { spawn: spawn1 } = wp1.getImportObject()['mithic:process/manager'];
    const { spawn: spawn2 } = wp2.getImportObject()['mithic:process/manager'];

    spawn1('a', []);
    spawn1('b', []);
    spawn2('c', []);

    const mgr1 = wp1.manager as SimpleProcessManager;
    const mgr2 = wp2.manager as SimpleProcessManager;
    assert.equal(mgr1.table.size, 2);
    assert.equal(mgr2.table.size, 1);
  });
});
