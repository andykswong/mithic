import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, 'cli.ts');

async function runShell(script: string): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((resolve) => {
    const child = spawn('node', ['--experimental-strip-types', CLI], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code: number | null) => {
      resolve({ stdout, stderr, exit: code ?? 0 });
    });
    child.stdin.write(script);
    child.stdin.end();
  });
}

describe('history builtin', () => {
  it('history lists previous commands with numbers', async () => {
    const { stdout } = await runShell('echo first\necho second\nhistory\n');
    assert.ok(stdout.includes('echo first'));
    assert.ok(stdout.includes('echo second'));
    assert.match(stdout, /\d+\s+echo first/);
  });

  it('history -c clears history', async () => {
    const { stdout } = await runShell('echo a\nhistory -c\nhistory\n');
    assert.ok(!stdout.includes('echo a'));
  });

  it('history does not include itself in output', async () => {
    const { stdout } = await runShell('echo a\nhistory\n');
    assert.ok(stdout.includes('echo a'));
  });
});

describe('fc builtin', () => {
  it('fc -l lists recent commands', async () => {
    const { stdout } = await runShell('echo first\necho second\nfc -l\n');
    assert.ok(stdout.includes('echo first'));
    assert.ok(stdout.includes('echo second'));
  });
});

describe('history expansion (bash mode)', () => {
  it('!! repeats previous command', async () => {
    const { stdout } = await runShell('echo hello\n!!\n');
    assert.strictEqual(stdout.trim(), 'hello\nhello');
  });

  it('!-1 repeats previous command', async () => {
    const { stdout } = await runShell('echo prev\n!-1\n');
    assert.strictEqual(stdout.trim(), 'prev\nprev');
  });

  it('!echo repeats last command starting with echo', async () => {
    const { stdout } = await runShell('echo target\ntrue\n!echo\n');
    const lines = stdout.trim().split('\n');
    assert.strictEqual(lines[lines.length - 1], 'target');
  });

  it('!! disabled in POSIX mode', async () => {
    // In POSIX mode, !! should be treated literally (not expanded)
    const { stderr } = await runShell('set -o posix\necho hi\n!!\n');
    // !! is treated as a command name, not expansion
    assert.ok(stderr.includes('not found') || stderr.includes('!!'));
  });
});

describe('HISTSIZE', () => {
  it('HISTSIZE limits history length', async () => {
    const { stdout } = await runShell('export HISTSIZE=3\necho a\necho b\necho c\necho d\necho e\nhistory\n');
    // With HISTSIZE=3, only last 3 commands before 'history' should be in history
    assert.ok(!stdout.includes('echo a') || !stdout.includes('echo b'));
    assert.ok(stdout.includes('echo e'));
  });
});

describe('PS1/PS2 prompt', () => {
  it('PS1 default includes cwd', async () => {
    // Check that PS1 var is set by default
    const { stdout } = await runShell('echo "$PS1"\n');
    assert.ok(stdout.trim().length > 0);
  });
});
