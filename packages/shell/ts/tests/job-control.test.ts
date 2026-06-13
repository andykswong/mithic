import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '../cli/index.ts');

async function runShell(script: string, timeout = 5000): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code: number | null) => {
      resolve({ stdout, stderr, exit: code ?? 0 });
    });
    child.on('error', reject);
    child.stdin.write(script);
    child.stdin.end();
  });
}

describe('background execution (cmd &)', () => {
  it('builtin in background runs synchronously without job report', async () => {
    const { stderr, exit } = await runShell('true &\n');
    assert.strictEqual(exit, 0);
    assert.ok(!stderr.includes('command not found'));
  });

  it('background does not block foreground execution', async () => {
    const { stdout } = await runShell('true & echo foreground\n');
    assert.strictEqual(stdout.trim(), 'foreground');
  });

  it('$! is empty when no process was backgrounded', async () => {
    const { stdout } = await runShell('echo "$!"\n');
    assert.strictEqual(stdout.trim(), '');
  });
});

describe('wait builtin', () => {
  it('wait with no jobs returns 0', async () => {
    const { stdout } = await runShell('wait\necho $?\n');
    assert.strictEqual(stdout.trim(), '0');
  });

  it('wait for nonexistent job returns 127', async () => {
    // builtins run synchronously so no job is created; wait %1 sees no such job
    const { stdout } = await runShell('wait %1\necho $?\n');
    assert.strictEqual(stdout.trim(), '127');
  });

  it('wait for all background jobs', async () => {
    const { stdout } = await runShell('true &\ntrue &\nwait\necho done\n');
    assert.ok(stdout.includes('done'));
  });
});

describe('jobs builtin', () => {
  it('lists no jobs when none exist', async () => {
    const { stdout } = await runShell('jobs\n');
    assert.strictEqual(stdout.trim(), '');
  });
});

describe('kill builtin', () => {
  it('kill unknown job returns error', async () => {
    const { stderr } = await runShell('kill %99\n');
    assert.ok(stderr.includes('no such job'));
  });

  it('kill with no args prints usage', async () => {
    const { stderr } = await runShell('kill\n');
    assert.ok(stderr.includes('usage'));
  });
});

describe('disown builtin', () => {
  it('disown removes job from table', async () => {
    const { stdout } = await runShell('true &\ndisown %1\njobs\n');
    assert.strictEqual(stdout.trim(), '');
  });

  it('disown unknown job returns error', async () => {
    const { stderr } = await runShell('disown %99\n');
    assert.ok(stderr.includes('no such job'));
  });
});

describe('trap builtin', () => {
  it('trap EXIT runs handler on shell exit', async () => {
    const { stdout } = await runShell('trap "echo goodbye" EXIT\nexit\n');
    assert.ok(stdout.includes('goodbye'));
  });

  it('trap EXIT runs on natural EOF', async () => {
    const { stdout } = await runShell('trap "echo bye" EXIT\n');
    assert.ok(stdout.includes('bye'));
  });

  it('trap with no args lists traps', async () => {
    const { stdout } = await runShell('trap "echo hi" EXIT\ntrap\n');
    assert.ok(stdout.includes('\'echo hi\' EXIT'));
  });

  it('trap - removes all handlers', async () => {
    const { stdout } = await runShell('trap "echo hi" EXIT\ntrap -\ntrap\n');
    assert.strictEqual(stdout.trim(), '');
  });

  it('trap - SIG removes specific handler', async () => {
    const { stdout } = await runShell('trap "echo a" EXIT\ntrap "echo b" INT\ntrap - EXIT\ntrap\n');
    assert.ok(!stdout.includes('\'echo a\' EXIT'));
    assert.ok(stdout.includes('\'echo b\' INT'));
  });

  it('trap accepts signal numbers', async () => {
    const { stdout } = await runShell('trap "echo caught" 2\ntrap\n');
    assert.ok(stdout.includes('\'echo caught\' INT'));
  });

  it('trap - with signal number removes handler', async () => {
    const { stdout } = await runShell('trap "echo x" INT\ntrap - 2\ntrap\n');
    assert.ok(!stdout.includes('INT'));
  });
});
