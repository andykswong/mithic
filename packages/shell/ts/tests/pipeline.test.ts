import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '../cli.ts');

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

describe('simple pipelines', () => {
  it('echo | echo passes through (last command wins)', async () => {
    const { stdout } = await runShell('echo hello | echo world\n');
    assert.strictEqual(stdout.trim(), 'world');
  });

  it('pipeline exit code reflects last command', async () => {
    const { exit } = await runShell('true | true\n');
    assert.strictEqual(exit, 0);
  });

  it('pipeline exit code is 1 when last command fails', async () => {
    const { exit } = await runShell('true | false\n');
    assert.strictEqual(exit, 1);
  });

  it('pipeline exit code is 0 when last command succeeds', async () => {
    const { exit } = await runShell('false | true\n');
    assert.strictEqual(exit, 0);
  });
});

describe('! negation', () => {
  it('! false yields exit 0', async () => {
    const { stdout } = await runShell('! false\necho $?\n');
    assert.strictEqual(stdout.trim(), '0');
  });

  it('! true yields exit 1', async () => {
    const { stdout } = await runShell('! true\necho $?\n');
    assert.strictEqual(stdout.trim(), '1');
  });

  it('! false; echo $? prints 0', async () => {
    const { stdout } = await runShell('! false; echo $?\n');
    assert.strictEqual(stdout.trim(), '0');
  });
});

describe('&& (AND list)', () => {
  it('true && echo yes runs second command', async () => {
    const { stdout } = await runShell('true && echo yes\n');
    assert.strictEqual(stdout.trim(), 'yes');
  });

  it('false && echo no skips second command', async () => {
    const { stdout } = await runShell('false && echo no\n');
    assert.strictEqual(stdout.trim(), '');
  });

  it('&& propagates failure exit code', async () => {
    const { exit } = await runShell('false && echo no\n');
    assert.strictEqual(exit, 1);
  });

  it('chained && all succeed', async () => {
    const { stdout } = await runShell('true && true && echo done\n');
    assert.strictEqual(stdout.trim(), 'done');
  });
});

describe('|| (OR list)', () => {
  it('false || echo fallback runs second command', async () => {
    const { stdout } = await runShell('false || echo fallback\n');
    assert.strictEqual(stdout.trim(), 'fallback');
  });

  it('true || echo no skips second command', async () => {
    const { stdout } = await runShell('true || echo no\n');
    assert.strictEqual(stdout.trim(), '');
  });

  it('|| success exit code is 0', async () => {
    const { exit } = await runShell('false || true\n');
    assert.strictEqual(exit, 0);
  });
});

describe('combined && and ||', () => {
  it('false || echo or && echo and chains correctly', async () => {
    const { stdout } = await runShell('false || echo or && echo and\n');
    assert.strictEqual(stdout.trim(), 'or\nand');
  });

  it('true && echo first || echo second', async () => {
    const { stdout } = await runShell('true && echo first || echo second\n');
    assert.strictEqual(stdout.trim(), 'first');
  });

  it('false && echo first || echo second', async () => {
    const { stdout } = await runShell('false && echo first || echo second\n');
    assert.strictEqual(stdout.trim(), 'second');
  });
});

describe('|& pipe stderr', () => {
  it('pipes stderr to next command stdin', async () => {
    // Child shell writes "command not found" to stderr; |& pipes it to cat's stdin
    const { stdout } = await runShell('sh -c "nonexistent_xyz" |& cat\n');
    assert.ok(stdout.includes('command not found'));
  });

  it('also pipes stdout', async () => {
    const { stdout } = await runShell('echo both |& cat\n');
    assert.strictEqual(stdout.trim(), 'both');
  });

  it('in POSIX mode produces error', async () => {
    const { stderr, exit } = await runShell('set -o posix\necho x |& cat\n');
    assert.ok(stderr.includes('not supported in POSIX mode') || exit !== 0);
  });

  it('regular | does not pipe stderr', async () => {
    // With regular |, child shell stderr does NOT go to cat's stdin
    const { stdout } = await runShell('sh -c "nonexistent_xyz" | cat\n');
    assert.strictEqual(stdout.trim(), '');
  });
});
