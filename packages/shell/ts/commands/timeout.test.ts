import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runTimeoutAsync } from './timeout.ts';
import { SimpleProcessManager, type CommandHandler } from '@mithic/process/manager/simple';

describe('runTimeoutAsync', () => {
  function createManager(resolver: (file: string) => CommandHandler | undefined) {
    return new SimpleProcessManager({ commandResolver: resolver });
  }

  it('returns 125 with missing operand', async () => {
    const errors: string[] = [];
    const mgr = createManager(() => undefined);
    const code = await runTimeoutAsync([], mgr, undefined, (msg) => errors.push(msg));
    assert.equal(code, 125);
    assert.ok(errors[0].includes('missing operand'));
  });

  it('returns 125 with invalid duration', async () => {
    const errors: string[] = [];
    const mgr = createManager(() => undefined);
    const code = await runTimeoutAsync(['abc', 'echo'], mgr, undefined, (msg) => errors.push(msg));
    assert.equal(code, 125);
    assert.ok(errors[0].includes('invalid time interval'));
  });

  it('returns 127 when command not found', async () => {
    const mgr = createManager(() => undefined);
    const code = await runTimeoutAsync(['1', 'nonexistent'], mgr);
    assert.equal(code, 127);
  });

  it('returns child exit code when child exits before timeout', async () => {
    const handler: CommandHandler = async () => 42;
    const mgr = createManager((f) => f === 'cmd' ? handler : undefined);
    const code = await runTimeoutAsync(['10', 'cmd'], mgr);
    assert.equal(code, 42);
  });

  it('returns 0 when child exits successfully before timeout', async () => {
    const handler: CommandHandler = async () => 0;
    const mgr = createManager((f) => f === 'true' ? handler : undefined);
    const code = await runTimeoutAsync(['10', 'true'], mgr);
    assert.equal(code, 0);
  });

  it('returns 124 when child times out', async () => {
    const handler: CommandHandler = async () => {
      await new Promise(r => setTimeout(r, 5000));
      return 0;
    };
    const mgr = createManager((f) => f === 'sleep' ? handler : undefined);
    const code = await runTimeoutAsync(['0.05', 'sleep'], mgr);
    assert.equal(code, 124);
  });

  it('returns 125 with negative duration', async () => {
    const errors: string[] = [];
    const mgr = createManager(() => undefined);
    const code = await runTimeoutAsync(['-1', 'echo'], mgr, undefined, (msg) => errors.push(msg));
    assert.equal(code, 125);
  });
});
