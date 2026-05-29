import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, 'cli.ts');

function runCli(args: string[], env?: Record<string, string>): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((resolve) => {
    const child = spawn('node', ['--experimental-strip-types', CLI, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code: number | null) => {
      resolve({ stdout, stderr, exit: code ?? 0 });
    });
    child.stdin.end();
  });
}

describe('POSIX mode: disabled bash extensions', () => {
  it('brace expansion disabled', async () => {
    const { stdout } = await runCli(['--posix', '-c', 'echo {a,b,c}']);
    assert.strictEqual(stdout.trim(), '{a,b,c}');
  });

  it('echo -n treated as literal in POSIX', async () => {
    const { stdout } = await runCli(['--posix', '-c', 'echo -n hello']);
    assert.strictEqual(stdout.trim(), '-n hello');
  });

  it('echo -e treated as literal in POSIX', async () => {
    const { stdout } = await runCli(['--posix', '-c', 'echo -e hi']);
    assert.strictEqual(stdout.trim(), '-e hi');
  });

  it('[[ ]] rejected in POSIX mode', async () => {
    const { exit } = await runCli(['--posix', '-c', '[[ 1 == 1 ]]']);
    assert.notStrictEqual(exit, 0);
  });

  it('source rejected in POSIX mode (use . instead)', async () => {
    const { stderr, exit } = await runCli(['--posix', '-c', 'echo ok > /tmp/posix_dot.sh; source /tmp/posix_dot.sh']);
    assert.notStrictEqual(exit, 0);
  });

  it('. command works in POSIX mode', async () => {
    const { stdout } = await runCli(['--posix', '-c', 'echo "echo from_dot" > /tmp/posix_dot2.sh; . /tmp/posix_dot2.sh']);
    assert.strictEqual(stdout.trim(), 'from_dot');
  });
});

describe('POSIX mode: activation methods', () => {
  it('--posix flag works', async () => {
    const { stdout } = await runCli(['--posix', '-c', 'echo {a,b}']);
    assert.strictEqual(stdout.trim(), '{a,b}');
  });

  it('set -o posix activates at runtime', async () => {
    const { stdout } = await runCli(['-c', 'set -o posix; echo {a,b}']);
    assert.strictEqual(stdout.trim(), '{a,b}');
  });

  it('POSIXLY_CORRECT env var activates', async () => {
    const { stdout } = await runCli(['-c', 'echo {a,b}'], { POSIXLY_CORRECT: '1' });
    assert.strictEqual(stdout.trim(), '{a,b}');
  });
});

describe('POSIX mode: features that STILL work', () => {
  it('basic commands work', async () => {
    const { stdout } = await runCli(['--posix', '-c', 'echo hello']);
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('pipes work', async () => {
    const { stdout } = await runCli(['--posix', '-c', 'echo hello | cat']);
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('if/then/else works', async () => {
    const { stdout } = await runCli(['--posix', '-c', 'if true; then echo yes; fi']);
    assert.strictEqual(stdout.trim(), 'yes');
  });

  it('test/[ builtin works', async () => {
    const { stdout } = await runCli(['--posix', '-c', 'if [ 1 -eq 1 ]; then echo eq; fi']);
    assert.strictEqual(stdout.trim(), 'eq');
  });

  it('for loop works', async () => {
    const { stdout } = await runCli(['--posix', '-c', 'for i in a b c; do echo $i; done']);
    assert.strictEqual(stdout.trim(), 'a\nb\nc');
  });

  it('variable expansion works', async () => {
    const { stdout } = await runCli(['--posix', '-c', 'x=hello; echo $x']);
    assert.strictEqual(stdout.trim(), 'hello');
  });
});
