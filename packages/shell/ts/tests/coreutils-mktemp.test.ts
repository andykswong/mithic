import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '../cli/index.ts');

function runShell(script: string): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI], {
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

describe('mktemp', () => {
  it('creates file in /tmp with default template', async () => {
    const { stdout, exit } = await runShell('f=$(mktemp)\necho $f\ntest -f "$f" && echo exists\n');
    assert.strictEqual(exit, 0);
    assert.ok(stdout.includes('/tmp/tmp.'));
    assert.ok(stdout.includes('exists'));
  });

  it('-d creates a directory', async () => {
    const { stdout, exit } = await runShell('d=$(mktemp -d)\necho $d\ntest -d "$d" && echo isdir\n');
    assert.strictEqual(exit, 0);
    assert.ok(stdout.includes('/tmp/tmp.'));
    assert.ok(stdout.includes('isdir'));
  });

  it('custom template replaces Xs', async () => {
    const { stdout, exit } = await runShell('mktemp /tmp/myapp.XXXXXX\n');
    assert.strictEqual(exit, 0);
    const path = stdout.trim();
    assert.ok(path.startsWith('/tmp/myapp.'));
    assert.strictEqual(path.length, '/tmp/myapp.'.length + 6);
  });

  it('-p specifies directory', async () => {
    const { stdout, exit } = await runShell('mkdir -p /var/tmp\nmktemp -p /var/tmp\n');
    assert.strictEqual(exit, 0);
    assert.ok(stdout.trim().startsWith('/var/tmp/'));
  });

  it('fails with fewer than 3 Xs', async () => {
    const { exit, stderr } = await runShell('mktemp /tmp/foo.XX\n');
    assert.notStrictEqual(exit, 0);
    assert.ok(stderr.includes("too few X's"));
  });

  it('--suffix appends suffix', async () => {
    const { stdout, exit } = await runShell('mktemp --suffix=.txt\n');
    assert.strictEqual(exit, 0);
    assert.ok(stdout.trim().endsWith('.txt'));
  });

  it('-u prints name without creating file', async () => {
    const { stdout, exit } = await runShell('f=$(mktemp -u)\necho $f\ntest -f "$f" && echo exists || echo nofile\n');
    assert.strictEqual(exit, 0);
    assert.ok(stdout.includes('/tmp/tmp.'));
    assert.ok(stdout.includes('nofile'));
  });

  it('-t uses TMPDIR', async () => {
    const { stdout, exit } = await runShell('export TMPDIR=/var/tmp\nmkdir -p /var/tmp\nmktemp -t myXXXXXX\n');
    assert.strictEqual(exit, 0);
    assert.ok(stdout.trim().startsWith('/var/tmp/my'));
  });

  it('generates unique names on successive calls', async () => {
    const { stdout, exit } = await runShell('a=$(mktemp)\nb=$(mktemp)\ntest "$a" != "$b" && echo different\n');
    assert.strictEqual(exit, 0);
    assert.ok(stdout.includes('different'));
  });

  it('-q suppresses error messages', async () => {
    const { stderr, exit } = await runShell('mktemp -q /nonexistent/dir/XXXXXX\n');
    assert.notStrictEqual(exit, 0);
    assert.strictEqual(stderr, '');
  });
});
