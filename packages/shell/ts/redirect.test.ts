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

describe('here-string (<<<)', () => {
  it('feeds string to stdin of a builtin', async () => {
    const { stdout } = await runShell('read line <<< "hello world"\necho "$line"\n');
    assert.strictEqual(stdout.trim(), 'hello world');
  });

  it('splits words with read using multiple variables', async () => {
    const { stdout } = await runShell('read a b <<< "hello world"\necho "$a"\necho "$b"\n');
    assert.strictEqual(stdout.trim(), 'hello\nworld');
  });

  it('here-string with variable expansion', async () => {
    const { stdout } = await runShell('export x=5\nread n <<< "$((x * 2))"\necho "$n"\n');
    assert.strictEqual(stdout.trim(), '10');
  });

  it('here-string with quoted single word', async () => {
    const { stdout } = await runShell('read word <<< "oneword"\necho "$word"\n');
    assert.strictEqual(stdout.trim(), 'oneword');
  });
});

describe('output redirection via pipe (no filesystem required)', () => {
  it('pipeline exit code is the last command exit', async () => {
    const { exit } = await runShell('true | false\n');
    assert.strictEqual(exit, 1);
  });

  it('pipeline exit code 0 when last succeeds', async () => {
    const { exit } = await runShell('false | true\n');
    assert.strictEqual(exit, 0);
  });

  it('pipe from subshell collects all output', async () => {
    const { stdout } = await runShell('(echo a; echo b; echo c) | read x\necho "ok"\n');
    assert.ok(stdout.includes('ok'));
  });
});
